/**
 * A conversation, and the unsent reply at the foot of it.
 *
 * Alex, 2026-09-19: "Lets merge the outbox into To Do." The Outbox page had
 * the only good rendering of a thread in the app — bubbles, oldest first, his
 * own side on the right — and the To Do pane, which is where the thread
 * actually matters, drew the same mail as a flat `<pre>` behind an `open ↗`
 * link. Rather than copy one into the other, both call this.
 *
 * Nothing here decides what is sendable. The buttons post to the same routes
 * the Outbox always used, which refuse without his signed-in identity — see
 * `outbox-mail.test.mjs`. This is the shape of the thing, not the gate.
 */
import { el } from './ui.mjs';
import { renderText, trimQuoted } from './links.mjs';
import { htmlSwitch, mayHaveHtml } from './mail-view.mjs';

const fill = (node, ...kids) => { node.textContent = ''; node.append(...kids); };

export async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

export const recipientOf = (it) =>
  it.toName || String(it.to ?? '').replace(/<.*>/, '').trim() || it.to || 'unknown';

/**
 * The thread, oldest first, so a draft reads as the next thing said.
 *
 * Fills `host` in place and returns it. Said, never silent: the question this
 * answers is whether the reply fits the conversation, and an empty box would
 * read as "nothing was said" rather than "I could not look".
 */
export async function renderThread(host, src, { limit = 8 } = {}) {
  const url = src.kind === 'mail' || src.threadId
    ? `/api/reading/body?account=${encodeURIComponent(src.account ?? 'personal')}&thread=${encodeURIComponent(src.threadId)}`
    : `/api/thread?id=${encodeURIComponent(src.chatId)}`;
  host.textContent = 'reading the thread…';
  try {
    const d = await (await fetch(url)).json();
    if (d.error) throw new Error(d.error);
    const all = d.messages ?? [];
    const msgs = all.slice(-limit);
    host.textContent = '';
    if (!msgs.length) { host.append(el('div', 'out-msg-more', 'nothing on this thread yet.')); return host; }

    /* TEXT OR AS SENT, HERE TOO. Alex, 2026-09-21: "when to-dos link to
       messages, lets offer both HTML and Text view." Mail has had the switch
       since 09-19 and the task pane had text only — backwards for the mail
       that most needs looking at properly, since an invoice, a statement or a
       proposal is often where the text/plain part is padding and four
       tracking URLs.

       TEXT IS THE DEFAULT HERE, unlike on Mail. This pane is about the debt,
       not the document: the bubbles are compact, the actions sit under them,
       and a stack of full-height frames would push Done and Later off the
       screen. It is also free — the text is in the cache, while `as sent`
       spends a Gmail call. One tap when the layout is the point. */
    const texts = el('div', 'out-thread-texts');
    const mail = (src.kind === 'mail' || src.threadId) && !src.chatId;
    let sw = null;
    if (mail && mayHaveHtml(msgs)) {
      sw = htmlSwitch({ account: src.account ?? 'personal', threadId: src.threadId, texts,
                        title: d.subject || 'message' });
      host.append(sw.bar);
    }
    if (all.length > msgs.length) {
      texts.append(el('div', 'out-msg-more', `…${all.length - msgs.length} earlier message${all.length - msgs.length === 1 ? '' : 's'} not shown`));
    }
    for (const m of msgs) {
      // `from_me` is the message extract's word; a cached mail says who it is
      // from instead, so both are asked.
      const mine = m.from_me ?? (globalThis.OWNER_EMAILS ?? []).some((a) => String(m.from ?? '').toLowerCase().includes(String(a).toLowerCase()));
      const r = el('div', 'out-msg' + (mine ? ' mine' : ''));
      const at = typeof m.at === 'number'
        ? new Date(m.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : String(m.at ?? m.date ?? '').slice(0, 24);
      const who = mine ? 'you' : (m.who || String(m.from ?? '').replace(/<.*>/, '').trim() || 'them');
      r.append(el('div', 'out-msg-who', `${who}${at ? ' · ' + at : ''}`));
      const body = el('div', 'out-msg-text');
      // Through the link renderer: a marketing mail is mostly tracking URLs,
      // and raw they are most of what you would read.
      // Without the conversation quoted underneath — it is sitting right above
      // in this view. See trimQuoted; nothing is dropped that was not a quote.
      const { text } = trimQuoted(String(m.text ?? '').trim());
      renderText(body, (text || '(no text)').slice(0, 1200));
      r.append(body);
      texts.append(r);
    }
    host.append(texts);
    // After the texts, so `as sent` renders beneath the switch and above
    // nothing — the frames are the tall thing and belong last.
    if (sw) host.append(sw.frames);
  } catch (err) {
    host.textContent = `could not read the thread: ${err?.message ?? err}`;
  }
  return host;
}

/** Send / Edit / Discard, under the draft. */
function actionsFor(it, body, { reload }) {
  const actions = el('div', 'out-actions');
  const note = el('span', 'out-note');
  const send = el('button', 'send', `Send to ${recipientOf(it)}`);
  const edit = el('button', null, 'Edit');
  const drop = el('button', null, 'Discard');
  for (const b of [send, edit, drop]) b.type = 'button';
  const busy = (on) => { send.disabled = edit.disabled = drop.disabled = on; };
  const fail = (what, err) => { note.textContent = `could not ${what}: ${err.message}`; note.classList.add('err'); busy(false); };

  if (it.kind === 'mail' && it.canSend === false) { send.disabled = true; note.textContent = 'this account cannot send from here'; }
  // The event itself is edited in Calendar, where the whole of it is visible.
  if (it.kind === 'invite') edit.remove();

  send.onclick = async () => {
    busy(true); note.classList.remove('err'); note.textContent = 'sending…';
    try {
      if (it.kind === 'mail') { await post('/api/outbox/mail/send', { account: it.account, id: it.id, text: it.text }); note.textContent = 'sent'; }
      else if (it.kind === 'invite') {
        const r = await post('/api/outbox/invite/send', { id: it.id });
        note.textContent = r?.conference ? 'invited — the meeting link is on the event' : 'invited';
      } else { await post('/api/outbox/status', { id: it.id, status: 'approved' }); note.textContent = 'approved — the Mac sends it within a minute'; }
      window.outboxCount?.();
      fill(actions, note);
      setTimeout(() => reload(), 1500);
    } catch (err) { fail('send', err); }
  };
  drop.onclick = async () => {
    busy(true); note.classList.remove('err'); note.textContent = 'discarding…';
    try {
      if (it.kind === 'mail') await post('/api/outbox/mail/discard', { account: it.account, id: it.id });
      else await post('/api/outbox/status', { id: it.id, status: 'discarded' });
      note.textContent = 'discarded'; fill(actions, note); window.outboxCount?.();
      setTimeout(() => reload(), 1200);
    } catch (err) { fail('discard', err); }
  };
  edit.onclick = () => {
    const ta = el('textarea', 'card-edit');
    ta.value = it.text || '';
    body.replaceWith(ta);
    const save = el('button', 'send', 'Save'), cancel = el('button', null, 'Cancel');
    save.type = cancel.type = 'button';
    fill(actions, save, cancel, note);
    cancel.onclick = () => { ta.replaceWith(body); fill(actions, send, edit, drop, note); };
    save.onclick = async () => {
      save.disabled = cancel.disabled = true; note.classList.remove('err'); note.textContent = 'saving…';
      try {
        if (it.kind === 'mail') await post('/api/outbox/mail/update', { account: it.account, id: it.id, text: ta.value });
        else await post('/api/outbox/text', { id: it.id, text: ta.value });
        reload();
      } catch (err) { note.textContent = `could not save: ${err.message}`; note.classList.add('err'); save.disabled = cancel.disabled = false; }
    };
    ta.focus();
  };
  actions.append(send, edit, drop, note);
  return actions;
}

/**
 * The draft itself: what it says, and what he can do about it. Drawn as the
 * last thing in a conversation, because that is what it is.
 */
export function draftFoot(it, { reload = () => {} } = {}) {
  const draft = el('div', 'out-draft');
  const label = it.status === 'draft' ? 'your reply — not sent yet' : `this ${it.status}`;
  const head = el('div', 'out-draft-label', label);
  draft.append(head);
  if (it.stale?.length) {
    const warn = el('div', 'out-stale');
    warn.append(el('span', 'out-stale-tag', it.status === 'approved' ? 'sends itself' : 'check this'));
    warn.append(el('span', 'out-stale-why', it.stale.join(' · ')));
    draft.append(warn);
  }
  const body = el('div', 'out-draft-text', it.text || '(empty)');
  draft.append(body);
  if (it.status === 'draft') draft.append(actionsFor(it, body, { reload }));
  return draft;
}

/**
 * A reply box, or the draft already waiting on this thread. Shared by the Mail
 * pane and the To Do pane — Alex, 2026-09-30: "it would be helpful if I can
 * reply inline" on a task, which had only ever pointed at the thread.
 *
 * Asks the Outbox what is pending rather than keeping its own idea of it:
 * a draft written here, by a job, or in Gmail itself all reach the same list,
 * and two views of "is there a reply waiting" is how the Outbox and To Do
 * came to disagree in the first place.
 */
export async function replyBox(host, it, { onSent = () => {}, onDrafted = null } = {}) {
  host.textContent = '';
  let existing = null;
  try {
    const d = await (await fetch('/api/outbox')).json();
    existing = (d?.mail ?? []).find((m) => m.threadId === it.threadId && m.account === it.account) ?? null;
  } catch { /* the box still works; the draft simply is not known about */ }

  if (existing) {
    host.append(el('div', 'mail-reply-head', 'Your reply — not sent yet'));
    host.append(draftFoot({ ...existing, kind: 'mail', status: 'draft' },
                          { reload: () => replyBox(host, it, { onSent, onDrafted }) }));
    return;
  }

  const form = el('form', 'replybox');
  const ta = el('textarea');
  ta.rows = 3;
  ta.placeholder = `Reply to ${it.who || 'this thread'}…`;
  const row = el('div', 'replyrow');
  const note = el('span', 'out-note');
  const save = el('button', null, 'Save draft');
  save.type = 'button';
  save.title = 'Put it in your Gmail drafts on this thread and come back to it.';
  /* Send, because he wrote it. Alex, 2026-09-19: "Gmail sending is fine if
   * it is manual, I am writing the response." The button names the recipient,
   * which is what makes a tap an approval — the same rule the Outbox's Send
   * has always followed. */
  const send = el('button', 'send', `Send to ${it.who || 'this thread'}`);
  send.type = 'submit';
  row.append(note, save, send);
  form.append(ta, row);

  const go = async (doSend) => {
    const text = ta.value.trim();
    if (!text) return;
    save.disabled = send.disabled = ta.disabled = true;
    note.classList.remove('err');
    note.textContent = doSend ? 'sending…' : 'drafting…';
    try {
      const r = await fetch('/api/mail/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: it.account, threadId: it.threadId, text, send: doSend }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? 'refused');
      window.outboxCount?.();
      if (doSend) {
        host.textContent = '';
        host.append(el('div', 'mail-reply-head', 'Sent'));
        host.append(el('div', 'mut', `To ${d.to ?? it.who}. It is in the thread in Gmail, and in the outbox record.`));
        onSent(d);
        return;
      }
      if (onDrafted) onDrafted(d); else replyBox(host, it, { onSent, onDrafted });
    } catch (err) {
      note.textContent = `could not ${doSend ? 'send' : 'draft'}: ${err?.message ?? err}`;
      note.classList.add('err');
      save.disabled = send.disabled = ta.disabled = false;
    }
  };
  form.onsubmit = (e) => { e.preventDefault(); go(true); };
  save.onclick = () => go(false);
  host.append(form);
}
