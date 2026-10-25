/**
 * Bookings onto the calendar, and duplicates off it — 2026-09-05.
 *
 * bookings-events.mjs creates events unattended from a file the mail job
 * writes, so the parser is pinned line by line: all-day, multi-day, timed with
 * and without an end, continuation lines, cancelled lines skipped, the title
 * being the first fact and not the confirmation number.
 *
 * calendar-dupes.mjs DELETES, so its policy gets the negatives: a Gmail stub is
 * removed only when a real event on the same day matches it; two real events
 * are reported and never touched; a stub with nothing to duplicate stays.
 */
import { parseBookings, alreadyCovered } from '../bookings-events.mjs';
import { exactTwins } from '../integrations/calendar-write.mjs';
import { plan, words, norm } from '../calendar-dupes.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('bookings.md → events');
{
  const text = `# Bookings

## Hank Funland World · 2026-09-06 → 2026-09-07

Prose about the trip.

- 2026-09-06 → 2026-09-07 · Funland's Art of Theme Resort, The Jungle
  Family Rooms · hotel conf 600000000195 · $432.00/night · check-in from 15:00
- 2026-09-06 · Harbor Castle theme park reservation, party of 3 · conf
  100000000000000001
- 2026-09-06 18:40 · The Garden Buffet dinner, Harbor Castle, 3 guests · conf
  300000000054 · **moved from 18:10 to 18:40**
- 2026-09-07 13:00–16:00 · Little Sprouts, theme park childcare for Noah · $120
- ~~2026-09-06 · Lake Hotel · booking 1 · total $355.81~~ — cancelled
- a note that is not a booking

## Japan · dates not yet recorded

- 2026-12-01 · Something · conf x
`;
  const ev = parseBookings(text);
  const by = Object.fromEntries(ev.map((e) => [e.title, e]));
  check('five bullets, four bookings (the note is not one)', ev.length === 5, ev.map((e) => e.title).join(' | '));
  const hotel = by["Funland's Art of Theme Resort, The Jungle Family Rooms"];
  check('a multi-day booking is all-day with an until', hotel?.kind === 'allday' && hotel.date === '2026-09-06' && hotel.until === '2026-09-07', JSON.stringify(hotel));
  check('...and its continuation line was joined', hotel?.description.includes('hotel conf 600000000195'));
  const park = by['Harbor Castle theme park reservation, party of 3'];
  check('a dated booking is all-day, one day', park?.kind === 'allday' && park.until === park.date);
  const dinner = by['The Garden Buffet dinner, Harbor Castle, 3 guests'];
  check('a timed booking with no end runs 90 minutes', dinner?.kind === 'timed' && dinner.start === '18:40' && dinner.end === '20:10', JSON.stringify(dinner));
  check('bold markers are stripped from the description', dinner && !dinner.description.includes('**'));
  const sitter = by['Little Sprouts, theme park childcare for Noah'];
  check('an explicit end is honoured', sitter?.start === '13:00' && sitter.end === '16:00');
  check('a cancelled (struck) line is skipped', !ev.some((e) => e.title.includes('Lake Hotel')));
  check('the trip rides along', hotel?.trip.name === 'Hank Funland World' && hotel.trip.from === '2026-09-06');
  check('a heading without dates still parses its bookings', ev.some((e) => e.trip.name === 'Japan'));
  check('markers are stable and distinct', new Set(ev.map((e) => e.marker)).size === ev.length && ev.every((e) => /^booking:[0-9a-f]{12}$/.test(e.marker)));
  check('the same text yields the same markers', parseBookings(text)[0].marker === ev[0].marker);
}

console.log('\nduplicates — what may be removed');
{
  const gm = (id, summary, date) => ({ id, summary, eventType: 'fromGmail', start: { date }, status: 'confirmed' });
  const real = (id, summary, date, time) => ({ id, summary, eventType: 'default', start: time ? { dateTime: `${date}T${time}:00-04:00` } : { date }, status: 'confirmed' });
  check('venue words are five letters and not filler', [...words('Event at Harbor Castle Park')].sort().join(',') === 'castle,harbor', [...words('Event at Harbor Castle Park')].join(','));

  const p1 = plan([gm('g1', 'Event at Harbor Castle Park', '2026-09-06'), real('r1', 'Harbor Castle theme park reservation, party of 3', '2026-09-06')]);
  check('a Gmail stub duplicating a real event is removed', p1.remove.length === 1 && p1.remove[0].id === 'g1', JSON.stringify(p1));
  check('...and it names what it duplicated', p1.remove[0]?.because.startsWith('Harbor Castle'));

  const p2 = plan([gm('g2', 'Event at FUNLAND', '2026-09-07')]);
  check('a stub with nothing to duplicate stays', p2.remove.length === 0);

  // Two of the assistant's own, same title and start: the newer comes off. Two of
  // his: reported, never touched. 2026-09-06, the Little Sprouts clone.
  const own = (id, created) => ({ ...real(id, 'Little Sprouts, theme park childcare', '2026-09-07'), created, extendedProperties: { private: { obligations: 'booking:' + id } } });
  const q1 = plan([own('o2', '2026-09-06T21:24:49Z'), own('o1', '2026-09-05T21:01:22Z')]);
  check('two of the assistant\'s own twins: the newer is removed, the first stays', q1.remove.length === 1 && q1.remove[0].id === 'o2' && q1.remove[0].own && !q1.report.length, JSON.stringify(q1));
  const q2 = plan([{ ...real('h2', 'Dentist', '2026-09-09'), created: '2026-09-02T10:00:00Z' }, { ...real('h1', 'Dentist', '2026-09-09'), created: '2026-09-01T10:00:00Z' }]);
  check('two of his own, exact, nobody else on them: the newer is merged away, keeping the first', q2.remove.length === 1 && q2.remove[0].id === 'h2' && q2.remove[0].twinOf === 'h1' && !q2.report.length, JSON.stringify(q2));
  const withPeople = (id) => ({ ...real(id, 'GP meeting', '2026-09-09', '10:30'), attendees: [{ email: 'alex@x', self: true }, { email: 'owen@x' }] });
  const q3 = plan([withPeople('m1'), withPeople('m2')]);
  check('two with other people on them: reported, never removed — a delete cancels it for them', q3.remove.length === 0 && q3.report.length === 1 && /other people/.test(q3.report[0].why));
  check('exactTwins: same title, start and end, nobody else', exactTwins(real('a', 'X', '2026-09-09'), real('b', 'X', '2026-09-09')) && !exactTwins(real('a', 'X', '2026-09-09'), real('b', 'X', '2026-09-10')) && !exactTwins(withPeople('a'), withPeople('b')));
  const p3 = plan([gm('g3', 'Event at FUNLAND', '2026-09-07'), real('r3', 'FUNLAND theme park reservation', '2026-09-08')]);
  check('a match on a different day is not a duplicate', p3.remove.length === 0);

  const p4 = plan([{ ...real('r4a', 'Dentist', '2026-09-09'), created: '2026-09-01T00:00:00Z' }, { ...real('r4b', 'Dentist', '2026-09-09'), created: '2026-09-02T00:00:00Z' }]);
  check('two real exact twins: merged, the first kept (policy changed 2026-09-06 — "Handle that")', p4.remove.length === 1 && p4.remove[0].id === 'r4b' && p4.report.length === 0, JSON.stringify(p4));

  const p5 = plan([real('a', 'Dinner with Jon', '2026-09-08', '19:00'), real('b', 'Dinner with Jon', '2026-09-08', '20:00')]);
  check('same title at a different time is not a duplicate', p5.report.length === 0);

  const p6 = plan([gm('g6', 'Event at Harbor Castle Park', '2026-09-06'), { ...real('r6', 'Harbor Castle', '2026-09-06'), status: 'cancelled' }]);
  check('a cancelled twin does not count', p6.remove.length === 0);
  check('norm folds case and punctuation', norm("Funland's Art of Animation!") === 'funland s art of animation');
}

console.log('\nnot doubling what he already has');
{
  const b = { title: 'Meet the City Council Candidates, Friends of City Airport Airport', date: '2026-09-22' };
  const hand = { summary: 'Council candidates — Friends of City Airport', eventType: 'default', start: { dateTime: '2026-09-22T17:00:00-04:00' } };
  const stub = { summary: 'Event at Friends of City Airport Airport', eventType: 'fromGmail', start: { date: '2026-09-22' } };
  const ours = { summary: 'Meet the City Council Candidates', eventType: 'default', extendedProperties: { private: { obligations: 'booking:abc' } }, start: { date: '2026-09-22' } };
  check('a hand-made event sharing two venue words counts as cover', alreadyCovered(b, [hand]) === hand);
  check('a Gmail stub does not count as cover', alreadyCovered(b, [stub]) === null, 'the stub is what gets removed once the real one exists');
  check('the assistant\'s own marked event does not count here (findMarked handles it)', alreadyCovered(b, [ours]) === null);
  check('an unrelated event is not cover', alreadyCovered(b, [{ summary: 'Dentist', eventType: 'default', start: { date: '2026-09-22' } }]) === null);
  check('a cancelled twin is not cover', alreadyCovered(b, [{ ...hand, status: 'cancelled' }]) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
