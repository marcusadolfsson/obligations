#!/usr/bin/env node
/**
 * Put a reply in his Drafts — the one door for that, outside the MCP server.
 *
 * A Gmail draft reaches nobody. CLAUDE.md: "Drafting is always fine, anywhere."
 * The mail job drafts through the MCP tool; the chat on the host, and any
 * deterministic job, had no way to. Alex, 2026-09-05: "we should draft a
 * response to her that we already booked through another service" — with the
 * MCP servers unreachable from the session he asked in.
 *
 * It threads the reply properly: To is whoever last wrote that was not him,
 * Subject is theirs with Re:, and In-Reply-To / References carry their
 * Message-ID, so the draft sits under the conversation in Gmail rather than
 * starting a new one. Plain text only. It uses the gmail.modify grant and never
 * the send one — nothing here can leave the box.
 *
 *   node deploy/integrations/mail-draft.mjs <account> <threadId> --body "text"
 *   node deploy/integrations/mail-draft.mjs <account> <threadId> --body-file path
 *   … --to "name@example.com"   when the thread's last sender is not the person
 *   … --attach /path/file.pdf    repeatable; a file rides in the draft
 *   node deploy/integrations/mail-draft.mjs <account> --update <draftId> [--body …] [--to addr] [--attach path]…
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken } from '../mcp/google-auth.mjs';
import { isMachine } from '../agent-service/handles.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';

async function api(token, path, { method = 'GET', params = {}, body } = {}) {
  const url = new URL(BASE + path);
  // Gmail wants a repeated key for a list (metadataHeaders=From&metadataHeaders=To);
  // a comma-joined value is silently ignored and the reply comes back with no
  // To and no Subject — which is exactly what the first draft did.
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x)); else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`gmail ${method} ${path} failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

/** A header by name, case-insensitively. Exported for mail-drafts.mjs and the tests. */
export const header = (msg, name) => (msg.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/**
 * A sender no reply should go to: the machine that bounced a reminder, a
 * noreply, a mailer-daemon. The evening job's first nudge went to
 * reminder@superhuman.com, because a Superhuman reminder was the last message
 * on the thread that was not his. Exported for the tests.
 */
export { isMachine } from '../agent-service/handles.mjs';

/** The reply's addressing, from the thread. `to` overrides who; exported for the tests. */
export function replyHeaders(messages, me, { to = null } = {}) {
  const mine = String(me ?? '').toLowerCase();
  // A name is not an address. Callers pass `who` off an obligation, and the
  // triage writes that as "Hank Mercer" whenever the address book can name
  // the person — which Gmail rejects with "Invalid To header (400)". Every
  // chase to somebody it could name failed that way, hourly, and the pass threw
  // the error away, so the log showed a run that simply wrote nothing. Alex,
  // 2026-09-17: "they appear very adhoc" — they were the subset of people the
  // address book could NOT name. A `to` with no @ is treated as absent, and the
  // reply goes where a reply goes: the address on the thread.
  if (to && !/@/.test(String(to))) to = null;
  const human = [...messages].reverse().filter((m) => !header(m, 'From').toLowerCase().includes(mine));
  const theirs = human.find((m) => !isMachine(header(m, 'From'))) ?? human[0] ?? messages[messages.length - 1];
  const subject = header(theirs, 'Subject');
  return {
    to: to || header(theirs, 'Reply-To') || header(theirs, 'From'),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: header(theirs, 'Message-ID'),
    references: [header(theirs, 'References'), header(theirs, 'Message-ID')].filter(Boolean).join(' '),
  };
}

/** RFC 2822 text/plain, base64url — the shape drafts.create wants. Exported for the tests. */
/** Plain text as the HTML Gmail's own composer would produce: paragraphs, <br> inside them. Exported for the tests. */
export function bodyHtml(text) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text ?? '').trim().split(/\r?\n\s*\r?\n/).map((para) => `<div>${esc(para).replace(/\r?\n/g, '<br>')}</div>`).join('<div><br></div>');
}

/**
 * multipart/alternative: text/plain and text/html. A plain-text-only draft
 * came out of Gmail's mobile composer with every line break flattened into
 * one paragraph — Alex, 2026-09-06, "This is how the draft shows on Gmail".
 * The HTML part is what the composer edits; the plain part is what a reader
 * without HTML gets, and what the Outbox page shows.
 */
export function rawMessage({ from, to, cc = null, subject, inReplyTo, references, body, attachments = [] }) {
  const alt = 'obligations-alt-' + Math.random().toString(36).slice(2, 10);
  const plain = body.trimEnd().replace(/\r?\n/g, '\r\n');
  const alternative = [
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', plain, '',
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', bodyHtml(body), '',
    `--${alt}--`,
  ];
  const head = [
    `From: ${from}`, `To: ${to}`, cc ? `Cc: ${cc}` : null, `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
  ].filter((l) => l !== null);
  let lines;
  if (!attachments.length) {
    lines = [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...alternative, ''];
  } else {
    // Files ride in a multipart/mixed around the text — the shape every mail
    // client writes. Alex, 2026-09-06, on a draft promising certificates
    // that were not there: "Also no attachment."
    const mixed = 'obligations-mix-' + Math.random().toString(36).slice(2, 10);
    const files = attachments.flatMap((a) => {
      const name = String(a.filename ?? 'attachment').replace(/["\r\n]/g, '');
      const data = Buffer.isBuffer(a.data) ? a.data : Buffer.from(String(a.data ?? ''), 'base64');
      return [`--${mixed}`, `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${name}"`, 'Content-Transfer-Encoding: base64',
              `Content-Disposition: attachment; filename="${name}"`, '', data.toString('base64').replace(/(.{76})/g, '$1\r\n'), ''];
    });
    lines = [...head, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...alternative, '', ...files, `--${mixed}--`, ''];
  }
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

/** A local file as an attachment: name from the path, type from the extension. */
export async function fileAttachment(path) {
  const data = await readFile(path);
  const name = path.split('/').pop();
  const ext = (name.split('.').pop() || '').toLowerCase();
  const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
                  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip', json: 'application/json' };
  if (data.length > 20 * 1024 * 1024) throw new Error(`${name} is ${Math.round(data.length / 1048576)}MB — over Gmail's attachment size`);
  return { filename: name, mimeType: TYPES[ext] ?? 'application/octet-stream', data };
}

export async function draftReply(vault, account, threadId, body, { to = null, attachments = [] } = {}) {
  if (!body?.trim()) throw new Error('--body is required');
  const token = await accessToken(vault, fetch, account);
  const profile = await api(token, 'profile');
  const thread = await api(token, `threads/${encodeURIComponent(threadId)}`, { params: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Message-ID', 'References', 'Reply-To'] } });
  const h = replyHeaders(thread.messages ?? [], profile.emailAddress, { to });
  if (!h.to) throw new Error('could not determine who to reply to — the thread came back without headers; no draft written');
  if (isMachine(h.to)) throw new Error(`refusing to draft to a machine address (${h.to}) — pass --to with the person's address`);
  // One waiting draft per thread: new information rewrites it.
  //
  // Alex, 2026-09-15, looking at two drafts to Miles Hale on the same
  // "RE: Proposal Questions" thread — one five days old promising an answer
  // "by the end of the day tomorrow", one two days old holding the decision to
  // Friday: "if there is new information, rewrite a pending unsent message
  // rather than adding new ones." Every run that learned something wrote a
  // fresh draft beside the last, so the Outbox filled with competing versions
  // of one reply and the oldest was the most wrong. Only drafts on THIS thread
  // are touched, and attachments go through the create path so none is lost.
  if (!attachments.length) {
    const { listDrafts, updateDraft } = await import('./mail-drafts.mjs');
    const waiting = (await listDrafts(vault, account, { fresh: true }).catch(() => []))
      .filter((d) => d.threadId === threadId)
      .sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
    if (waiting.length) {
      const keep = waiting[0];
      await updateDraft(vault, account, keep.id, body, { to: h.to });
      return { draftId: keep.id, to: h.to, subject: h.subject, threadId, attachments: [], rewrote: true,
               others: waiting.slice(1).map((d) => d.id), link: keep.link };
    }
  }
  const raw = rawMessage({ from: profile.emailAddress, ...h, body, attachments });
  const made = await api(token, 'drafts', { method: 'POST', body: { message: { raw, threadId } } });
  return { draftId: made.id, to: h.to, subject: h.subject, threadId, attachments: attachments.map((a) => a.filename), link: `https://mail.google.com/mail/u/0/#drafts/${made.message?.id ?? ''}` };
}

/** Remove a draft — only ever one this made. A draft is not mail. */
/**
 * Did the assistant write this draft, and has he left it alone since?
 *
 * Every draft rawMessage() builds uses a MIME boundary beginning `obligations-alt-`
 * or `obligations-mix-`. Gmail replaces the boundary when a person edits the draft,
 * so this answers both halves at once: written here, and untouched by him. Once
 * he has changed a word it is his draft, and nothing here may delete it.
 */
export function isObligationsDraft(message) {
  const ct = header(message ?? {}, 'Content-Type');
  return /boundary="?obligations-(alt|mix)-/i.test(ct);
}

/**
 * Delete a draft — only one the assistant wrote and he has not touched.
 *
 * Found 2026-09-15: this deleted ANY draft, with no check, from a script on the
 * unattended allow list. The MCP delete_draft tools are denied by name and
 * CLAUDE.md says deleting mail is never the assistant's, so this was a side door
 * around a Never, sitting unused. Nothing called it — which is the only reason
 * it had not mattered. A draft he wrote, or edited, is refused here by name.
 */
export async function deleteDraft(vault, account, draftId) {
  const token = await accessToken(vault, fetch, account);
  const got = await api(token, `drafts/${encodeURIComponent(draftId)}`, { params: { format: 'metadata', metadataHeaders: ['Content-Type', 'To', 'Subject'] } });
  if (!isObligationsDraft(got.message)) {
    throw new Error(`refusing to delete draft ${draftId}: he wrote it or has edited it, so it is his`);
  }
  const url = new URL(BASE + `drafts/${encodeURIComponent(draftId)}`);
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error(`gmail DELETE drafts failed (${res.status})`);
  return { draftId, deleted: res.ok };
}

/* NO TOP-LEVEL AWAIT HERE. The evening job's owed-by-you holding replies
   failed every night from 2026-09-15 to 09-24 with exit 13, "unsettled
   top-level await", and the jobs' own notes blamed a network hang in the
   token refresh. It was a module deadlock: run as a script, this file was
   still evaluating — suspended on its own top-level await — when draftReply
   and --update dynamically imported mail-drafts.mjs, which statically imports
   THIS file back. Each waited for the other with nothing pending, so node
   exited. The service imports this as a module, already evaluated, which is
   why the chase pass drafted fine through the same functions. Running the CLI
   in a function lets evaluation finish first. Alex, 2026-09-25: "The
   mail-drafting path has failed every evening it has been tried since 09-15;
   this is the seventh time." */
if (import.meta.url === `file://${process.argv[1]}`) (async () => {
  if (process.argv[2] === '--delete-draft') {
    const [, , , account, id] = process.argv;
    console.log(JSON.stringify(await deleteDraft(OBLIGATIONS, account, id))); process.exit(0);
  }
  const argv = process.argv;
  const bi = argv.indexOf('--body'), bf = argv.indexOf('--body-file'), ti = argv.indexOf('--to'), ui = argv.indexOf('--update');
  // --update <draftId>: change an existing draft's text and/or add files. Still
  // a draft; nothing here sends. Alex, 2026-09-06: "And the chat agent can
  // do it now?" — attaching a fetched file to the draft it wrote earlier.
  if (ui > 0) {
    const account = argv[2], draftId = argv[ui + 1];
    try {
      const { updateDraft } = await import('./mail-drafts.mjs');
      const body = bi > 0 ? argv[bi + 1] : bf > 0 ? await readFile(argv[bf + 1], 'utf8') : null;
      const add = [];
      for (let i = 0; i < argv.length; i++) if (argv[i] === '--attach' && argv[i + 1]) add.push(await fileAttachment(argv[i + 1]));
      if (!account || !draftId) throw new Error('usage: mail-draft.mjs <account> --update <draftId> [--body "text" | --body-file path] [--attach path]…');
      const r = await updateDraft(OBLIGATIONS, account, draftId, body, { add, to: ti > 0 ? argv[ti + 1] : null });
      console.log(`updated draft ${r.id} → ${r.to}${r.attachments.length ? '\n  files: ' + r.attachments.join(', ') : ''}`);
    } catch (err) { console.error(`mail-draft: ${err.message}`); process.exit(1); }
    process.exit(0);
  }
  const [account, threadId] = argv.slice(2);
  try {
    const body = bi > 0 ? argv[bi + 1] : bf > 0 ? await readFile(argv[bf + 1], 'utf8') : '';
    if (!account || !threadId) throw new Error('usage: mail-draft.mjs <account> <threadId> --body "text" | --body-file path [--to addr] [--attach path]…');
    const attachments = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--attach' && argv[i + 1]) attachments.push(await fileAttachment(argv[i + 1]));
    const r = await draftReply(OBLIGATIONS, account, threadId, body, { to: ti > 0 ? argv[ti + 1] : null, attachments });
    console.log(`drafted → ${r.to}\n  ${r.subject}\n  draft ${r.draftId} on thread ${r.threadId}${r.attachments.length ? '\n  attached: ' + r.attachments.join(', ') : ''}\n  ${r.link}`);
  } catch (err) { console.error(`mail-draft: ${err.message}`); process.exit(1); }
})();
