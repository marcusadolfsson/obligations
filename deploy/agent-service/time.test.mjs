/**
 * Time formatting.
 *
 * `slotKey` earns most of this file. Its separator is compared, as a string,
 * against a key the host watchdog computes independently in python — and on
 * 2026-08-30 the two drifted. Consolidating `localStamp` into one module
 * changed its default separator from `T` to a space, `slotKey` inherited the
 * new default, and the 07:00 brief was reported missing 45 minutes after it had
 * finished successfully. Nothing caught it because nothing checked that the two
 * halves agreed.
 */
import { localStamp, localDate, parseStamp, daysSince, slotKey } from './time.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

console.log('Slot key');
{
  const noon = new Date(2026, 7, 30, 12, 0);
  check('is YYYY-MM-DDTHH:MM', slotKey(noon, [7, 0]) === '2026-08-30T07:00',
        slotKey(noon, [7, 0]));
  check('  ...the same literal reminder-dispatch.test.py is pinned to',
        slotKey(noon, [7, 0]) === '2026-08-30T07:00',
        'if this fails, every scheduled job will be reported missed');
  check('names the slot, not the moment it ran',
        slotKey(new Date(2026, 7, 30, 7, 43), [7, 0]) === '2026-08-30T07:00',
        'a job that starts late still belongs to its slot');
  check('the evening slot too', slotKey(noon, [18, 0]) === '2026-08-30T18:00');
}

console.log('\nLocal, never UTC');
{
  // The containers ran UTC once and the evening job fired at 14:00. Everything
  // here is local because everything already in the repo is.
  const d = new Date(2026, 0, 5, 9, 7);
  check('localStamp pads and uses a space by default',
        localStamp(d) === '2026-01-05 09:07', localStamp(d));
  check('  ...and takes an explicit separator', localStamp(d, 'T') === '2026-01-05T09:07');
  check('localDate is the day alone', localDate(d) === '2026-01-05');
}

console.log('\nParsing what this repo writes');
{
  const day = new Date(2026, 7, 26).getTime();
  check('a full stamp', parseStamp('2026-08-26 09:00') === new Date(2026, 7, 26, 9, 0).getTime());
  check('the T form too', parseStamp('2026-08-26T09:00') === new Date(2026, 7, 26, 9, 0).getTime());
  // new Date('2026-08-26') is parsed as UTC by spec, which in this timezone is
  // the 25th at 20:00 — an obligation would gain a day the moment it was written.
  check('a bare date is local midnight, not UTC midnight', parseStamp('2026-08-26') === day,
        'a UTC read would age everything by a day');
  check('junk is NaN rather than a throw', Number.isNaN(parseStamp('whenever')));
  check('null is NaN', Number.isNaN(parseStamp(null)));
}

console.log('\nAges');
{
  const now = new Date(2026, 7, 30, 12, 0).getTime();
  check('whole days', daysSince('2026-08-26 09:00', now) === 4,
        String(daysSince('2026-08-26 09:00', now)));
  check('today is zero', daysSince('2026-08-30 09:00', now) === 0);
  check('the future does not go negative', daysSince('2026-09-30', now) === 0,
        'a negative age reads as a countdown, which it is not');
  check('unparseable is null, not zero', daysSince('soon', now) === null,
        'zero would render as "today"');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
