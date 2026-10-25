#!/usr/bin/env node
/**
 * `node deploy/digest.mjs [--since "YYYY-MM-DD HH:MM"]` — the mail that was
 * filed rather than acted on, since the last brief.
 *
 * ## Why this exists
 *
 * `rules/email-triage.md` gives digest, reading, awareness, memory and ephemeral
 * their own delivery: a grouped line in the brief, a count for reading, one
 * surfacing for awareness. The mail job writes exactly that line — but into
 * `.log/jobs/mail-latest.md`, which is a log. When the brief stopped reading
 * mail on 2026-09-03 the mail section went with it, and the digest lost its only
 * route to Alex. Sixty per cent of judged mail was being archived unmentioned.
 *
 * The fix is not to hand the brief the mail job's prose. It is to derive the
 * digest from the conclusions themselves, which are the record — one source, no
 * second copy to drift, and it works however many times the mail job ran.
 *
 * ## Why a time window rather than a `surfaced` flag
 *
 * Awareness is meant to surface once and stop. A flag would do it, and there is
 * one on the conclusion — carried by 4 of 605, so it is not maintained and
 * trusting it would silently drop the rest. A window does the same job without a
 * write: today's brief covers what was judged since yesterday's, and tomorrow's
 * window has moved past it. Nothing is surfaced twice because nothing is judged
 * twice.
 *
 * Read-only. The brief does the grouping — "11 social notifications, 6 receipts"
 * is judgement, and this hands over the lines to judge.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reasonFor, upcoming } from './digest-window.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tiers that are filed rather than acted on. `silent` is absent on purpose. */
const TIERS = ['digest', 'reading', 'awareness', 'memory', 'ephemeral'];

/**
 * How far the digest has actually been DELIVERED, not merely computed.
 *
 * A rolling 24-hour window assumes the brief runs every day and succeeds. Miss
 * one — the job fails, the box is down, the model errors — and that day's filed
 * mail is never mentioned by anyone, because tomorrow's window has already moved
 * past it. Awareness is surfaced exactly once, so "once" would become "never".
 *
 * Same shape as the extract cursor, and for the same reason Alex gave for
 * that one: it advances only on success, so a failure widens the next window
 * instead of losing a day. `--mark` is what advances it, and the brief runs that
 * only after the message file is written.
 */
const CURSOR = join(OBLIGATIONS, '.log', 'digest-cursor.json');
/** However long the gap, never look further back than this. */
const MAX_LOOKBACK_DAYS = 14;

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1] ?? null; };
const parse = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? null : t; };

// Where the last DELIVERED digest got to. Explicit --since wins; then the
// cursor; then 24 hours, which is only the first-run default.
let cursor = null;
try { cursor = JSON.parse(await readFile(CURSOR, 'utf8')); } catch { /* first run */ }
const floor = Date.now() - MAX_LOOKBACK_DAYS * 24 * 3600 * 1000;
const since = Math.max(floor,
  parse(flag('since')) ?? parse(cursor?.through) ?? Date.now() - 24 * 3600 * 1000);
const covered = new Date().toISOString();

let state;
try {
  state = JSON.parse(await readFile(join(OBLIGATIONS, 'integrations', 'email-state.json'), 'utf8'));
} catch {
  console.log('no mail triage state yet — nothing filed');
  process.exit(0);
}

/* The window is in digest-window.mjs now, because brief-input.mjs asks the same
   question and two copies of it would be two answers. That is also where
   `surfaced_for` is implemented — a dated awareness item waits for its day. */
const rows = [];
for (const t of state.threads ?? []) {
  const c = t.conclusion;
  if (!c || !TIERS.includes(c.tier)) continue;
  const why = reasonFor(t, since);
  if (why) rows.push(Object.assign(Object.create(Object.getPrototypeOf(t)), t, { why }));
}
/* Counted, never merely absent. A dated item still waiting and one quietly
   dropped look identical from here, and that is how eighteen live deferrals sat
   unread. */
const waiting = upcoming(state.threads, TIERS);

if (argv.includes('--json')) {
  console.log(JSON.stringify({ since: new Date(since).toISOString(), count: rows.length,
    items: rows.map((t) => ({ tier: t.conclusion.tier, who: t.conclusion.who ?? null,
      title: t.conclusion.title ?? null, what: t.conclusion.what ?? '',
      surfaced_for: t.conclusion.surfaced_for ?? null, why: t.why })),
    ahead: waiting.map((t) => ({ surfaced_for: t.conclusion.surfaced_for,
      who: t.conclusion.who ?? null, title: t.conclusion.title ?? null })) }, null, 1));
  process.exit(0);
}

/**
 * Advance the cursor. The brief calls this ONLY after the message file is
 * written, so a run that died before delivering leaves the window open and the
 * next brief covers both days.
 */
if (argv.includes('--mark')) {
  await mkdir(dirname(CURSOR), { recursive: true });
  await writeFile(CURSOR, JSON.stringify({ through: covered, count: rows.length }, null, 1) + '\n');
  console.log(`digest marked delivered through ${covered.slice(0, 16).replace('T', ' ')} (${rows.length} items)`);
  process.exit(0);
}

const heldLine = () => (waiting.length
  ? `\n${waiting.length} dated and still ahead: `
    + waiting.slice(0, 5).map((t) => `${t.conclusion.surfaced_for} ${(t.conclusion.title || t.conclusion.what || '').slice(0, 40)}`).join('; ')
    + (waiting.length > 5 ? `; …and ${waiting.length - 5} more` : '')
  : '');

if (!rows.length) {
  console.log('Nothing filed since ' + new Date(since).toISOString().slice(0, 16).replace('T', ' ') + heldLine());
  process.exit(0);
}

const byTier = {};
for (const t of rows) (byTier[t.conclusion.tier] ??= []).push(t);

const gapDays = (Date.now() - since) / 86400000;
console.log(`${rows.length} filed since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')}`
  + (cursor ? '' : ' (no cursor yet — first run)')
  + (gapDays > 1.5 ? ` — ${gapDays.toFixed(1)} days, so a brief was missed` : '')
  + heldLine());
for (const tier of TIERS) {
  const list = byTier[tier];
  if (!list) continue;
  console.log(`\n${tier.toUpperCase()} (${list.length})`);
  // Capped, with the remainder COUNTED rather than dropped — the same rule the
  // work list follows. A normal day is 50-80 filed threads; the day the backlog
  // was cleared it was 350, and a brief handed 350 lines is a brief nobody
  // finishes.
  const SHOW = 20;
  for (const t of list.slice(0, SHOW)) {
    const c = t.conclusion;
    // One line each, for the brief to group. The `what` is the triage's own
    // sentence; nothing is re-summarised here.
    // `due` is the day-of reminder for something he was told about on arrival;
    // marked, because a brief that writes it as news is telling him twice.
    console.log(`  ${t.why === 'due' ? 'DUE ' : '    '}${(c.who ?? '').slice(0, 26).padEnd(26)} ${(c.title || c.what || '').slice(0, 92)}`);
  }
  if (list.length > SHOW) console.log(`  … and ${list.length - SHOW} more, not shown`);
}
