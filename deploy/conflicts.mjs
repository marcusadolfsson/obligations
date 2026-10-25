#!/usr/bin/env node
/**
 * Cross-source conflict detection: things that are only wrong when you look at
 * two sources at once.
 *
 * Alex, 2026-09-05: "Let's add cross-source conflict detection."
 *
 * The case that named this already happened by hand. A mail run noticed that
 * "Meet the City Council Candidates, Tue 2026-09-22 17:00" sits inside his own
 * 2026-09-22 → 09-27 Pinecrest aircraft booking. Neither fact is wrong. The
 * calendar is right, the trip is right, and every surface in this system would
 * show both without comment, because each is only visible to the source that
 * owns it. A person reading both at once sees it in a second.
 *
 * This is arithmetic, so it is code — the repo's standing division, and the
 * reason this is a script and not a paragraph in a job prompt. A model asked to
 * "look for conflicts" finds different ones each morning and cannot be tested;
 * a date-overlap check finds the same ones every time and fails loudly when the
 * parsing breaks.
 *
 * Four kinds, each needing two sources:
 *
 *   AWAY      a dated commitment lands inside a trip window
 *             (tasks.mjs + reference/bookings.md)
 *   CLASH     two of his own calendar events overlap
 *             (calendar.json against itself, but across calendars)
 *   PROMISED  something he said he would do, still not on any list
 *             (journal "## Said I'd do" + tasks.mjs + logbook.md)
 *   CROWDED   several hard deadlines land on one day
 *             (tasks.mjs against itself, across sources)
 *
 * Read-only. It closes nothing, writes nothing, and pushes nothing — it reports,
 * and the brief decides what is worth his attention.
 *
 *   node deploy/conflicts.mjs           # human-readable
 *   node deploy/conflicts.mjs --json
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listObligations, sortObligations } from './agent-service/obligations.mjs';
// Import-free on purpose: bookings-events.mjs imports gym.mjs, which imports
// this file, so importing the parse from there deadlocked the whole check.
import { parseBookings } from './bookings-parse.mjs';
const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

/** A bare local stamp to epoch ms. Same shape as everywhere else here. */
function ms(s) {
  const t = Date.parse(String(s ?? '').trim().replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}
/** Midnight of the day a stamp falls on, so day-level overlaps are inclusive. */
const dayOf = (s) => { const t = ms(s); return t ? ms(String(s).slice(0, 10)) : 0; };

/* ---------------------------------------------------------------- sources */

/**
 * Trips, from the `##` headings in reference/bookings.md.
 *
 * The date range lives in the heading — "## Pinecrest · 2026-09-22 → 2026-09-27" —
 * which is also what the reference page groups by, so there is one place to fix
 * and no second file to drift. Headings without a range ("dates not chosen")
 * are skipped rather than guessed at: a trip with no dates cannot collide with
 * anything, and inventing a window would manufacture conflicts.
 */
export async function trips(vault = OBLIGATIONS) {
  let text;
  try { text = await readFile(join(vault, 'reference', 'bookings.md'), 'utf8'); }
  catch { return []; }

  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.*)$/);
    if (!m) continue;
    const range = m[1].match(/(\d{4}-\d{2}-\d{2})\s*(?:→|->|—|-)\s*(\d{4}-\d{2}-\d{2})/);
    const single = !range && m[1].match(/(\d{4}-\d{2}-\d{2})/);
    // `source: 'bookings'` says the name is a heading in this file, which is
    // what a booking marker's hash was built from. Only those can be matched
    // against the marker map — see awayConflicts.
    if (range) out.push({ name: m[1].split('·')[0].trim(), from: range[1], to: range[2], source: 'bookings' });
    else if (single) out.push({ name: m[1].split('·')[0].trim(), from: single[1], to: single[1], source: 'bookings' });
  }
  return out;
}

/**
 * The merged obligation list.
 *
 * From obligations.mjs directly, which is what deploy/tasks.mjs is itself a CLI
 * over — so this is the same merge, not a second one. It was shelling out to
 * `tasks.mjs --json` and silently getting a truncated capture (255KB of a 295KB
 * document), which parsed as a syntax error and reported the whole check as
 * blind. The JSON was fine; the subprocess was the bug. Calling the module is
 * both correct and cheaper.
 */
/**
 * Every booking marker on the calendar, mapped to the trip heading it came from.
 *
 * `bookings-events.mjs` stamps each entry it makes with
 * `booking:sha1(trip|date|title)`, so the trip is recoverable by recomputing the
 * hash over the same source. That is why this reads `bookings.md` and rebuilds
 * the markers rather than trusting the calendar: the marker itself is a bare
 * hash and says nothing about which trip it belongs to.
 *
 * Keyed twice: by marker, and by `day|title`. The marker alone is not enough —
 * the hash covers the title, so editing a booking's wording orphans the marker
 * on an event already sitting in the calendar. That is not hypothetical: the
 * PHOA evenings were placed under titles that have since been reworded, so
 * marker lookup alone found nothing and the check stayed silent. Day and title
 * are what `bookings-events.mjs` itself falls back on for the same reason.
 *
 * Anything still unfound is one whose source line is gone entirely. Those keep
 * the old behaviour — treated as their own trip's and skipped — because a
 * marker with no line behind it is not evidence of a clash.
 */
export const bookingKey = (day, title) =>
  `${String(day ?? '').slice(0, 10)}|${String(title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;

export async function bookingTrips(vault = OBLIGATIONS) {
  const map = new Map();
  let text;
  try { text = await readFile(join(vault, 'reference', 'bookings.md'), 'utf8'); }
  catch { return map; }
  for (const b of parseBookings(text)) {
    if (!b.trip?.name) continue;
    if (b.marker) map.set(b.marker, b.trip.name);
    map.set(bookingKey(b.date, b.title), b.trip.name);
  }
  return map;
}

/**
 * Trips as the calendar knows them: any entry spanning more than one day.
 *
 * The case that named this feature — "still inside your 9/22–9/27 Pinecrest
 * aircraft booking" — is not in reference/bookings.md at all. Aircraft
 * availability lives on its own calendar, and CLAUDE.md already says both
 * aircraft calendars are his business. A trip source that only read bookings.md
 * would have missed the one example we started from.
 */
export function calendarTrips(evts) {
  const out = [];
  for (const e of evts ?? []) {
    // A booking is something INSIDE a trip, never a trip. The assistant writes
    // multi-day bookings — a hotel stay, a rental car — to the calendar itself,
    // and reading one back as a trip creates a second window identical to the
    // one bookings.md already describes, so every conflict in it is reported
    // twice. The Summit Lodge Pinecrest stay (09-24 → 09-29) did exactly that on
    // 2026-09-18: 31 AWAY hits, 27 of them one real conflict counted twice.
    if (String(e.obligations ?? '').startsWith('booking:')) continue;
    const from = evStartDay(e), to = evEndDay(e);
    if (!from || !to || from === to) continue;
    out.push({ name: e.summary ?? '(untitled)', from, to, calendar: e.calendar ?? null });
  }
  return out;
}

export async function tasks(vault = OBLIGATIONS) {
  try {
    // Open only. listObligations returns the closed ones too — 964 against the
    // 176 the tasks page shows — and a conflict about something already done is
    // noise of exactly the kind that stops a brief being read.
    return sortObligations(await listObligations(vault)).filter((o) => o.open !== false);
  } catch (err) {
    // null, not [] — see the report below. An unreadable source is not an
    // absence of conflicts, and the reason is kept so it is diagnosable.
    tasks.error = String(err?.message ?? err).split('\n')[0];
    return null;
  }
}

/* The calendar's own field names. This mattered more than it looks: the first
 * version read `start`/`end`/`at`, none of which exist on these records — so
 * every calendar check ran, matched nothing, and reported no conflicts. A check
 * looking at a field that does not exist is indistinguishable from a clean
 * result, which is the failure this repo keeps writing guards against. The
 * report below now counts how many events yielded a usable date and says so
 * when the answer is none.
 *
 * `startsOn`/`endsOn` are dates (all-day entries); `startsAt`/`endsAt` are
 * stamps. Day-level checks want the former, overlap wants the latter. */
export const evStartDay = (e) => e?.startsOn || String(e?.startsAt ?? '').slice(0, 10) || '';
export const evEndDay = (e) => e?.endsOn || String(e?.endsAt ?? '').slice(0, 10) || evStartDay(e);

/** Calendar events, today and ahead. */
export async function events(vault = OBLIGATIONS) {
  try {
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'calendar.json'), 'utf8'));
    if (d.error) return null;
    return [...(d.today ?? []), ...(d.upcoming ?? [])];
  } catch {
    return null;
  }
}

/**
 * Commitments in his own words, from the journal's `## Said I'd do` sections.
 *
 * Only the last `days` of journal are read. This is the one source with no
 * structure behind it — a line here is a sentence he said, not a record with an
 * id — so it can only ever be matched loosely, and the check below is written
 * to under-report rather than nag.
 */
export async function promises(vault = OBLIGATIONS, days = 14) {
  const dir = join(vault, 'journal');
  let names;
  try { names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort(); }
  catch { return []; }

  const cutoff = Date.now() - days * DAY;
  const out = [];
  for (const name of names) {
    const date = name.slice(0, 10);
    if (ms(date) < cutoff) continue;
    let text;
    try { text = await readFile(join(dir, name), 'utf8'); } catch { continue; }
    const section = text.split(/^##\s+/m).find((s) => /^Said I'?d do/i.test(s));
    if (!section) continue;
    for (const line of section.split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (m) out.push({ date, text: m[1] });
    }
  }
  return out;
}

/* -------------------------------------------------------------- the checks */

/** Words worth matching on — drops the filler that would match anything. */
const STOP = new Set(['will', 'the', 'and', 'for', 'that', 'with', 'you', 'your', 'this',
  'have', 'from', 'they', 'need', 'want', 'into', 'about', 'send', 'make', 'take', 'said',
  'told', 'going', 'need', 'a', 'an', 'to', 'of', 'in', 'on', 'it', 'is', 'be', 'do']);
const keywords = (s) => [...new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) ?? [])]
  .filter((w) => !STOP.has(w));

const LEG = /\b([A-Z]{3,4})\s*(?:→|->)\s*([A-Z]{3,4})\b/g;

/** Whether a booking-marked event belongs to trip `t` — see awayConflicts. */
function ownBooking(e, t, bookingTrip) {
  const marker = String(e.obligations ?? '');
  if (!marker.startsWith('booking:')) return false;
  if (!bookingTrip || t.source !== 'bookings') return true;
  const owner = bookingTrip.get(marker) ?? bookingTrip.get(bookingKey(evStartDay(e), e.summary ?? e.title));
  return owner === undefined || owner === t.name;
}

/**
 * A dated obligation, or a calendar event, that lands inside a trip.
 *
 * Both ends are inclusive and compared at day granularity: arriving on the 22nd
 * and a 17:00 event on the 22nd is exactly the collision worth naming, and an
 * hours-based comparison would miss it.
 */
export function awayConflicts(items, evts, trs, bookingTrip = null) {
  const out = [];
  for (const t of trs) {
    const from = dayOf(t.from), to = dayOf(t.to);
    if (!from || !to) continue;
    for (const it of items ?? []) {
      const d = dayOf(it.due);
      if (!d || d < from || d > to) continue;
      out.push({ kind: 'AWAY', trip: t.name, when: iso(d),
                 what: it.title, why: `due while you are away (${t.from} → ${t.to})`,
                 source: 'tasks + bookings', id: it.id });
    }
    // His own entry for a flight the assistant also wrote from bookings is the
    // same flight. "Flight to Riverton (CA 1032)" at Milton MLT on 2026-10-24 was
    // reported as a clash with the N200BB drop-off whose return leg it was
    // (MLT → SPX). Only codes from an "XXX → YYY" pair count, so a dinner or a
    // call on the same day still collides.
    const legs = new Map();
    for (const e of evts ?? []) {
      if (!ownBooking(e, t, bookingTrip)) continue;
      const day = String(evStartDay(e) ?? '').slice(0, 10);
      for (const m of String(e.summary ?? e.title ?? '').matchAll(LEG)) {
        if (!legs.has(day)) legs.set(day, new Set());
        legs.get(day).add(m[1]).add(m[2]);
      }
    }
    for (const e of evts ?? []) {
      // An event the assistant wrote from a booking IS the trip — the flight, the
      // hotel, the park day. Reading it back as a commitment during the trip
      // produced 22 conflicts in one evening brief, every one of them noise.
      //
      // But only its OWN trip's bookings are the trip. `bookingTrip` maps each
      // marker back to the heading it came from, so a booking under one trip is
      // still a commitment during another. Alex extended Pinecrest by two days on
      // 2026-09-15 and it swallowed a PHOA evening in Springfield on the
      // 28th; that evening is booking-marked, so the check skipped it and the
      // run came back clean on the largest clash in the calendar. Without the
      // map the old behaviour stands — skip every booking — because a caller
      // that cannot say which trip a marker belongs to must not start guessing.
      //
      // Only a trip that came from a bookings.md heading can be matched this
      // way, because the heading IS what the hash was built over. A trip
      // inferred from a multi-day calendar entry has an event summary for a
      // name, which matches no heading — so every booking would look foreign to
      // it and the old 22-conflict evening would come straight back. Those keep
      // the blanket skip.
      if (ownBooking(e, t, bookingTrip)) continue;
      const d = dayOf(evStartDay(e));
      if (!d || d < from || d > to) continue;
      const codes = legs.get(String(evStartDay(e) ?? '').slice(0, 10));
      if (codes) {
        const words = `${e.summary ?? e.title ?? ''} ${e.location ?? ''}`.match(/\b[A-Z]{3,4}\b/g) ?? [];
        if (words.some((w) => codes.has(w))) continue;
      }
      out.push({ kind: 'AWAY', trip: t.name, when: iso(d),
                 what: e.summary ?? e.title ?? '(untitled event)',
                 why: `on the calendar while you are away (${t.from} → ${t.to})`,
                 source: 'calendar + bookings' });
    }
  }
  return out;
}

/** Two events that overlap in time. Cross-calendar is the interesting case. */
export function clashConflicts(evts) {
  const out = [];
  const timed = (evts ?? [])
    // Timed events only. An all-day entry has no start time and would
    // "overlap" everything else that day, which is not a clash — it is a
    // Tuesday.
    .map((e) => ({ e, s: ms(e.startsAt), t: ms(e.endsAt) }))
    .filter((x) => x.s);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i], b = timed[j];
      // An all-day entry has no end and would otherwise "overlap" everything.
      if (a.t <= a.s || b.t <= b.s) continue;
      if (a.s < b.t && b.s < a.t) {
        out.push({ kind: 'CLASH', when: iso(a.s),
                   what: `${a.e.summary ?? 'event'} overlaps ${b.e.summary ?? 'event'}`,
                   why: 'two things at the same time',
                   source: 'calendar' });
      }
    }
  }
  return out;
}

/**
 * Something he said he would do that is on no list.
 *
 * Deliberately conservative. A promise is matched against every open obligation
 * and every logbook line by keyword overlap; anything with a plausible match is
 * dropped. The compaction routine already sweeps for dropped balls and this
 * runs three times a day, so a false positive is a daily nag about something
 * already handled — far worse here than a miss.
 */
export function promisedConflicts(proms, items, logbook, { minAgeDays = 2 } = {}) {
  const out = [];
  const openText = (items ?? []).map((i) => `${i.title} ${i.what ?? ''}`.toLowerCase());
  const log = String(logbook ?? '').toLowerCase();
  const cutoff = Date.now() - minAgeDays * DAY;

  for (const p of proms) {
    if (ms(p.date) > cutoff) continue;         // give him a couple of days first
    const words = keywords(p.text);
    if (words.length < 2) continue;            // too vague to match on, so do not try
    const hit = (hay) => words.filter((w) => hay.includes(w)).length >= 2;
    if (openText.some(hit) || hit(log)) continue;
    out.push({ kind: 'PROMISED', when: p.date, what: p.text,
               why: `said on ${p.date}, and on no list since`,
               source: 'journal + tasks + logbook' });
  }
  return out;
}

/** Three or more hard deadlines on one day. */
export function crowdedDays(items, { at = 3 } = {}) {
  const byDay = new Map();
  for (const it of items ?? []) {
    const d = dayOf(it.due);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(it);
  }
  return [...byDay.entries()]
    .filter(([, xs]) => xs.length >= at)
    .map(([d, xs]) => ({ kind: 'CROWDED', when: iso(d),
                         what: `${xs.length} things due`,
                         why: xs.map((x) => x.title).slice(0, 4).join('; '),
                         source: 'tasks' }));
}

/* -------------------------------------------------------------- the report */

export async function conflicts(vault = OBLIGATIONS, { ahead = 45 } = {}) {
  const [booked, items, evts, proms, bookingTrip] = await Promise.all([
    trips(vault), tasks(vault), events(vault), promises(vault), bookingTrips(vault),
  ]);
  const trs = [...booked, ...calendarTrips(evts)];
  let logbook = '';
  try { logbook = await readFile(join(vault, 'logbook.md'), 'utf8'); } catch { /* fine */ }

  /* A source that could not be read is NOT an absence of conflicts. Saying "no
   * conflicts" when the calendar failed to load is the exact lie the pipeline
   * guards exist to prevent, so it is reported instead of swallowed. */
  const blind = [];
  if (items === null) blind.push('tasks.mjs did not run — obligations not checked');
  if (evts === null) blind.push('calendar.json unreadable — events not checked');
  if (!trs.length) blind.push('no dated trips in bookings.md or on the calendar');
  // A field-name change upstream would otherwise turn every calendar check into
  // a silent no-op. Absence gets a number.
  if (evts?.length && !evts.some((e) => evStartDay(e))) {
    blind.push(`${evts.length} events carry no readable date — the calendar field names have changed`);
  }

  const horizon = Date.now() + ahead * DAY;
  const found = [
    ...awayConflicts(items, evts, trs, bookingTrip),
    ...clashConflicts(evts),
    ...promisedConflicts(proms, items, logbook),
    ...crowdedDays(items),
  ].filter((c) => c.kind === 'PROMISED' || ms(c.when) <= horizon)
   .sort((a, b) => ms(a.when) - ms(b.when));

  return { generated_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
           count: found.length, blind, conflicts: found,
           checked: { trips: trs.length, tripsFromCalendar: calendarTrips(evts).length,
                      obligations: items?.length ?? 0,
                      events: evts?.length ?? 0, promises: proms.length } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await conflicts();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const c = out.checked;
    console.log(`checked ${c.obligations} obligations, ${c.events} events, `
              + `${c.trips} trips, ${c.promises} stated commitments`);
    for (const b of out.blind) console.log(`  ! ${b}`);
    if (!out.conflicts.length) console.log('\nnothing crossed.');
    for (const x of out.conflicts) {
      console.log(`\n${x.kind}  ${x.when}\n  ${x.what}\n  ${x.why}  [${x.source}]`);
    }
  }
}
