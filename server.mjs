#!/usr/bin/env node
// Local web UI for the WhatsApp Community & Group Manager.
// Listens on 127.0.0.1 only and requires a per-run secret token, so other
// websites and other computers cannot drive your WhatsApp.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import {
  HERE, OUT_DIR, SESSION_DIR, sleep, config, usageSummary, stamp, safeName, numbersFromText, parseCsv, toCsv, writeCsv,
  fillTemplate, mediaFromBase64, planKeepList, planFromList, planAdd, phoneColumns, planDms,
  openWhatsApp, waCaller, PacedJob,
} from './lib/engine.mjs';

const PORT = Number(process.env.PORT || 3030);
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const MAX_BODY = 100 * 1024 * 1024;

// ---------- WhatsApp session ----------
const session = { state: 'starting', qr: null, error: null, browser: null, page: null, wa: null };

async function startSession() {
  session.state = 'starting'; session.error = null; session.qr = null;
  try {
    const { browser, page } = await openWhatsApp((state, extra) => {
      if (state === 'qr' && session.state === 'ready') pushLog('WhatsApp was logged out (for example from your phone). Scan the QR code to link again.', 'warn');
      if (state === 'ready' && session.state === 'qr' && session.wa) pushLog('WhatsApp is linked again.', 'ok');
      session.state = state;
      if (state === 'qr') session.qr = extra;
      if (state === 'ready') session.qr = null;
      broadcast({ type: 'status', state, qr: state === 'qr' ? extra : null });
    });
    session.browser = browser; session.page = page; session.wa = waCaller(page);
    browser.on('disconnected', () => {
      if (session.loggingOut) return;
      session.state = 'closed'; session.wa = null;
      broadcast({ type: 'status', state: 'closed' });
      pushLog('The WhatsApp Chrome window was closed. Click "Reconnect" to open it again.', 'warn');
    });
    pushLog('WhatsApp Web is ready.', 'ok');
  } catch (e) {
    session.state = 'error'; session.error = String(e && e.message ? e.message : e);
    broadcast({ type: 'status', state: 'error', error: session.error });
  }
}

function requireReady() {
  if (session.state !== 'ready' || !session.wa) throw httpError(503, 'WhatsApp is not ready yet.');
  return session.wa;
}

// ---------- events (Server-Sent Events) ----------
const clients = new Set();
const recentLog = [];
function broadcast(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(data);
}
function pushLog(text, level = 'info') {
  const evt = { type: 'log', text, level, time: new Date().toISOString() };
  recentLog.push(evt);
  if (recentLog.length > 400) recentLog.shift();
  broadcast(evt);
}

// ---------- jobs ----------
let job = null;
function startJob(opts) {
  if (job && job.state === 'running') throw httpError(409, 'Another job is running. Stop it or wait for it to finish.');
  job = new PacedJob(opts);
  job.on('log', (t, l) => pushLog(t, l));
  job.on('item', (it) => {
    pushLog(`${it.done ? '✓' : it.result.startsWith('error') ? '✗' : '•'} ${it.index}/${it.total}  ${it.target}  — ${it.result}`, it.done ? 'ok' : it.result.startsWith('error') ? 'error' : 'info');
    broadcast({ type: 'job', job: job.snapshot() });
  });
  job.on('end', (s) => broadcast({ type: 'job', job: s }));
  broadcast({ type: 'job', job: job.snapshot() });
  job.run().catch((e) => pushLog('Job crashed: ' + (e && e.message ? e.message : e), 'error'));
  return job.snapshot();
}

// ---------- helpers ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const outFile = (prefix, title) => path.join(OUT_DIR, `${title ? safeName(title) + '_' : ''}${prefix}_${stamp()}.csv`);

async function chatById(wa, id) {
  const chats = await wa('listChats');
  const c = chats.find((x) => x.id === id);
  if (!c) throw httpError(404, 'Group or community not found.');
  return c;
}
const sendTarget = (c) => ({ chatId: c.kind === 'community' ? c.announceId : c.id });
const slim = (list, n = 5000) => list.slice(0, n).map((m) => ({ phone: m.phone, name: m.name || '', role: m.role || '' }));

function checkConfirm(confirmValue, count) {
  if (String(confirmValue).trim() !== String(count)) throw httpError(400, `Confirmation must be the exact number: ${count}.`);
}

// ---------- API ----------
async function api(req, url, body) {
  const route = `${req.method} ${url.pathname}`;
  const wa = () => requireReady();

  switch (route) {
    case 'GET /api/status':
      return { state: session.state, qr: session.qr, error: session.error, job: job ? job.snapshot() : null, usage: usageSummary(), countryCode: config.countryCode };

    case 'POST /api/reconnect':
      if (session.state === 'ready' || session.state === 'starting' || session.state === 'qr') return { ok: true };
      startSession();
      return { ok: true };

    // Forget this computer: close the WhatsApp window and delete the saved login.
    // (Also remove it on the phone under Linked devices to fully disconnect.)
    case 'POST /api/logout': {
      if (job && job.state === 'running') throw httpError(409, 'Stop the running job first.');
      session.loggingOut = true;
      try { if (session.browser) await session.browser.close(); } catch {}
      session.browser = null; session.page = null; session.wa = null;
      let removed = false;
      for (let i = 0; i < 10 && !removed; i++) {
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); removed = !fs.existsSync(SESSION_DIR); } catch {}
        if (!removed) await sleep(500);
      }
      session.loggingOut = false;
      session.state = 'closed';
      broadcast({ type: 'status', state: 'closed' });
      pushLog(removed ? 'Logged out: the saved WhatsApp login was deleted from this computer. Also remove "Google Chrome (Windows)" under Linked devices on your phone.' : 'Could not delete the saved login folder — close any WhatsApp Chrome window and try again.', removed ? 'ok' : 'error');
      return { ok: removed };
    }

    case 'POST /api/quit':
      setTimeout(shutdown, 300);
      return { ok: true };

    case 'GET /api/chats': {
      const chats = await wa()('listChats');
      return chats.sort((a, b) => a.title.localeCompare(b.title));
    }

    case 'GET /api/members': {
      const id = url.searchParams.get('id');
      const members = await wa()('loadMembers', id);
      return { members: slim(members, 20000), admins: members.filter((m) => m.role).length, hidden: members.filter((m) => !m.role && !m.phone).length };
    }

    case 'POST /api/export/members': {
      const c = await chatById(wa(), body.chatId);
      const members = await wa()('loadMembers', c.id);
      const file = writeCsv(outFile('members', c.title), members, ['phone', 'name', 'role']);
      return { name: path.basename(file), csv: toCsv(members, ['phone', 'name', 'role']), count: members.length };
    }

    case 'POST /api/export/chats': {
      const chats = await wa()('listChats');
      if (body.full) {
        for (const c of chats.filter((x) => x.kind === 'community')) {
          try { c.loadedMembers = (await wa()('loadMembers', c.id)).length; } catch {}
        }
      }
      chats.sort((a, b) => a.title.localeCompare(b.title));
      const cols = ['title', 'kind', 'parentTitle', 'myRole', 'canSend', 'loadedMembers', 'inviteLink', 'id'];
      const file = writeCsv(outFile('my_groups'), chats, cols);
      return { name: path.basename(file), csv: toCsv(chats, cols), count: chats.length };
    }

    // ----- members: plan (preview) and run -----
    case 'POST /api/members/plan':
    case 'POST /api/members/run': {
      const run = route.endsWith('/run');
      const c = await chatById(wa(), body.chatId);
      const members = await wa()('loadMembers', c.id);
      const numbers = numbersFromText(body.text || '');
      if (!numbers.size) throw httpError(400, 'No phone numbers found in the list.');
      const action = body.action;
      if (action !== 'keep' && action !== 'removeList' && action !== 'promote' && action !== 'demote' && action !== 'add') throw httpError(400, 'Unknown action.');
      if (action !== 'keep' && action !== 'removeList' && c.myRole === 'member') throw httpError(403, 'You need to be an admin for this.');
      if ((action === 'keep' || action === 'removeList') && run && c.myRole === 'member') throw httpError(403, 'You need to be an admin to remove members.');
      if (action === 'add' && c.kind !== 'group') throw httpError(400, 'Add people to one of the community\'s groups, not the community itself.');

      let plan, targets;
      if (action === 'keep') { plan = planKeepList(members, numbers); targets = plan.remove; }
      else if (action === 'add') { plan = planAdd(members, numbers); targets = plan.toAdd; }
      else { plan = planFromList(members, numbers, action); targets = plan.targets; }

      if (!run) {
        return {
          chat: c,
          action,
          count: targets.length,
          targets: slim(targets),
          kept: plan.kept ? plan.kept.length : undefined,
          keepCount: plan.keepCount,
          missing: plan.missing ? slim(plan.missing) : plan.notFound ? slim(plan.notFound) : [],
          already: plan.already,
        };
      }

      checkConfirm(body.confirm, targets.length);
      if (!targets.length) throw httpError(400, 'Nothing to do.');
      const w = wa();
      const fn = action === 'add' ? (m) => w('addMember', c.id, m.phone)
        : action === 'promote' || action === 'demote' ? (m) => w('setAdmin', c.id, m.key, action === 'promote')
        : (m) => w('removeMember', c.id, m.key, m.phone, m.name);
      const label = { keep: 'Remove members not on keep list', removeList: 'Remove listed members', promote: 'Make admins', demote: 'Remove admin rights', add: 'Add members' }[action];
      return startJob({ kind: 'members', label: `${label} — ${c.title}`, items: targets, action: fn, logFile: outFile(`${action}_log`, c.title) });
    }

    // ----- one message to many chats -----
    case 'POST /api/broadcast/run': {
      const ids = Array.isArray(body.chatIds) ? body.chatIds : [];
      if (!ids.length) throw httpError(400, 'Pick at least one group or community.');
      const text = String(body.text || '').trim();
      const media = body.media ? mediaFromBase64(body.media.base64, body.media.name) : null;
      if (!text && !media) throw httpError(400, 'Write a message or attach a file.');
      checkConfirm(body.confirm, ids.length);
      const chats = await wa()('listChats');
      const targets = ids.map((id) => chats.find((c) => c.id === id)).filter(Boolean);
      const blocked = targets.filter((c) => !c.canSend);
      if (blocked.length) throw httpError(403, `You can't post in: ${blocked.map((c) => c.title).join(', ')}`);
      const w = wa();
      return startJob({
        kind: 'groupMsgs', label: targets.length === 1 ? `Post to ${targets[0].title}` : `Message ${targets.length} groups`,
        items: targets, action: (c) => w('sendMessage', sendTarget(c), text, media), describe: (c) => c.title,
        logFile: outFile('group_messages_log'),
      });
    }

    // ----- personal messages from CSV -----
    case 'POST /api/dms/inspect': {
      const { headers, records } = parseCsv(body.csv || '');
      return { headers, rows: records.length, phoneColumns: phoneColumns(headers, records) };
    }

    case 'POST /api/dms/plan':
    case 'POST /api/dms/run': {
      const run = route.endsWith('/run');
      const { headers, records } = parseCsv(body.csv || '');
      if (!records.length) throw httpError(400, 'No rows found in the CSV.');
      if (!headers.includes(body.phoneCol)) throw httpError(400, 'Pick the column with phone numbers.');
      const gate = await chatById(wa(), body.gateId);
      const members = await wa()('loadMembers', gate.id);
      const plan = planDms(records, body.phoneCol, members);
      const template = String(body.template || '');
      const media = body.media ? mediaFromBase64(body.media.base64, body.media.name) : null;
      if (!template.trim() && !media) throw httpError(400, 'Write a message or attach a file.');
      if (!run) {
        const previews = plan.recipients.slice(0, 3).map((r) => ({ phone: r.phone, text: fillTemplate(template, r.record) }));
        const unfilled = plan.recipients.length ? (fillTemplate(template, plan.recipients[0].record).match(/\{[^{}]+\}/g) || []) : [];
        return { headers, gate: gate.title, rows: plan.rows, count: plan.recipients.length, notMember: plan.notMember, dup: plan.dup, bad: plan.bad, previews, unfilled };
      }
      checkConfirm(body.confirm, plan.recipients.length);
      if (!plan.recipients.length) throw httpError(400, 'Nobody to message.');
      const w = wa();
      return startJob({
        kind: 'dms', label: `Personal messages (${plan.recipients.length})`, items: plan.recipients,
        action: (r) => w('sendMessage', { phone: r.phone }, fillTemplate(template, r.record), media),
        describe: (r) => r.phone, logFile: outFile('personal_messages_log'),
      });
    }

    // ----- job control -----
    case 'GET /api/job': return job ? job.snapshot() : null;
    case 'POST /api/job/pause': job && job.pause(); return job ? job.snapshot() : null;
    case 'POST /api/job/resume': job && job.resume(); return job ? job.snapshot() : null;
    case 'POST /api/job/stop': job && job.stop(); return job ? job.snapshot() : null;
    case 'GET /api/usage': return usageSummary();

    default:
      throw httpError(404, 'Not found');
  }
}

// ---------- HTTP server ----------
const INDEX = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(httpError(413, 'Upload too large (max 100 MB).')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'Bad JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    // Block DNS-rebinding and cross-site requests.
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 403, { error: 'Forbidden host' });
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'Forbidden origin' });

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
      return res.end(INDEX.replace('__TOKEN__', TOKEN));
    }

    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    const token = req.headers['x-token'] || url.searchParams.get('token');
    if (token !== TOKEN) return send(res, 401, { error: 'Missing or wrong token. Reload the page.' });

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'status', state: session.state, qr: session.qr, error: session.error })}\n\n`);
      for (const evt of recentLog) res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (job) res.write(`data: ${JSON.stringify({ type: 'job', job: job.snapshot() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (url.pathname === '/api/job/log' && req.method === 'GET') {
      if (!job || !job.logFile || !fs.existsSync(job.logFile)) return send(res, 404, { error: 'No log yet' });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.basename(job.logFile)}"` });
      return fs.createReadStream(job.logFile).pipe(res);
    }

    if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'JSON only' });
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await api(req, url, body);
    send(res, 200, result === undefined ? null : result);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`WhatsApp Manager is running at ${url}`);
  console.log('Keep this window open. Press Ctrl+C to quit.');
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
  startSession();
});

async function shutdown() {
  console.log('\nShutting down…');
  if (job && job.state === 'running') job.stop();
  try { if (session.browser) await session.browser.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
