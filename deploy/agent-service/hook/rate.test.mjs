/**
 * The caps, which are what stand between "a stranger can cause an interrupt"
 * and "a stranger can cause two hundred interrupts".
 *
 * Pure functions over a state object, so every one of these is a fact about a
 * night rather than about a mock.
 */
import {
  decide, record, prune, markSuppressed,
  GLOBAL_HOUR, GLOBAL_DAY, UNRATIFIED_HOUR, PER_SENDER_HOUR, SEEN_MS,
} from './rate.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const T = 1_800_000_000_000;            // a fixed "now"
const empty = () => ({ seen: {}, pushes: [], suppressedAt: 0 });
const msg = (over = {}) => ({ messageId: 'm1', sender: 'google.com', ratified: true, ...over });

console.log('The ordinary case');
{
  const d = decide(empty(), msg(), T);
  check('a first code from a ratified sender goes through', d.allow, d.reason);
}

console.log('\nA code is never sent twice');
{
  // The failure this exists to stop: the voip.ms API returned success on a
  // retried send and Alex got the same code twice. A code that arrives twice
  // is one he stops trusting.
  let s = record(empty(), msg(), T);
  const d = decide(s, msg(), T + 1000);
  check('the same message id is refused the second time', !d.allow, d.reason);
  check('  ...and says why', /already pushed/.test(d.reason), d.reason);

  const later = decide(s, msg(), T + SEEN_MS + 1000);
  check('but the id is forgotten after a day, so state cannot grow forever',
        later.allow, later.reason);

  // Recording BEFORE the send is what makes an ambiguous result safe.
  check('recording marks the id even though no send has happened yet',
        s.seen.m1 === T);
}

console.log('\nOne sender cannot occupy the channel');
{
  let s = record(empty(), msg({ messageId: 'a' }), T);
  const soon = decide(s, msg({ messageId: 'b' }), T + 60_000);
  check('the same sender within 5 minutes is refused', !soon.allow, soon.reason);

  const after = decide(s, msg({ messageId: 'b' }), T + 6 * 60_000);
  check('  ...and allowed once the window passes', after.allow, after.reason);

  // Fill the sender's hourly allowance at 6-minute spacing.
  let t = T;
  s = empty();
  for (let i = 0; i < PER_SENDER_HOUR; i++) {
    s = record(s, msg({ messageId: `s${i}` }), t);
    t += 6 * 60_000;
  }
  const capped = decide(s, msg({ messageId: 'over' }), t);
  check(`a sender is capped at ${PER_SENDER_HOUR} an hour`, !capped.allow, capped.reason);

  const other = decide(s, msg({ messageId: 'other', sender: 'slack.com' }), t);
  check('  ...and a different sender is unaffected', other.allow, other.reason);
}

console.log('\nThe global ceiling on a night');
{
  let s = empty();
  let t = T;
  // Distinct senders and 6-minute gaps, so only the global cap can bite.
  for (let i = 0; i < GLOBAL_HOUR; i++) {
    s = record(s, msg({ messageId: `g${i}`, sender: `svc${i}.com` }), t);
    t += 6 * 60_000;
  }
  const d = decide(s, msg({ messageId: 'over', sender: 'fresh.com' }), t);
  check(`${GLOBAL_HOUR} pushes in an hour is the ceiling`, !d.allow, d.reason);
  check('  ...and it announces the suppression once', d.announce === true);
  check('  ...reporting how many were suppressed', d.suppressed === GLOBAL_HOUR);

  const after = markSuppressed(s, t);
  const second = decide(after, msg({ messageId: 'over2', sender: 'fresh.com' }), t + 1000);
  check('a second refusal in the same window does NOT announce again',
        second.allow === false && second.announce === false,
        'a suppressed burst must not become an unsuppressed one');

  const nextHour = decide(after, msg({ messageId: 'over3', sender: 'fresh.com' }),
                          t + 61 * 60_000);
  check('the hourly window rolls', nextHour.allow, nextHour.reason);
}

console.log('\nUnratified senders share a tighter pool');
{
  let s = empty();
  let t = T;
  for (let i = 0; i < UNRATIFIED_HOUR; i++) {
    s = record(s, msg({ messageId: `u${i}`, sender: `who${i}.com`, ratified: false }), t);
    t += 6 * 60_000;
  }
  const another = decide(s, msg({ messageId: 'u9', sender: 'whoelse.com', ratified: false }), t);
  check(`unratified senders are capped at ${UNRATIFIED_HOUR} an hour`,
        !another.allow, another.reason);

  // Being on the list is what buys the looser budget — the reason ratifying is
  // worth doing even though it is not required.
  const listed = decide(s, msg({ messageId: 'r1', sender: 'google.com', ratified: true }), t);
  check('  ...while a ratified sender still gets through', listed.allow, listed.reason);
}

console.log('\nThe daily cap outlasts the hourly one');
{
  let s = empty();
  let t = T;
  for (let i = 0; i < GLOBAL_DAY; i++) {
    s = record(s, msg({ messageId: `d${i}`, sender: `d${i}.com` }), t);
    t += 30 * 60_000;                   // spread over hours
  }
  const d = decide(s, msg({ messageId: 'dover', sender: 'fresh.com' }), t);
  check(`${GLOBAL_DAY} in a day is refused even with an empty hour`,
        !d.allow && /today/.test(d.reason), d.reason);
}

console.log('\nState does not grow without bound');
{
  let s = record(empty(), msg(), T);
  const pruned = prune(s, T + SEEN_MS + 1);
  check('old message ids are dropped', Object.keys(pruned.seen).length === 0);
  check('old pushes are dropped', pruned.pushes.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
