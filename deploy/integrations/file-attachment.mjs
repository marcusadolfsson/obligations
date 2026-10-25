#!/usr/bin/env node
/**
 * `node deploy/integrations/file-attachment.mjs <account> <threadId>` — put a
 * thread's attachments in Drive and write down where they went.
 *
 * Alex, 2026-09-02, about the LFC borrower statement: "There is no obligation
 * from that email, so I rather archive it after filing." This is the filing
 * half. The archiving stays with the triage, through the one rate-limited,
 * audit-logged door, exactly as it does for everything else.
 *
 * ## The agent does not do this
 *
 * Downloading bytes and putting them somewhere is arithmetic. Which threads are
 * worth filing is judgement, and that stays with the triage. Keeping the two
 * apart is what means the agent never holds Drive write at all — the same split
 * as archiving, and the same reason.
 *
 * ## What it can reach
 *
 * The Drive grant is `drive.file`: this app may create files, and may see or
 * manage **only files it created**. Alex's existing Drive is not visible to
 * it — not denied, invisible. Verified on the day the grant landed: listing
 * files returned an empty set.
 *
 * That has a consequence worth knowing rather than discovering. The folders
 * below are found by searching, and the search can only find them **because we
 * made them**. If someone moves or recreates `Obligations/Statements` by hand, this
 * loses sight of it and makes a second one; it cannot see the original to
 * complain. That is the scope working as designed.
 *
 * ## The record is the point
 *
 * A PDF in Drive nobody can find again is not filed, it is lost somewhere
 * tidier. `reference/statements.md` gets a line per document — date, who,
 * subject, link — so "where is the August LFC statement" is answerable from the
 * repo without opening Drive at all. Same job `reference/bookings.md` does for
 * reservations.
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, accountsWith, capabilitiesOf } from '../mcp/google-auth.mjs';
import { fields, fieldsLine, looksLikeInvoice } from './pdf-fields.mjs';
import { documentParts } from './attachment-parts.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECORD = join(OBLIGATIONS, 'reference', 'statements.md');

/** Where things go. One folder per year keeps a decade legible. */
const ROOT = 'Obligations';
const SECTION = 'Statements';

/** Bigger than any statement; small enough that a runaway is visible. */
const MAX_BYTES = 25 * 1024 * 1024;

const [account = 'gmail', threadId] = process.argv.slice(2);
if (!threadId) {
  console.error('usage: file-attachment.mjs <account> <threadId>');
  process.exit(2);
}

const gmailToken = await accessToken(OBLIGATIONS, fetch, account);

/**
 * Whose Drive the document goes to.
 *
 * The mail account's own, when that account has Drive — a work statement
 * belongs in the work Drive, not in the personal one, and under the old
 * capability-keyed layout there was exactly one Drive so it had no choice.
 * Otherwise the first account that has Drive at all, which is the single-Drive
 * case and stays the common one.
 */
const driveAccount = (await capabilitiesOf(account, OBLIGATIONS)).includes('drive')
  ? account
  : (await accountsWith('drive', OBLIGATIONS))[0];
if (!driveAccount) {
  console.error('no Google account has been granted Drive access; '
              + 'run deploy/integrations/google-auth-cli.mjs --account=<id> --enable=drive');
  process.exit(1);
}
const driveToken = await accessToken(OBLIGATIONS, fetch, driveAccount);

async function gmail(path, params = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${gmailToken}` } });
  if (!res.ok) throw new Error(`gmail ${path} (${res.status}): ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function drive(path, { method = 'GET', params = {}, body, headers = {} } = {}) {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${driveToken}`, ...headers },
    body,
  });
  if (!res.ok) throw new Error(`drive ${path} (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Find the folder we made, or make it. See the header on why "we made it" matters. */
async function folder(name, parent) {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    parent ? `'${parent}' in parents` : "'root' in parents",
  ].join(' and ');

  const found = await drive('files', { params: { q, fields: 'files(id,name)', pageSize: 1 } });
  if (found.files?.length) return found.files[0].id;

  const made = await drive('files', {
    method: 'POST',
    params: { fields: 'id' },
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parent ? { parents: [parent] } : {}),
    }),
  });
  return made.id;
}

const header = (headers, name) => (headers ?? [])
  .find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/**
 * The text of a PDF we just uploaded, via a copy-to-Doc round trip.
 *
 * `drive.file` lets this manage the files it created, so it may copy one of
 * its own uploads into a Google Doc — which converts it — export that as
 * plain text, and delete the copy. No `pdftotext` on the host, no
 * `node_modules`, and the repo is stdlib-only on purpose.
 *
 * The temp Doc is removed in a `finally`: a conversion copy left behind is a
 * second document in the same folder that reads like the filed one.
 *
 * Returns '' on any failure. Extraction is a bonus on top of filing, and a
 * document that is safely in Drive must never be reported as unfiled because
 * a text export 500'd.
 */
async function pdfText(fileId) {
  let copyId = null;
  try {
    const copy = await drive(`files/${encodeURIComponent(fileId)}/copy`, {
      method: 'POST',
      params: { fields: 'id' },
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `obligations-tmp-extract-${fileId}`,
                             mimeType: 'application/vnd.google-apps.document' }),
    });
    copyId = copy.id;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(copyId)}/export`
      + '?mimeType=text%2Fplain',
      { headers: { Authorization: `Bearer ${driveToken}` } });
    if (!res.ok) return '';
    return await res.text();
  } catch (e) {
    console.error(`  (could not read text from ${fileId}: ${e.message})`);
    return '';
  } finally {
    if (copyId) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(copyId)}`,
                  { method: 'DELETE', headers: { Authorization: `Bearer ${driveToken}` } })
        .catch(() => {});
    }
  }
}

/** Safe as a filename on any of the three platforms this repo touches. */
const clean = (s) => String(s ?? '')
  .replace(/[\/\\:*?"<>|]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120);

const p = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

/* What counts as a document rather than a signature logo is `isDecoration` in
 * attachment-parts.mjs — shared with `statements-tidy.mjs`, which applies the
 * same rule to everything filed before that rule existed. */

/** Already filed? The record is the check — see the header. */
async function alreadyFiled(messageId) {
  try {
    return (await readFile(RECORD, 'utf8')).includes(messageId);
  } catch {
    return false;
  }
}

const thread = await gmail(`threads/${encodeURIComponent(threadId)}`, { format: 'full' });
const filed = [];

for (const m of thread.messages ?? []) {
  const h = m.payload?.headers ?? [];
  const from = header(h, 'From');
  const subject = header(h, 'Subject');
  const when = new Date(Number(m.internalDate ?? Date.now()));

  const parts = documentParts(m.payload);
  if (!parts.length) continue;

  if (await alreadyFiled(m.id)) {
    console.log(`already filed, skipping: ${subject}`);
    continue;
  }

  const year = String(when.getFullYear());
  const parent = await folder(year, await folder(SECTION, await folder(ROOT, null)));

  for (const a of parts) {
    if (a.bytes > MAX_BYTES) {
      console.error(`skipping ${a.filename}: ${a.bytes} bytes exceeds the cap`);
      continue;
    }
    const att = await gmail(
      `messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}`);
    const bytes = Buffer.from(att.data, 'base64url');

    // Named so the folder is browsable without opening anything: when, who,
    // what. The original filename is often just "statement.pdf".
    const sender = clean((from.match(/^([^<]+)/)?.[1] ?? from).replace(/"/g, ''));
    const ext = a.filename.includes('.') ? a.filename.slice(a.filename.lastIndexOf('.')) : '';
    const base = clean(`${isoDay(when)} ${sender} — ${subject}`);
    const name = `${base}${ext}`;

    // Multipart upload: metadata and bytes in one request. Fine to this size;
    // a resumable upload would be the right shape only for something far larger.
    const boundary = `obligations-${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(JSON.stringify({ name, parents: [parent] })),
      Buffer.from(`\r\n--${boundary}\r\ncontent-type: ${a.mime || 'application/octet-stream'}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      { method: 'POST',
        headers: { Authorization: `Bearer ${driveToken}`,
                   'content-type': `multipart/related; boundary=${boundary}` },
        body });
    if (!res.ok) throw new Error(`drive upload (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const file = await res.json();

    // What the document says about itself. Only PDFs, and only the labelled
    // fields — see pdf-fields.mjs on why nothing here resolves a due date.
    let found = null;
    if ((a.mime || '').includes('pdf')) {
      found = fields(await pdfText(file.id));
      if (found.blind) console.log(`  no text layer: ${file.name}`);
      else if (looksLikeInvoice(found)) {
        console.log(`  invoice fields: ${JSON.stringify(found)}`);
      }
    }

    filed.push({ name: file.name, link: file.webViewLink, bytes: bytes.length,
                 messageId: m.id, subject, from, day: isoDay(when), found });
  }
}

if (!filed.length) {
  console.log('nothing to file');
  process.exit(0);
}

// The record, last: a line written before the upload succeeded would claim a
// document that is not there.
await mkdir(dirname(RECORD), { recursive: true });
try {
  await readFile(RECORD, 'utf8');
} catch {
  await appendFile(RECORD, `# Statements and filed documents

> Written by \`deploy/integrations/file-attachment.mjs\`. One line per document
> filed to Drive, so "where is the August statement" is answerable from here
> without opening Drive. Append-only; a correction is another line.

`);
}

for (const f of filed) {
  await appendFile(RECORD,
    `- ${f.day} — **${f.subject}** from ${f.from.replace(/[<>]/g, '')} · `
    + `[${f.name}](${f.link}) · ${Math.round(f.bytes / 1024)}KB${fieldsLine(f.found)}`
    + ` · msg:${f.messageId}\n`);
  console.log(`filed: ${f.name}\n  ${f.link}`);
}
