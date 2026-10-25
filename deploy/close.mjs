#!/usr/bin/env node
/**
 * `node deploy/close.mjs <id> --outcome "what closed it" [--who NAME]`
 * `node deploy/close.mjs <id> --reopen --why "what makes it open again"`
 * `node deploy/close.mjs --list [text]`
 *
 * Discharge an obligation from outside the web page.
 *
 * ## Why this exists
 *
 * `closeObligation()` already closes an obligation everywhere it is evidenced —
 * that is the whole point of the obligation model, and it is what makes
 * answering an email also clear the text about the same thing. But the only
 * door onto it was `POST /api/obligations/close`, which sits behind the Access
 * gate. A scheduled job runs inside the container with no way to authenticate
 * to that, so it could not use the function at all.
 *
 * The mail triage hit this on 2026-09-03 and said so plainly: Alex had been to
 * the orthopedic appointment, the receipt and the review request were both in
 * his mail, and the task still read "check in and complete the paperwork before
 * the visit" — "because it lives in the message triage and I can't close that
 * from here."
 *
 * The alternative it correctly refused to take was editing
 * `integrations/imessage-state.json` itself. Sources stay authoritative and each
 * one owns its own file; a job reaching into another source's cache is how two
 * writers start disagreeing about what is open.
 *
 * So: one door, the same function, available to a job and to Alex at a
 * terminal. It takes the repo lock, discharges every source, and appends the
 * logbook line, because that is what `closeObligation` does and this adds
 * nothing to it.
 *
 * ## `who` is not a formality
 *
 * `closed_by` means *this was closed deliberately, do not reopen it*, and the
 * differ honours it. A job must therefore never write Alex's name: that would
 * forge a decision he did not make, and `rules/email-triage.md` says so about
 * the triage's own closes. Default is the caller's own name, and `--who` is for
 * naming a different job, never for impersonating him.
 */
import { listObligations, closeObligation, reopenObligation } from './agent-service/obligations.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
};

if (argv.includes('--list') || !argv.length) {
  const q = (flag('list') ?? argv[argv.indexOf('--list') + 1] ?? '').toLowerCase();
  const open = (await listObligations(OBLIGATIONS)).filter((o) => o.open);
  const rows = q && !q.startsWith('--')
    ? open.filter((o) => JSON.stringify(o).toLowerCase().includes(q))
    : open;
  for (const o of rows) {
    console.log(`${o.id}\n    ${o.title}`);
    console.log(`    ${(o.evidence ?? []).map((e) => e.source).join('+')}`
      + (o.closes ? ` · closes when: ${o.closes}` : ''));
  }
  console.log(`\n${rows.length} open${q ? ` matching "${q}"` : ''}`);
  process.exit(0);
}

const id = argv[0];

// `close.mjs <id> --reopen --why "…"`: the reopen door. One state per
// obligation (review item 2, 2026-09-20) means a source saying "open" no longer
// reopens a dated close by itself — a decision with a name and a reason does.
// Rare from a job: the triage re-judging a thread already counts as newer
// evidence. This is for the chat, and for a todo or reminder half.
if (argv.includes('--reopen')) {
  const why = flag('why');
  if (!why) { console.error('--why is required: say what makes it open again'); process.exit(2); }
  const by = 'agent:' + (flag('who') || 'assistant').replace(/^agent:/, '');
  try {
    const r = await reopenObligation(OBLIGATIONS, id, by, why);
    console.log(r.reopened ? `reopened ${r.id}${r.flipped.length ? ` (conclusion flipped: ${r.flipped.join(', ')})` : ''}` : `${r.id} had no close on record — nothing to reopen`);
  } catch (e) { console.error(`could not reopen: ${e.message}`); process.exit(1); }
  process.exit(0);
}

const outcome = flag('outcome');
// `agent:` prefix, always. The differs treat a bare `closed_by` as "a human
// decided this, never reopen it" — which is right for the tasks page and wrong
// for a job. Without the marker an agent close would be permanent, and a
// wrongly-closed obligation that never comes back is the one failure this whole
// system is built to avoid.
const who = 'agent:' + (flag('who') || 'assistant').replace(/^agent:/, '');

if (!outcome) {
  // The outcome is the entire value of the logbook line. "Did August's hours go
  // to Northwind?" is answerable months later only because someone wrote down
  // what closed it, and a close with no outcome is a tick nobody can audit.
  console.error('--outcome is required: say what actually closed it');
  process.exit(2);
}
if (/^agent:alex$/i.test(who)) {
  console.error('refusing: `closed_by: alex` means HE closed it. '
    + 'Use the tasks page for that, or name the job here.');
  process.exit(2);
}

try {
  const r = await closeObligation(OBLIGATIONS, id, who, outcome);
  console.log(`closed ${r.id} across: ${r.closed.join(', ')}`);
  if (r.failed?.length) console.log(`  did NOT close: ${r.failed.join('; ')}`);
} catch (e) {
  console.error(`could not close: ${e.message}`);
  process.exit(1);
}
