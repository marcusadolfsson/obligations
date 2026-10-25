/**
 * `surfaced_for` — the deferral that nothing implemented.
 *
 * `rules/email-triage.md` described a time-sensitive awareness item from
 * 2026-09-02 and named the field that carries its date. A grep on 2026-09-19
 * found that sentence and no reader anywhere in the repo, so every dated item
 * was reported in whatever brief followed its judgement and then dropped by the
 * cursor — early, once, and never on the day it was about.
 *
 * These pin the four things that have to be true for the field to mean
 * anything, and the two ways a naive implementation gets it wrong: surfacing a
 * held item because its review stamp is in the window, and re-surfacing it
 * every day once its date has passed.
 */
import { reasonFor, surfaces, upcoming, dueAt } from './digest-window.mjs';

let pass = 0, fail = 0;
const ok = (name) => { pass += 1; console.log(`  ok   ${name}`); };
const bad = (name, detail) => { fail += 1; console.log(`  FAIL ${name}\n         ${detail}`); };
const check = (got, want, name) => (got === want ? ok(name) : bad(name, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const DAY = 86400000;
const now = Date.parse('2026-09-19T09:00:00');
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const thread = (reviewedMs, conclusion = {}) => ({
  thread_id: 'abc123', account: 'personal',
  reviewed: stamp(reviewedMs),
  conclusion: { tier: 'awareness', open: false, title: 't', ...conclusion },
});

console.log('surfaced_for');

// The ordinary case is unchanged: no date, judged inside the window.
check(surfaces(thread(now - 2 * 3600000), now - DAY, now), true,
  'an undated item in the window surfaces');
check(surfaces(thread(now - 5 * DAY), now - DAY, now), false,
  'an undated item older than the window does not');

/* TWICE, AND THE TWO READ DIFFERENTLY. Alex, 2026-09-19, on the first cut of
 * this, which held a dated item out of every brief until its day: "I do also
 * need to be made aware of the email before the date, with a reminder on the
 * date."
 *
 * Holding was wrong in the direction that costs him something — the one thing
 * he might want to do early, he could not, because he had never been told the
 * mail existed. So: news on arrival, reminder on the day. */
check(reasonFor(thread(now, { surfaced_for: '2026-09-24' }), now - DAY, now), 'new',
  'a dated item is reported when it ARRIVES, like anything else');

const tuesday = Date.parse('2026-09-24T09:00:00');
check(reasonFor(thread(now, { surfaced_for: '2026-09-24' }), tuesday - DAY, tuesday), 'due',
  'and comes back on its date, weeks after its review stamp left the window');

/* ONE EVENT, ONE LINE. Judged on its own date, it is not both news and a
 * reminder in the same brief — that is the same fact printed twice. */
check(reasonFor(thread(now, { surfaced_for: '2026-09-19' }), now - DAY, now), 'new',
  'judged on its own date, it is news once and not also a reminder');

/* AND NOT A THIRD TIME. The cursor moves past the surfacing date the same way
 * it moves past a review stamp; without that, a dated item would reappear in
 * every brief forever — the failure mode of a flag nobody clears. */
check(reasonFor(thread(now, { surfaced_for: '2026-09-24' }), tuesday + 2 * 3600000, tuesday + DAY), null,
  'and never again once the cursor has passed its date');

// A date already past when it is judged is simply news, once.
check(reasonFor(thread(now, { surfaced_for: '2026-09-18' }), now - DAY, now), 'new',
  'a date already past when it arrives is news, not a reminder');

/* A TYPO MUST NOT RELEASE IT EARLY — and must not swallow it either. Treating
 * an unparseable date as "now" would turn every mistyped deferral into an
 * immediate surfacing, which is the behaviour the field was added to end. */
check(dueAt({ surfaced_for: 'next tuesday' }), null, 'an unparseable date reads as absent');
check(surfaces(thread(now, { surfaced_for: 'next tuesday' }), now - DAY, now), true,
  'so a mistyped date surfaces normally rather than vanishing');

// Local midnight, not UTC: an item dated today is due when the 07:00 brief runs.
const sevenAm = Date.parse('2026-09-19T07:00:00');
check(reasonFor(thread(now - 3 * DAY, { surfaced_for: '2026-09-19' }), sevenAm - 13 * 3600000, sevenAm), 'due',
  'a bare date is local midnight, so today is due at the 07:00 brief');

/* WHAT IS AHEAD IS COUNTED, NEVER MERELY ABSENT. A dated item still waiting and
 * one quietly dropped are indistinguishable from the brief's side, and that is
 * how eighteen live deferrals sat unread for seventeen days. */
const TIERS = ['digest', 'reading', 'awareness', 'memory'];
const list = [
  thread(now, { surfaced_for: '2026-09-24' }),
  thread(now, { surfaced_for: '2026-09-21' }),
  thread(now),
  thread(now, { tier: 'action', surfaced_for: '2026-09-25' }),
];
const ahead = upcoming(list, TIERS, now);
check(ahead.length, 2, 'what is ahead counts the dated, and only the filed tiers');
check(ahead[0].conclusion.surfaced_for, '2026-09-21', 'and is ordered by the date it is due');

// A record with no review stamp is not silently treated as ancient or current.
check(surfaces({ conclusion: { tier: 'awareness' } }, now - DAY, now), false,
  'a thread with no review stamp never surfaces');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
