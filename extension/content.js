// WhatsApp Community Cleaner
// Runs inside web.whatsapp.com (MAIN world) so it can use WhatsApp Web's own modules.
// Removal goes through WhatsApp's own "Remove from community" confirm box, one member at a time.
(() => {
  if (window.__wccLoaded) return;
  window.__wccLoaded = true;

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
  const req = (name) => window.require(name);

  function waReady() {
    try {
      return typeof window.require === 'function' &&
        req('WAWebChatCollection').ChatCollection.getModelsArray().length > 0;
    } catch (e) {
      return false;
    }
  }

  function listCommunities() {
    const { ChatCollection } = req('WAWebChatCollection');
    return ChatCollection.getModelsArray()
      .filter((c) => c.groupMetadata && c.groupMetadata.isParentGroup)
      .map((c) => ({
        id: c.id.toString(),
        title: c.formattedTitle || c.name || c.id.toString(),
        count: c.groupMetadata.participants ? c.groupMetadata.participants.length : 0,
        chat: c,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  function phoneOf(p) {
    const u =
      (p.phoneNumber && p.phoneNumber.user) ||
      (p.contact && p.contact.phoneNumber && p.contact.phoneNumber.user) ||
      (p.id && p.id.server === 'c.us' ? p.id.user : '');
    return u ? '+' + u : '';
  }

  function nameOf(p) {
    const c = p.contact;
    if (!c) return '';
    return c.name || c.pushname || c.notifyName || c.verifiedName || '';
  }

  // WhatsApp Web keeps only a few community members in memory until asked;
  // this asks WhatsApp for the full list (read-only) before we use it.
  async function loadFullMemberList(chat) {
    try {
      const m = req('WAWebQueryAndUpdateCommunityParticipantsAction');
      await m.queryAndUpdateCommunityParticipants(chat.id);
    } catch (e) {
      log('Could not refresh member list (' + (e && e.message ? e.message : e) + ') — using what is loaded.');
    }
    return getMembers(chat);
  }

  function getMembers(chat) {
    return chat.groupMetadata.participants.getModelsArray().map((p) => ({
      phone: phoneOf(p),
      name: nameOf(p),
      role: p.isSuperAdmin ? 'Owner' : p.isAdmin ? 'Admin' : '',
      isAdmin: !!(p.isAdmin || p.isSuperAdmin),
      wid: p.id,
    }));
  }

  // Normalise a phone-like string to international digits (no +).
  function normalisePhone(raw, cc) {
    let d = digits(raw);
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10 && cc) d = cc + d;
    return d;
  }

  // Pull every phone-looking value out of CSV / pasted text.
  function parseKeepList(text, cc) {
    const out = new Set();
    const cells = String(text)
      .split(/[\r\n,;\t]+/)
      .map((s) => s.trim().replace(/^"|"$/g, '').trim())
      .filter(Boolean);
    for (const cell of cells) {
      if (!/^[+\d\s().-]+$/.test(cell)) continue; // skip names, IDs with letters, headers
      const n = normalisePhone(cell, cc);
      if (n.length >= 10 && n.length <= 15) out.add(n);
    }
    return out;
  }

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(filename, rows, header) {
    const lines = [header.join(',')].concat(rows.map((r) => header.map((h) => csvEscape(r[h])).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  // ---------- removal (uses WhatsApp's own confirm box) ----------
  async function removeOne(parentChat, m) {
    const part = parentChat.groupMetadata.participants.get(m.wid);
    if (!part) return 'already-gone';
    if (part.isAdmin || part.isSuperAdmin) return 'skipped-admin';

    const React = req('react');
    const { ModalManager } = req('WAWebModalManager');
    const P = req('WAWebRemoveFromCommunityConfirmationPopup.react');
    const Comp = P.default || P;

    ModalManager.open(React.createElement(Comp, { contact: part.contact, parentGroupChatId: parentChat.id }));
    await sleep(900);

    const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
    const firstLine = dlg ? dlg.innerText.split('\n')[0] : '';
    const numberOk = m.phone && digits(firstLine).includes(digits(m.phone));
    const nameOk = m.name && firstLine.includes(m.name);
    if (!dlg || !(numberOk || nameOk)) {
      try { ModalManager.close(); } catch (e) {}
      throw new Error('Confirm box did not match ' + (m.phone || m.name) + ' (it said: ' + firstLine.slice(0, 80) + ')');
    }
    const btn = [...dlg.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Remove');
    if (!btn) {
      try { ModalManager.close(); } catch (e) {}
      throw new Error('No Remove button in confirm box for ' + m.phone);
    }
    btn.click();

    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (!parentChat.groupMetadata.participants.get(m.wid)) return 'removed';
    }
    throw new Error('WhatsApp did not confirm removal of ' + m.phone + ' within 30s');
  }

  // ---------- UI ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Segoe UI, Roboto, Arial, sans-serif; }
    .fab { background:#25d366; color:#fff; border:none; border-radius:24px; padding:10px 16px; font-size:14px; font-weight:600; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.3); }
    .panel { display:none; width:380px; max-height:80vh; overflow:auto; background:#1f2c34; color:#e9edef; border-radius:12px; padding:14px; box-shadow:0 4px 20px rgba(0,0,0,.5); font-size:13px; margin-bottom:10px; }
    .panel.open { display:block; }
    h3 { margin:0 0 10px; font-size:15px; display:flex; justify-content:space-between; align-items:center; }
    label { display:block; margin:10px 0 4px; color:#8696a0; font-size:12px; }
    select, input[type=text], input[type=number], textarea { width:100%; background:#2a3942; color:#e9edef; border:1px solid #3b4a54; border-radius:6px; padding:6px 8px; font-size:13px; }
    textarea { height:70px; resize:vertical; }
    .row { display:flex; gap:6px; align-items:center; }
    .row > * { flex:1; }
    button.b { background:#2a3942; color:#e9edef; border:1px solid #3b4a54; border-radius:6px; padding:7px 10px; font-size:13px; cursor:pointer; margin-top:8px; width:100%; }
    button.b:hover { background:#34454f; }
    button.primary { background:#00a884; border-color:#00a884; color:#fff; }
    button.danger { background:#c0392b; border-color:#c0392b; color:#fff; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .stats { background:#111b21; border-radius:8px; padding:8px 10px; margin-top:10px; line-height:1.7; }
    .stats b { color:#fff; }
    .log { background:#111b21; border-radius:8px; padding:6px 8px; margin-top:8px; height:110px; overflow:auto; font-family:Consolas, monospace; font-size:11px; white-space:pre-wrap; }
    .bar { height:6px; background:#111b21; border-radius:3px; margin-top:8px; overflow:hidden; }
    .bar > div { height:100%; width:0; background:#00a884; transition:width .3s; }
    .x { background:none; border:none; color:#8696a0; font-size:18px; cursor:pointer; }
    .hint { color:#8696a0; font-size:11px; margin-top:4px; }
  </style>
  <div class="panel" id="panel">
    <h3>Community Cleaner <button class="x" id="close">×</button></h3>

    <label>Community</label>
    <div class="row"><select id="community"></select><button class="b" id="refresh" style="flex:0 0 70px;margin-top:0">Reload</button></div>
    <button class="b" id="export">Export all members (CSV)</button>

    <label>Keep list — CSV file and/or pasted numbers</label>
    <input type="file" id="file" accept=".csv,.txt">
    <textarea id="paste" placeholder="Paste numbers here, one per line (optional)"></textarea>
    <div class="row">
      <div><label>Default country code</label><input type="text" id="cc" value="91"></div>
      <div><label>Delay min (s)</label><input type="number" id="dmin" value="4" min="1"></div>
      <div><label>Delay max (s)</label><input type="number" id="dmax" value="7" min="1"></div>
    </div>
    <div class="hint">10-digit numbers get the country code added. Admins and the owner are never removed.</div>
    <button class="b primary" id="compare">Compare</button>

    <div class="stats" id="stats" style="display:none"></div>
    <div class="row">
      <button class="b" id="dlRemove" disabled>Download remove list</button>
      <button class="b" id="dlMissing" disabled>Download not-in-community</button>
    </div>
    <button class="b danger" id="start" disabled>Remove members</button>
    <div class="row">
      <button class="b" id="pause" disabled>Pause</button>
      <button class="b" id="stop" disabled>Stop</button>
    </div>
    <div class="bar"><div id="prog"></div></div>
    <div class="log" id="log"></div>
    <button class="b" id="dlLog" disabled>Download removal log</button>
  </div>
  <button class="fab" id="fab">Community Cleaner</button>`;

  const $ = (id) => root.getElementById(id);
  const state = { communities: [], plan: null, running: false, paused: false, stop: false, log: [] };

  function log(msg) {
    const line = new Date().toLocaleTimeString() + '  ' + msg;
    $('log').textContent += line + '\n';
    $('log').scrollTop = $('log').scrollHeight;
  }

  function currentCommunity() {
    return state.communities.find((c) => c.id === $('community').value);
  }

  function loadCommunities() {
    if (!waReady()) { log('WhatsApp is still loading — try Reload in a few seconds.'); return; }
    state.communities = listCommunities();
    const sel = $('community');
    const prev = sel.value;
    sel.innerHTML = '';
    for (const c of state.communities) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.title;
      sel.appendChild(o);
    }
    if (prev && state.communities.some((c) => c.id === prev)) sel.value = prev;
    log('Found ' + state.communities.length + ' communities.');
    resetPlan();
  }

  function resetPlan() {
    state.plan = null;
    $('stats').style.display = 'none';
    ['dlRemove', 'dlMissing', 'start'].forEach((id) => ($(id).disabled = true));
  }

  $('fab').onclick = () => {
    $('panel').classList.toggle('open');
    if ($('panel').classList.contains('open') && !state.communities.length) loadCommunities();
  };
  $('close').onclick = () => $('panel').classList.remove('open');
  $('refresh').onclick = loadCommunities;
  $('community').onchange = resetPlan;

  $('export').onclick = async () => {
    const c = currentCommunity();
    if (!c) return log('Pick a community first.');
    log('Loading full member list…');
    const rows = await loadFullMemberList(c.chat);
    download(safeName(c.title) + '_members_' + stamp() + '.csv', rows, ['phone', 'name', 'role']);
    log('Exported ' + rows.length + ' members.');
  };

  $('compare').onclick = async () => {
    const c = currentCommunity();
    if (!c) return log('Pick a community first.');
    const cc = digits($('cc').value);
    let text = $('paste').value || '';
    const f = $('file').files[0];
    if (f) text += '\n' + (await f.text());
    const keep = parseKeepList(text, cc);
    if (!keep.size) return log('Keep list is empty — add a CSV or paste numbers.');

    log('Loading full member list…');
    const members = await loadFullMemberList(c.chat);
    const memberSet = new Set(members.map((m) => digits(m.phone)));
    const admins = members.filter((m) => m.isAdmin);
    const hidden = members.filter((m) => !m.isAdmin && !m.phone); // number not visible: never auto-removed
    const kept = members.filter((m) => !m.isAdmin && m.phone && keep.has(digits(m.phone)));
    const remove = members.filter((m) => !m.isAdmin && m.phone && !keep.has(digits(m.phone)));
    const missing = [...keep].filter((n) => !memberSet.has(n)).map((n) => ({ phone: '+' + n }));

    state.plan = { community: c, remove, missing };
    $('stats').style.display = 'block';
    $('stats').innerHTML =
      'Community: <b>' + c.title + '</b><br>' +
      'Members: <b>' + members.length + '</b> &nbsp; Admins/owner (never removed): <b>' + admins.length + '</b><br>' +
      'Keep-list numbers: <b>' + keep.size + '</b><br>' +
      'Members on keep list: <b>' + kept.length + '</b><br>' +
      'Members to remove: <b style="color:#ff6b6b">' + remove.length + '</b><br>' +
      (hidden.length ? 'Members with hidden number (left alone): <b>' + hidden.length + '</b><br>' : '') +
      'Keep-list numbers not in community: <b>' + missing.length + '</b>';
    $('dlRemove').disabled = !remove.length;
    $('dlMissing').disabled = !missing.length;
    $('start').disabled = !remove.length;
    $('start').textContent = 'Remove ' + remove.length + ' members';
    log('Compared: ' + remove.length + ' to remove, ' + kept.length + ' to keep.');
  };

  $('dlRemove').onclick = () => {
    const p = state.plan; if (!p) return;
    download(safeName(p.community.title) + '_to_remove_' + stamp() + '.csv', p.remove, ['phone', 'name']);
  };
  $('dlMissing').onclick = () => {
    const p = state.plan; if (!p) return;
    download(safeName(p.community.title) + '_not_in_community_' + stamp() + '.csv', p.missing, ['phone']);
  };
  $('dlLog').onclick = () => {
    download('removal_log_' + stamp() + '.csv', state.log, ['time', 'phone', 'name', 'result']);
  };

  $('pause').onclick = () => {
    state.paused = !state.paused;
    $('pause').textContent = state.paused ? 'Resume' : 'Pause';
    log(state.paused ? 'Paused.' : 'Resumed.');
  };
  $('stop').onclick = () => { state.stop = true; log('Stopping after the current member…'); };

  $('start').onclick = async () => {
    const p = state.plan;
    if (!p || state.running) return;
    const ok = window.confirm(
      'Remove ' + p.remove.length + ' members from "' + p.community.title + '"?\n\n' +
      'This cannot be undone. Removed people would need to rejoin via invite link.'
    );
    if (!ok) return;

    const dmin = Math.max(1, Number($('dmin').value) || 4);
    const dmax = Math.max(dmin, Number($('dmax').value) || 7);
    state.running = true; state.stop = false; state.paused = false;
    ['start', 'compare', 'community', 'refresh'].forEach((id) => ($(id).disabled = true));
    ['pause', 'stop'].forEach((id) => ($(id).disabled = false));
    $('dlLog').disabled = false;

    let done = 0, removed = 0;
    const total = p.remove.length;
    log('Starting: ' + total + ' members, ' + dmin + '–' + dmax + 's apart.');

    for (const m of p.remove) {
      while (state.paused && !state.stop) await sleep(500);
      if (state.stop) break;
      let result;
      try {
        result = await removeOne(p.community.chat, m);
      } catch (e) {
        result = 'error';
        log('STOPPED: ' + e.message);
        state.log.push({ time: new Date().toISOString(), phone: m.phone, name: m.name, result: 'error: ' + e.message });
        break;
      }
      done++;
      if (result === 'removed') removed++;
      state.log.push({ time: new Date().toISOString(), phone: m.phone, name: m.name, result });
      log(result + '  ' + m.phone + (m.name ? '  ' + m.name : '') + '  (' + done + '/' + total + ')');
      $('prog').style.width = Math.round((done / total) * 100) + '%';
      if (result === 'removed') await sleep((dmin + Math.random() * (dmax - dmin)) * 1000);
    }

    log('Finished: ' + removed + ' removed, ' + (done - removed) + ' skipped/already gone, ' + (total - done) + ' not processed.');
    state.running = false;
    ['compare', 'community', 'refresh'].forEach((id) => ($(id).disabled = false));
    ['pause', 'stop'].forEach((id) => ($(id).disabled = true));
    $('pause').textContent = 'Pause';
    resetPlan();
  };
})();
