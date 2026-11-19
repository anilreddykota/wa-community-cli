// Shared engine for the terminal tool (index.mjs) and the web UI (server.mjs).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(HERE, 'output');
const STATE_FILE = path.join(HERE, '.wa-cli-state.json');
const CONFIG_FILE = path.join(HERE, 'config.json');
export const SESSION_DIR = path.join(HERE, '.wa-session');
const INPAGE = fs.readFileSync(path.join(HERE, 'lib', 'inpage.js'), 'utf8');

// ---------- settings (override any of these in config.json) ----------
const DEFAULTS = {
  countryCode: '91', // added to 10-digit numbers
  pace: {
    members:   { delayMinSec: 5,  delayMaxSec: 9,  coolDownEvery: 25, coolDownSec: 90,  dailyLimit: 200 },
    groupMsgs: { delayMinSec: 10, delayMaxSec: 20, coolDownEvery: 20, coolDownSec: 120, dailyLimit: 100 },
    dms:       { delayMinSec: 20, delayMaxSec: 45, coolDownEvery: 10, coolDownSec: 300, dailyLimit: 50 },
  },
};
const userCfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
export const config = {
  countryCode: userCfg.countryCode || DEFAULTS.countryCode,
  pace: Object.fromEntries(Object.entries(DEFAULTS.pace).map(([k, v]) => [k, { ...v, ...((userCfg.pace || {})[k] || {}) }])),
};
export const PACE_LABEL = { members: 'member changes', groupMsgs: 'group messages', dms: 'personal messages' };

// ---------- helpers ----------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
export const today = () => new Date().toISOString().slice(0, 10);
export const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
export const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { daily: {} }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
export function usedToday(kind) { const d = loadState().daily[today()]; return (d && typeof d === 'object' ? d[kind] : 0) || 0; }
export function addUsage(kind, n) {
  const s = loadState();
  const d = s.daily[today()] && typeof s.daily[today()] === 'object' ? s.daily[today()] : {};
  d[kind] = (d[kind] || 0) + n;
  s.daily[today()] = d;
  saveState(s);
}
export function usageSummary() {
  return Object.fromEntries(Object.keys(config.pace).map((k) => [k, { label: PACE_LABEL[k], used: usedToday(k), limit: config.pace[k].dailyLimit }]));
}

export function normalisePhone(raw, cc = config.countryCode) {
  let d = digits(raw);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && cc) d = cc + d;
  return d;
}
export const looksLikePhone = (v) => /^[+\d\s().-]+$/.test(String(v).trim()) && digits(v).length >= 10 && digits(v).length <= 15;

// Every phone-looking cell in CSV/text (names, IDs and headers are ignored).
export function numbersFromText(text) {
  const out = new Set();
  for (const cell of String(text).split(/[\r\n,;\t]+/)) {
    const v = cell.trim().replace(/^"|"$/g, '').trim();
    if (!v || !looksLikePhone(v)) continue;
    const n = normalisePhone(v);
    if (n.length >= 10 && n.length <= 15) out.add(n);
  }
  return out;
}

// CSV with a header row -> { headers, records }
export function parseCsv(text) {
  text = String(text).replace(/^\ufeff/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
  return { headers, records };
}

export function toCsv(rows, cols) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\r\n');
}
export function writeCsv(file, rows, cols) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toCsv(rows, cols));
  return file;
}

export function fillTemplate(text, record) {
  return String(text).replace(/\{([^{}]+)\}/g, (all, key) => {
    const k = Object.keys(record).find((h) => h.toLowerCase() === key.trim().toLowerCase());
    return k !== undefined ? record[k] : all;
  });
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// media from raw bytes (base64) + file name
export function mediaFromBase64(base64, name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const size = Math.floor((base64.length * 3) / 4);
  const isPhotoVideo = /^image\/(jpeg|png|webp)$|^video\//.test(mime);
  const limitMb = isPhotoVideo ? 16 : 64;
  if (size > limitMb * 1024 * 1024) throw new Error(`File is ${(size / 1048576).toFixed(1)} MB; up to ${limitMb} MB is supported for this type.`);
  return { base64, name: path.basename(name), mime, asDocument: !isPhotoVideo, size };
}
export function mediaFromFile(file) {
  return mediaFromBase64(fs.readFileSync(file).toString('base64'), file);
}

// ---------- saved group lists (local CSV: saved-lists.csv) ----------
// Columns: list, title, kind, chat_id. Rows typed by hand may leave chat_id empty;
// they are matched by exact group title when used.
export const LISTS_FILE = path.join(HERE, 'saved-lists.csv');
const LIST_COLS = ['list', 'title', 'kind', 'chat_id'];

function cleanListName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('Give the list a name.');
  if (n.length > 60) throw new Error('List names can be at most 60 characters.');
  return n;
}

function listsFromRecords(records) {
  const byName = new Map();
  for (const r of records) {
    const key = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase(), v]));
    const name = (key.list || '').trim();
    const title = (key.title || '').trim();
    const id = (key.chat_id || key.id || '').trim();
    if (!name || (!title && !id)) continue;
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, items: [] });
    const list = byName.get(name.toLowerCase());
    if (!list.items.some((it) => (id && it.id === id) || (!id && !it.id && it.title.toLowerCase() === title.toLowerCase()))) {
      list.items.push({ title, kind: (key.kind || '').trim(), id });
    }
  }
  return [...byName.values()];
}

export function readLists() {
  if (!fs.existsSync(LISTS_FILE)) return [];
  return listsFromRecords(parseCsv(fs.readFileSync(LISTS_FILE, 'utf8')).records);
}

function writeLists(lists) {
  const rows = lists.flatMap((l) => l.items.map((it) => ({ list: l.name, title: it.title, kind: it.kind, chat_id: it.id })));
  const tmp = LISTS_FILE + '.tmp';
  fs.writeFileSync(tmp, toCsv(rows, LIST_COLS));
  fs.renameSync(tmp, LISTS_FILE);
}

// items: [{ id, title, kind }]
export function saveList(name, items) {
  name = cleanListName(name);
  if (!items.length) throw new Error('The list is empty — select some groups first.');
  const lists = readLists().filter((l) => l.name.toLowerCase() !== name.toLowerCase());
  lists.push({ name, items: items.map((c) => ({ id: c.id || '', title: c.title || '', kind: c.kind || '' })) });
  writeLists(lists);
  return { name, count: items.length };
}

export function deleteList(name) {
  const lists = readLists();
  const left = lists.filter((l) => l.name.toLowerCase() !== String(name).toLowerCase());
  if (left.length === lists.length) throw new Error(`No list named "${name}".`);
  writeLists(left);
  return { deleted: name };
}

export function renameList(from, to) {
  to = cleanListName(to);
  const lists = readLists();
  const l = lists.find((x) => x.name.toLowerCase() === String(from).toLowerCase());
  if (!l) throw new Error(`No list named "${from}".`);
  if (lists.some((x) => x !== l && x.name.toLowerCase() === to.toLowerCase())) throw new Error(`A list named "${to}" already exists.`);
  l.name = to;
  writeLists(lists);
  return { name: to };
}

export function exportListsCsv() {
  return toCsv(readLists().flatMap((l) => l.items.map((it) => ({ list: l.name, title: it.title, kind: it.kind, chat_id: it.id }))), LIST_COLS);
}

// mode 'merge': lists in the file replace same-named lists, others are kept; 'replace': file replaces everything.
export function importListsCsv(text, mode = 'merge') {
  const { headers, records } = parseCsv(text);
  const h = headers.map((x) => x.toLowerCase());
  if (!h.includes('list') || !(h.includes('title') || h.includes('chat_id'))) {
    throw new Error('The CSV needs a "list" column and a "title" (or "chat_id") column.');
  }
  const incoming = listsFromRecords(records);
  if (!incoming.length) throw new Error('No lists found in the CSV.');
  const names = new Set(incoming.map((l) => l.name.toLowerCase()));
  const lists = mode === 'replace' ? incoming : [...readLists().filter((l) => !names.has(l.name.toLowerCase())), ...incoming];
  writeLists(lists);
  return { imported: incoming.length, total: lists.length };
}

// Match a saved list against the current chats. Returns chats to send to and items that couldn't be matched.
export function resolveList(list, chats) {
  const targets = [];
  const missing = [];
  const seen = new Set();
  for (const it of list.items) {
    let c = it.id ? chats.find((x) => x.id === it.id) : null;
    if (!c && it.title) {
      const same = chats.filter((x) => x.title.trim().toLowerCase() === it.title.toLowerCase());
      if (same.length === 1) c = same[0];
      else if (same.length > 1) { missing.push({ title: it.title, reason: `${same.length} chats have this name — add its chat_id` }); continue; }
    }
    if (!c) { missing.push({ title: it.title || it.id, reason: 'not found (left the group, renamed, or typo)' }); continue; }
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (!c.canSend) { missing.push({ title: c.title, reason: "you can't post there (admins only)" }); continue; }
    targets.push(c);
  }
  return { targets, missing };
}

// ---------- planning (pure; used by CLI and UI) ----------
export function planKeepList(members, keep) {
  const normal = members.filter((m) => !m.role && m.phone); // admins/owner and hidden numbers are never touched
  const kept = normal.filter((m) => keep.has(digits(m.phone)));
  const remove = normal.filter((m) => !keep.has(digits(m.phone)));
  const memberSet = new Set(members.map((m) => digits(m.phone)));
  const missing = [...keep].filter((n) => !memberSet.has(n)).map((n) => ({ phone: '+' + n }));
  return { keepCount: keep.size, kept, remove, missing };
}

// mode: removeList | promote | demote
export function planFromList(members, wanted, mode) {
  const matched = members.filter((m) => m.phone && wanted.has(digits(m.phone)));
  const targets = mode === 'demote' ? matched.filter((m) => m.role === 'admin') : matched.filter((m) => !m.role);
  const notFound = [...wanted].filter((n) => !members.some((m) => digits(m.phone) === n)).map((n) => ({ phone: '+' + n }));
  return { wanted: wanted.size, targets, notFound };
}

export function planAdd(members, wanted) {
  const present = new Set(members.map((m) => digits(m.phone)));
  const list = [...wanted];
  const toAdd = list.filter((n) => !present.has(n)).map((n) => ({ phone: '+' + n }));
  return { wanted: list.length, already: list.length - toAdd.length, toAdd };
}

export function phoneColumns(headers, records) {
  return headers.filter((h) => records.slice(0, 50).some((r) => looksLikePhone(r[h])));
}

export function planDms(records, phoneCol, members) {
  const memberSet = new Set(members.map((m) => digits(m.phone)));
  const seen = new Set();
  const recipients = [];
  let notMember = 0, bad = 0, dup = 0;
  for (const r of records) {
    const n = normalisePhone(r[phoneCol]);
    if (n.length < 10) { bad++; continue; }
    if (seen.has(n)) { dup++; continue; }
    seen.add(n);
    if (!memberSet.has(n)) { notMember++; continue; }
    recipients.push({ phone: '+' + n, record: r });
  }
  return { rows: records.length, recipients, notMember, dup, bad };
}

// ---------- WhatsApp Web session ----------
export function findChrome() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to your chrome.exe path.');
  return found;
}

// onStatus(state, extra): state = 'starting' | 'qr' (extra = PNG data URL or null) | 'ready'
export async function openWhatsApp(onStatus = () => {}) {
  onStatus('starting');
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: false,
      userDataDir: SESSION_DIR,
      defaultViewport: null,
      protocolTimeout: 300000,
      args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
    });
  } catch (e) {
    const profileLocked = ['lockfile', 'SingletonLock'].some((f) => fs.existsSync(path.join(SESSION_DIR, f)));
    if (/already running|lock|in use/i.test(String(e && e.message)) || profileLocked) {
      throw new Error('WhatsApp Manager is already open (web or terminal version). Close the other one first — only one can run at a time.');
    }
    throw e;
  }
  const page = (await browser.pages())[0] || (await browser.newPage());
  // Dark mode makes WhatsApp draw a light-on-dark (inverted) QR code that many
  // phones can't scan, so force the light theme in this window.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

  let lastQr = '', lastState = '';
  // One look at the page: reports 'qr' (with image), 'ready', or 'loading'.
  const tick = async () => {
    const st = await pageState(page);
    if (st === 'qr') {
      const img = await qrImage(page).catch(() => null);
      if (img && (img !== lastQr || lastState !== 'qr')) { lastQr = img; onStatus('qr', img); }
    }
    if (st === 'ready' && lastState !== 'ready') {
      await sleep(3000); // let chats finish syncing
      await page.evaluate(INPAGE);
      onStatus('ready');
    }
    if (st !== 'loading') lastState = st;
    return st;
  };
  while ((await tick()) !== 'ready') await sleep(1500);

  // Keep watching: if WhatsApp gets logged out (e.g. from the phone), show the QR again;
  // when it's linked again, carry on.
  (async () => {
    while (!page.isClosed()) {
      await sleep(4000);
      try { await tick(); } catch {}
    }
  })();
  return { browser, page };
}

async function pageState(page) {
  return page.evaluate(() => {
      try {
        if (typeof window.require === 'function' && window.require('WAWebChatCollection').ChatCollection.getModelsArray().length) return 'ready';
      } catch (e) {}
      // An expired code shows a "reload" button over it — press it to get a fresh code.
      const reload = [...document.querySelectorAll('button, [role="button"]')].find((b) => /reload|refresh/i.test(b.getAttribute('aria-label') || b.innerText || ''));
      if (reload && document.querySelector('canvas')) { reload.click(); return 'loading'; }
      return document.querySelector('canvas') ? 'qr' : 'loading';
  }).catch(() => 'loading');
}

// The QR code redrawn as pure black on white, whatever colours WhatsApp used.
async function qrImage(page) {
        return page.evaluate(() => {
          const c = document.querySelector('canvas');
          const w = c.width, h = c.height;
          const src = c.getContext('2d').getImageData(0, 0, w, h).data;
          const out = document.createElement('canvas');
          out.width = w; out.height = h;
          const g = out.getContext('2d');
          const img = g.createImageData(w, h);
          let transparent = 0, lumSum = 0, opaque = 0;
          for (let i = 0; i < src.length; i += 4) {
            if (src[i + 3] < 128) transparent++;
            else { opaque++; lumSum += 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]; }
          }
          const useAlpha = transparent > (w * h) * 0.2; // modules drawn on a transparent background
          const mid = opaque ? lumSum / opaque : 128;
          // Decide which colour is "ink": the finder pattern's outer ring, just inside the top-left corner.
          const px = Math.max(1, Math.round(w * 0.01)), py = Math.max(1, Math.round(h * 0.01));
          const probe = (py * w + px) * 4;
          const probeLum = 0.299 * src[probe] + 0.587 * src[probe + 1] + 0.114 * src[probe + 2];
          const inkIsDark = useAlpha ? true : probeLum < mid;
          for (let i = 0; i < src.length; i += 4) {
            const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
            const ink = useAlpha ? src[i + 3] >= 128 : inkIsDark ? lum < mid : lum >= mid;
            const v = ink ? 0 : 255;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
          }
          g.putImageData(img, 0, 0);
          return out.toDataURL('image/png');
        });
}

// Returns wa(fn, ...args): calls window.__wacli[fn] inside the page (re-injects if WhatsApp reloaded).
export function waCaller(page) {
  return async (fn, ...args) => {
    const has = await page.evaluate(() => !!window.__wacli).catch(() => false);
    if (!has) await page.evaluate(INPAGE);
    return page.evaluate((f, a) => window.__wacli[f](...a), fn, args);
  };
}

// ---------- paced job runner ----------
const DONE_RESULTS = new Set(['removed', 'added', 'promoted', 'demoted', 'sent']);

// Events: 'log' (text, level), 'item' ({index,total,target,result,done}), 'end' (summary)
export class PacedJob extends EventEmitter {
  constructor({ kind, label, items, action, describe, logFile }) {
    super();
    this.kind = kind; this.label = label; this.items = items; this.action = action;
    this.describe = describe || ((m) => `${m.phone || ''}  ${m.name || ''}`.trim());
    this.logFile = logFile;
    this.state = 'idle'; this.paused = false; this.stopRequested = false;
    this.done = 0; this.processed = 0; this.total = 0; this.log = []; this.startedAt = null;
  }
  pause() { if (this.state === 'running') { this.paused = true; this.emit('log', 'Paused.', 'info'); } }
  resume() { if (this.paused) { this.paused = false; this.emit('log', 'Resumed.', 'info'); } }
  stop() { this.stopRequested = true; this.paused = false; this.emit('log', 'Stopping after the current item…', 'warn'); }
  snapshot() {
    return { label: this.label, kind: this.kind, state: this.state, paused: this.paused, done: this.done,
      processed: this.processed, total: this.total, logFile: this.logFile ? path.basename(this.logFile) : null, startedAt: this.startedAt };
  }
  async wait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.stopRequested) await sleep(Math.min(500, end - Date.now()));
    while (this.paused && !this.stopRequested) await sleep(500);
  }
  async run() {
    const p = config.pace[this.kind];
    this.state = 'running'; this.startedAt = new Date().toISOString();
    const left = p.dailyLimit - usedToday(this.kind);
    if (left <= 0) {
      this.emit('log', `Daily limit for ${PACE_LABEL[this.kind]} reached (${p.dailyLimit}). Try again tomorrow.`, 'error');
      this.state = 'finished'; this.emit('end', this.snapshot()); return this.snapshot();
    }
    let batch = this.items;
    if (batch.length > left) {
      this.emit('log', `Only ${left} ${PACE_LABEL[this.kind]} left today (limit ${p.dailyLimit}). Doing the first ${left}; run again tomorrow for the rest.`, 'warn');
      batch = batch.slice(0, left);
    }
    this.total = batch.length;
    const avg = (p.delayMinSec + p.delayMaxSec) / 2 + 2;
    const mins = Math.max(1, Math.round((batch.length * avg + Math.floor(batch.length / p.coolDownEvery) * p.coolDownSec) / 60));
    this.emit('log', `${this.label}: ${batch.length} items, ${p.delayMinSec}–${p.delayMaxSec}s apart, ${p.coolDownSec}s break every ${p.coolDownEvery}. About ${mins} min.`, 'info');

    for (let i = 0; i < batch.length; i++) {
      while (this.paused && !this.stopRequested) await sleep(500);
      if (this.stopRequested) break;
      const m = batch[i];
      const target = this.describe(m);
      let result;
      try {
        result = await this.action(m);
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        this.log.push({ time: new Date().toISOString(), target, result: 'error: ' + msg });
        this.processed++;
        this.emit('item', { index: i + 1, total: batch.length, target, result: 'error: ' + msg, done: false });
        this.emit('log', `Stopped on error: ${msg}`, 'error');
        if (/rate|limit|too many|429|not-authorized|forbidden|spam|banned/i.test(msg)) this.emit('log', 'WhatsApp may be limiting you. Stop for today and try again tomorrow.', 'error');
        break;
      }
      this.processed++;
      const ok = DONE_RESULTS.has(result);
      if (ok) { this.done++; addUsage(this.kind, 1); }
      this.log.push({ time: new Date().toISOString(), target, result });
      this.emit('item', { index: i + 1, total: batch.length, target, result, done: ok });
      if (!ok || i === batch.length - 1) continue;
      if (this.done % p.coolDownEvery === 0) {
        this.emit('log', `Break: ${p.coolDownSec}s…`, 'info');
        await this.wait(p.coolDownSec * 1000);
      } else {
        await this.wait((p.delayMinSec + Math.random() * (p.delayMaxSec - p.delayMinSec)) * 1000);
      }
    }
    if (this.logFile) writeCsv(this.logFile, this.log, ['time', 'target', 'result']);
    this.state = 'finished';
    this.emit('log', `${this.label}: ${this.done} done, ${this.total - this.processed} not processed.`, this.done ? 'ok' : 'info');
    this.emit('end', this.snapshot());
    return this.snapshot();
  }
}
