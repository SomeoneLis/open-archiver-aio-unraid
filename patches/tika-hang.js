#!/usr/bin/env node
// Build-time patch for Open Archiver's compiled OcrService (Apache Tika client).
//
// Problem: every Tika request is sent with "Connection: close". Tika then closes the socket right
// after each reply, and Node's built-in HTTP client (undici) can hit an internal race when that
// happens while it is still reading the reply: `AssertionError: assert(!this.paused)` at
// Parser.finish. The error escapes the request, so the request's promise never settles, the email
// being indexed never finishes building and its whole indexing job hangs until BullMQ marks it
// stalled. With hundreds of attachments per job, indexing stops entirely.
//
// Fix:
//   1. Drop the "Connection: close" header, so Tika keeps the connection open and the socket is not
//      closed in the middle of a reply.
//   2. Put a hard deadline on each Tika extraction (TIKA_HARD_TIMEOUT_MS, default 300000 ms). If a
//      request still never settles, the attachment is indexed without its text instead of hanging
//      the job.
//
// The patch is applied by string matching on the compiled file. If upstream changes the code so the
// patterns are not found, the build continues unpatched and says so in /etc/oa-aio/patches.txt.
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || '/app/packages/backend/dist/services/OcrService.js';
const reportFile = process.env.OA_PATCH_REPORT || '/etc/oa-aio/patches.txt';

function report(line) {
    console.log(`[tika-hang patch] ${line}`);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.appendFileSync(reportFile, `tika-hang: ${line}\n`);
}

if (!fs.existsSync(file)) {
    report(`skipped, ${file} not found (upstream layout changed)`);
    process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');
const applied = [];

if (src.includes('__oaTikaDeadline')) {
    report('already applied');
    process.exit(0);
}

// 1. Remove the "Connection: close" request header.
const connectionHeader = /^[ \t]*Connection:\s*'close',?[ \t]*\r?\n/m;
if (connectionHeader.test(src)) {
    src = src.replace(connectionHeader, '');
    applied.push('keep-alive');
}

// 2. Wrap the deduplicated Tika operation in a hard deadline.
const operationCall = 'const promise = this.executeOperation(key, operation);';
if (src.includes(operationCall)) {
    src = src.replace(operationCall, 'const promise = __oaTikaDeadline(this.executeOperation(key, operation));');
    src += `

// Added by open-archiver-aio (patches/tika-hang.js): a Tika extraction that never settles must not
// hang the indexing job. Resolves to '' (no attachment text) after TIKA_HARD_TIMEOUT_MS.
function __oaTikaDeadline(work) {
    const ms = Number(process.env.TIKA_HARD_TIMEOUT_MS) || 300000;
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
            console.warn('[open-archiver-aio] Tika extraction did not finish within ' + ms + ' ms; indexing this attachment without its text');
            resolve('');
        }, ms);
    });
    return Promise.race([work.finally(() => clearTimeout(timer)), deadline]);
}
`;
    applied.push('deadline');
}

if (applied.length === 0) {
    report('skipped, patterns not found (upstream code changed)');
    process.exit(0);
}

fs.writeFileSync(file, src);
report(`applied (${applied.join(', ')})`);
