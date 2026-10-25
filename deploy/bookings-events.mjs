#!/usr/bin/env node
/**
 * Bookings onto the calendar, without reminders.
 *
 * Alex, 2026-09-05: "can we add calendar entries for all the Funland stuff, but
 * set them without reminders. How can we make that happen automatically?"
 *
 * The automation is already half built: the mail job files every reservation,
 * confirmation and ticket into reference/bookings.md under a `## Trip · from →
 * to` heading, as dated lines. This turns those lines into calendar events and
 * runs after the mail job (and nightly), so a confirmation that lands at 14:00
 * is on the calendar by the next mail run. Nothing new has to be judged — the
 * judgement that "this is a booking" was made once, when it was filed.
 *
 * Reminders off, always. A booking is a fact about where he will be, not a
 * thing to be nudged about; the trip's own emails and tickets do the nudging,
 * and eleven Funland pings on a Sunday morning is the opposite of a chief of
 * staff. (The gym block keeps its popup — that one he asked to be nudged for.)
 *
 * Idempotent by marker `booking:<hash of trip + day + title>`, so an edit to a
 * line's description is the same booking. (It hashed the whole line until
 * 2026-09-06, when an edit cloned an event.) The old event stays until the duplicate scan or
 * he removes it — this never deletes. Struck lines (~~cancelled~~) are skipped.
 *
 *   node deploy/bookings-events.mjs [--dry] [--all]     # default: trips not yet over
 */
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertEvent, findMarked, listEvents } from './integrations/calendar-write.mjs';
import { norm, words } from './calendar-dupes.mjs';
import { localDateTime } from './gym.mjs';
// The parse is its own import-free module. This file imports gym.mjs, gym.mjs
// imports conflicts.mjs, and conflicts.mjs needs the same parse to tell which
// trip a `booking:` marker came from — importing it from here deadlocked the
// whole conflict check. Re-exported so existing callers and tests keep working.
import { parseBookings } from './bookings-parse.mjs';
export { parseBookings, plusMinutes } from './bookings-parse.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const ALL = process.argv.includes('--all');
const pad = (n) => String(n).padStart(2, '0');
const nextDay = (date) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/**
 * Is this booking already on the calendar as something HE made? Same day, and
 * either the same normalised title or two shared venue words. Gmail's stubs do
 * not count as cover — they are what calendar-dupes removes once the real entry
 * exists — and the assistant's own markers are handled by findMarked. Exported for
 * the tests.
 */
export function alreadyCovered(booking, dayEvents) {
  const bw = words(booking.title);
  return dayEvents.find((e) => {
    if (e.eventType === 'fromGmail' || e.extendedProperties?.private?.obligations || e.status === 'cancelled') return false;
    if (norm(e.summary) === norm(booking.title)) return true;
    const shared = [...words(e.summary)].filter((w) => bw.has(w));
    return shared.length >= 2;
  }) ?? null;
}

export async function run(vault = OBLIGATIONS, { all = ALL, today = new Date().toISOString().slice(0, 10) } = {}) {
  let text;
  try { text = await readFile(join(vault, 'reference', 'bookings.md'), 'utf8'); }
  catch { return { made: [], skipped: [], error: 'reference/bookings.md unreadable' }; }
  const wanted = parseBookings(text).filter((e) => all || (e.kind === 'allday' ? e.until : e.date) >= today);
  const placed = await findMarked(vault, 'booking:');
  const have = new Set(placed.map((e) => e.marker));
  const dayTitle = (d, t) => `${String(d).slice(0, 10)}|${String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const placedByDayTitle = new Set(placed.map((e) => dayTitle(e.start?.date ?? e.start?.dateTime ?? e.startsOn ?? '', e.summary ?? e.title)));
  // Everything already on the calendar in the window, so a booking he added by
  // hand is not doubled. Two PHOA evenings were about to be.
  const dates = wanted.map((e) => e.kind === 'allday' ? e.until : e.date).sort();
  const existing = wanted.length ? await listEvents(vault, {
    timeMin: new Date(`${wanted.map((e) => e.date).sort()[0]}T00:00:00`).toISOString(),
    timeMax: new Date(`${dates[dates.length - 1]}T23:59:59`).toISOString(),
  }) : [];
  const onDay = (date) => existing.filter((x) => (x.start?.date ?? String(x.start?.dateTime ?? '').slice(0, 10)) === date);
  const made = [], skipped = [];
  for (const e of wanted) {
    if (have.has(e.marker) || placedByDayTitle.has(dayTitle(e.date, e.title))) { skipped.push({ ...e, why: 'already on the calendar' }); continue; }
    const twin = alreadyCovered(e, onDay(e.date));
    if (twin) { skipped.push({ ...e, why: `already there as "${twin.summary}"` }); continue; }
    if (DRY) { made.push({ ...e, dry: true }); continue; }
    const r = e.kind === 'allday'
      ? await insertEvent(vault, { summary: e.title, allDay: true, start: e.date, end: nextDay(e.until), description: e.description, marker: e.marker, reminders: 'none' })
      : await insertEvent(vault, { summary: e.title, start: localDateTime(e.date, e.start), end: localDateTime(e.date, e.end), description: e.description, marker: e.marker, reminders: 'none' });
    made.push({ ...e, id: r.id });
  }
  return { made, skipped, error: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await run();
  if (r.error) { console.log(r.error); process.exit(0); }
  for (const m of r.made) console.log(`${m.dry ? 'would add' : 'added   '}  ${m.date}${m.kind === 'timed' ? ` ${m.start}–${m.end}` : m.until !== m.date ? ` → ${m.until}` : ' (all day)'}  ${m.title}  [${m.trip.name}]`);
  for (const s of r.skipped) console.log(`skipped   ${s.date}  ${s.title} — ${s.why}`);
  if (!r.made.length && !r.skipped.length) console.log('no upcoming bookings in reference/bookings.md');
}
