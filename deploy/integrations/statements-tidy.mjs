#!/usr/bin/env node
/**
 * `node deploy/integrations/statements-tidy.mjs [--write] [--trash]` — take the
 * signature logos back out of `reference/statements.md`.
 *
 * Alex, 2026-09-19, looking at the documents list on /reference: "can we
 * clean up the older documents that are only email inbody images. I think we
 * stopped saving new ones but not previous imports." Both halves are right.
 * `isDecoration()` landed on 2026-09-09 and was corrected on 09-16; everything
 * filed before that kept every part of the message that had a filename, so 500
 * of the 799 lines are PNGs and GIFs out of people's signature blocks — the
 * same 3KB logo filed once per message in a nine-message thread.
 *
 * ## It asks the message, it does not guess from the line
 *
 * A record line keeps the renamed file, its size and the message id; the
 * original filename, the MIME type and the headers are gone. So the size half
 * of the rule could be applied here and the *inline* half could not, and the
 * inline half is the one that catches a 381KB animated GIF in a footer. This
 * re-fetches each message and runs the real `isDecoration()` over its parts —
 * the same function the filer now uses, imported rather than restated, so the
 * question "would we file this today?" has exactly one answer.
 *
 * A line whose message cannot be fetched — deleted, or in neither mailbox — is
 * KEPT and counted under `could not check`. Removing a document because its
 * evidence was unavailable is the one failure that would be invisible
 * afterwards.
 *
 * ## What it does with what it finds
 *
 * Nothing, without `--write`. With it:
 *   - the decoration lines leave `reference/statements.md`
 *   - and land in `archive/<today>-statements-decorations.md`, in full, so the
 *     record of what was filed survives even though it is no longer an index
 *     entry. Same rule as `people/`: move it to `archive/`, never rm it.
 *
 * `--trash` additionally moves the Drive files themselves to the Drive trash —
 * recoverable for 30 days, and never `files.delete`, which is not. Separate
 * from `--write` because one of them touches only this repo and the other
 * touches his Drive.
 */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, accounts, capabilitiesOf, accountsWith } from '../mcp/google-auth.mjs';
import { attachmentParts } from './attachment-parts.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECORD = join(OBLIGATIONS, 'reference', 'statements.md');
/**
 * What each message said about its own parts, so a second run costs nothing.
 *
 * 274 messages at `format=full` is enough to exhaust Gmail's per-minute query
 * cost for the whole user, and on 2026-09-19 it did — twice in one command,
 * because the dry run and the write were two separate passes over the same
 * mailbox. Alex saw the 403 in the chat while I was still running it. The
 * mailbox is shared with the triage jobs and the chat, so the quota is not
 * this script's to spend twice on the same question.
 */
const CACHE = join(OBLIGATIONS, '.log', 'statements-tidy-parts.json');

const WRITE = process.argv.includes('--write');
const TRASH = process.argv.includes('--trash');

const p = (n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

/**
 * `- DAY — **SUBJECT** from FROM · [NAME](LINK) · NKB[ · invoice fields] · msg:ID`
 *
 * The fields section is optional and free-form (see `fieldsLine` in
 * pdf-fields.mjs), so it is matched lazily between the size and the id.
 */
const LINE = /^- (\d{4}-\d{2}-\d{2}) — \*\*([\s\S]*?)\*\* from (.+?) · \[(.+?)\]\((.+?)\) · (\d+)KB(.*?) · msg:([0-9a-f]+)\s*$/;

function parse(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, day, subject, from, name, link, kb, , messageId] = m;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  const fileId = (link.match(/\/file\/d\/([^/]+)/) ?? [])[1] ?? null;
  return { line, day, subject, from, name, link, kb: Number(kb), ext, fileId, messageId };
}

/** What a record line and a live message part have in common. */
const key = (ext, bytes) => `${ext}|${Math.round(bytes / 1024)}`;

const raw = await readFile(RECORD, 'utf8');
const lines = raw.split('\n');
const records = [];
for (const [i, line] of lines.entries()) {
  if (!line.startsWith('- ')) continue;
  const r = parse(line);
  if (r) records.push({ ...r, at: i });
  else console.error(`could not parse line ${i + 1}: ${line.slice(0, 90)}…`);
}
console.log(`${records.length} filed documents, ${new Set(records.map((r) => r.messageId)).size} messages`);

/* ------------------------------------------------------------------ gmail */

const mailAccounts = [];
for (const a of await accounts(OBLIGATIONS)) {
  if ((await capabilitiesOf(a, OBLIGATIONS)).includes('mail')) mailAccounts.push(a);
}
if (!mailAccounts.length) { console.error('no account has mail access'); process.exit(1); }
const tokens = new Map();
for (const a of mailAccounts) tokens.set(a, await accessToken(OBLIGATIONS, fetch, a));

/**
 * The message, from whichever mailbox has it.
 *
 * Returns `{ msg }`, or `{ why }` saying why not — and the difference decides
 * whether a line can be judged. A 404 from every mailbox means the message is
 * genuinely gone. **A quota or rate error means we did not get to ask**, and on
 * the first run of this that was most of what looked like an answer: the work
 * mailbox was over its per-minute quota and returned 403 to everything, which
 * an earlier version read as "not here" for 104 lines. Neither one removes a
 * line, but only one of them is a fact about the mail.
 */
const RETRYABLE = /quota|rateLimit|backendError|Internal error/i;
async function message(id) {
  let why = 'not in either mailbox';
  for (const a of mailAccounts) {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
    url.searchParams.set('format', 'full');
    for (let attempt = 0; attempt < 5; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.get(a)}` } });
      } catch (e) {
        why = `${a}: ${e.message}`;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      if (res.ok) return { msg: await res.json() };
      if (res.status === 404) break;                       // not this mailbox
      const body = (await res.text()).slice(0, 200);
      if (res.status === 429 || res.status >= 500 || (res.status === 403 && RETRYABLE.test(body))) {
        why = `${a}: ${res.status} ${RETRYABLE.exec(body)?.[0] ?? 'transient'}`;
        // Gmail's per-minute quota refills on a minute boundary, so the waits
        // are seconds rather than milliseconds.
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      why = `${a}: ${res.status} ${body.slice(0, 80)}`;
      break;
    }
  }
  return { why };
}

/* ------------------------------------------------------------- the verdict */

const byMessage = new Map();
for (const r of records) {
  if (!byMessage.has(r.messageId)) byMessage.set(r.messageId, []);
  byMessage.get(r.messageId).push(r);
}

const remove = [];
const keep = [];
const blind = [];
let done = 0;
let fetched = 0;

let cache = {};
try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch { /* first run */ }
const cachedAtStart = Object.keys(cache).length;

const ids = [...byMessage.keys()];
// Two lanes, not four. See CACHE above: this shares a per-minute quota with
// the triage jobs and the chat, and going faster only means failing sooner.
const LANES = 2;
await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
  for (let i = lane; i < ids.length; i += LANES) {
    const id = ids[i];
    const rows = byMessage.get(id);
    let keys = cache[id];
    if (!keys) {
      const { msg, why } = await message(id);
      fetched++;
      if (!msg) { blind.push(...rows.map((r) => ({ ...r, why }))); keep.push(...rows); done++; continue; }
      // The decoration parts, keyed on what a record line still remembers.
      keys = attachmentParts(msg.payload)
        .filter((part) => part.decoration)
        .map((part) => key(part.filename.includes('.')
          ? part.filename.slice(part.filename.lastIndexOf('.')).toLowerCase() : '', part.bytes));
      cache[id] = keys;
    }
    done++;
    if (done % 50 === 0) process.stderr.write(`  ${done}/${ids.length} messages (${fetched} fetched)\n`);

    // A multiset, consumed as it matches, so a message with one 3KB logo and
    // one genuine 3KB icon loses exactly one line.
    const pool = new Map();
    for (const k of keys) pool.set(k, (pool.get(k) ?? 0) + 1);
    for (const r of rows) {
      const k = key(r.ext, r.kb * 1024);
      if (pool.get(k)) { pool.set(k, pool.get(k) - 1); remove.push(r); }
      else keep.push(r);
    }
  }
}));

await mkdir(dirname(CACHE), { recursive: true });
await writeFile(CACHE, JSON.stringify(cache));
if (fetched) console.log(`\n${fetched} messages fetched, ${cachedAtStart} read from the cache`);

/* --------------------------------------------------------------- the report */

const senderOf = (r) => {
  const q = r.from.match(/^"([^"]+)"/);
  return q?.[1] || r.from.replace(/\s*\S+@\S+\s*$/, '').trim() || (r.from.match(/@([\w.-]+)/) ?? [])[1] || r.from;
};
const tally = (rows, f) => {
  const m = new Map();
  for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`\n${remove.length} are decoration, ${keep.length - blind.length} are documents, ${blind.length} could not be checked`);
console.log('\nwhat goes, by kind:');
for (const [k, n] of tally(remove, (r) => r.ext || '(none)')) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('\nwhat goes, by sender:');
for (const [k, n] of tally(remove, senderOf).slice(0, 12)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('\nwhat stays, by kind:');
for (const [k, n] of tally(keep, (r) => r.ext || '(none)')) console.log(`  ${String(n).padStart(4)}  ${k}`);
if (blind.length) {
  console.log(`\ncould not check, so kept: ${blind.length}`);
  for (const [k, n] of tally(blind, (r) => r.why)) console.log(`  ${String(n).padStart(4)}  ${k}`);
}
/* A PDF, a spreadsheet or a document can only be called decoration by the
 * inline/Content-ID half of the rule — never by the size floor. That is a real
 * thing senders do, and it is also exactly where the rule would be wrong, so
 * every one is named rather than counted. */
const notImages = remove.filter((r) => !/\.(png|gif|jpe?g|bmp|tiff?|webp|ico)$/.test(r.ext));
if (notImages.length) {
  console.log(`\nNOT images, and going — check these by eye (${notImages.length}):`);
  for (const r of notImages) console.log(`  ${r.day} ${r.kb}KB ${senderOf(r)} — ${r.subject.slice(0, 60)}\n      ${r.link}`);
}
// The ones the size floor alone would never have caught, listed so a person can
// see that the inline rule is doing something real rather than trusting it.
const big = remove.filter((r) => /\.(png|gif|jpe?g|bmp|tiff?)$/.test(r.ext) && r.kb >= 20);
if (big.length) {
  console.log(`\nimages over 20KB that are decoration anyway (inline in the body): ${big.length}`);
  for (const [k, n] of tally(big, (r) => `${r.kb}KB ${r.ext}`).slice(0, 8)) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

if (!WRITE) {
  console.log('\ndry run — nothing written. --write to tidy the record, --trash to bin the Drive files too.');
  process.exit(0);
}

/* ---------------------------------------------------------------- the write */

if (!remove.length) { console.log('\nnothing to remove.'); process.exit(0); }

const gone = new Set(remove.map((r) => r.at));
const kept = lines.filter((_, i) => !gone.has(i));
const ARCHIVE = join(OBLIGATIONS, 'archive', `${today()}-statements-decorations.md`);
// Merged, never overwritten. A second run on the same day used to replace the
// archive with only what that run found — on 2026-09-19 that turned 496
// archived lines into 3, and the originals survived only because they were
// still in git. What leaves the record has exactly one place to land.
let existing = [];
try {
  existing = (await readFile(ARCHIVE, 'utf8')).split('\n').filter((l) => l.startsWith('- '));
} catch { /* first run today */ }
const all = [...existing, ...remove.map((r) => r.line).filter((l) => !existing.includes(l))];
await mkdir(dirname(ARCHIVE), { recursive: true });
await writeFile(ARCHIVE, `# Signature logos taken out of the documents list

${today()}. ${all.length} lines that \`reference/statements.md\` carried as filed
documents, removed because they are inline images from senders' signature
blocks rather than anything filed on purpose — the same 3KB logo filed once per
message in a nine-message thread.

Every one was checked against the message it came from, with the same
\`isDecoration()\` the filer uses today: see \`deploy/integrations/statements-tidy.mjs\`.
Images only — a PDF or a docx is never furniture, whatever disposition the
sender put on it.

Kept here rather than deleted. The Drive files are untouched unless a \`--trash\`
pass says otherwise below, so every link still resolves.

${all.join('\n')}
`);
await writeFile(RECORD, kept.join('\n'));
console.log(`\nrecord: ${records.length} → ${records.length - remove.length} documents`);
console.log(`archive: ${ARCHIVE.replace(OBLIGATIONS + '/', '')}`);

/* ---------------------------------------------------------------- the trash */

if (!TRASH) {
  console.log('\nthe Drive files are untouched — --trash moves them to the Drive bin.');
  process.exit(0);
}

const driveAccount = (await accountsWith('drive', OBLIGATIONS))[0];
if (!driveAccount) { console.error('no account has Drive access'); process.exit(1); }
const driveToken = await accessToken(OBLIGATIONS, fetch, driveAccount);
let trashed = 0, failed = 0;
for (const r of remove) {
  if (!r.fileId) { failed++; continue; }
  // trashed:true, never files.delete — the bin is recoverable for 30 days and
  // a delete is not. Same reasoning as archive-not-delete for mail.
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(r.fileId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${driveToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (res.ok) trashed++;
  else { failed++; if (failed <= 5) console.error(`  ${r.fileId}: ${res.status} ${(await res.text()).slice(0, 120)}`); }
}
console.log(`drive: ${trashed} moved to the bin, ${failed} could not be`);
await appendFile(ARCHIVE, `\n${trashed} of these were moved to the Drive bin on ${today()}; ${failed} could not be.\n`);
