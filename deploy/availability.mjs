#!/usr/bin/env node
/**
 * When is he free — the slots a scheduling reply offers.
 *
 * Alex, 2026-09-05, re-audit: "It can't schedule on your behalf. 10 judged
 * threads ask about your availability and every one was answered by hand or not
 * at all." A chief of staff reads the calendar, proposes three slots in his
 * voice, and drafts the reply. Every piece existed — calendar read, mail drafts,
 * the approval card — and nothing joined them. This is the arithmetic half.
 *
 * Free = working hours on a weekday, minus his own timed events, minus days he
 * is away (a trip in bookings.md or a multi-day calendar entry), minus all-day
 * entries on HIS calendar that read as blocking (travel, out of office). Other
 * people's calendars do not block him unless they are a trip — "Mom works" is
 * information for the brief, not a hold on his morning.
 *
 * Read-only. The judgement — which three of these to offer, to whom, in what
 * words — is the triage's, which calls this and drafts. The draft is his to send.
 *
 *   node deploy/availability.mjs                    # next 5 working days, 30-min slots
 *   node deploy/availability.mjs --days 10 --len 60 --count 5 --json
 */
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trips, calendarTrips } from './conflicts.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORK = { start: '09:00', end: '17:00' };     // his working window, local
const BLOCKING_ALLDAY = /travel|flight|out of office|ooo|away|vacation|holiday|trip/i;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ms = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };
const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const at = (date, hm) => { const [h, m] = hm.split(':').map(Number); const d = new Date(`${date}T00:00:00`); d.setHours(h, m, 0, 0); return d.getTime(); };

/**
 * Free slots, pure. `events` are calendar records; `trs` are trip windows.
 * Returns [{date, start, end, minutes}] of the whole free gaps, not chopped —
 * chopping into 30-minute pieces is the caller's choice (see `chop`).
 */
export function freeGaps({ now, days = 5, events = [], trs = [], work = WORK, minMinutes = 30 }) {
  const out = [];
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let d = new Date(start), counted = 0;
  while (counted < days && d.getTime() < start.getTime() + 40 * 86400000) {
    const date = iso(d);
    const dow = d.getDay();
    d = new Date(d.getTime() + 86400000);
    if (dow === 0 || dow === 6) continue;                                   // weekends
    counted++;
    if (trs.some((t) => t.from && t.to && date >= t.from && date <= t.to)) continue;   // away
    const dayEvents = events.filter((e) => (e.startsOn || String(e.startsAt ?? '').slice(0, 10)) === date && e.mine !== false);
    if (dayEvents.some((e) => e.allDay && BLOCKING_ALLDAY.test(e.summary ?? ''))) continue;
    // Busy intervals from his timed events, clipped to the working window.
    const busy = dayEvents.filter((e) => e.startsAt && e.endsAt)
      .map((e) => [ms(e.startsAt), ms(e.endsAt)]).filter(([s, t]) => t > s)
      .sort((a, b) => a[0] - b[0]);
    let cursor = Math.max(at(date, work.start), now);                        // never offer the past
    const close = at(date, work.end);
    for (const [s, t] of busy) {
      if (t <= cursor) continue;
      if (s > cursor) push(date, cursor, Math.min(s, close));
      cursor = Math.max(cursor, t);
      if (cursor >= close) break;
    }
    if (cursor < close) push(date, cursor, close);
  }
  function push(date, s, t) {
    const mins = Math.round((t - s) / 60000);
    if (mins >= minMinutes) out.push({ date, start: hhmm(s), end: hhmm(t), minutes: mins, startMs: s, endMs: t });
  }
  return out;
}

/** Chop gaps into offerable slots of `len` minutes, at most `count`, spread across days. */
export function chop(gaps, { len = 30, count = 3 } = {}) {
  const slots = [];
  for (const g of gaps) {
    for (let s = g.startMs; s + len * 60000 <= g.endMs; s += len * 60000) {
      slots.push({ date: g.date, start: hhmm(s), end: hhmm(s + len * 60000) });
    }
  }
  // Spread: one per day first, then fill. Three slots on one morning is not a
  // choice; three days is.
  const byDay = new Map();
  for (const s of slots) { if (!byDay.has(s.date)) byDay.set(s.date, []); byDay.get(s.date).push(s); }
  const out = [];
  const queues = [...byDay.values()];
  while (out.length < count && queues.some((q) => q.length)) {
    for (const q of queues) { if (out.length >= count) break; const s = q.shift(); if (s) out.push(s); }
  }
  return out;
}

/** "Tue 8 Sep 10:00–10:30" — the form a reply uses. */
export function say(slot) {
  // Hand-formatted: toLocaleDateString gave "Sept" on one runtime and "Sep" on
  // another, and a container without ICU gives something else again.
  const d = new Date(`${slot.date}T12:00:00`);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${slot.start}–${slot.end}`;
}

export async function availability(vault = OBLIGATIONS, { days = 5, len = 30, count = 3, now = Date.now() } = {}) {
  let cal;
  try { cal = JSON.parse(await readFile(join(vault, 'integrations', 'calendar.json'), 'utf8')); }
  catch (err) { return { slots: [], gaps: [], error: `calendar.json unreadable: ${err.message}` }; }
  if (cal.error) return { slots: [], gaps: [], error: `calendar: ${cal.error}` };
  const events = [...(cal.today ?? []), ...(cal.upcoming ?? [])];
  const trs = [...(await trips(vault)), ...calendarTrips(events)];
  const gaps = freeGaps({ now, days, events, trs, minMinutes: len });
  const slots = chop(gaps, { len, count });
  return { slots, gaps, prose: slots.map(say), timezone: cal.timezone ?? null, error: null,
           checked: { days, events: events.length, trips: trs.length } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await availability(OBLIGATIONS, { days: Number(flag('days', 5)), len: Number(flag('len', 30)), count: Number(flag('count', 3)) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  if (r.error) { console.log(r.error); process.exit(0); }
  console.log(`free (${r.checked.days} working days, ${r.checked.events} events, ${r.checked.trips} trips${r.timezone ? ', ' + r.timezone : ''}):`);
  for (const g of r.gaps) console.log(`  ${g.date}  ${g.start}–${g.end}  (${g.minutes} min)`);
  console.log(`\noffer: ${r.prose.join(' · ') || 'nothing in the window'}`);
}
