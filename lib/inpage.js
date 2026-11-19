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

  // ---------- add (EXPERIMENTAL, normal groups only) ----------
  async function addMember(id, phone) {
    const c = Chats().get(id);
    if (!c) throw new Error('Chat not found: ' + id);
    const gm = c.groupMetadata;
    if (gm.isParentGroup) throw new Error('Add people to one of the community\'s groups, not the community itself.');
    const d = digits(phone);
    const has = () => gm.participants.getModelsArray().some((p) => digits(phoneOf(p)) === d);
    if (has()) return 'already-member';
    const { createWid } = req('WAWebWidFactory');
    const { Contact } = req('WAWebCollections');
    const wid = createWid(d + '@c.us');
    const contact = Contact.gadd ? Contact.gadd(wid) : Contact.get(wid);
    if (!contact) throw new Error('Could not create contact for ' + phone);
    const res = await req('WAWebModifyParticipantsGroupAction').addParticipants(c, [contact]);
    if (await waitFor(has, 15000)) return 'added';
    let detail = '';
    try { detail = JSON.stringify(res).slice(0, 200); } catch (e) {}
    return 'not-added' + (detail ? ' ' + detail : '') + ' (they may only accept invites, or have blocked group adds)';
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

  window.__wacli = { ready, listChats, loadMembers, removeMember, addMember, setAdmin, sendMessage };
  return 'loaded';
})();
