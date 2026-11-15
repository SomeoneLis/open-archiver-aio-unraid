#!/usr/bin/env node
// Vocabulary report for the Open Archiver search index.
//
// Meilisearch keeps every distinct word of an index in one structure (the words FST), stored as a
// single LMDB value. LMDB cannot write a value larger than ~2 GB on Linux and fails with
// "I/O error (os error 5)" instead. This samples indexed documents and shows which kinds of
// "words" (real words, numbers, codes, long random strings) and which sources and attachment types
// produce the most distinct words, so the right ones can be filtered out of the index.
//
// Run inside the container:  node /config/vocab-report.js [pages=60] [pageSize=100]
'use strict';
const fs = require('fs');

const MEILI = process.env.MEILI_HOST || 'http://127.0.0.1:7700';
const KEY = fs.readFileSync('/config/keys/meili.key', 'utf8').trim();
const PAGES = Number(process.argv[2]) || 60;
const PAGE_SIZE = Number(process.argv[3]) || 100;
const MAX_TOKENS_PER_FIELD = 65535; // Meilisearch indexes at most 65535 positions per attribute

async function meili(path) {
    const res = await fetch(MEILI + path, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
}

function classify(t) {
    const hasL = /\p{L}/u.test(t);
    const hasN = /\p{N}/u.test(t);
    const len = [...t].length;
    if (len > 24) return 'long string (>24 chars)';
    if (!hasN) return len > 16 ? 'long word (17-24 letters)' : 'word';
    if (!hasL) {
        if (len <= 4) return 'number, 1-4 digits';
        if (len <= 6) return 'number, 5-6 digits';
        if (len <= 12) return 'number, 7-12 digits';
        return 'number, 13+ digits';
    }
    if (/^[0-9a-f]+$/i.test(t) && len >= 12) return 'hex-like (12-24 chars)';
    return len <= 12 ? 'code, letters+digits <=12' : 'code, letters+digits 13-24';
}

function tokens(text) {
    if (!text) return [];
    const out = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return out.length > MAX_TOKENS_PER_FIELD ? out.slice(0, MAX_TOKENS_PER_FIELD) : out;
}

(async () => {
    const stats = await meili('/indexes/emails/stats');
    const total = stats.numberOfDocuments;
    const step = Math.max(PAGE_SIZE, Math.floor(total / PAGES));
    const vocab = new Map(); // token -> class
    const byClass = new Map();
    const bySource = new Map(); // source -> Set of tokens first seen there
    const byExt = new Map(); // attachment extension -> new distinct tokens
    const fieldNew = { body: 0, subject: 0, attachments: 0 };
    let docs = 0;

    const add = (tok, source, where, ext) => {
        if (vocab.has(tok)) return;
        const cls = classify(tok);
        vocab.set(tok, cls);
        byClass.set(cls, (byClass.get(cls) || 0) + 1);
        bySource.set(source, (bySource.get(source) || 0) + 1);
        fieldNew[where]++;
        if (ext) byExt.set(ext, (byExt.get(ext) || 0) + 1);
    };

    for (let offset = 0; offset < total && docs < PAGES * PAGE_SIZE; offset += step) {
        const page = await meili(`/indexes/emails/documents?offset=${offset}&limit=${PAGE_SIZE}&fields=id,ingestionSourceId,subject,body,attachments`);
        for (const d of page.results) {
            docs++;
            const src = d.ingestionSourceId || 'unknown';
            for (const t of tokens(d.subject)) add(t, src, 'subject');
            for (const t of tokens(d.body)) add(t, src, 'body');
            let budget = MAX_TOKENS_PER_FIELD;
            for (const a of d.attachments || []) {
                const ext = ((a.filename || '').match(/\.([a-z0-9]{1,6})$/i) || [, 'none'])[1].toLowerCase();
                const ts = tokens(a.content).slice(0, budget);
                budget -= ts.length;
                for (const t of ts) add(t, src, 'attachments', ext);
                if (budget <= 0) break;
            }
        }
        process.stderr.write(`\rsampled ${docs} documents, ${vocab.size} distinct words`);
    }
    process.stderr.write('\n');

    const pct = (n) => ((100 * n) / vocab.size).toFixed(1).padStart(5) + '%';
    const table = (title, map, top = 12) => {
        console.log(`\n${title}`);
        [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
            .forEach(([k, n]) => console.log(`  ${pct(n)}  ${String(n).padStart(9)}  ${k}`));
    };

    console.log(`Index: ${total} documents. Sample: ${docs} documents, ${vocab.size} distinct words.`);
    console.log(`Distinct words first seen in: subject ${fieldNew.subject}, body ${fieldNew.body}, attachments ${fieldNew.attachments}`);
    table('By kind of word:', byClass);
    table('By ingestion source:', bySource);
    table('By attachment type (attachments only):', byExt);

    const examples = new Map();
    for (const [t, c] of vocab) {
        const list = examples.get(c) || [];
        if (list.length < 6) list.push(t);
        examples.set(c, list);
    }
    console.log('\nExamples:');
    for (const [c, list] of examples) console.log(`  ${c}: ${list.join('  ')}`);
})().catch((e) => { console.error(e); process.exit(1); });
