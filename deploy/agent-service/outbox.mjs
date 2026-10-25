/**
 * The outbox: drafts the agent writes, that Alex approves, that the Mac sends.
 * Contract: rules/outbox.md.
 *
 * The only state transition this module performs is draft → approved (or
 * discarded), and only when called from an authenticated request. It never
 * writes `sent` — that is the Mac's word, written back after the fact, and a
 * service that could claim a message was sent would make the record worthless.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { localStamp } from './time.mjs';

const FIELDS = ['type', 'to', 'cc', 'chat_id', 'status', 'created', 'approved_at', 'sent_at', 'error',
                'subject', 'account', 'draft_id', 'message_id', 'thread_id', 'edited_at',
                // A calendar invite waiting for his tap. Alex, 2026-09-08: an
                // event with attendees mails a third party in his name, which is
                // the same shape as a text and a Gmail draft, so it belongs on
                // the same page behind the same approval rather than in a CLI
                // that only works while a chat session is open.
                'event_id', 'attendees', 'conference', 'when', 'conference_url'];
const STATUSES = ['draft', 'approved', 'sent', 'discarded', 'failed'];

function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    if (FIELDS.includes(k)) meta[k] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

export async function listOutbox(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort().reverse()) {
    try {
      const { meta, body } = parse(await readFile(join(dir, name), 'utf8'));
      out.push({
        id: name,
        // A text the Mac sends, the record of a mail the Outbox page sent, or
        // a calendar invite waiting to have its attendees added.
        kind: meta.type === 'outbox-mail' ? 'mail' : meta.type === 'outbox-invite' ? 'invite' : 'text',
        eventId: meta.event_id && meta.event_id !== '-' ? meta.event_id : null,
        // Comma-separated in the file so it stays greppable, like every other
        // field here. Empty means there is nobody to invite, which the send
        // route refuses rather than silently patching an event with nothing.
        attendees: String(meta.attendees ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        conference: String(meta.conference ?? '').trim() === 'yes',
        conferenceUrl: meta.conference_url && meta.conference_url !== '-' ? meta.conference_url : null,
        when: meta.when ?? null,
        subject: meta.subject ?? null,
        account: meta.account ?? null,
        editedAt: meta.edited_at && meta.edited_at !== '-' ? meta.edited_at : null,
        to: meta.to ?? '(missing recipient)',
        chatId: meta.chat_id && meta.chat_id !== '-' ? meta.chat_id : null,
        // A mail record carries the Gmail thread it was sent on; it was written
        // to the file since the Outbox began sending mail and never read back,
        // which is why a sent reply could not be joined to the obligation it
        // discharged. Review item 2, 2026-09-20.
        threadId: meta.thread_id && meta.thread_id !== '-' ? meta.thread_id : null,
        status: STATUSES.includes(meta.status) ? meta.status : 'draft',
        created: meta.created ?? '',
        approvedAt: meta.approved_at && meta.approved_at !== '-' ? meta.approved_at : null,
        sentAt: meta.sent_at && meta.sent_at !== '-' ? meta.sent_at : null,
        error: meta.error && meta.error !== '-' ? meta.error : null,
        text: body.trim(),
      });
    } catch {
      out.push({ id: name, kind: 'text', subject: null, account: null, editedAt: null, to: '?', status: 'failed', text: '(unreadable draft)',
                 error: 'could not parse', created: '', chatId: null,
                 eventId: null, attendees: [], conference: false, when: null,
                 approvedAt: null, sentAt: null });
    }
  }
  return out;
}

/**
 * An invite has gone out. Alex, 2026-09-08.
 *
 * The header above says this module never writes `sent`, because for a text
 * `sent` is the Mac's word and a service that could claim delivery would make
 * the record worthless. An invite is the one case where that reasoning points
 * the other way: this service made the Google Calendar call itself and holds
 * the response, so it is the only witness there is. The rule is unchanged —
 * only the party that actually delivered it may write `sent`.
 *
 * Still one direction only: draft → sent, never anything else.
 */
export async function markInviteSent(dir, id, who, result = {}) {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(id)) throw new Error('bad draft id');
  const path = join(dir, id);
  if (!resolve(path).startsWith(resolve(dir) + sep)) throw new Error('outside outbox/');
  const text = await readFile(path, 'utf8');
  const { meta } = parse(text);
  if (meta.type !== 'outbox-invite') throw new Error(`${id} is not an invite`);
  if (meta.status !== 'draft') throw new Error(`invite is already ${meta.status}`);
  const stamp = localStamp();
  let updated = text.replace(/^status:.*$/m, 'status: sent')
    .replace(/^approved_at:.*$/m, `approved_at: ${stamp}${who ? ' by ' + who : ''}`)
    .replace(/^sent_at:.*$/m, `sent_at: ${stamp}`);
  if (result.conference) {
    updated = updated.replace(/^sent_at:.*$/m, (l) => `${l}\nconference_url: ${result.conference}`);
  }
  await writeFile(path, updated);
  return { id, status: 'sent', at: stamp, conference: result.conference ?? null };
}

/**
 * Approve or discard. Only draft → approved|discarded is permitted: approving
 * something already sent, or resurrecting a discarded draft, are both ways a
 * message gets delivered that nobody meant to send.
 */
export async function setStatus(dir, id, next, who) {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(id)) throw new Error('bad draft id');
  if (!['approved', 'discarded'].includes(next)) throw new Error(`cannot set status ${next}`);

  const path = join(dir, id);
  if (!resolve(path).startsWith(resolve(dir) + sep)) throw new Error('outside outbox/');

  const text = await readFile(path, 'utf8');
  const { meta } = parse(text);
  if (meta.status !== 'draft') {
    throw new Error(`draft is already ${meta.status}; only a draft can be ${next}`);
  }

  const stamp = localStamp();
  let updated = text.replace(/^status:.*$/m, `status: ${next}`);
  if (next === 'approved') {
    // Who approved it, in the file, because "the assistant sent this" and "Alex
    // approved the assistant sending this" are different claims and the record has
    // to be able to tell them apart.
    updated = /^approved_at:/m.test(updated)
      ? updated.replace(/^approved_at:.*$/m, `approved_at: ${stamp}${who ? ' by ' + who : ''}`)
      : updated.replace(/^status:.*$/m, (l) => `${l}\napproved_at: ${stamp}${who ? ' by ' + who : ''}`);
  }
  await writeFile(path, updated);
  return { id, status: next, at: stamp };
}

/**
 * Alex rewrites the body of a draft before approving it. His words, his
 * message: the approval gate exists because the AGENT composed something, and
 * an edit by the person who will be named as sender is not what it guards.
 * Only a draft; the file records when and by whom.
 */
export async function setText(dir, id, text, who) {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(id)) throw new Error('bad draft id');
  if (!String(text ?? '').trim()) throw new Error('an empty message is a discard, not an edit');
  const path = join(dir, id);
  if (!resolve(path).startsWith(resolve(dir) + sep)) throw new Error('outside outbox/');
  const raw = await readFile(path, 'utf8');
  const { meta } = parse(raw);
  if (meta.status !== 'draft') throw new Error(`draft is already ${meta.status}; only a draft can be edited`);
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  const stamp = localStamp();
  let head = m[0];
  head = /^edited_at:/m.test(head)
    ? head.replace(/^edited_at:.*$/m, `edited_at: ${stamp}${who ? ' by ' + who : ''}`)
    : head.replace(/^status:.*$/m, (l) => `${l}\nedited_at: ${stamp}${who ? ' by ' + who : ''}`);
  await writeFile(path, head + '\n' + String(text).trim() + '\n');
  return { id, editedAt: stamp };
}

/**
 * The record of a mail the Outbox page sent. rules/outbox.md promises that what
 * went out as Alex, when, to whom, and who approved it is answerable from git
 * a year later; a Gmail draft sent from the page gets the same line in the
 * same folder as a text the Mac sent.
 */
export async function recordMailSent(dir, { to, cc, subject, account, draftId, messageId, threadId, who, text }) {
  const stamp = localStamp();
  const slug = String(subject || to || 'mail').toLowerCase().replace(/^re:\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mail';
  const name = `${stamp.slice(0, 10)}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}-mail-${slug}.md`;
  const path = join(dir, name);
  const body = [
    '---', 'type: outbox-mail', `to: ${to}`, cc ? `cc: ${cc}` : null, `subject: ${subject}`, `account: ${account}`,
    `draft_id: ${draftId}`, `message_id: ${messageId ?? '-'}`, `thread_id: ${threadId ?? '-'}`,
    'status: sent', `created: ${stamp}`, `approved_at: ${stamp}${who ? ' by ' + who : ''}`, `sent_at: ${stamp}`, 'error: -', '---',
    String(text ?? '').trim(), '',
  ].filter((l) => l !== null).join('\n');
  await writeFile(path, body, { flag: 'wx' });
  return { id: name, sentAt: stamp };
}
