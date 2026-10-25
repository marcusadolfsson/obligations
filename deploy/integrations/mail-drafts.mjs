/**
 * His Gmail Drafts, as the Outbox page sees them — and the one door that sends one.
 *
 * Alex, 2026-09-05: "build an outbox view in the assistant interface so I don't
 * need to use gmail to approve." The assistant drafts replies into Gmail
 * (mail-draft.mjs) and texts into outbox/; approving the second was a tap on
 * the chat drawer, approving the first meant opening Gmail. This lists both
 * accounts' drafts, reads the body of each, and lets the page edit, send or
 * discard one.
 *
 * Sending is the outward act, so it is fenced three ways, none of them a prompt:
 *   - sendDraft refuses without `who` — the Google identity Cloudflare Access
 *     attached to the request. A job has none; the agent's own HTTP calls have
 *     none; only a person signed in to the page does.
 *   - this file has no CLI. There is nothing to put on the allow list, and
 *     guards pin that it never appears there.
 *   - every send writes a record into outbox/ naming the recipient, the subject,
 *     the account, and who approved it — the same answerability rules/outbox.md
 *     promises for texts.
 *
 * Nothing here deletes mail. discardDraft removes a draft, which is not mail.
 */
import { accessToken } from '../mcp/google-auth.mjs';
import { header, rawMessage, isMachine, isObligationsDraft } from './mail-draft.mjs';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const PER_ACCOUNT = 25;          // drafts read per account per listing; more is a backlog, not an outbox
const TTL_MS = 60_000;

async function api(token, path, { method = 'GET', params = {}, body } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x)); else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return {};
  if (!res.ok) throw new Error(`gmail ${method} ${path} failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

const b64 = (s) => Buffer.from(String(s ?? ''), 'base64url').toString('utf8');

/** The readable text of a message payload: text/plain first, else HTML stripped. Exported for the tests. */
export function plainText(payload) {
  const parts = [];
  const walk = (p) => { if (!p) return; parts.push(p); for (const c of p.parts ?? []) walk(c); };
  walk(payload);
  const plain = parts.find((p) => /^text\/plain/i.test(p.mimeType ?? '') && p.body?.data);
  if (plain) return b64(plain.body.data).replace(/\r\n/g, '\n').trim();
  const html = parts.find((p) => /^text\/html/i.test(p.mimeType ?? '') && p.body?.data);
  return entities(html ? b64(html.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n') : '').trim();
}

/** The entities Gmail's HTML actually uses. Exported for the tests. */
export function entities(s) {
  const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

/** The files on a message: name, type, size, and the id to fetch the bytes. Exported for the tests. */
export function attachmentsOf(payload) {
  const out = [];
  const walk = (p) => { if (!p) return; if (p.filename && p.body?.attachmentId) out.push({ filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', size: p.body.size ?? null, attachmentId: p.body.attachmentId }); for (const c of p.parts ?? []) walk(c); };
  walk(payload);
  return out;
}

/** One draft, in the page's shape. Exported for the tests. */
export function shapeDraft(d, account, { canSend = false } = {}) {
  const m = d.message ?? {};
  const to = header(m, 'To');
  return {
    kind: 'mail', id: d.id, account, canSend,
    // Written here and not edited by him since — the only drafts the assistant may
    // ever remove. See isObligationsDraft in mail-draft.mjs.
    obligations: isObligationsDraft(m),
    attachments: attachmentsOf(m.payload).map(({ filename, mimeType, size }) => ({ filename, mimeType, size })),
    to, cc: header(m, 'Cc') || null, subject: header(m, 'Subject') || '(no subject)',
    threadId: m.threadId ?? null, inReplyTo: header(m, 'In-Reply-To') || null,
    text: plainText(m.payload), snippet: m.snippet ?? '',
    // Gmail's internalDate is ms since epoch, as a string.
    updatedMs: Number(m.internalDate ?? 0) || 0,
    link: `https://mail.google.com/mail/u/0/#drafts/${m.id ?? ''}`,
  };
}

const cache = new Map();     // account -> { at, drafts }
export const forget = (account) => (account ? cache.delete(account) : cache.clear());

export async function listDrafts(vault, account, { canSend = false, fresh = false } = {}) {
  const hit = cache.get(account);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.drafts;
  const token = await accessToken(vault, fetch, account);
  const list = await api(token, 'drafts', { params: { maxResults: PER_ACCOUNT } });
  const drafts = [];
  for (const d of list.drafts ?? []) {
    const full = await api(token, `drafts/${encodeURIComponent(d.id)}`, { params: { format: 'full' } });
    drafts.push(shapeDraft(full, account, { canSend }));
  }
  drafts.sort((a, b) => b.updatedMs - a.updatedMs);
  cache.set(account, { at: Date.now(), drafts });
  return drafts;
}

/** The bytes of every file already on a draft, so a rewrite keeps them. */
async function existingAttachments(token, m) {
  const out = [];
  for (const a of attachmentsOf(m.payload)) {
    const part = await api(token, `messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.attachmentId)}`);
    out.push({ filename: a.filename, mimeType: a.mimeType, data: Buffer.from(part.data ?? '', 'base64url') });
  }
  return out;
}

/**
 * Replace the body, keeping every header and every file the draft already
 * has; `add` appends files. The first version rebuilt the draft from text
 * alone and would have dropped the attachments on an edit.
 */
export async function updateDraft(vault, account, draftId, text, { add = [], to = null } = {}) {
  const token = await accessToken(vault, fetch, account);
  const cur = await api(token, `drafts/${encodeURIComponent(draftId)}`, { params: { format: 'full' } });
  const m = cur.message ?? {};
  // No text given: keep what the draft says and only touch the files.
  if (text == null) text = plainText(m.payload);
  if (!text?.trim()) throw new Error('an empty body is a discard, not an edit');
  const profile = await api(token, 'profile');
  const attachments = [...await existingAttachments(token, m), ...add];
  // `to` repoints the draft — a draft addressed to a queue moves to the
  // person — rather than leaving a second draft beside the first.
  if (to && isMachine(to)) throw new Error(`refusing to address a machine (${to})`);
  const raw = rawMessage({
    from: header(m, 'From') || profile.emailAddress, to: to || header(m, 'To'), cc: header(m, 'Cc') || null,
    subject: header(m, 'Subject'), inReplyTo: header(m, 'In-Reply-To') || null, references: header(m, 'References') || null, body: text, attachments,
  });
  if (!(to || header(m, 'To'))) throw new Error('the draft has no recipient; add one in Gmail first');
  const r = await api(token, `drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', body: { id: draftId, message: { raw, threadId: m.threadId ?? undefined } } });
  forget(account);
  return { id: r.id, threadId: r.message?.threadId ?? null, to: to || header(m, 'To'), attachments: attachments.map((a) => a.filename) };
}

/**
 * Send a draft. `who` is the signed-in identity that tapped Send — required,
 * never defaulted, so a caller without a person behind it cannot get here.
 */
export async function sendDraft(vault, account, draftId, { who } = {}) {
  if (!who || !/@/.test(String(who))) throw new Error('sending needs the signed-in identity that approved it');
  const token = await accessToken(vault, fetch, account);
  const cur = await api(token, `drafts/${encodeURIComponent(draftId)}`, { params: { format: 'metadata', metadataHeaders: ['To', 'Cc', 'Subject'] } });
  const m = cur.message ?? {};
  const to = header(m, 'To');
  if (!to) throw new Error('refusing to send a draft with no recipient');
  const sent = await api(token, 'drafts/send', { method: 'POST', body: { id: draftId } });
  forget(account);
  return { id: sent.id ?? null, threadId: sent.threadId ?? m.threadId ?? null, to, cc: header(m, 'Cc') || null, subject: header(m, 'Subject') || '(no subject)', account, draftId, who };
}

/** Remove a draft. A draft is not mail; nothing sent is touched. */
export async function discardDraft(vault, account, draftId) {
  const token = await accessToken(vault, fetch, account);
  const url = new URL(BASE + `drafts/${encodeURIComponent(draftId)}`);
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error(`gmail DELETE drafts failed (${res.status})`);
  forget(account);
  return { id: draftId, deleted: res.ok };
}
