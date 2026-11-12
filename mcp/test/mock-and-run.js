// Test harness: a mock Open Archiver API plus a scripted MCP client session.
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const KEY = 'test-key';
const eml = [
  'From: =?UTF-8?Q?M=C3=A1rio_Gon=C3=A7alves?= <mario@example.com>',
  'To: Pedro <pedro@example.com>',
  'Subject: Survey Cork',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUTER"',
  '',
  '--OUTER',
  'Content-Type: multipart/alternative; boundary="INNER"',
  '',
  '--INNER',
  'Content-Type: text/plain; charset="windows-1252"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Ol=E1 Pedro, the survey for cluster 54 is done =96 see attached.=',
  ' Regards',
  '--INNER',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>HTML version</p>',
  '--INNER--',
  '--OUTER',
  'Content-Type: application/pdf; name="Cluster 54.pdf"',
  'Content-Disposition: attachment; filename="Cluster 54.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake').toString('base64'),
  '--OUTER--',
  '',
].join('\r\n');

const deleted = new Set();
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (req.headers['x-api-key'] !== KEY) return send(401, { message: 'Unauthorized' });
  if (u.pathname === '/api/v1/search') {
    if (!u.searchParams.get('keywords') && !u.searchParams.get('dateFrom') && !u.searchParams.get('from')) return send(400, { message: 'keywords required' });
    return send(200, { hits: [{ id: 'e1', from: 'mario@example.com', fromName: 'Mário Gonçalves', to: ['pedro@example.com'], cc: [], subject: 'Survey Cork', body: 'Olá Pedro, the survey for cluster 54 is done', attachments: [{ filename: 'Cluster 54.pdf' }], timestamp: 1526032800000 }], total: 1, page: 1, limit: 20, totalPages: 1, _seen: Object.fromEntries(u.searchParams) });
  }
  const m = u.pathname.match(/^\/api\/v1\/archived-emails\/(.+)$/);
  if (m) {
    if (req.method === 'DELETE') {
      if (m[1] === 'blocked') return send(400, { message: 'Deletion is disabled for this instance.' });
      if (m[1] === 'missing' || deleted.has(m[1])) return send(404, { message: 'not found' });
      deleted.add(m[1]); return send(204);
    }
    if (m[1] !== 'e1') return send(404, { message: 'not found' });
    return send(200, { id: 'e1', sentAt: '2018-05-11T09:20:00.000Z', subject: 'Survey Cork', senderName: 'Mário Gonçalves', senderEmail: 'mario@example.com', recipients: { to: [{ name: 'Pedro', address: 'pedro@example.com' }], cc: [] }, path: 'Inbox/Cork', ingestionSource: { id: 's1', name: 'PST 2018' }, attachments: [], raw: Buffer.from(eml, 'latin1').toJSON(), thread: [{ id: 'e1', subject: 'Survey Cork', sentAt: '2018-05-11T09:20:00Z', senderName: 'Mário' }, { id: 'e2', subject: 'RE: Survey Cork', sentAt: '2018-05-11T10:00:00Z', senderName: 'Paul Dullaghan' }] });
  }
  if (u.pathname.startsWith('/api/v1/dashboard/')) return send(200, { ok: u.pathname.split('/').pop(), totalEmails: 1234 });
  send(404, { message: 'no route' });
});

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, OA_URL: `http://127.0.0.1:${port}/`, OA_API_KEY: KEY }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(msg.id)?.(msg); } });
  let n = 0;
  const call = (method, params) => new Promise((r) => { const id = ++n; pending.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result;
  const fails = []; const check = (label, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails.push(label), console.log(extra); };

  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check('initialize negotiates 2025-06-18', init.result.protocolVersion === '2025-06-18', init);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await call('tools/list', {});
  check('5 tools listed', list.result.tools.length === 5, list);
  check('delete marked destructive, others read-only', list.result.tools.every((t) => t.name === 'delete_emails' ? t.annotations.destructiveHint && !t.annotations.readOnlyHint : t.annotations.readOnlyHint), list.result.tools.map((t) => t.annotations));

  const s = await tool('search_emails', { query: 'survey cork', from: '*@example.com', search_in: ['body', 'subject'], date_from: '2018-01-01', match_all_words: true });
  check('search returns formatted hit', /id: e1/.test(s.content[0].text) && /Cluster 54\.pdf/.test(s.content[0].text) && /2018-05-11/.test(s.content[0].text), s);
  const s2 = await tool('search_emails', {});
  check('empty search falls back to all emails', !s2.isError, s2);

  const g = await tool('get_email', { id: 'e1' });
  const t = g.content[0].text;
  check('get_email decodes windows-1252 quoted-printable', t.includes('Olá Pedro') && t.includes('done – see attached. Regards'), t);
  check('get_email prefers text/plain over html', !t.includes('HTML version'), t);
  check('get_email lists attachment from MIME', t.includes('attachments: Cluster 54.pdf'), t);
  check('get_email shows folder, source and thread', t.includes('folder: Inbox/Cork') && t.includes('source: PST 2018') && t.includes('RE: Survey Cork | id: e2') && !t.includes('| id: e1'), t);
  const g404 = await tool('get_email', { id: 'nope' });
  check('get_email 404 is a tool error', g404.isError && /404/.test(g404.content[0].text), g404);

  const o = await tool('archive_overview', {});
  check('overview combines dashboard calls', /index-health/.test(o.content[0].text) && /ingestion-sources/.test(o.content[0].text), o);

  const d = await tool('delete_emails', { ids: ['a', 'b', 'missing', 'a'] });
  check('delete counts, dedups and reports not-found', /Deleted 2 of 3/.test(d.content[0].text) && /not found\): 1/.test(d.content[0].text), d);
  const d2 = await tool('delete_emails', { ids: ['blocked', 'c'] });
  check('delete explains when deletion is switched off', /Allow Deletion/.test(d2.content[0].text), d2);

  const bad = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, OA_URL: `http://127.0.0.1:${port}`, OA_API_KEY: 'wrong' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const badOut = await new Promise((r) => { bad.stdout.once('data', (d) => r(JSON.parse(String(d)))); bad.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_emails', arguments: { query: 'x' } } }) + '\n'); });
  check('wrong API key gives a clear message', badOut.result.isError && /API key/.test(badOut.result.content[0].text), badOut);
  bad.kill();

  const unknown = await call('nonexistent/method', {});
  check('unknown method returns -32601', unknown.error && unknown.error.code === -32601, unknown);

  child.kill(); srv.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
});
