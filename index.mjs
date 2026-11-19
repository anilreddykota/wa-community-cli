#!/usr/bin/env node
// WhatsApp community / group manager — interactive terminal version.
// For the browser version run:  npm run ui
import fs from 'node:fs';
import path from 'node:path';
import { search, select, input, confirm, checkbox, editor } from '@inquirer/prompts';
import {
  OUT_DIR, config, PACE_LABEL, usedToday, usageSummary, stamp, safeName, digits, numbersFromText, parseCsv,
  writeCsv, fillTemplate, mediaFromFile, planKeepList, planFromList, planAdd, phoneColumns, planDms,
  openWhatsApp, waCaller, PacedJob,
  LISTS_FILE, readLists, saveList, deleteList, renameList, resolveList,
} from './lib/engine.mjs';

const col = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const cleanPath = (p) => path.resolve(p.trim().replace(/^["']|["']$/g, ''));
async function askFile(message) {
  return cleanPath(await input({ message, validate: (v) => (fs.existsSync(cleanPath(v)) ? true : 'File not found') }));
}
const readNumbers = (file) => numbersFromText(fs.readFileSync(file, 'utf8'));
const outFile = (prefix, title) => path.join(OUT_DIR, `${title ? safeName(title) + '_' : ''}${prefix}_${stamp()}.csv`);

async function confirmCount(n, what) {
  const typed = await input({ message: col.red(`Type ${n} to confirm ${what} (anything else cancels):`) });
  return typed.trim() === String(n);
}

// ---------- paced runs with Ctrl+C to stop ----------
let currentJob = null;
process.on('SIGINT', () => {
  if (currentJob && currentJob.state === 'running' && !currentJob.stopRequested) { currentJob.stop(); return; }
  process.exit(1);
});

async function runJob(opts) {
  const job = new PacedJob(opts);
  currentJob = job;
  const color = { error: col.red, warn: col.yellow, ok: col.green, info: col.dim };
  job.on('log', (t, l) => console.log((color[l] || ((s) => s))('  ' + t)));
  job.on('item', (it) => console.log(`  ${it.done ? col.green('✓') : it.result.startsWith('error') ? col.red('✗') : col.dim('•')} ${String(it.index).padStart(4)}/${it.total}  ${it.target}  ${col.dim(it.result)}`));
  console.log(col.dim('  Ctrl+C stops safely after the current item.'));
  await job.run();
  currentJob = null;
  if (opts.logFile) console.log(col.dim(`  Log: ${opts.logFile}`));
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
    media = mediaFromFile(await askFile('Path to file:'));
    console.log(col.dim(`  Attaching ${media.name} (${(media.size / 1048576).toFixed(2)} MB) as ${media.asDocument ? 'document' : 'photo/video'}.`));
  }
  if (!text && !media) throw new Error('Nothing to send.');
  return { text, media };
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
const sendTarget = (c) => ({ chatId: c.kind === 'community' ? c.announceId : c.id });

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
async function memberMenu(wa, chat) {
  for (;;) {
    console.log(col.dim('Loading members…'));
    const members = await wa('loadMembers', chat.id);
    const admins = members.filter((m) => m.role);
    const hidden = members.filter((m) => !m.role && !m.phone);
    console.log(col.bold(`\n${chat.title}`) + col.dim(`  (${chat.kind}, you are ${chat.myRole})`));
    console.log(`  Members: ${members.length}   Admins/owner: ${admins.length}${hidden.length ? `   Hidden numbers: ${hidden.length}` : ''}`);

    const isAdmin = chat.myRole !== 'member';
    const choices = [
      { name: 'Export members to CSV', value: 'export' },
      { name: 'Compare with a keep list (preview only)', value: 'compare' },
    ];
    if (isAdmin) {
      choices.push(
        { name: 'Remove everyone NOT on a keep list', value: 'keep' },
        { name: 'Remove the numbers listed in a file', value: 'removeList' },
        { name: 'Make admins: numbers in a file', value: 'promote' },
        { name: 'Remove admin rights: numbers in a file', value: 'demote' },
      );
      choices.push({ name: chat.kind === 'community' ? 'Add numbers from a file (via its Announcements group — not tested live yet)' : 'Add numbers from a file', value: 'add' });
    }
    if (chat.canSend) choices.push({ name: chat.kind === 'community' ? 'Send a message to its Announcements' : 'Send a message to this group', value: 'send' });
    choices.push({ name: '← Back', value: 'back' });

    const action = await select({ message: 'What do you want to do?', choices, pageSize: 12 });
    if (action === 'back') return;

    if (action === 'export') {
      const f = writeCsv(outFile('members', chat.title), members, ['phone', 'name', 'role']);
      console.log(col.green(`Saved ${members.length} members → ${f}`));
    }

    if (action === 'compare' || action === 'keep') {
      const keep = readNumbers(await askFile('Keep-list file (CSV or text):'));
      const plan = planKeepList(members, keep);
      const fRemove = writeCsv(outFile('to_remove', chat.title), plan.remove, ['phone', 'name']);
      const fMissing = writeCsv(outFile('not_in_chat', chat.title), plan.missing, ['phone']);
      console.log(`  Keep-list numbers: ${plan.keepCount}`);
      console.log(`  Members on keep list: ${col.green(plan.kept.length)}`);
      console.log(`  Members NOT on keep list: ${col.red(plan.remove.length)}  → ${fRemove}`);
      console.log(`  Keep-list numbers not in this ${chat.kind}: ${plan.missing.length}  → ${fMissing}`);
      console.log(col.dim('  Admins/owner and members with hidden numbers are never removed.'));
      if (action === 'keep' && plan.remove.length) {
        if (await confirmCount(plan.remove.length, `removing ${plan.remove.length} members from "${chat.title}"`)) {
          await runJob({ kind: 'members', label: 'Removal', items: plan.remove, action: (m) => wa('removeMember', chat.id, m.key, m.phone, m.name), logFile: outFile('removal_log', chat.title) });
        } else console.log('Cancelled.');
      }
    }

    if (action === 'removeList' || action === 'promote' || action === 'demote') {
      const plan = planFromList(members, readNumbers(await askFile('File with the numbers:')), action);
      const verb = action === 'removeList' ? 'removing' : action === 'promote' ? 'making admin' : 'removing admin rights from';
      console.log(`  Numbers in file: ${plan.wanted}   Will change: ${col.yellow(plan.targets.length)}   Not in this ${chat.kind}: ${plan.notFound.length}`);
      if (plan.targets.length && (await confirmCount(plan.targets.length, `${verb} ${plan.targets.length} members in "${chat.title}"`))) {
        const fn = action === 'removeList'
          ? (m) => wa('removeMember', chat.id, m.key, m.phone, m.name)
          : (m) => wa('setAdmin', chat.id, m.key, action === 'promote');
        await runJob({ kind: 'members', label: action === 'removeList' ? 'Removal' : 'Admin change', items: plan.targets, action: fn, logFile: outFile(`${action}_log`, chat.title) });
      } else if (plan.targets.length) console.log('Cancelled.');
    }

    if (action === 'add') {
      console.log(col.yellow('  Only add people who know you. People whose privacy settings block group adds will show as not-added — send them your invite link instead.'));
      if (chat.kind === 'community') console.log(col.yellow('  Communities: people are added through the Announcements group. Not tested live yet — try one number first.'));
      const plan = planAdd(members, readNumbers(await askFile('File with numbers to add:')));
      console.log(`  Numbers in file: ${plan.wanted}   Already members: ${plan.already}   To add: ${col.green(plan.toAdd.length)}`);
      if (plan.toAdd.length && (await confirmCount(plan.toAdd.length, `adding ${plan.toAdd.length} people to "${chat.title}"`))) {
        await runJob({ kind: 'members', label: 'Add', items: plan.toAdd, action: (m) => wa('addMember', chat.id, m.phone), logFile: outFile('add_log', chat.title) });
      } else if (plan.toAdd.length) console.log('Cancelled.');
    }

    if (action === 'send') {
      const { text, media } = await composeMessage();
      preview(chat.title, text, media);
      if (await confirm({ message: `Send this to "${chat.title}"?`, default: false })) {
        await runJob({ kind: 'groupMsgs', label: 'Send', items: [chat], action: (c) => wa('sendMessage', sendTarget(c), text, media), describe: (c) => c.title, logFile: outFile('send_log', chat.title) });
      }
    }
  }
}

function showResolved(r) {
  console.log(`  ${col.green(r.targets.length)} chat(s): ${r.targets.slice(0, 8).map((c) => c.title).join(', ')}${r.targets.length > 8 ? '…' : ''}`);
  for (const m of r.missing) console.log(col.yellow(`  ⚠ ${m.title} — ${m.reason}`));
}

async function pickGroupsNow(allChats) {
  const chats = allChats.filter((c) => c.canSend);
  console.log(col.dim(`  ${chats.length} groups/communities where you can post. Communities post to their Announcements.`));
  const term = (await input({ message: 'Filter by name (leave empty to list all):' })).toLowerCase();
  const pool = chats.filter((c) => !term || c.title.toLowerCase().includes(term) || c.parentTitle.toLowerCase().includes(term))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!pool.length) { console.log('Nothing matches.'); return []; }
  const picked = await checkbox({
    message: 'Pick where to send (space = select, a = all, enter = done):',
    pageSize: 20,
    choices: pool.map((c) => ({ name: `${kindLabel(c.kind)} ${c.title}${c.parentTitle ? col.dim('  (in ' + c.parentTitle + ')') : ''}`, value: c })),
    validate: (v) => (v.length ? true : 'Pick at least one'),
  });
  const name = (await input({ message: 'Save these as a list for next time? Type a name (or leave empty to skip):' })).trim();
  if (name) {
    try { saveList(name, picked); console.log(col.green(`  Saved list "${name}" (${picked.length} chats) in ${LISTS_FILE}`)); }
    catch (e) { console.log(col.red('  ' + e.message)); }
  }
  return picked;
}

async function broadcastToGroups(wa) {
  const allChats = await wa('listChats');
  const lists = readLists();
  let picked;
  if (lists.length) {
    const src = await select({
      message: 'Send to:',
      choices: [
        ...lists.map((l) => ({ name: `Saved list: ${l.name}  ${col.dim('(' + l.items.length + ' chats)')}`, value: l })),
        { name: 'Pick groups now', value: null },
      ],
    });
    if (src) {
      const r = resolveList(src, allChats);
      showResolved(r);
      if (!r.targets.length) return console.log(col.red('  Nothing in this list can be sent to right now.'));
      picked = r.targets;
    }
  }
  if (!picked) picked = await pickGroupsNow(allChats);
  if (!picked.length) return;
  const { text, media } = await composeMessage();
  preview(`${picked.length} chats`, text, media);
  if (!(await confirmCount(picked.length, `sending this message to ${picked.length} groups/communities`))) return console.log('Cancelled.');
  await runJob({ kind: 'groupMsgs', label: 'Group messages', items: picked, action: (c) => wa('sendMessage', sendTarget(c), text, media), describe: (c) => c.title, logFile: outFile('group_messages_log') });
}

async function personalMessages(wa) {
  console.log(col.yellow('  Personal messages are the riskiest thing to automate: people who don\'t expect them report them, and reports get numbers banned.'));
  console.log(col.dim('  To keep this safe, the tool only messages people who are members of a community/group you pick.'));
  const { headers, records } = parseCsv(fs.readFileSync(await askFile('CSV with recipients (needs a header row):'), 'utf8'));
  if (!records.length) return console.log('No rows found.');
  const cols = phoneColumns(headers, records);
  if (!cols.length) return console.log(col.red('No column with phone numbers found.'));
  const phoneCol = cols.length === 1 ? cols[0] : await select({ message: 'Which column has the numbers to message?', choices: cols.map((h) => ({ name: h, value: h })) });

  const gate = await pickChat(await wa('listChats'), 'Only message people who are members of (search):');
  console.log(col.dim('Loading members…'));
  const plan = planDms(records, phoneCol, await wa('loadMembers', gate.id));
  console.log(`  Rows: ${plan.rows}   Will message: ${col.green(plan.recipients.length)}   Not members of "${gate.title}": ${plan.notMember}   Duplicates: ${plan.dup}   Bad numbers: ${plan.bad}`);
  if (!plan.recipients.length) return;

  const { text, media } = await composeMessage({ placeholders: headers });
  for (const r of plan.recipients.slice(0, 3)) preview(r.phone, fillTemplate(text, r.record), media);
  const unfilled = fillTemplate(text, plan.recipients[0].record).match(/\{[^{}]+\}/g) || [];
  if (unfilled.length) console.log(col.yellow(`  Warning: these placeholders didn't match a column: ${unfilled.join(' ')}`));
  if (!(await confirmCount(plan.recipients.length, `sending personal messages to ${plan.recipients.length} people`))) return console.log('Cancelled.');
  await runJob({ kind: 'dms', label: 'Personal messages', items: plan.recipients, action: (r) => wa('sendMessage', { phone: r.phone }, fillTemplate(text, r.record), media), describe: (r) => r.phone, logFile: outFile('personal_messages_log') });
}

async function manageLists(wa) {
  for (;;) {
    const lists = readLists();
    console.log(col.dim(`  Saved in ${LISTS_FILE} — you can also edit it in Excel (columns: list, title, kind, chat_id).`));
    if (!lists.length) { console.log('  No saved lists yet. Make one from "Send one message to many groups".'); return; }
    const l = await select({
      message: 'Saved group lists:',
      choices: [...lists.map((x) => ({ name: `${x.name}  ${col.dim('(' + x.items.length + ' chats)')}`, value: x })), { name: '← Back', value: null }],
    });
    if (!l) return;
    showResolved(resolveList(l, await wa('listChats')));
    const act = await select({ message: `"${l.name}":`, choices: [{ name: 'Rename', value: 'rename' }, { name: 'Delete', value: 'delete' }, { name: '← Back', value: 'back' }] });
    try {
      if (act === 'rename') { const to = await input({ message: 'New name:', default: l.name }); renameList(l.name, to); console.log(col.green('  Renamed.')); }
      if (act === 'delete' && (await confirm({ message: `Delete "${l.name}"? (Groups themselves are not affected.)`, default: false }))) { deleteList(l.name); console.log(col.green('  Deleted.')); }
    } catch (e) { console.log(col.red('  ' + e.message)); }
  }
}

async function exportAllChats(wa) {
  let chats = await wa('listChats');
  const full = await confirm({ message: 'Load full member counts for communities too? (slower, read-only)', default: false });
  if (full) for (const c of chats.filter((x) => x.kind === 'community')) { try { c.loadedMembers = (await wa('loadMembers', c.id)).length; } catch {} }
  chats = chats.sort((a, b) => a.title.localeCompare(b.title));
  const f = writeCsv(outFile('my_groups'), chats, ['title', 'kind', 'parentTitle', 'myRole', 'canSend', 'loadedMembers', 'inviteLink', 'id']);
  console.log(col.green(`Saved ${chats.length} groups/communities → ${f}`));
  console.log(col.dim('  Invite links appear only for groups whose "Invite via link" screen you have opened once.'));
}

async function main() {
  console.log(col.bold('WhatsApp Community & Group Manager') + col.dim('   (browser version: npm run ui)'));
  console.log(col.dim('Waiting for WhatsApp Web to load…'));
  const { browser, page } = await openWhatsApp((state) => {
    if (state === 'qr') console.log(col.yellow('→ On your phone: WhatsApp → Linked devices → Link a device, then scan the QR code in the Chrome window.'));
    if (state === 'ready') console.log(col.green('WhatsApp Web is ready.'));
  });
  const wa = waCaller(page);
  try {
    for (;;) {
      const action = await select({
        message: 'Main menu',
        choices: [
          { name: 'Manage a community or group (members, admins, post)', value: 'manage' },
          { name: 'Send one message to many groups/communities (or a saved list)', value: 'broadcast' },
          { name: 'Saved group lists', value: 'lists' },
          { name: 'Send personal messages from a CSV', value: 'dms' },
          { name: 'Export all my groups & communities (CSV)', value: 'exportAll' },
          { name: 'Show today\'s usage and limits', value: 'usage' },
          { name: 'Quit', value: 'quit' },
        ],
      });
      try {
        if (action === 'quit') break;
        if (action === 'manage') await memberMenu(wa, await pickChat(await wa('listChats')));
        if (action === 'broadcast') await broadcastToGroups(wa);
        if (action === 'lists') await manageLists(wa);
        if (action === 'dms') await personalMessages(wa);
        if (action === 'exportAll') await exportAllChats(wa);
        if (action === 'usage') for (const u of Object.values(usageSummary())) console.log(`  ${u.label.padEnd(18)} ${u.used}/${u.limit} today`);
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
