#!/usr/bin/env node
// Build-time patch for Open Archiver's compiled IndexingService: keep encoded binary data out of
// the search index.
//
// Problem: email bodies can carry base64 data as text (inline images as data: URIs, encoded parts
// that end up in the body text). Meilisearch splits that data into millions of random "words".
// Every distinct word goes into one list (the words FST) that Meilisearch stores as a single LMDB
// value, and LMDB cannot write a value over ~2 GB on Linux: indexing then fails with
// "I/O error (os error 5)" and the index cannot grow any further. On a large archive this happened
// at ~80,000-100,000 emails, with over 90% of the distinct words coming from base64 in bodies.
//
// Fix: sanitizeText (applied to subject, body, attachment names and attachment text before they
// are sent to Meilisearch) also removes
//   - data: URIs with base64 content, and
//   - runs of 40+ base64 characters that mix upper case, lower case and digits (encoded data;
//     words, codes, phone numbers, IDs and URLs do not look like that).
// Nothing else changes: the archived emails and attachments are untouched, only the search text.
// Set INDEXING_STRIP_ENCODED=false to turn it off.
//
// If upstream changes the code so the pattern is not found, the build continues unpatched and says
// so in /etc/oa-aio/patches.txt.
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || '/app/packages/backend/dist/services/IndexingService.js';
const reportFile = process.env.OA_PATCH_REPORT || '/etc/oa-aio/patches.txt';

function report(line) {
    console.log(`[strip-encoded patch] ${line}`);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.appendFileSync(reportFile, `strip-encoded: ${line}\n`);
}

if (!fs.existsSync(file)) {
    report(`skipped, ${file} not found (upstream layout changed)`);
    process.exit(0);
}

let src = fs.readFileSync(file, 'utf8');

if (src.includes('__oaStripEncoded')) {
    report('already applied');
    process.exit(0);
}

const declaration = 'function sanitizeText(text) {';
if (!src.includes(declaration)) {
    report('skipped, sanitizeText not found (upstream code changed)');
    process.exit(0);
}

src = src.replace(
    declaration,
    'function sanitizeText(text) {\n    return __oaStripEncoded(__oaSanitizeTextOriginal(text));\n}\nfunction __oaSanitizeTextOriginal(text) {'
);
src += `

// Added by open-archiver-aio (patches/strip-encoded.js): remove base64 data from search text.
function __oaStripEncoded(text) {
    if (!text || process.env.INDEXING_STRIP_ENCODED === 'false') return text;
    return text
        .replace(/data:[\\w.+-]+\\/[\\w.+-]+;base64,[A-Za-z0-9+/=\\s]*/g, ' ')
        .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, (run) =>
            /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run) ? ' ' : run
        );
}
`;

fs.writeFileSync(file, src);
report('applied');
