/**
 * Recurring obligations and the logbook.
 *
 * Month boundaries are where this kind of code goes wrong, and the failure is
 * silent: a submission due on the 8th that quietly moves to the 1st, or an
 * August instance that disappears the moment September starts. So the period
 * arithmetic is pinned at every edge it has.
 *
 * The other half is the property the whole design rests on: **each period is a
 * separate obligation.** Closing August must say nothing about September.
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { periods, dueFor, recurRef, read, close } from './sources/recurring.mjs';
import { appendClose, readCloses } from './logbook.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const at = (s) => new Date(s + 'T10:00');
const keys = (every, from, when) => periods(every, from, at(when)).map((p) => p.key);
const due = (every, from, when, by) => {
  const p = periods(every, from, at(when));
  return p.length ? dueFor(every, p[p.length - 1], by) : null;
};

/* ------------------------------------------------------------------ periods */

console.log('Which period is being reported on');
check('in September, the month reported on is August',
      keys('1m', null, '2026-09-02')[0] === '2026-08', keys('1m', null, '2026-09-02')[0]);
check('on the last day of August it is still July',
      keys('1m', null, '2026-08-31')[0] === '2026-07', keys('1m', null, '2026-08-31')[0]);
check('on 1 January the month reported on is the previous December',
      keys('1m', null, '2027-01-01')[0] === '2026-12', keys('1m', null, '2027-01-01')[0]);

check('without !from: only one period is tracked',
      keys('1m', null, '2026-12-02').length === 1,
      'writing a block down must not invent a backlog');
check('with !from: every period since is tracked',
      keys('1m', '2026-08', '2026-11-02').join(',') === '2026-10,2026-09,2026-08',
      keys('1m', '2026-08', '2026-11-02').join(','));
check('  ...newest first', keys('1m', '2026-08', '2026-11-02')[0] === '2026-10');
check('a !from: in the future yields nothing yet',
      keys('1m', '2027-01', '2026-11-02').length === 0);

check('quarterly reports on the quarter that finished',
      keys('3m', null, '2026-05-04')[0] === '2026-Q1', keys('3m', null, '2026-05-04')[0]);
check('  ...and does not advance mid-quarter',
      keys('3m', null, '2026-06-30')[0] === '2026-Q1', keys('3m', null, '2026-06-30')[0]);
check('  ...but does on the first day of the next one',
      keys('3m', null, '2026-07-01')[0] === '2026-Q2', keys('3m', null, '2026-07-01')[0]);

check('yearly reports on last year',
      keys('1y', null, '2026-03-04')[0] === '2025', keys('1y', null, '2026-03-04')[0]);
check('weekly reports on the week that ended',
      /^2026-W\d\d$/.test(keys('1w', null, '2026-09-02')[0] ?? ''), keys('1w', null, '2026-09-02')[0]);
check('an unknown cadence surfaces nothing rather than guessing',
      periods('fortnightly-ish', null, at('2026-09-02')).length === 0);

/* --------------------------------------------------------------- due dates */

console.log('\nWhen it is due');
check('August is due the 8th of September',
      due('1m', null, '2026-09-02', '8') === '2026-09-08 09:00',
      due('1m', null, '2026-09-02', '8'));
check('December is due in January of the next year',
      due('1m', null, '2027-01-02', '8') === '2027-01-08 09:00',
      due('1m', null, '2027-01-02', '8'));

// A day that does not exist must clamp, not roll forward: a deadline that slid
// into March would be a deadline for the wrong period entirely.
check('!by:31 in February is the 28th, not 3 March',
      due('1m', null, '2026-02-02', '31') === '2026-02-28 09:00',
      due('1m', null, '2026-02-02', '31'));
check('  ...and 29 February in a leap year',
      due('1m', null, '2028-02-02', '31') === '2028-02-29 09:00',
      due('1m', null, '2028-02-02', '31'));
check('a missing !by: defaults to the 1st',
      due('1m', null, '2026-09-02', null) === '2026-09-01 09:00',
      due('1m', null, '2026-09-02', null));
check('Q1 is due after March ends',
      due('3m', null, '2026-05-04', '15') === '2026-04-15 09:00',
      due('3m', null, '2026-05-04', '15'));

/* ------------------------------------------------------------------ reading */

const FILE = `# Recurring

> Documentation in a blockquote is not a block.
> - [ ] and a list item inside it is not an item

## Aircraft hours                  !every:1m !by:8 !from:2026-08

Previous month's hours to the programmes.

- [ ] N200BB to Northwind            !closes:receipt email from Northwind
- [ ] N300CC to Pinewood Engines     !closes:receipt email from PE

## Board pack                      !every:3m !by:20 !from:2026-Q1 !high

- [ ] circulate the quarterly numbers

## Broken block                    !by:9

- [ ] this has no cadence and must be skipped
`;

const dir = await mkdtemp(join(tmpdir(), 'recur-'));
await writeFile(join(dir, 'recurring.md'), FILE);

console.log('\nReading the file');
{
  const rows = await read(dir, at('2026-09-02'));
  const air = rows.filter((r) => r.what.startsWith('Aircraft hours'));

  check('two aircraft items become two obligations', air.length === 2, String(air.length));
  check('  ...each naming its period', air.every((r) => r.what.endsWith('(2026-08)')),
        air.map((r) => r.what).join(' | '));
  check('  ...each carrying what closes it',
        air[0].closes === 'receipt email from Northwind', air[0].closes);
  check('  ...with the tag stripped from the text', !air[0].what.includes('!closes'), air[0].what);
  check('  ...and the due date from the block', air.every((r) => r.due === '2026-09-08 09:00'));
  check('the block note is kept', air[0].detail.note?.startsWith("Previous month's hours"),
        air[0].detail.note);

  check('a block-level priority applies to its items',
        rows.find((r) => r.what.startsWith('Board pack'))?.priority === 'high');
  check('a block with no !every: is skipped, not guessed at',
        !rows.some((r) => r.what.startsWith('Broken block')));
  check('a list item inside the documentation is not an obligation',
        !rows.some((r) => r.what.includes('not an item')));
}

/* ------------------------------------------------------------------ closing */

console.log('\nClosing one period says nothing about another');
{
  const ref = recurRef('Aircraft hours', 'N200BB to Northwind', '2026-08');
  await close(dir, ref, 'alex@rivera.example', 'receipt from Northwind 2026-09-05');

  const sept = await read(dir, at('2026-09-09'));
  const augNorthwind = sept.find((r) => r.ref === ref);
  check('the closed instance is no longer open', augNorthwind?.open === false);
  check('  ...and says what closed it',
        augNorthwind?.detail.outcome === 'receipt from Northwind 2026-09-05',
        augNorthwind?.detail.outcome);
  check('the other vendor is untouched',
        sept.find((r) => r.what.includes('Pinewood') && r.what.includes('2026-08'))?.open === true);

  const oct = await read(dir, at('2026-10-02'));
  check('September is a separate obligation and still open',
        oct.find((r) => r.what.includes('N200BB to Northwind') && r.what.includes('2026-09'))?.open === true,
        'a bumped due date would have lost this distinction entirely');
  check('  ...while August stays closed',
        oct.find((r) => r.ref === ref)?.open === false);

  // recurring.md is a definition. If closing edited it, the history would live
  // in a file that gets rewritten, which is the thing this replaced.
  check('recurring.md itself is unchanged',
        (await readFile(join(dir, 'recurring.md'), 'utf8')) === FILE);

  const r2 = await close(dir, ref, 'someone', 'again');
  check('closing it twice does not write a second line', r2.alreadyClosed === true);
}

/* ------------------------------------------------------------------ logbook */

console.log('\nThe logbook');
{
  const log = await readFile(join(dir, 'logbook.md'), 'utf8');
  check('it explains its own contract on creation', log.startsWith('# Logbook'));
  check('the entry names who closed it', log.includes('by alex@rivera.example'));
  check('  ...and what closed it', log.includes('receipt from Northwind 2026-09-05'));
  check('  ...and is human-readable', log.includes('Aircraft hours: N200BB to Northwind (2026-08)'));

  // A pipe in free text would invent a field; a newline would end the record
  // and make the rest of the note read as a new entry.
  await appendClose(dir, { id: 'x:1', what: 'a | b', who: 'me', outcome: 'line\none | two' });
  const closes = await readCloses(dir);
  check('a pipe in the text cannot invent a field', closes.get('x:1')?.what === 'a b',
        closes.get('x:1')?.what);
  check('a newline cannot end the record early',
        closes.get('x:1')?.outcome === 'line one two', closes.get('x:1')?.outcome);

  await appendClose(dir, { id: 'x:1', what: 'corrected', who: 'me', outcome: null });
  check('the last entry for an id wins', (await readCloses(dir)).get('x:1').what === 'corrected',
        'append-only means a correction is another line, not an edit');
  check('  ...and the earlier line is still there',
        (await readFile(join(dir, 'logbook.md'), 'utf8')).includes('a b'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
