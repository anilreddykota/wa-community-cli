#!/usr/bin/env node
// Demo mode: serves the real web UI with made-up data. No WhatsApp, nothing is sent.
// Run:  npm run demo   then open http://localhost:3031
// Phone numbers use +1 555-01xx, a range reserved for fiction, so none belong to real people.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3031);
const TOKEN = 'demo';
const INDEX = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Vihaan', 'Isha', 'Arjun', 'Meera', 'Rohan', 'Saanvi', 'Aditya', 'Kavya', 'Reyansh', 'Myra', 'Krishna', 'Anika', 'Ayaan', 'Riya', 'Dev', 'Tara'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Nair', 'Patel', 'Rao', 'Gupta', 'Menon', 'Das', 'Varma'];
// +1 <area code> 555-01xx: the 555-0100..0199 block is reserved for fictional use in every NANP area code.
const phone = (i) => `+1${201 + (Math.floor(i / 100) % 700)}55501${String(i % 100).padStart(2, '0')}`;
const person = (i) => ({ phone: phone(i), name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`, role: '' });

const chats = [
  { id: 'c1', title: 'Class of 2027 · Students', kind: 'community', parentTitle: '', myRole: 'owner', canSend: true, announceId: 'a1' },
  { id: 'c2', title: 'Class of 2027 · Parents', kind: 'community', parentTitle: '', myRole: 'owner', canSend: true, announceId: 'a2' },
  { id: 'g1', title: 'CSE · Section A', kind: 'group', parentTitle: 'Class of 2027 · Students', myRole: 'admin', canSend: true },
  { id: 'g2', title: 'CSE · Section B', kind: 'group', parentTitle: 'Class of 2027 · Students', myRole: 'admin', canSend: true },
  { id: 'g3', title: 'ECE · Section A', kind: 'group', parentTitle: 'Class of 2027 · Students', myRole: 'admin', canSend: true },
  { id: 'g4', title: 'Mechanical · Section A', kind: 'group', parentTitle: 'Class of 2027 · Students', myRole: 'admin', canSend: true },
  { id: 'g5', title: 'Hackathon Volunteers', kind: 'group', parentTitle: '', myRole: 'owner', canSend: true },
  { id: 'g6', title: 'Placement Updates', kind: 'group', parentTitle: '', myRole: 'admin', canSend: true },
  { id: 'g7', title: 'Sports Club', kind: 'group', parentTitle: '', myRole: 'member', canSend: true },
  { id: 'g8', title: 'Alumni Network', kind: 'community', parentTitle: '', myRole: 'admin', canSend: true, announceId: 'a8' },
  { id: 'g9', title: 'Library Notices', kind: 'group', parentTitle: '', myRole: 'member', canSend: false },
  { id: 'g10', title: 'Coding Club', kind: 'group', parentTitle: '', myRole: 'owner', canSend: true },
];
const members = [
  { phone: phone(0), name: 'You', role: 'owner' },
  { phone: phone(1), name: 'Prof. Meenakshi Rao', role: 'admin' },
  { phone: phone(2), name: 'Dr. Kiran Varma', role: 'admin' },
  ...Array.from({ length: 1997 }, (_, i) => person(i + 3)),
];

let demoLists = [
  { name: 'All section groups', ids: ['g1', 'g2', 'g3', 'g4'] },
  { name: 'Every Announcements', ids: ['c1', 'c2', 'g8'] },
  { name: 'Clubs', ids: ['g5', 'g10', 'g7'], missing: [{ title: 'Drama Club', reason: 'not found (left the group, renamed, or typo)' }] },
];

// ---------- events ----------
const clients = new Set();
const recent = [];
const send = (evt) => { const d = `data: ${JSON.stringify(evt)}\n\n`; for (const r of clients) r.write(d); };
const log = (text, level = 'info') => { const e = { type: 'log', text, level, time: new Date().toISOString() }; recent.push(e); if (recent.length > 200) recent.shift(); send(e); };
let job = null;

function fakeJob(label, targets, verb, resultFor = () => verb) {
  job = { label, kind: 'members', state: 'running', paused: false, done: 0, processed: 0, total: targets.length, logFile: 'demo_log.csv', startedAt: new Date().toISOString() };
  log(`${label}: ${targets.length} items, 5–9s apart, 90s break every 25. About ${Math.ceil(targets.length * 9 / 60)} min.`);
  send({ type: 'job', job });
  let i = 0;
  const step = () => {
    if (!job || job.state !== 'running') return;
    if (job.paused) return setTimeout(step, 500);
    const t = targets[i++];
    const result = resultFor(t, i);
    const ok = result === verb;
    job.processed++; if (ok) job.done++;
    log(`${ok ? '✓' : '•'} ${i}/${targets.length}  ${t.phone}  ${t.name || ''} — ${result}`, ok ? 'ok' : 'info');
    send({ type: 'job', job });
    if (i >= targets.length) {
      job.state = 'finished';
      log(`${label}: ${job.done} done, 0 not processed.`, 'ok');
      if (job.done < targets.length) log(`Not changed: ${targets.length - job.done} not-added. Details are in the log.`, 'warn');
      send({ type: 'job', job }); return;
    }
    setTimeout(step, Number(process.env.DEMO_STEP_MS || 1500));
  };
  setTimeout(step, 800);
  return job;
}

// ---------- API ----------
const numbersIn = (text) => new Set((String(text).match(/\+?\d[\d ()-]{8,}\d/g) || []).map((n) => n.replace(/\D/g, '')));

function api(method, p, q, body) {
  if (p === '/api/status') return { state: 'ready', qr: null, error: null, job, usage: usage(), countryCode: '1' };
  if (p === '/api/usage') return usage();
  if (p === '/api/chats') return chats;
  if (p === '/api/members') return { members: q.get('id') === 'c1' ? members : members.slice(0, 64), admins: 3, hidden: 0 };
  if (p === '/api/export/members' || p === '/api/export/chats') return { name: 'demo.csv', csv: 'phone,name\n', count: p.endsWith('members') ? members.length : chats.length };
  if (p === '/api/members/plan' || p === '/api/members/run') {
    const keep = numbersIn(body.text);
    const normal = members.filter((m) => !m.role);
    if (body.action === 'keep') {
      const remove = normal.filter((m) => !keep.has(m.phone.replace(/\D/g, '')));
      if (p.endsWith('/run')) return fakeJob('Remove members not on keep list — Class of 2027 · Students', remove, 'removed');
      return { action: 'keep', count: remove.length, targets: remove.slice(0, 500), kept: normal.length - remove.length, keepCount: keep.size, missing: Array.from({ length: 41 }, (_, i) => ({ phone: phone(3000 + i), name: '' })) };
    }
    if (body.action === 'add') {
      const present = new Set(members.map((m) => m.phone.replace(/\D/g, '')));
      const toAdd = [...keep].filter((n) => !present.has(n)).map((n) => ({ phone: '+' + n, name: '' }));
      if (p.endsWith('/run')) return fakeJob(`Add members — ${(chats.find((c) => c.id === body.chatId) || {}).title}`, toAdd, 'added',
        (t, i) => (i === 2 ? 'not-added: their privacy settings may block being added — send them an invite link instead' : 'added'));
      return { action: 'add', count: toAdd.length, targets: toAdd, missing: [], already: keep.size - toAdd.length };
    }
    const targets = normal.filter((m) => keep.has(m.phone.replace(/\D/g, '')));
    if (p.endsWith('/run')) return fakeJob('Bulk action', targets, 'done');
    return { action: body.action, count: targets.length, targets, missing: [], already: 0 };
  }
  if (p === '/api/broadcast/run') return fakeJob(`Message ${body.chatIds.length} groups`, body.chatIds.map((id) => ({ phone: (chats.find((c) => c.id === id) || {}).title, name: '' })), 'sent');
  if (p === '/api/dms/inspect') {
    const lines = String(body.csv).trim().split(/\r?\n/);
    const headers = lines[0].split(',').map((h) => h.trim());
    return { headers, rows: lines.length - 1, phoneColumns: headers.filter((h) => /phone|mobile/i.test(h)) };
  }
  if (p === '/api/dms/plan' || p === '/api/dms/run') {
    const lines = String(body.csv).trim().split(/\r?\n/);
    const headers = lines[0].split(',').map((h) => h.trim());
    const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [headers[i], v.trim()])));
    const fill = (t, r) => t.replace(/\{([^{}]+)\}/g, (a, k) => { const h = headers.find((x) => x.toLowerCase() === k.trim().toLowerCase()); return h ? r[h] : a; });
    if (p.endsWith('/run')) return fakeJob(`Personal messages (${rows.length})`, rows.map((r) => ({ phone: r[body.phoneCol] })), 'sent');
    const anyone = body.gateId === '__anyone__';
    return { headers, gate: anyone ? 'anyone in your CSV' : (chats.find((c) => c.id === body.gateId) || {}).title, anyone, dailyLimit: 50, rows: rows.length, count: rows.length - (anyone ? 1 : 2), notMember: anyone ? 0 : 1, dup: 1, bad: 0,
      previews: rows.slice(0, 3).map((r) => ({ phone: r[body.phoneCol], text: fill(body.template, r) })), unfilled: [] };
  }
  // saved lists (kept in memory for the demo)
  if (p === '/api/lists') return demoLists.map((l) => ({ name: l.name, count: l.ids.length + (l.missing || []).length, ids: l.ids, missing: l.missing || [] }));
  if (p === '/api/lists/save') { demoLists = demoLists.filter((l) => l.name.toLowerCase() !== String(body.name).toLowerCase()); demoLists.push({ name: String(body.name).trim(), ids: body.chatIds }); log(`Saved list "${body.name}" (${body.chatIds.length} chats).`, 'ok'); return { name: body.name, count: body.chatIds.length }; }
  if (p === '/api/lists/delete') { demoLists = demoLists.filter((l) => l.name !== body.name); return { deleted: body.name }; }
  if (p === '/api/lists/rename') { const l = demoLists.find((x) => x.name === body.from); if (l) l.name = body.to; return { name: body.to }; }
  if (p === '/api/lists/export') return { name: 'saved-lists.csv', csv: 'list,title,kind,chat_id\n' + demoLists.flatMap((l) => l.ids.map((id) => { const c = chats.find((x) => x.id === id); return `${l.name},${c.title},${c.kind},${id}`; })).join('\n') };
  if (p === '/api/lists/import') return { imported: 0, total: demoLists.length };
  if (p === '/api/job/pause') { if (job) job.paused = true; send({ type: 'job', job }); return job; }
  if (p === '/api/job/resume') { if (job) job.paused = false; send({ type: 'job', job }); return job; }
  if (p === '/api/job/stop') { if (job) job.state = 'finished'; send({ type: 'job', job }); return job; }
  if (p === '/api/reconnect' || p === '/api/logout') return { ok: true };
  if (p === '/api/quit') { setTimeout(() => process.exit(0), 200); return { ok: true }; }
  return null;
}
const usage = () => ({ members: { label: 'removals & admin changes', used: 42, limit: 200 }, adds: { label: 'people added', used: 12, limit: 80 }, groupMsgs: { label: 'group messages', used: 6, limit: 100 }, dms: { label: 'personal messages', used: 0, limit: 50 } });

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' ) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(INDEX); }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(`data: ${JSON.stringify({ type: 'status', state: 'ready' })}\n\n`);
    for (const e of recent) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (job) res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const out = api(req.method, url.pathname, url.searchParams, raw ? JSON.parse(raw) : {});
    res.writeHead(out === null && !url.pathname.startsWith('/api/job') ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Demo (made-up data, nothing is sent): http://localhost:${PORT}`);
  log('Demo mode: made-up data, no WhatsApp connection, nothing is sent.', 'warn');
});
