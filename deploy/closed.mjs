#!/usr/bin/env node
/**
 * What was closed, and on what evidence — the day's closes as a CROSS-CHECK.
 *
 * Alex, 2026-09-05: "I think Tomorrow's Brief should have recap of closed
 * obligations, as a cross-check."
 *
 * The word that matters is cross-check, not recap. CLAUDE.md already argues
 * that closing is the agent's job and not a proposal — "a list he has to
 * hand-clear is the list he stops reading" — and holds that safe with three
 * things: a required outcome, `closed_by: agent:` never his name, and a
 * seven-day expiry that brings an agent close back for another look.
 *
 * Seven days is a long time to be wrong. The asymmetry CLAUDE.md names is real
 * — a spurious obligation is visible and annoying, a wrongly-closed one is
 * silent — and the expiry is what stops the silent one being permanent, not
 * what stops it happening. A nightly list of what the agent decided, with the
 * evidence it decided on, closes that gap to a few hours: he reads five lines
 * and knows whether any of them is wrong while he still remembers the day.
 *
 * So this prints the OUTCOME, which is the auditable half. The `what` field in
 * a logbook line is the whole conclusion and runs to thousands of characters;
 * nobody cross-checks that at 18:00. The outcome is the sentence that claims
 * the thing is done, and it is the sentence that can be false.
 *
 * Agent closes are marked. His own never expire and are not in question — the
 * ones worth his eye are the ones a job decided.
 *
 *   node deploy/closed.mjs              # today
 *   node deploy/closed.mjs --since 2026-09-01
 *   node deploy/closed.mjs --json
 */
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listObligations } from './agent-service/obligations.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : null;
};

/** Today in local time. Bare date, the repo's stamp shape. */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
       + `${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Parse logbook.md.
 *
 * The format is `- <stamp> | <id> | <what> | by <who> | <outcome>`, and the
 * `what` field routinely contains pipes of its own — it is prose written by a
 * model about a mail thread. So the line is split from BOTH ends: the first two
 * fields and the last two are fixed, and whatever is left in the middle is the
 * conclusion. Splitting naively on "|" mangles roughly one line in three.
 */
export function parseLogbook(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*\|\s*([^|]+?)\s*\|\s*(.*)$/);
    if (!m) continue;
    const [, date, time, id, rest] = m;
    // From the right: ` | by <who> | <outcome>`. The outcome may itself contain
    // pipes, so anchor on the LAST ` | by ` rather than the first.
    const at = rest.lastIndexOf('| by ');
    if (at < 0) { out.push({ date, time, id, what: rest.trim(), by: null, outcome: null }); continue; }
    const what = rest.slice(0, at).trim();
    const tail = rest.slice(at + 5);
    const split = tail.indexOf(' | ');
    const by = (split < 0 ? tail : tail.slice(0, split)).trim();
    const outcome = split < 0 ? null : tail.slice(split + 3).trim();
    out.push({ date, time, id, what, by, outcome });
  }
  return out;
}

export async function closedSince(vault = OBLIGATIONS, since = todayLocal()) {
  let text = '';
  try { text = await readFile(join(vault, 'logbook.md'), 'utf8'); }
  catch (err) {
    // Never an empty list on failure. "Nothing closed today" and "the logbook
    // could not be read" must not look the same — the whole point of this
    // script is being able to trust what it says.
    return { since, rows: [], error: String(err?.message ?? err) };
  }

  // String comparison, deliberately: these are ISO dates, so it sorts and
  // compares correctly without parsing, and a date that never becomes a Date
  // cannot pick up a timezone on the way.
  const lines = parseLogbook(text)
    .filter((r) => r.date >= since)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // Titles come from the obligation, not the logbook: the logbook's `what` is
  // the full conclusion and is unreadable at a glance.
  let titles = new Map();
  try {
    titles = new Map((await listObligations(vault)).map((o) => [o.id, o.title]));
  } catch { /* a title is a nicety; the outcome is the point */ }

  const rows = lines.map((r) => ({
    ...r,
    title: titles.get(r.id) ?? r.what.slice(0, 90) + (r.what.length > 90 ? '…' : ''),
    // The distinction that makes this a cross-check: his closes are decisions,
    // an agent's are claims.
    agent: !!r.by && r.by.startsWith('agent:'),
  }));

  return { since, rows, error: null,
           counts: { total: rows.length, byAgent: rows.filter((r) => r.agent).length } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await closedSince(OBLIGATIONS, flag('since') ?? todayLocal());
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); }
  else if (out.error) { console.log(`logbook.md could not be read: ${out.error}`); }
  else if (!out.rows.length) { console.log(`nothing closed since ${out.since}.`); }
  else {
    console.log(`${out.counts.total} closed since ${out.since}`
              + ` — ${out.counts.byAgent} by the agent, worth a glance\n`);
    let day = null;
    for (const r of out.rows) {
      // The date, once per day. Without it a 09-04 18:02 above a 09-05 07:03
      // reads as unsorted, which makes the whole list look untrustworthy — and
      // trusting this list is the entire point of printing it.
      if (r.date !== day) { console.log(`${r.date}`); day = r.date; }
      console.log(`  ${r.time}  ${r.agent ? '[agent]' : '[you]  '}  ${r.title}`);
      if (r.outcome) console.log(`          closed by: ${r.outcome}`);
      console.log(`          ${r.id}\n`);
    }
  }
}
