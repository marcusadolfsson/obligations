/**
 * Cross-source conflict detection.
 *
 * The checks that matter here are the ones that stop it crying wolf. A conflict
 * report is read three times a day; one false positive a day and he stops
 * reading it, at which point the true one arrives into a channel nobody opens.
 * So most of this file is "does NOT fire".
 *
 * It also pins the calendar field names. The first version of awayConflicts
 * read `start`/`end`/`at`, none of which exist on a calendar record — every
 * calendar check ran, matched nothing, and reported a clean result. That is the
 * repo's oldest failure shape: a silence indistinguishable from a success.
 */
import {
  awayConflicts, clashConflicts, promisedConflicts, crowdedDays,
  calendarTrips, evStartDay, evEndDay,
} from '../conflicts.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

const PINECREST = { name: 'Pinecrest', from: '2026-09-22', to: '2026-09-27' };

console.log('AWAY — the trip\'s own bookings are not commitments during it');
{
  // bookings-events.mjs writes the flights and the hotel to the calendar with
  // a `booking:` marker; conflicts read them back and reported 22 AWAY hits in
  // one evening brief. The marker is the tell. An unmarked event still counts.
  const own = { summary: 'Flight to Pinecrest', startsOn: '2026-09-22', endsOn: '2026-09-22', obligations: 'booking:abc' };
  const real = { summary: 'Dentist', startsOn: '2026-09-23', endsOn: '2026-09-23', obligations: null };
  const hits = awayConflicts([], [own, real], [PINECREST]);
  check('a booking-marked event is skipped', !hits.some((h) => h.what === 'Flight to Pinecrest'), JSON.stringify(hits));
  check('an unmarked event during the trip is still reported', hits.some((h) => h.what === 'Dentist'), JSON.stringify(hits));
  check('a gym block the assistant wrote is not a booking', awayConflicts([], [{ ...real, obligations: 'gym:2026-09-24' }], [PINECREST]).length === 1);
}

console.log('\nAWAY — but ANOTHER trip\'s booking IS a commitment during this one');
{
  // Alex extended Pinecrest by two days on 2026-09-15 and the window swallowed a
  // PHOA evening in Springfield on the 28th. That evening is on the
  // calendar with a `booking:` marker too — bookings-events.mjs writes every
  // dated line in bookings.md, not only trips — so the blanket skip hid it and
  // the run came back clean on the largest clash in the calendar.
  const PINECREST9 = { name: 'Pinecrest', from: '2026-09-22', to: '2026-09-29', source: 'bookings' };
  const mine = { summary: 'Summit Lodge Pinecrest', startsOn: '2026-09-24', endsOn: '2026-09-24', obligations: 'booking:aaa' };
  const foreign = { summary: 'Meet the Local Candidates', startsOn: '2026-09-28', endsOn: '2026-09-28', obligations: 'booking:bbb' };
  const map = new Map([['booking:aaa', 'Pinecrest'], ['booking:bbb', 'PHOA candidate evenings']]);

  const hits = awayConflicts([], [mine, foreign], [PINECREST9], map);
  check('the trip\'s own booking is still skipped',
        !hits.some((h) => h.what === 'Summit Lodge Pinecrest'), JSON.stringify(hits));
  check('a booking belonging to a DIFFERENT heading is reported',
        hits.some((h) => h.what === 'Meet the Local Candidates'), JSON.stringify(hits));

  check('with no map, nothing changes — the old blanket skip stands',
        awayConflicts([], [mine, foreign], [PINECREST9]).length === 0);

  check('a marker whose source line is gone is treated as the trip\'s own',
        awayConflicts([], [foreign], [PINECREST9], new Map()).length === 0,
        'a stale marker is not evidence of a clash');

  // The regression this guards: a trip inferred from a multi-day calendar entry
  // is named after an event summary, so no booking marker can ever match it.
  // Matching by name there would report every booking as foreign and bring the
  // 22-conflict evening straight back.
  const fromCalendar = { name: 'N200BB — Pinecrest', from: '2026-09-22', to: '2026-09-29' };
  check('a calendar-derived trip keeps the blanket skip',
        awayConflicts([], [mine, foreign], [fromCalendar], map).length === 0,
        JSON.stringify(awayConflicts([], [mine, foreign], [fromCalendar], map)));
}

console.log('\nAWAY — his own entry for the trip\'s flight is the same flight');
{
  // 2026-10-24: the assistant wrote the return leg of the N200BB drop-off from
  // bookings (MLT → SPX), and Alex had his own "Flight to Riverton (CA 1032)"
  // entry at Milton. The evening brief called it a clash and said one of the
  // two was wrong. Both were right; they are one flight.
  const DROP = { name: 'N200BB drop-off at Ellison — Milton, IL', from: '2026-10-24', to: '2026-10-24', source: 'bookings' };
  const leg = { summary: 'MLT → SPX, Coastal Air, itinerary #QX7R2T, seat 4A', startsOn: '2026-10-24', endsOn: '2026-10-24', obligations: 'booking:7bda' };
  const his = { summary: 'Flight to Riverton (CA 1032)', startsOn: '2026-10-24', endsOn: '2026-10-24',
                startsAt: '12:29', endsAt: '15:00', location: 'Milton MLT', obligations: null };
  const dinner = { summary: 'Dinner with Work', startsOn: '2026-10-24', endsOn: '2026-10-24', location: 'Riverton', obligations: null };
  const map = new Map([['booking:7bda', DROP.name]]);

  const hits = awayConflicts([], [leg, his, dinner], [DROP], map);
  check('his entry naming the leg\'s airport is skipped',
        !hits.some((h) => h.what === his.summary), JSON.stringify(hits));
  check('a dinner the same day is still reported',
        hits.some((h) => h.what === dinner.summary), JSON.stringify(hits));

  const DROP2 = { ...DROP, to: '2026-10-25' };
  const moved = { ...his, startsOn: '2026-10-25', endsOn: '2026-10-25' };
  const movedHits = awayConflicts([], [leg, moved], [DROP2], map);
  check('the same entry on a day with no leg is reported',
        movedHits.length === 1, JSON.stringify(movedHits));

  const elsewhere = new Map([['booking:7bda', 'Elsewhere']]);
  const foreignHits = awayConflicts([], [leg, his], [DROP], elsewhere);
  check('another trip\'s leg does not excuse his entry',
        foreignHits.length === 2, JSON.stringify(foreignHits));
}

console.log('\ncalendarTrips — a booking is inside a trip, never a trip itself');
{
  // The mirror of the bug above, found the same week. The assistant writes its own
  // multi-day bookings to the calendar; reading a hotel stay back as a trip
  // makes a second window identical to the one bookings.md already describes,
  // and every conflict inside it is reported twice. The Summit Lodge Pinecrest stay
  // did this on 2026-09-18 — 31 AWAY hits, 27 of them one conflict counted
  // twice — and a report nobody can trust the count of is not a report.
  const hotel = { summary: 'Summit Lodge Pinecrest', startsOn: '2026-09-24', endsOn: '2026-09-29',
                  allDay: true, obligations: 'booking:aaa' };
  const aircraft = { summary: 'N200BB — Pinecrest', startsOn: '2026-09-24', endsOn: '2026-09-29',
                     allDay: true, obligations: null };
  const trips = calendarTrips([hotel, aircraft]);
  check('the hotel stay is not a trip', !trips.some((t) => t.name === 'Summit Lodge Pinecrest'),
        JSON.stringify(trips));
  check('the aircraft booking still is — it is on a calendar, not in bookings.md',
        trips.some((t) => t.name === 'N200BB — Pinecrest'), JSON.stringify(trips));
  check('so one real trip yields one window', trips.length === 1, JSON.stringify(trips));
}

console.log('AWAY — a commitment inside a trip');
{
  // The case this feature was named for.
  const items = [{ id: 'a', title: 'Meet the City Council Candidates', due: '2026-09-22 17:00' }];
  const hits = awayConflicts(items, [], [PINECREST]);
  check('an obligation due mid-trip is found', hits.length === 1, JSON.stringify(hits));
  check('...and it names the trip', hits[0]?.trip === 'Pinecrest');

  // Both ends inclusive: landing on the 22nd and a 17:00 thing on the 22nd is
  // exactly the collision worth naming.
  check('the first day counts',
        awayConflicts([{ id: 'b', title: 'x', due: '2026-09-22 09:00' }], [], [PINECREST]).length === 1);
  check('the last day counts',
        awayConflicts([{ id: 'c', title: 'x', due: '2026-09-27 23:00' }], [], [PINECREST]).length === 1);
  check('the day before does not',
        awayConflicts([{ id: 'd', title: 'x', due: '2026-09-21 23:00' }], [], [PINECREST]).length === 0);
  check('the day after does not',
        awayConflicts([{ id: 'e', title: 'x', due: '2026-09-28 00:01' }], [], [PINECREST]).length === 0);
  check('an undated obligation is never a conflict',
        awayConflicts([{ id: 'f', title: 'x', due: null }], [], [PINECREST]).length === 0);
  check('a trip with no dates cannot collide',
        awayConflicts([{ id: 'g', title: 'x', due: '2026-09-22' }], [],
                      [{ name: 'Japan', from: '', to: '' }]).length === 0);
}

console.log('\nAWAY — the calendar field names, pinned');
{
  // If these ever change upstream, this fails rather than quietly finding
  // nothing. That is the whole point of the block.
  const ev = { summary: 'Council candidates', startsOn: '2026-09-22', endsOn: '2026-09-22' };
  check('evStartDay reads an all-day entry', evStartDay(ev) === '2026-09-22');
  const timed = { summary: 'Call', startsAt: '2026-09-23 14:00', endsAt: '2026-09-23 15:00' };
  check('evStartDay falls back to a timed entry', evStartDay(timed) === '2026-09-23');
  check('evEndDay defaults to the start', evEndDay({ startsOn: '2026-09-22' }) === '2026-09-22');
  check('an event mid-trip is found', awayConflicts([], [ev], [PINECREST]).length === 1);
  // The bug itself: the old field names must not silently produce a clean run.
  check('an event with only the OLD field names is not silently ignored',
        awayConflicts([], [{ summary: 'x', start: '2026-09-23' }], [PINECREST]).length === 0,
        'it should find nothing, and conflicts() reports that as blindness');
}

console.log('\nAWAY — trips from the calendar, not just bookings.md');
{
  // The Pinecrest aircraft booking is on a calendar, not in reference/bookings.md.
  const evts = [{ summary: 'N200BB — Pinecrest', startsOn: '2026-09-22', endsOn: '2026-09-27',
                  calendar: 'N200BB' }];
  const trs = calendarTrips(evts);
  check('a multi-day event becomes a trip', trs.length === 1, JSON.stringify(trs));
  check('...with the right window', trs[0]?.from === '2026-09-22' && trs[0]?.to === '2026-09-27');
  check('a single-day event is not a trip',
        calendarTrips([{ summary: 'x', startsOn: '2026-09-22', endsOn: '2026-09-22' }]).length === 0);
  check('the whole chain finds the original case',
        awayConflicts([{ id: 'x', title: 'Council candidates', due: '2026-09-22 17:00' }],
                      [], trs).length === 1);
}

console.log('\nCLASH — two timed things at once');
{
  const a = { summary: 'A', startsAt: '2026-09-10 09:00', endsAt: '2026-09-10 10:00' };
  const b = { summary: 'B', startsAt: '2026-09-10 09:30', endsAt: '2026-09-10 10:30' };
  const c = { summary: 'C', startsAt: '2026-09-10 10:00', endsAt: '2026-09-10 11:00' };
  check('an overlap is found', clashConflicts([a, b]).length === 1);
  check('back to back is not an overlap', clashConflicts([a, c]).length === 0,
        'ending at 10:00 and starting at 10:00 is a normal day');
  // An all-day entry has no times and would otherwise "clash" with everything.
  check('an all-day entry does not clash with everything',
        clashConflicts([a, { summary: 'Anniversary', allDay: true, startsOn: '2026-09-10' }]).length === 0);
  check('one event alone cannot clash', clashConflicts([a]).length === 0);
  check('no events is not a crash', clashConflicts(null).length === 0);
}

console.log('\nPROMISED — under-report rather than nag');
{
  const old = '2026-01-01';        // safely older than minAgeDays
  const p = [{ date: old, text: '"I will get a COI from Bayside Plumbing." — to Jake Gerber' }];

  check('a promise on no list is surfaced',
        promisedConflicts(p, [], '').length === 1);
  check('...but not if an open obligation matches it',
        promisedConflicts(p, [{ title: 'COI from Bayside Plumbing', what: '' }], '').length === 0);
  check('...and not if the logbook already closed it',
        promisedConflicts(p, [], 'closed: got the COI from Bayside Plumbing').length === 0);

  // Two words minimum: one shared word is a coincidence, not a match.
  check('a single shared word is not a match',
        promisedConflicts(p, [{ title: 'Plumbing invoice for the pool house', what: '' }], '').length === 1,
        'only "plumbing" overlaps, which is not enough to call it handled');

  check('something said today is left alone',
        promisedConflicts([{ date: new Date().toISOString().slice(0, 10), text: 'I will do the thing properly' }],
                          [], '').length === 0,
        'he gets a couple of days before it is called a dropped ball');
  check('a vague line is not surfaced at all',
        promisedConflicts([{ date: old, text: '"Will do"' }], [], '').length === 0,
        'too few words to match on, so matching it would be guessing');
}

console.log('\nCROWDED');
{
  const due = (n, d) => ({ id: String(n), title: 't' + n, due: d });
  check('three on one day is crowded',
        crowdedDays([due(1, '2026-09-30'), due(2, '2026-09-30'), due(3, '2026-09-30')]).length === 1);
  check('two on one day is not',
        crowdedDays([due(1, '2026-09-30'), due(2, '2026-09-30')]).length === 0);
  check('three across three days is not',
        crowdedDays([due(1, '2026-09-28'), due(2, '2026-09-29'), due(3, '2026-09-30')]).length === 0);
  check('undated items never crowd a day',
        crowdedDays([due(1, null), due(2, null), due(3, null)]).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
