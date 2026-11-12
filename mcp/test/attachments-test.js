// Tests for read_attachment: index text first, file download fallback, find-with-context.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const KEY = 'test-key';
const FX = path.join(__dirname, 'fixtures');
const files = {
    'store/review.xlsx': fs.readFileSync(path.join(FX, 'review.xlsx')),
    'store/notes.docx': fs.readFileSync(path.join(FX, 'notes.docx')),
    'store/slides.pptx': fs.readFileSync(path.join(FX, 'slides.pptx')),
    'store/list.csv': fs.readFileSync(path.join(FX, 'list.csv')),
    'store/survey.pdf': Buffer.from('%PDF-1.4 binary'),
    'store/photo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};
const att = (filename, mimeType, p) => ({ filename, mimeType, sizeBytes: (files[p] || []).length, storagePath: p });
const emails = {
    // Indexed email: the PDF text comes from the search index
    idx: { id: 'idx', subject: 'Mast survey pack', senderEmail: 'donald@nbi.ie', senderName: 'Donald', sentAt: '2026-03-04T17:33:00Z',
        attachments: [att('survey.pdf', 'application/pdf', 'store/survey.pdf'), att('photo.png', 'image/png', 'store/photo.png')] },
    // Not indexed: Office files are read from the downloaded file
    raw: { id: 'raw', subject: '', senderEmail: 'pedro@indigotg.com', senderName: 'Pedro', sentAt: '2026-03-06T10:00:00Z',
        attachments: [att('review.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'store/review.xlsx'),
            att('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'store/notes.docx'),
            att('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'store/slides.pptx'),
            att('list.csv', 'text/csv', 'store/list.csv'),
            att('survey.pdf', 'application/pdf', 'store/survey.pdf')] },
    none: { id: 'none', subject: 'No files', senderEmail: 'a@b.c', sentAt: '2026-01-01T00:00:00Z', attachments: [] },
};
const indexedPdfText = 'Fibre Connection Survey\nSite: Belle Lake WT0102\nPole 4 failed – replace\nAccess: farm lane';
const seen = [];

const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-api-key'] !== KEY) return json(401, { message: 'no' });
    seen.push(u.pathname + u.search);
    if (u.pathname === '/api/v1/search') {
        const hits = [];
        // Only 'idx' is in the index; the search must be narrowed by sender and date
        if (u.searchParams.get('from') === 'donald@nbi.ie' && u.searchParams.get('dateFrom') === '2026-03-03' && u.searchParams.get('dateTo') === '2026-03-05') {
            hits.push({ id: 'other', attachments: [] }, { id: 'idx', attachments: [{ filename: 'survey.pdf', content: indexedPdfText }, { filename: 'photo.png', content: '' }] });
        }
        return json(200, { hits, total: hits.length });
    }
    const m = u.pathname.match(/^\/api\/v1\/archived-emails\/(.+)$/);
    if (m) return emails[m[1]] ? json(200, emails[m[1]]) : json(404, { message: 'not found' });
    if (u.pathname === '/api/v1/storage/download') {
        const f = files[u.searchParams.get('path')];
        if (!f) { res.writeHead(404); return res.end('File not found'); }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(f);
    }
    json(404, { message: 'no route' });
});

srv.listen(0, '127.0.0.1', async () => {
    const port = srv.address().port;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, OA_URL: `http://127.0.0.1:${port}`, OA_API_KEY: KEY }, stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = new Map(); let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(msg.id)?.(msg); } });
    let n = 0;
    const call = (method, params) => new Promise((r) => { const id = ++n; pending.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const tool = async (args) => (await call('tools/call', { name: 'read_attachment', arguments: args })).result;
    const fails = []; const check = (label, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) { fails.push(label); console.log(typeof extra === 'string' ? extra : JSON.stringify(extra, null, 1)); } };

    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const list = await call('tools/list', {});
    const ra = list.result.tools.find((t) => t.name === 'read_attachment');
    check('read_attachment listed and read-only', ra && ra.annotations.readOnlyHint && !ra.annotations.destructiveHint, list.result.tools.map((t) => t.name));

    let r = await tool({ email_id: 'idx' });
    let t = r.content[0].text;
    check('PDF text comes from the search index', t.includes('[search index]') && t.includes('Pole 4 failed') && t.includes('survey.pdf'), t);
    check('images skipped when no filename given', !t.includes('photo.png'), t);
    check('index found via sender + date window', seen.some((s) => s.includes('from=donald%40nbi.ie') && s.includes('dateFrom=2026-03-03')), seen);

    r = await tool({ email_id: 'raw', filename: 'review', context_lines: 0, find: 'Belle Lake' });
    t = r.content[0].text;
    check('xlsx read from downloaded file', t.includes('[downloaded file]'), t);
    check('xlsx find returns the matching row with all cells', /INDRFI100881\tBelle Lake\tWaterford\tWT0102\tHLD done – awaiting wayleave\t7/.test(t), t);
    check('xlsx find keeps sheet name and header row', t.includes('=== Sheet: Masts ===') && t.includes('Indigo Identifier\tSite Name'), t);
    check('xlsx find covers other sheets and decodes XML entities', t.includes('=== Sheet: Notes ===') && t.includes('Belle Lake & Co: access via "east" gate <locked>'), t);
    check('xlsx find excludes non-matching rows', !t.includes('Noween Hill') && !t.includes('Lahardan'), t);
    check('match count reported', /2 matching line\(s\)/.test(t), t);

    r = await tool({ email_id: 'raw', filename: 'review' });
    t = r.content[0].text;
    check('full xlsx keeps empty cells aligned', t.includes('INDRFI100882\tNoween Hill\tCork\tCK0384\tOn hold') && t.includes('\t\tTRUE'), t);

    r = await tool({ email_id: 'raw', filename: 'notes.docx' });
    t = r.content[0].text;
    check('docx paragraphs, tabs and tables', t.includes('Mast survey notes') && t.includes('Belle Lake\tstructure only') && t.includes('WT0102\tOK'), t);

    r = await tool({ email_id: 'raw', filename: 'slides' });
    t = r.content[0].text;
    check('pptx slide text', t.includes('=== Slide 1 ===') && t.includes('Belle Lake approved in principle'), t);

    r = await tool({ email_id: 'raw', filename: 'list.csv' });
    t = r.content[0].text;
    check('csv becomes tab-separated, quoted commas kept', t.includes('"Belle Lake, Upper"\tWaterford') && t.includes('Noween Hill\tCork'), t);

    r = await tool({ email_id: 'raw', filename: 'survey.pdf' });
    t = r.content[0].text;
    check('unindexed PDF explains it needs the index', t.includes('not indexed yet'), t);

    r = await tool({ email_id: 'raw', find: 'nothing-like-this' });
    t = r.content[0].text;
    check('no-match message per attachment', (t.match(/No lines contain/g) || []).length === 4, t);

    r = await tool({ email_id: 'raw', filename: 'zzz' });
    check('unknown filename lists the attachments', r.content[0].text.includes('Attachments: review.xlsx, notes.docx'), r.content[0].text);

    r = await tool({ email_id: 'none' });
    check('email without attachments', r.content[0].text.includes('no stored attachments'), r.content[0].text);

    r = await tool({ email_id: 'nope' });
    check('unknown email is a tool error', r.isError && /404/.test(r.content[0].text), r);

    r = await tool({ email_id: 'raw', filename: 'review', max_chars: 1000 });
    check('max_chars respected', r.content[0].text.length < 1600, r.content[0].text.length);

    child.kill(); srv.close();
    console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
    process.exit(fails.length ? 1 : 0);
});
