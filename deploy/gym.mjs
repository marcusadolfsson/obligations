#!/usr/bin/env node
/**
 * Gym blocks: Monday and Thursday, 09:00–10:00, only when he is in town.
 *
 * "Gym — Mia & Alex" since 2026-09-10, at his ask. It had read "Gym — Mia"
 * from the day it was built, which was true when the block was her session and
 * stopped being true the day before, when two times in one of Pete's texts
 * turned out to mean one session each and they go together.
 *
 * Alex, 2026-09-05: "Mia and I train at the gym every Monday and Thursday.
 * Around 9:10–9:30 for 30 min. I need to block 9–10am on my calendar those
 * days, but only if I am in town. Pete Rourke usually texts day before with the
 * start time. Once we have the time, correct the calendar entry."
 *
 * Three pieces, two of them here:
 *
 *   PLAN   `node deploy/gym.mjs`           — for the next 7 days, create a block
 *          on each Mon/Thu that has none and does not fall inside a trip. Trips
 *          are what conflicts.mjs already knows: reference/bookings.md headings
 *          and multi-day calendar entries. "In town" is not a new fact, it is
 *          the absence of an AWAY window.
 *   SET    `node deploy/gym.mjs --set 2026-09-08 09:20`          one session, an hour
 *          `node deploy/gym.mjs --set 2026-09-10 09:20 09:30`  both of them, 09:20–10:00
 *                                           — move that day's block to start at
 *          the time Pete gave; the end follows, one hour later.
 *   (judgement — reading Pete's text and deciding it names a start time — stays
 *   with the message triage, which calls SET. This file only does arithmetic.)
 *
 * Idempotent: every block it makes carries the marker `gym:<date>`, and PLAN
 * skips a date that already has one. Running it every Sunday, or every day,
 * creates nothing twice. It never deletes: if a trip appears after a block was
 * made, the AWAY conflict surfaces it in the brief and he decides.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertEvent, patchEvent, findMarked } from './integrations/calendar-write.mjs';
import { trips, events, calendarTrips } from './conflicts.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GYM_TITLE = 'Gym — Mia & Alex';
export const DAYS = [1, 4];                 // Mon, Thu (JS getDay)
export const START = '09:00', END = '10:00';
const DRY = process.argv.includes('--dry');

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A local wall-clock stamp with the box's offset, which is what the API wants. */
export function localDateTime(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${date}T00:00:00`); d.setHours(h, m, 0, 0);
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  return `${date}T${pad(h)}:${pad(m)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
export function plusMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}

/** The Mon/Thu dates in the next `days`, and whether each is inside a trip. Pure. */
export function planDates(now, trs, { days = 7 } = {}) {
  const out = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(0, 0, 0, 0);
    if (!DAYS.includes(d.getDay())) continue;
    const date = isoDate(d);
    const away = trs.find((t) => t.from && t.to && date >= t.from && date <= t.to);
    out.push({ date, away: away ? away.name : null });
  }
  return out;
}

export async function plan(vault = OBLIGATIONS, now = new Date()) {
  const evts = await events(vault);
  const trs = [...(await trips(vault)), ...calendarTrips(evts)];
  const wanted = planDates(now, trs);
  const have = new Set((await findMarked(vault, 'gym:')).map((e) => e.marker));
  const made = [], skipped = [];
  for (const w of wanted) {
    if (have.has(`gym:${w.date}`)) { skipped.push({ ...w, why: 'already blocked' }); continue; }
    if (w.away) { skipped.push({ ...w, why: `away — ${w.away}` }); continue; }
    if (DRY) { made.push({ ...w, dry: true }); continue; }
    const r = await insertEvent(vault, {
      summary: GYM_TITLE, location: '', marker: `gym:${w.date}`,
      description: 'Blocked by the assistant. Pete Rourke usually texts the start time the day before; the block moves to match.',
      start: localDateTime(w.date, START), end: localDateTime(w.date, END),
      reminders: 15,          // a popup: this one he wants nudged for
    });
    made.push({ ...w, id: r.id });
  }
  return { made, skipped };
}

/**
 * The block a pair of times means. Pure, so the rule is testable.
 *
 * Alex, 2026-09-09: "two times means one for each of us. we go together so
 * the calendar should be from the first one, to the later one + 30 min."
 *
 * This reverses the reading that stood from 2026-08-30, where two times in one
 * of Pete's texts was taken as Mia's drop-off window and the block was left
 * alone. Under that rule the assistant sat on "930 & 940" on the 8th and "920 &
 * 930" on the 9th and moved nothing, so his own morning stayed at 09:00 twice
 * while the sessions were at 09:20 and 09:30.
 *
 * One time is still one session and still an hour — that half never changed.
 */
export function blockFor(times) {
  const hhmm = [...new Set(times)].filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => (t.length === 4 ? '0' + t : t)).sort();
  if (!hhmm.length) return null;
  if (hhmm.length === 1) return { start: hhmm[0], end: plusMinutes(hhmm[0], 60) };
  return { start: hhmm[0], end: plusMinutes(hhmm[hhmm.length - 1], 30) };
}

/** Move one day's block. One time gives an hour; several span first to last + 30. */
export async function setTime(vault = OBLIGATIONS, date, ...times) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('usage: --set YYYY-MM-DD HH:MM [HH:MM]');
  const span = blockFor(times);
  if (!span) throw new Error('usage: --set YYYY-MM-DD HH:MM [HH:MM]');
  const block = (await findMarked(vault, `gym:${date}`))[0];
  if (!block) return { moved: false, why: `no gym block on ${date} — is he away, or is it not a Mon/Thu?` };
  if (DRY) return { moved: false, dry: true, would: span };
  const r = await patchEvent(vault, block.id, {
    start: { dateTime: localDateTime(date, span.start) }, end: { dateTime: localDateTime(date, span.end) },
  });
  return { moved: true, id: r.id, ...span };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--set');
  try {
    if (i > 0) {
      // Every time after the date, so `--set 2026-09-10 09:20 09:30` reads the
      // way Pete writes it: "920 & 930 tomorrow".
      const times = process.argv.slice(i + 2).filter((a) => /^\d{1,2}:\d{2}$/.test(a));
      console.log(JSON.stringify(await setTime(OBLIGATIONS, process.argv[i + 1], ...times)));
    } else {
      const r = await plan();
      for (const m of r.made) console.log(`${m.dry ? 'would block' : 'blocked'}  ${m.date}  ${START}–${END}`);
      for (const s of r.skipped) console.log(`skipped      ${s.date}  ${s.why}`);
      if (!r.made.length && !r.skipped.length) console.log('no Mon/Thu in the next 7 days (impossible — check the clock)');
    }
  } catch (err) {
    console.error(`gym: ${err.message}`);
    process.exit(1);
  }
}
