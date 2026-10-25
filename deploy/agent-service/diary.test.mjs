/**
 * The assistant putting things in his diary, and telling him.
 *
 * Alex, 2026-09-14: "how can we make the assistant make schedule changes, as long
 * as it calls it out in the briefs expressively." The ARKO showroom visit was
 * settled on both sides at 13:26 and the triage wrote "the remaining move is
 * getting it onto the calendar" in five runs in a row, because the calendar
 * door could only list. The permission existed; the verb did not.
 *
 * Two halves are pinned here. What an entry request is allowed to mean, since
 * a job will now make them unasked. And that every change reaches the next
 * brief exactly once — the condition he attached to the whole capability.
 */
import { planEntry } from '../integrations/calendar-write.mjs';
import { diaryChanges } from '../brief-input.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};
const refuses = (label, req) => {
  try { planEntry(req); check(`refuses ${label}`, false, 'accepted'); }
  catch (e) { check(`refuses ${label}`, true, e.message); }
};

console.log('what an entry means');
{
  const p = planEntry({ title: 'ARKO showroom visit', start: '2026-09-18 10:00', location: 'ARKO showroom' });
  check('a start with no length is an hour', p.from === '10:00' && p.to === '11:00', `${p.from}-${p.to}`);
  check('the marker is the assistant\'s own, so it can only ever remove what it made',
        p.marker === 'add:2026-09-18:arko-showroom-visit', p.marker);
  check('the description says the next brief will name it', /next brief/.test(p.description));
  check('minutes set the length', planEntry({ title: 'x', start: '2026-09-18 10:00', minutes: 45 }).to === '10:45');
  check('an end time wins over the default', planEntry({ title: 'x', start: '2026-09-18 10:00', end: '10:30' }).to === '10:30');
  check('Pete-style 9:20 is 09:20', planEntry({ title: 'x', start: '2026-09-18 9:20' }).from === '09:20');
}

console.log('\nwhat it refuses');
refuses('an entry with no title', { start: '2026-09-18 10:00' });
refuses('a start that is not a date and time', { title: 'x', start: 'Friday morning' });
refuses('an end before the start', { title: 'x', start: '2026-09-18 10:00', end: '09:00' });
refuses('something running past midnight', { title: 'x', start: '2026-09-18 23:30', minutes: 90 });
refuses('a twelve-hour-plus block', { title: 'x', start: '2026-09-18 06:00', minutes: 800 });

console.log('\nevery change is announced exactly once');
{
  const rows = [
    { at: '2026-09-14 12:00', action: 'added', title: 'Old thing', when: '2026-09-15 09:00–10:00', why: 'announced this morning' },
    { at: '2026-09-14 19:05', action: 'added', title: 'ARKO showroom visit', when: '2026-09-18 10:00–11:00',
      location: 'ARKO showroom', why: 'Omar confirmed Friday 10am' },
    { at: '2026-09-14 19:40', action: 'removed', title: 'Wrong hold', when: '2026-09-16T11:00', why: 'Omar moved it' },
  ];
  const out = diaryChanges(rows, '2026-09-14 18:00');
  check('changes since the last brief are listed', out.length === 2, JSON.stringify(out));
  check('  ...and nothing the previous brief already announced', !out.some((l) => /Old thing/.test(l)));
  check('an addition says what, when, where and why',
        /ARKO showroom visit/.test(out[0]) && /10:00/.test(out[0]) && /ARKO showroom/.test(out[0]) && /Omar confirmed/.test(out[0]));
  check('a removal is announced too, not only additions', /removed/.test(out[1]));
  check('no marker leaks into the brief', !out.some((l) => /add:\d{4}/.test(l)));
  check('with no previous brief, everything is new', diaryChanges(rows, null).length === 3);
  check('an empty ledger announces nothing', diaryChanges([], '2026-09-14 18:00').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
