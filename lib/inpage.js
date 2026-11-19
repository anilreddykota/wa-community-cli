// Runs inside web.whatsapp.com. Exposes window.__wacli for the terminal tool.
// Uses WhatsApp Web's own modules; a WhatsApp update can rename them.
(() => {
  if (window.__wacli) return 'already-loaded';

  const req = (n) => window.require(n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
  const Chats = () => req('WAWebChatCollection').ChatCollection;

  function phoneOf(p) {
    const u =
      (p.phoneNumber && p.phoneNumber.user) ||
      (p.contact && p.contact.phoneNumber && p.contact.phoneNumber.user) ||
      (p.id && p.id.server === 'c.us' ? p.id.user : '');
    return u ? '+' + u : '';
  }

  function nameOf(p) {
    const c = p.contact;
    return c ? c.name || c.pushname || c.notifyName || c.verifiedName || '' : '';
  }

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function chatInfo(c) {
    const gm = c.groupMetadata;
    const kind = gm.isParentGroup ? 'community' : gm.defaultSubgroup ? 'announcements' : 'group';
    let parentTitle = '';
    if (gm.parentGroup) {
      const p = Chats().get(gm.parentGroup.toString());
      parentTitle = p ? p.formattedTitle || p.name || '' : '';
    }
    // For a community, messages go to its Announcements group.
    let announceId = '';
    if (kind === 'community') {
      const ann = Chats().getModelsArray().find((x) => x.groupMetadata && x.groupMetadata.defaultSubgroup &&
        x.groupMetadata.parentGroup && x.groupMetadata.parentGroup.toString() === c.id.toString());
      announceId = ann ? ann.id.toString() : '';
    }
    const pc = gm.participants;
    const iAmAdmin = safe(() => pc.iAmAdmin(), false);
    const iAmOwner = safe(() => pc.iAmSuperAdmin(), false);
    const adminOnlyMessages = !!gm.announce;
    return {
      id: c.id.toString(),
      title: c.formattedTitle || c.name || c.id.toString(),
      kind,
      parentTitle,
      announceId,
      myRole: iAmOwner ? 'owner' : iAmAdmin ? 'admin' : 'member',
      canSend: kind === 'community' ? !!announceId && (iAmAdmin || iAmOwner) : !adminOnlyMessages || iAmAdmin,
      loadedMembers: pc ? pc.length : 0,
      inviteLink: gm.inviteCode ? 'https://chat.whatsapp.com/' + gm.inviteCode : '',
    };
  }

  function ready() {
    try {
      return typeof window.require === 'function' && Chats().getModelsArray().length > 0;
    } catch (e) {
      return false;
    }
  }

  function listChats() {
    return Chats()
      .getModelsArray()
      .filter((c) => c.groupMetadata && c.id.server === 'g.us')
      .map(chatInfo)
      .filter((x) => x.kind !== 'announcements');
  }

  async function loadMembers(id) {
    const c = Chats().get(id);
    if (!c) throw new Error('Chat not found: ' + id);
    if (c.groupMetadata.isParentGroup) {
      // WhatsApp keeps only part of a community in memory until asked (read-only query).
      await req('WAWebQueryAndUpdateCommunityParticipantsAction').queryAndUpdateCommunityParticipants(c.id);
    }
    return c.groupMetadata.participants.getModelsArray().map((p) => ({
      key: p.id.toString(),
      phone: phoneOf(p),
      name: nameOf(p),
      role: p.isSuperAdmin ? 'owner' : p.isAdmin ? 'admin' : '',
    }));
  }

  async function waitFor(check, ms) {
    for (let t = 0; t < ms; t += 500) {
      await sleep(500);
      if (check()) return true;
    }
    return false;
  }

  // ---------- remove ----------
  // Community: goes through WhatsApp's own "Remove from community" confirm box and
  // checks it names the expected member before pressing Remove.
  async function removeFromCommunity(c, part, expectPhone, expectName) {
    const React = req('react');
    const { ModalManager } = req('WAWebModalManager');
    const P = req('WAWebRemoveFromCommunityConfirmationPopup.react');
    const Comp = P.default || P;
    ModalManager.open(React.createElement(Comp, { contact: part.contact, parentGroupChatId: c.id }));
    await sleep(900);
    const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
    const firstLine = dlg ? dlg.innerText.split('\n')[0] : '';
    const ok =
      (expectPhone && digits(firstLine).includes(digits(expectPhone))) ||
      (expectName && firstLine.includes(expectName));
    if (!dlg || !ok) {
      try { ModalManager.close(); } catch (e) {}
      throw new Error('Confirm box did not match ' + (expectPhone || expectName) + ': "' + firstLine.slice(0, 80) + '"');
    }
    const btn = [...dlg.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Remove');
    if (!btn) {
      try { ModalManager.close(); } catch (e) {}
      throw new Error('No Remove button in confirm box');
    }
    btn.click();
  }

  async function removeMember(id, key, expectPhone, expectName) {
    const c = Chats().get(id);
    if (!c) throw new Error('Chat not found: ' + id);
    const gm = c.groupMetadata;
    const part = gm.participants.get(key);
    if (!part) return 'already-gone';
    if (part.isAdmin || part.isSuperAdmin) return 'skipped-admin';
    if (gm.isParentGroup) await removeFromCommunity(c, part, expectPhone, expectName);
    else await req('WAWebModifyParticipantsGroupAction').removeParticipants(c, [part]);
    if (await waitFor(() => !gm.participants.get(key), 30000)) return 'removed';
    throw new Error('WhatsApp did not confirm the removal within 30s');
  }

  // ---------- add ----------
  // Normal group: tested. Community: adds through its Announcements group (how WhatsApp
  // community membership works) — not yet tested live.
  async function addMember(id, phone) {
    let c = Chats().get(id);
    if (!c) throw new Error('Chat not found: ' + id);
    if (c.groupMetadata.isParentGroup) {
      const ann = Chats().getModelsArray().find((x) => x.groupMetadata && x.groupMetadata.defaultSubgroup &&
        x.groupMetadata.parentGroup && x.groupMetadata.parentGroup.toString() === c.id.toString());
      if (!ann) throw new Error('This community has no Announcements group loaded — open it once in WhatsApp and try again.');
      c = ann;
    }
    const gm = c.groupMetadata;
    // Whole-job problem: stop instead of failing every number the same way.
    const membersMayAdd = /all/i.test(String(gm.memberAddMode || '')); // group setting "all members can add"
    if (!safe(() => gm.participants.iAmAdmin(), true) && !membersMayAdd) {
      throw new Error('You are not an admin of "' + (c.formattedTitle || 'this group') + '" in the WhatsApp account linked to this tool, so WhatsApp won\'t let you add people. Ask an admin to make you admin, or check you linked the right phone.');
    }
    const d = digits(phone);
    const has = () => gm.participants.getModelsArray().some((p) => digits(phoneOf(p)) === d);
    if (has()) return 'already-member';
    const { createWid } = req('WAWebWidFactory');
    const { Contact } = req('WAWebCollections');
    const wid = createWid(d + '@c.us');

    // Groups now track people by WhatsApp's private ID. If WhatsApp doesn't know this
    // number's ID yet, look the number up first (the same lookup as starting a chat).
    const lidKnown = () => safe(() => !!req('WAWebApiContact').getCurrentLid(wid), true);
    if (!lidKnown()) {
      try { await req('WAWebFindChatAction').findOrCreateLatestChat(wid); }
      catch (e) { return 'not-added: ' + addReason(e, 'this number doesn\'t seem to be on WhatsApp'); }
      if (!lidKnown()) return 'not-added: WhatsApp couldn\'t find this number — check it is correct and on WhatsApp';
    }
    const contact = Contact.gadd ? Contact.gadd(wid) : Contact.get(wid);
    if (!contact) return 'not-added: WhatsApp couldn\'t find this number';

    let res;
    try {
      res = await req('WAWebModifyParticipantsGroupAction').addParticipants(c, [contact]);
    } catch (e) {
      const why = addReason(e);
      if (/rate limit|too many/i.test(why)) throw new Error(why); // stop the whole run
      if (/already a member/i.test(why)) return 'already-member';
      return 'not-added: ' + why;
    }
    if (await waitFor(has, 15000)) return 'added';
    const code = statusOf(res);
    return 'not-added: ' + (code ? reasonForCode(code) : 'their privacy settings may block being added — send them your invite link instead');
  }

  // ---------- understanding WhatsApp's errors ----------
  // WhatsApp throws minified error objects (shown as just "t"); the useful part is the status code.
  function statusOf(x) {
    if (x == null) return null;
    if (typeof x === 'number') return x;
    if (typeof x !== 'object') { const m = String(x).match(/\b(40[0-9]|42[0-9]|50[0-9])\b/); return m ? +m[1] : null; }
    for (const k of ['status', 'statusCode', 'code', 'errorCode', 'error']) {
      const v = x[k];
      if (typeof v === 'number' && v >= 100 && v < 600) return v;
      if (typeof v === 'string' && /^\d{3}$/.test(v)) return +v;
    }
    try { const m = JSON.stringify(x).match(/"(?:code|status|error)"\s*:\s*"?(\d{3})"?/); if (m) return +m[1]; } catch (e) {}
    return null;
  }
  function reasonForCode(code) {
    return ({
      400: 'WhatsApp rejected the request (400)',
      401: 'they blocked you, or you blocked them (401)',
      403: 'their privacy settings only allow invites, or you are not allowed to add people here — send them your invite link instead (403)',
      404: 'this number isn\'t on WhatsApp (404)',
      406: 'this number can\'t be added to groups (406)',
      408: 'they left this group recently, so they can only rejoin with an invite link (408)',
      409: 'already a member (409)',
      419: 'the group is full (419)',
      429: 'WhatsApp rate limit — stop for today and try again tomorrow (429)',
      500: 'WhatsApp server error — try again later (500)',
    })[code] || 'WhatsApp refused (code ' + code + ')';
  }
  function addReason(e, fallback) {
    const code = statusOf(e);
    if (code) return reasonForCode(code);
    const text = explain(e);
    if (/^WhatsApp gave no reason/.test(text)) return fallback || 'WhatsApp refused without giving a reason — usually their privacy settings, or they left the group recently. Send them your invite link instead';
    return text;
  }
  // A readable description of anything thrown inside WhatsApp Web.
  function explain(e) {
    if (e == null) return 'unknown error';
    if (typeof e !== 'object') return String(e);
    const msg = typeof e.message === 'string' ? e.message.trim() : '';
    const code = statusOf(e);
    if (msg.length > 3) return msg + (code && !msg.includes(String(code)) ? ' (' + code + ')' : '');
    if (code) return reasonForCode(code);
    const name = (e.constructor && e.constructor.name) || e.name || 'Error';
    let fields = '';
    try { fields = JSON.stringify(e, Object.getOwnPropertyNames(e).filter((k) => k !== 'stack')).slice(0, 160); } catch (x) {}
    return 'WhatsApp gave no reason (internal error "' + name + '"' + (fields && fields !== '{}' ? ' ' + fields : '') + ')';
  }

  // ---------- promote / demote (UNTESTED on a live group) ----------
  async function setAdmin(id, key, makeAdmin) {
    const c = Chats().get(id);
    if (!c) throw new Error('Chat not found: ' + id);
    const gm = c.groupMetadata;
    const part = gm.participants.get(key);
    if (!part) return 'not-a-member';
    if (part.isSuperAdmin) return 'skipped-owner';
    if (!!part.isAdmin === makeAdmin) return makeAdmin ? 'already-admin' : 'already-not-admin';
    const m = req('WAWebModifyParticipantsGroupAction');
    const fn = gm.isParentGroup
      ? makeAdmin ? m.promoteCommunityParticipants : m.demoteCommunityParticipants
      : makeAdmin ? m.promoteParticipants : m.demoteParticipants;
    await fn(c, [part]);
    const ok = await waitFor(() => { const p = gm.participants.get(key); return p && !!p.isAdmin === makeAdmin; }, 20000);
    if (ok) return makeAdmin ? 'promoted' : 'demoted';
    throw new Error('WhatsApp did not confirm the admin change within 20s');
  }

  // ---------- send messages ----------
  async function chatForTarget(target) {
    if (target.chatId) {
      const c = Chats().get(target.chatId);
      if (!c) throw new Error('Chat not found: ' + target.chatId);
      return c;
    }
    const { createWid } = req('WAWebWidFactory');
    const { findOrCreateLatestChat } = req('WAWebFindChatAction');
    const r = await findOrCreateLatestChat(createWid(digits(target.phone) + '@c.us'));
    const c = r && r.chat ? r.chat : r;
    if (!c) throw new Error('Could not open a chat with ' + target.phone);
    return c;
  }

  function b64ToFile(media) {
    const bin = atob(media.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], media.name, { type: media.mime, lastModified: Date.now() });
  }

  // target: { chatId } or { phone }; media: { base64, name, mime, asDocument } or null
  async function sendMessage(target, text, media) {
    const chat = await chatForTarget(target);
    let res;
    if (media) {
      const OpaqueData = req('WAWebMediaOpaqueData');
      const { prepRawMedia } = req('WAWebPrepRawMedia');
      const file = b64ToFile(media);
      const od = await OpaqueData.createFromData(file, file.type);
      const prep = prepRawMedia(od, media.asDocument ? { asDocument: true } : {});
      await prep.waitForPrep();
      res = await prep.sendToChat({ chat, options: text ? { caption: text } : {} });
    } else {
      res = await req('WAWebSendTextMsgChatAction').sendTextMsgToChat(chat, text);
    }
    const result = res && res.messageSendResult;
    if (result !== 'OK') throw new Error('WhatsApp did not accept the message (' + (result || 'no result') + ')');
    return 'sent';
  }

  // Every action reports a readable message instead of WhatsApp's minified errors (e.g. just "t").
  const readable = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (e) { throw new Error(e instanceof Error && e.message && e.message.length > 3 ? e.message : explain(e)); }
  };
  window.__wacli = {
    ready, listChats,
    loadMembers: readable(loadMembers), removeMember: readable(removeMember), addMember: readable(addMember),
    setAdmin: readable(setAdmin), sendMessage: readable(sendMessage),
    _explain: explain, _reasonForCode: reasonForCode, // used by self-tests
  };
  return 'loaded';
})();
