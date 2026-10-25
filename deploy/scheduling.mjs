#!/usr/bin/env node
/**
 * They offered times; pick one and draft the reply.
 *
 * Alex, 2026-09-08, on a four-day-old thread where Carl at Brava had sent
 * his windows and the invite was Alex's to send: "How could I have this more
 * highly posted in the brief, or even better sit in the outbox as a draft
 * automagically."
 *
 * The existing rule covers the other direction — someone asks when he is free
 * and `availability.mjs` offers three slots. This is the mirror, and it is the
 * commoner shape: the other side names windows, and he owes a pick, a
 * confirmation and an invite. The judgement — reading "Wednesday any time
 * before 15:00, or Thursday any time after 11:00" out of a message — belongs
 * to the triage, which records it as structured windows. Everything after that
 * is arithmetic and lives here: which window is actually free on his calendar,
 * and the sentence that answers it.
 *
 *   node deploy/scheduling.mjs --windows '[{"date":"2026-09-09","before":"15:00"}]' \
 *                              [--len 45] [--who "Carl"] [--what "the Brava intro call"]
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK } from './availability.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** A window's usable span on that day, inside working hours. Exported for the tests. */
export function span(w, work = WORK) {
  const from = Math.max(mins(w.after ?? work.start), mins(work.start));
  const to = Math.min(mins(w.before ?? work.end), mins(work.end));
  return to - from >= 0 ? { date: w.date, from, to } : null;
}

/** The day's busy blocks, from the calendar's own shape. Exported for the tests. */
export function busyOn(events, date) {
  return (events ?? [])
    .filter((e) => (e.startsOn ?? String(e.startsAt ?? '').slice(0, 10)) === date)
    .map((e) => (e.allDay || !e.startsAt
      ? { from: 0, to: 24 * 60, allDay: true, summary: e.summary }
      : { from: mins(String(e.startsAt).slice(11, 16) || e.startsAt), to: mins(String(e.endsAt ?? '').slice(11, 16) || e.endsAt || e.startsAt), summary: e.summary }))
    .sort((a, b) => a.from - b.from);
}

/**
 * The first slot of `len` minutes that fits inside one of the windows and
 * clashes with nothing. Windows are tried in the order they were offered,
 * which is the order the other person put them in.
 */
export function pick(windows, events, { len = 30, pad = 10, work = WORK } = {}) {
  const tried = [];
  for (const w of windows ?? []) {
    const s = span(w, work);
    if (!s) { tried.push({ date: w.date, why: 'outside working hours' }); continue; }
    const busy = busyOn(events, s.date);
    if (busy.some((b) => b.allDay && /out|away|trip|vacation/i.test(b.summary ?? ''))) { tried.push({ date: s.date, why: 'away that day' }); continue; }
    let at = s.from;
    for (const b of busy) {
      if (b.allDay) continue;
      if (at + len <= b.from - pad) break;                 // it fits before this one
      at = Math.max(at, b.to + pad);
    }
    if (at + len <= s.to) return { date: s.date, start: hhmm(at), end: hhmm(at + len), day: DAYS[new Date(`${s.date}T12:00:00`).getDay()], tried };
    tried.push({ date: s.date, why: 'nothing free in that window' });
  }
  return { none: true, tried };
}

/** The reply, in his voice: one line, the time named, and what happens next. */
export function reply(slot, { who = null, what = 'the call', invite = true } = {}) {
  if (slot?.none) return null;
  const when = `${slot.day} at ${slot.start.replace(/^0/, '')}`;
  return `${who ? who + ' — ' : ''}${when} works for ${what}. ${invite ? 'Sending an invite now.' : ''}`.trim();
}

export async function suggest(vault = OBLIGATIONS, windows, opts = {}) {
  let cal = {};
  try { cal = JSON.parse(await readFile(join(vault, 'integrations', 'calendar.json'), 'utf8')); } catch {}
  const events = [...(cal.today ?? []), ...(cal.upcoming ?? [])];
  const slot = pick(windows, events, opts);
  return { slot, text: reply(slot, opts), events: events.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv;
  const flag = (n, d = null) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
  try {
    const windows = JSON.parse(flag('--windows') ?? '[]');
    const r = await suggest(OBLIGATIONS, windows, { len: Number(flag('--len', 30)), who: flag('--who'), what: flag('--what', 'the call') });
    if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
    if (r.slot.none) {
      console.log('nothing free in the windows offered:');
      for (const t of r.slot.tried) console.log(`  ${t.date}  ${t.why}`);
      process.exit(1);
    }
    console.log(`${r.slot.date} ${r.slot.start}–${r.slot.end} (${r.slot.day})`);
    console.log(r.text);
  } catch (err) { console.error(`scheduling: ${err.message}`); process.exit(1); }
}
