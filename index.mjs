#!/usr/bin/env node
// WhatsApp community / group manager (interactive terminal).
// Opens WhatsApp Web in its own Chrome window (scan the QR once), then lets you
// manage members, admins and messages for your communities and groups —
// at a human pace with daily limits.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { search, select, input, confirm, checkbox, editor } from '@inquirer/prompts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'output');
const STATE_FILE = path.join(HERE, '.wa-cli-state.json');
const CONFIG_FILE = path.join(HERE, 'config.json');
const SESSION_DIR = path.join(HERE, '.wa-session');
const INPAGE = fs.readFileSync(path.join(HERE, 'lib', 'inpage.js'), 'utf8');

// ---------- settings (override any of these in config.json) ----------
const DEFAULTS = {
  countryCode: '91', // added to 10-digit numbers
  pace: {
    // members: remove / add / promote / demote
    members:   { delayMinSec: 5,  delayMaxSec: 9,  coolDownEvery: 25, coolDownSec: 90,  dailyLimit: 200 },
    // one message to many groups / communities
    groupMsgs: { delayMinSec: 10, delayMaxSec: 20, coolDownEvery: 20, coolDownSec: 120, dailyLimit: 100 },
    // personal messages to individual people
    dms:       { delayMinSec: 20, delayMaxSec: 45, coolDownEvery: 10, coolDownSec: 300, dailyLimit: 50 },
  },
};
const userCfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
const config = {
  countryCode: userCfg.countryCode || DEFAULTS.countryCode,
  pace: Object.fromEntries(Object.entries(DEFAULTS.pace).map(([k, v]) => [k, { ...v, ...((userCfg.pace || {})[k] || {}) }])),
};
const PACE_LABEL = { members: 'member changes', groupMsgs: 'group messages', dms: 'personal messages' };

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);
const col = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { daily: {} }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function usedToday(kind) { const d = loadState().daily[today()]; return (d && typeof d === 'object' ? d[kind] : 0) || 0; }
function addUsage(kind, n) {
  const s = loadState();
  const d = s.daily[today()] && typeof s.daily[today()] === 'object' ? s.daily[today()] : {};
  d[kind] = (d[kind] || 0) + n;
  s.daily[today()] = d;
  saveState(s);
}

function normalisePhone(raw, cc) {
  let d = digits(raw);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && cc) d = cc + d;
  return d;
}
const looksLikePhone = (v) => /^[+\d\s().-]+$/.test(String(v).trim()) && digits(v).length >= 10 && digits(v).length <= 15;

// Every phone-looking cell in a CSV/text file (names, IDs and headers are ignored).
function readNumbers(file) {
  const out = new Set();
  for (const cell of fs.readFileSync(file, 'utf8').split(/[\r\n,;\t]+/)) {
    const v = cell.trim().replace(/^"|"$/g, '').trim();
    if (!v || !looksLikePhone(v)) continue;
    const n = normalisePhone(v, config.countryCode);
    if (n.length >= 10 && n.length <= 15) out.add(n);
  }
  return out;
}

// Proper CSV with header row -> array of objects.
function parseCsv(text) {
  text = text.replace(/^\ufeff/, '');
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

function writeCsv(file, rows, cols) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  fs.writeFileSync(file, '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\r\n'));
  return file;
}

const cleanPath = (p) => path.resolve(p.trim().replace(/^["']|["']$/g, ''));
async function askFile(message) {
  return cleanPath(await input({ message, validate: (v) => (fs.existsSync(cleanPath(v)) ? true : 'File not found') }));
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

function loadMedia(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const size = fs.statSync(file).size;
  const isPhotoVideo = /^image\/(jpeg|png|webp)$|^video\//.test(mime);
  const limitMb = isPhotoVideo ? 16 : 64;
  if (size > limitMb * 1024 * 1024) throw new Error(`File is ${(size / 1048576).toFixed(1)} MB; this tool supports up to ${limitMb} MB for this type.`);
  return { base64: fs.readFileSync(file).toString('base64'), name: path.basename(file), mime, asDocument: !isPhotoVideo, size };
}

function findChrome() {
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

// ---------- WhatsApp Web session ----------
async function openWhatsApp() {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    userDataDir: SESSION_DIR,
    defaultViewport: null,
    protocolTimeout: 300000,
    args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });

  console.log(col.dim('Waiting for WhatsApp Web to load… (first time: scan the QR code in the Chrome window)'));
  let told = false;
  for (;;) {
    const st = await page.evaluate(() => {
      try {
        if (typeof window.require === 'function' && window.require('WAWebChatCollection').ChatCollection.getModelsArray().length) return 'ready';
      } catch (e) {}
      return document.querySelector('canvas') ? 'qr' : 'loading';
    }).catch(() => 'loading');
    if (st === 'ready') break;
    if (st === 'qr' && !told) { console.log(col.yellow('→ On your phone: WhatsApp → Linked devices → Link a device, then scan the QR code.')); told = true; }
    await sleep(1500);
  }
  await sleep(3000); // let chats finish syncing
  await page.evaluate(INPAGE);
  console.log(col.green('WhatsApp Web is ready.'));
  return { browser, page };
}

// Call a helper inside the page; re-inject if WhatsApp reloaded itself.
async function wa(page, fn, ...args) {
  const has = await page.evaluate(() => !!window.__wacli).catch(() => false);
  if (!has) await page.evaluate(INPAGE);
  return page.evaluate((f, a) => window.__wacli[f](...a), fn, args);
}

// ---------- paced runner ----------
let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(1);
  stopRequested = true;
  console.log(col.yellow('\nStopping after the current item… (press Ctrl+C again to quit now)'));
});

const DONE_RESULTS = new Set(['removed', 'added', 'promoted', 'demoted', 'sent']);

async function runPaced(kind, label, items, action, logFile, describe = (m) => `${m.phone || ''}  ${m.name || ''}`) {
  const p = config.pace[kind];
  const left = p.dailyLimit - usedToday(kind);
  if (left <= 0) { console.log(col.red(`Daily limit for ${PACE_LABEL[kind]} reached (${p.dailyLimit}). Try again tomorrow.`)); return; }
  let batch = items;
  if (items.length > left) {
    console.log(col.yellow(`Only ${left} ${PACE_LABEL[kind]} left today (limit ${p.dailyLimit}). Doing the first ${left}; run again tomorrow for the rest.`));
    batch = items.slice(0, left);
  }
  const avg = (p.delayMinSec + p.delayMaxSec) / 2 + 2;
  const mins = Math.max(1, Math.round((batch.length * avg + Math.floor(batch.length / p.coolDownEvery) * p.coolDownSec) / 60));
  console.log(col.dim(`Pace: ${p.delayMinSec}–${p.delayMaxSec}s apart, ${p.coolDownSec}s break every ${p.coolDownEvery}. About ${mins} min. Ctrl+C stops safely.`));

  const log = [];
  stopRequested = false;
  let ok = 0;
  for (let i = 0; i < batch.length; i++) {
    if (stopRequested) break;
    const m = batch[i];
    let result;
    try {
      result = await action(m);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      log.push({ time: new Date().toISOString(), target: describe(m), result: 'error: ' + msg });
      console.log(col.red(`  ✗ ${describe(m)}  ${msg}`));
      if (/rate|limit|too many|429|not-authorized|forbidden|spam|banned/i.test(msg)) console.log(col.red('  WhatsApp may be limiting you. Stop for today and try again tomorrow.'));
      break;
    }
    log.push({ time: new Date().toISOString(), target: describe(m), result });
    const done = DONE_RESULTS.has(result);
    if (done) { ok++; addUsage(kind, 1); }
    console.log(`  ${done ? col.green('✓') : col.dim('•')} ${String(i + 1).padStart(4)}/${batch.length}  ${describe(m)}  ${col.dim(result)}`);
    if (!done || i === batch.length - 1) continue;
    if (ok % p.coolDownEvery === 0) {
      console.log(col.dim(`  break: ${p.coolDownSec}s…`));
      await sleep(p.coolDownSec * 1000);
    } else {
      await sleep((p.delayMinSec + Math.random() * (p.delayMaxSec - p.delayMinSec)) * 1000);
    }
  }
  writeCsv(logFile, log, ['time', 'target', 'result']);
  console.log(col.bold(`${label}: ${ok} done, ${batch.length - log.length} not processed. Log: ${logFile}`));
}

async function confirmCount(n, what) {
  const typed = await input({ message: col.red(`Type ${n} to confirm ${what} (anything else cancels):`) });
  return typed.trim() === String(n);
}

// ---------- message composer ----------
async function composeMessage({ placeholders = [] } = {}) {
  if (placeholders.length) console.log(col.dim(`  Placeholders you can use: ${placeholders.map((h) => `{${h}}`).join('  ')}`));
  const how = await select({
    message: 'Message text:',
    choices: [
      { name: 'Type it here (one line; use \\n for a new line)', value: 'line' },
      { name: 'Write it in an editor (multi-line)', value: 'editor' },
      { name: 'Load it from a .txt file', value: 'file' },
      { name: 'No text (attachment only)', value: 'none' },
    ],
  });
  let text = '';
  if (how === 'line') text = (await input({ message: 'Text:' })).replace(/\\n/g, '\n');
  if (how === 'editor') text = (await editor({ message: 'Opening your editor — write the message, save and close.' })).trim();
  if (how === 'file') text = fs.readFileSync(await askFile('Path to .txt file:'), 'utf8').trim();

  let media = null;
  if (await confirm({ message: 'Attach a file (image, video, PDF, document)?', default: false })) {
    const f = await askFile('Path to file:');
    media = loadMedia(f);
    console.log(col.dim(`  Attaching ${media.name} (${(media.size / 1048576).toFixed(2)} MB) as ${media.asDocument ? 'document' : 'photo/video'}.`));
  }
  if (!text && !media) throw new Error('Nothing to send.');
  return { text, media };
}

function fillTemplate(text, record) {
  return text.replace(/\{([^{}]+)\}/g, (all, key) => {
    const k = Object.keys(record).find((h) => h.toLowerCase() === key.trim().toLowerCase());
    return k !== undefined ? record[k] : all;
  });
}

function preview(title, text, media) {
  console.log(col.cyan(`  ┌─ ${title}`));
  for (const line of (text || col.dim('(no text)')).split('\n')) console.log(col.cyan('  │ ') + line);
  if (media) console.log(col.cyan('  │ ') + col.dim(`📎 ${media.name}`));
  console.log(col.cyan('  └─'));
}

// ---------- picking chats ----------
const kindLabel = (k) => (k === 'community' ? '[community]' : '[group]    ');
const roleLabel = (r) => (r === 'member' ? '' : col.dim(` · ${r}`));

async function pickChat(chats, message = 'Search community or group:') {
  return search({
    message,
    pageSize: 15,
    source: async (term) => {
      const t = (term || '').toLowerCase();
      return chats
        .filter((x) => !t || x.title.toLowerCase().includes(t) || x.parentTitle.toLowerCase().includes(t))
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((x) => ({ name: `${kindLabel(x.kind)} ${x.title}${roleLabel(x.myRole)}${x.parentTitle ? col.dim('  (in ' + x.parentTitle + ')') : ''}`, value: x }));
    },
  });
}

// ---------- flows ----------
async function memberMenu(page, chat) {
  const base = path.join(OUT_DIR, safeName(chat.title));
  for (;;) {
    console.log(col.dim('Loading members…'));
    const members = await wa(page, 'loadMembers', chat.id);
    const admins = members.filter((m) => m.role);
    const hidden = members.filter((m) => !m.role && !m.phone);
    console.log(col.bold(`\n${chat.title}`) + col.dim(`  (${chat.kind}, you are ${chat.myRole})`));
    console.log(`  Members: ${members.length}   Admins/owner: ${admins.length}${hidden.length ? `   Hidden numbers: ${hidden.length}` : ''}`);
    console.log(col.dim(`  Used today: ${usedToday('members')}/${config.pace.members.dailyLimit} member changes, ${usedToday('groupMsgs')}/${config.pace.groupMsgs.dailyLimit} group messages`));

    const isAdmin = chat.myRole !== 'member';
    const choices = [
      { name: 'Export members to CSV', value: 'export' },
      { name: 'Compare with a keep list (preview only)', value: 'compare' },
    ];
    if (isAdmin) {
      choices.push(
        { name: 'Remove everyone NOT on a keep list', value: 'removeNotKeep' },
        { name: 'Remove the numbers listed in a file', value: 'removeList' },
        { name: 'Make admins: numbers in a file', value: 'promote' },
        { name: 'Remove admin rights: numbers in a file', value: 'demote' },
      );
      if (chat.kind === 'group') choices.push({ name: 'Add numbers from a file (experimental)', value: 'add' });
    }
    if (chat.canSend) choices.push({ name: chat.kind === 'community' ? 'Send a message to its Announcements' : 'Send a message to this group', value: 'send' });
    choices.push({ name: '← Back', value: 'back' });

    const action = await select({ message: 'What do you want to do?', choices, pageSize: 12 });
    if (action === 'back') return;

    if (action === 'export') {
      const f = writeCsv(`${base}_members_${stamp()}.csv`, members, ['phone', 'name', 'role']);
      console.log(col.green(`Saved ${members.length} members → ${f}`));
    }

    if (action === 'compare' || action === 'removeNotKeep') {
      const keep = readNumbers(await askFile('Keep-list file (CSV or text):'));
      const normal = members.filter((m) => !m.role && m.phone);
      const kept = normal.filter((m) => keep.has(digits(m.phone)));
      const remove = normal.filter((m) => !keep.has(digits(m.phone)));
      const memberSet = new Set(members.map((m) => digits(m.phone)));
      const missing = [...keep].filter((n) => !memberSet.has(n)).map((n) => ({ phone: '+' + n }));
      const fRemove = writeCsv(`${base}_to_remove_${stamp()}.csv`, remove, ['phone', 'name']);
      const fMissing = writeCsv(`${base}_not_in_chat_${stamp()}.csv`, missing, ['phone']);
      console.log(`  Keep-list numbers: ${keep.size}`);
      console.log(`  Members on keep list: ${col.green(kept.length)}`);
      console.log(`  Members NOT on keep list: ${col.red(remove.length)}  → ${fRemove}`);
      console.log(`  Keep-list numbers not in this ${chat.kind}: ${missing.length}  → ${fMissing}`);
      console.log(col.dim('  Admins/owner and members with hidden numbers are never removed.'));
      if (action === 'removeNotKeep' && remove.length) {
        if (await confirmCount(remove.length, `removing ${remove.length} members from "${chat.title}"`)) {
          await runPaced('members', 'Removal', remove, (m) => wa(page, 'removeMember', chat.id, m.key, m.phone, m.name), `${base}_removal_log_${stamp()}.csv`);
        } else console.log('Cancelled.');
      }
    }

    if (action === 'removeList' || action === 'promote' || action === 'demote') {
      const wanted = readNumbers(await askFile('File with the numbers:'));
      const matched = members.filter((m) => m.phone && wanted.has(digits(m.phone)));
      const targets = action === 'removeList' ? matched.filter((m) => !m.role)
        : action === 'promote' ? matched.filter((m) => !m.role)
        : matched.filter((m) => m.role === 'admin');
      const notFound = [...wanted].filter((n) => !members.some((m) => digits(m.phone) === n));
      const verb = action === 'removeList' ? 'removing' : action === 'promote' ? 'making admin' : 'removing admin rights from';
      console.log(`  Numbers in file: ${wanted.size}   Will change: ${col.yellow(targets.length)}   Not in this ${chat.kind}: ${notFound.length}`);
      if (action !== 'removeList') console.log(col.yellow('  Admin changes have not been tested on a live group yet — try one number first.'));
      if (targets.length && (await confirmCount(targets.length, `${verb} ${targets.length} members in "${chat.title}"`))) {
        const fn = action === 'removeList'
          ? (m) => wa(page, 'removeMember', chat.id, m.key, m.phone, m.name)
          : (m) => wa(page, 'setAdmin', chat.id, m.key, action === 'promote');
        await runPaced('members', action === 'removeList' ? 'Removal' : 'Admin change', targets, fn, `${base}_${action}_log_${stamp()}.csv`);
      } else if (targets.length) console.log('Cancelled.');
    }

    if (action === 'add') {
      console.log(col.yellow('  Experimental: test with 1–2 numbers first. Only add people who know you; people who only accept invites will not be added.'));
      const wanted = [...readNumbers(await askFile('File with numbers to add:'))];
      const present = new Set(members.map((m) => digits(m.phone)));
      const toAdd = wanted.filter((n) => !present.has(n)).map((n) => ({ phone: '+' + n }));
      console.log(`  Numbers in file: ${wanted.length}   Already members: ${wanted.length - toAdd.length}   To add: ${col.green(toAdd.length)}`);
      if (toAdd.length && (await confirmCount(toAdd.length, `adding ${toAdd.length} people to "${chat.title}"`))) {
        await runPaced('members', 'Add', toAdd, (m) => wa(page, 'addMember', chat.id, m.phone), `${base}_add_log_${stamp()}.csv`);
      } else if (toAdd.length) console.log('Cancelled.');
    }

    if (action === 'send') {
      const { text, media } = await composeMessage();
      preview(chat.title, text, media);
      if (await confirm({ message: `Send this to "${chat.title}"?`, default: false })) {
        const target = { chatId: chat.kind === 'community' ? chat.announceId : chat.id };
        await runPaced('groupMsgs', 'Send', [{ name: chat.title }], () => wa(page, 'sendMessage', target, text, media), `${base}_send_log_${stamp()}.csv`, (m) => m.name);
      }
    }
  }
}

async function broadcastToGroups(page) {
  const chats = (await wa(page, 'listChats')).filter((c) => c.canSend);
  console.log(col.dim(`  ${chats.length} groups/communities where you can post. Communities post to their Announcements.`));
  const term = (await input({ message: 'Filter by name (leave empty to list all):' })).toLowerCase();
  const pool = chats.filter((c) => !term || c.title.toLowerCase().includes(term) || c.parentTitle.toLowerCase().includes(term))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!pool.length) return console.log('Nothing matches.');
  const picked = await checkbox({
    message: 'Pick where to send (space = select, a = all, enter = done):',
    pageSize: 20,
    choices: pool.map((c) => ({ name: `${kindLabel(c.kind)} ${c.title}${c.parentTitle ? col.dim('  (in ' + c.parentTitle + ')') : ''}`, value: c })),
    validate: (v) => (v.length ? true : 'Pick at least one'),
  });
  const { text, media } = await composeMessage();
  preview(`${picked.length} chats`, text, media);
  if (!(await confirmCount(picked.length, `sending this message to ${picked.length} groups/communities`))) return console.log('Cancelled.');
  await runPaced('groupMsgs', 'Group messages', picked,
    (c) => wa(page, 'sendMessage', { chatId: c.kind === 'community' ? c.announceId : c.id }, text, media),
    path.join(OUT_DIR, `group_messages_log_${stamp()}.csv`), (c) => c.title);
}

async function personalMessages(page) {
  console.log(col.yellow('  Personal messages are the riskiest thing to automate: people who don\'t expect them report them, and reports get numbers banned.'));
  console.log(col.dim('  To keep this safe, the tool only messages people who are members of a community/group you pick.'));
  const file = await askFile('CSV with recipients (needs a header row):');
  const { headers, records } = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!records.length) return console.log('No rows found.');

  const phoneCols = headers.filter((h) => records.slice(0, 50).some((r) => looksLikePhone(r[h])));
  if (!phoneCols.length) return console.log(col.red('No column with phone numbers found.'));
  const phoneCol = phoneCols.length === 1 ? phoneCols[0]
    : await select({ message: 'Which column has the numbers to message?', choices: phoneCols.map((h) => ({ name: h, value: h })) });

  const chats = await wa(page, 'listChats');
  const gate = await pickChat(chats, 'Only message people who are members of (search):');
  console.log(col.dim('Loading members…'));
  const members = await wa(page, 'loadMembers', gate.id);
  const memberSet = new Set(members.map((m) => digits(m.phone)));

  const seen = new Set();
  const recipients = [];
  let notMember = 0, bad = 0, dup = 0;
  for (const r of records) {
    const n = normalisePhone(r[phoneCol], config.countryCode);
    if (n.length < 10) { bad++; continue; }
    if (seen.has(n)) { dup++; continue; }
    seen.add(n);
    if (!memberSet.has(n)) { notMember++; continue; }
    recipients.push({ phone: '+' + n, record: r });
  }
  console.log(`  Rows: ${records.length}   Will message: ${col.green(recipients.length)}   Not members of "${gate.title}": ${notMember}   Duplicates: ${dup}   Bad numbers: ${bad}`);
  if (!recipients.length) return;

  const { text, media } = await composeMessage({ placeholders: headers });
  for (const r of recipients.slice(0, 3)) preview(r.phone, fillTemplate(text, r.record), media);
  const unfilled = (fillTemplate(text, recipients[0].record).match(/\{[^{}]+\}/g) || []);
  if (unfilled.length) console.log(col.yellow(`  Warning: these placeholders didn't match a column: ${unfilled.join(' ')}`));
  if (!(await confirmCount(recipients.length, `sending personal messages to ${recipients.length} people`))) return console.log('Cancelled.');
  await runPaced('dms', 'Personal messages', recipients,
    (r) => wa(page, 'sendMessage', { phone: r.phone }, fillTemplate(text, r.record), media),
    path.join(OUT_DIR, `personal_messages_log_${stamp()}.csv`), (r) => r.phone);
}

async function exportAllChats(page) {
  let chats = await wa(page, 'listChats');
  const full = await confirm({ message: 'Load full member counts for communities too? (slower, read-only)', default: false });
  if (full) {
    for (const c of chats.filter((x) => x.kind === 'community')) {
      try { c.loadedMembers = (await wa(page, 'loadMembers', c.id)).length; } catch {}
      await sleep(1500);
    }
  }
  chats = chats.sort((a, b) => a.title.localeCompare(b.title));
  const f = writeCsv(path.join(OUT_DIR, `my_groups_${stamp()}.csv`), chats,
    ['title', 'kind', 'parentTitle', 'myRole', 'canSend', 'loadedMembers', 'inviteLink', 'id']);
  console.log(col.green(`Saved ${chats.length} groups/communities → ${f}`));
  if (!full) console.log(col.dim('  Community member counts are partial unless you choose to load them.'));
  console.log(col.dim('  Invite links appear only where WhatsApp already has them (open a group\'s invite link once to fill it).'));
}

async function main() {
  console.log(col.bold('WhatsApp Community & Group Manager'));
  const { browser, page } = await openWhatsApp();
  try {
    for (;;) {
      const action = await select({
        message: 'Main menu',
        choices: [
          { name: 'Manage a community or group (members, admins, post)', value: 'manage' },
          { name: 'Send one message to many groups/communities', value: 'broadcast' },
          { name: 'Send personal messages from a CSV', value: 'dms' },
          { name: 'Export all my groups & communities (CSV)', value: 'exportAll' },
          { name: 'Show today\'s usage and limits', value: 'usage' },
          { name: 'Quit', value: 'quit' },
        ],
      });
      try {
        if (action === 'quit') break;
        if (action === 'manage') await memberMenu(page, await pickChat(await wa(page, 'listChats')));
        if (action === 'broadcast') await broadcastToGroups(page);
        if (action === 'dms') await personalMessages(page);
        if (action === 'exportAll') await exportAllChats(page);
        if (action === 'usage') {
          for (const k of Object.keys(config.pace)) console.log(`  ${PACE_LABEL[k].padEnd(18)} ${usedToday(k)}/${config.pace[k].dailyLimit} today`);
        }
      } catch (e) {
        if (e && e.name === 'ExitPromptError') throw e;
        console.log(col.red('  ' + (e && e.message ? e.message : e)));
      }
    }
  } catch (e) {
    if (!(e && e.name === 'ExitPromptError')) throw e;
  } finally {
    console.log('Bye.');
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(col.red('Error: ' + (e && e.message ? e.message : e)));
  process.exit(1);
});
