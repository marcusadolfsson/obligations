/**
 * Home: gym blocks and birthdays, 2026-09-05.
 *
 * The gym planner writes to his calendar unattended, so the tests pin the two
 * things that would make it wrong in a way he only notices at 09:00 on a Monday
 * in Pinecrest: it must skip a day inside a trip, and it must never make the same
 * block twice. The birthday source decides a verb from a relation, and the
 * tests pin that a people/ file outranks Contacts — the file is where he said
 * who someone is.
 */
import { planDates, localDateTime, plusMinutes, DAYS } from '../gym.mjs';
import { fromPeople, mergeBirthdays, read as readBirthdays, todayMD } from './sources/birthdays.mjs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('gym — which days, and in town');
{
  // Sat 2026-09-05 → the next week holds Mon 09-07 and Thu 09-10.
  const sat = new Date('2026-09-05T12:00:00');
  const plan = planDates(sat, []);
  check('Monday and Thursday are the days', DAYS.join(',') === '1,4');
  check('the next week yields one Monday and one Thursday',
        plan.map((p) => p.date).join(',') === '2026-09-07,2026-09-10', JSON.stringify(plan));
  check('with no trips, neither is away', plan.every((p) => !p.away));

  const pinecrest = [{ name: 'Pinecrest', from: '2026-09-08', to: '2026-09-12' }];
  const away = planDates(sat, pinecrest);
  check('a day inside a trip is marked away', away.find((p) => p.date === '2026-09-10')?.away === 'Pinecrest');
  check('...and a day outside it is not', away.find((p) => p.date === '2026-09-07')?.away === null);
  check('a trip boundary is inclusive',
        planDates(new Date('2026-09-05T12:00:00'), [{ name: 'x', from: '2026-09-10', to: '2026-09-10' }])
          .find((p) => p.date === '2026-09-10')?.away === 'x');
  check('a trip with no dates never marks anything away',
        planDates(sat, [{ name: 'Japan', from: '', to: '' }]).every((p) => !p.away));
}

console.log('\ngym — times the API accepts');
{
  const dt = localDateTime('2026-09-07', '09:00');
  check('a local date-time carries the box offset', /^2026-09-07T09:00:00[+-]\d{2}:\d{2}$/.test(dt), dt);
  check('an hour later is an hour later', plusMinutes('09:20', 60) === '10:20');
  check('minutes carry', plusMinutes('09:45', 30) === '10:15');
  check('midnight wraps', plusMinutes('23:30', 60) === '00:30');
}

console.log('\nbirthdays — who, and what to do');
{
  const dir = await mkdtemp(join(tmpdir(), 'bday-'));
  await mkdir(join(dir, 'people'), { recursive: true });
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'people', 'mia.md'),
    '---\ntype: person\nname: Mia\nrelation: wife\nbirthday: 09-04\n---\n\n# Mia\n\n**How I know them:** +15550001111 wife.\n');
  await writeFile(join(dir, 'people', 'hank-mercer.md'),
    '---\ntype: person\nname: Hank Mercer\nbirthday: 09-04\n---\n\n# Hank\n\n**How I know them:** PHOA. +15552000004.\n');
  await writeFile(join(dir, 'people', 'no-bday.md'), '---\ntype: person\nname: Nobody\n---\n');
  await writeFile(join(dir, 'integrations', 'contacts.json'), JSON.stringify([
    { name: 'Hank Mercer', birthday: '01-01', handles: [{ kind: 'phone', key: '5552000004', raw: '+1 555 200 0004' }] },
    { name: 'Alan Sutter', birthday: '09-04', handles: [{ kind: 'phone', key: '7275550123', raw: '(727) 555-0123' }] },
    { name: 'No Birthday', handles: [] },
  ]));

  const ppl = await fromPeople(dir);
  check('people files with a birthday are read', ppl.length === 2, JSON.stringify(ppl.map((p) => p.name)));
  check('...with their relation', ppl.find((p) => p.name === 'Mia')?.relation === 'wife');
  check('...and a phone to text', ppl.find((p) => p.name === 'Hank Mercer')?.handle === '+15552000004');
  check('a file with no birthday is skipped', !ppl.some((p) => p.name === 'Nobody'));

  const merged = mergeBirthdays(ppl, [{ name: 'Hank Mercer', md: '01-01', relation: '', handle: null, file: null },
                                      { name: 'Alan Sutter', md: '09-04', relation: '', handle: '+17275550123', file: null }]);
  check('a people/ file outranks Contacts for the same name',
        merged.find((b) => b.name === 'Hank Mercer')?.md === '09-04', 'the file is where he said who someone is');
  check('a contact with no file still counts', merged.some((b) => b.name === 'Alan Sutter'));

  const today = await readBirthdays(dir, '09-04');
  check('three birthdays on the day', today.length === 3, today.map((o) => o.what).join(' | '));
  const mia = today.find((o) => o.what.includes('Mia'));
  check('family is a call', mia?.what.startsWith('Call ') && mia?.detail.family === true);
  const hank = today.find((o) => o.what.includes('Hank'));
  check('everyone else is a text, drafted', hank?.what.startsWith('Wish ') && hank?.what.includes('draft'));
  check('a birthday is owed by him, high, tagged', today.every((o) => o.owed_by === 'me' && o.priority === 'high' && o.tags.includes('birthday')));
  check('the id is stable for the year', /^birthday:\d{4}-09-04:mia$/.test(mia?.ref ?? ''), mia?.ref);
  check('a different day has none of these', (await readBirthdays(dir, '12-25')).length === 0);
  check('todayMD is MM-DD', /^\d{2}-\d{2}$/.test(todayMD()));
  // A close is the logbook line — so the source has to read it. Ben's stayed
  // open after its close on 2026-09-05 because it did not.
  await writeFile(join(dir, 'logbook.md'),
    '- 2026-09-05 20:20 | birthday:' + new Date().getFullYear() + '-09-04:mia | Call Mia — birthday today (wife) | by agent:assistant | called at lunch\n');
  const afterClose = await readBirthdays(dir, '09-04');
  const cam = afterClose.find((b) => b.ref.endsWith(':mia'));
  check('a birthday closed in the logbook reads back closed, the others stay open',
        cam?.open === false && afterClose.filter((b) => b !== cam).every((b) => b.open === true), JSON.stringify(afterClose.map((b) => [b.ref, b.open])));

}

/* The run-up. Alex, 2026-10-16, of two reminders for Mia due eleven
 * months out: not a to-do "until her birthday is actually two weeks out." */
console.log('\nbirthdays — the run-up opens two weeks out');
{
  const { prepTasks, PREP_DAYS } = await import('./sources/birthdays.mjs');
  const mia = [{ name: 'Mia', md: '09-04', relation: 'wife', handle: null, file: 'people/mia.md', prep: 'make dinner plans, order flowers' }];
  const none = new Set();
  check('eleven months out there is no task', prepTasks(mia, none, new Date(2026, 9, 16)).length === 0);
  check('fifteen days out there is still none', prepTasks(mia, none, new Date(2027, 7, 20, 23, 0)).length === 0);
  const opened = prepTasks(mia, none, new Date(2027, 7, 21, 6, 0));
  check(`${PREP_DAYS} days out it opens, one task naming both`, opened.length === 1 && /September 4 — make dinner plans, order flowers$/.test(opened[0].what), JSON.stringify(opened));
  check('due the morning the window opens, ref by the birthday it is for',
        opened[0]?.due === '2027-08-21 09:00' && opened[0]?.ref === 'birthday:2027-09-04:mia:prep', JSON.stringify(opened[0]));
  check('still open on the day itself', prepTasks(mia, none, new Date(2027, 8, 4, 20, 0)).length === 1);
  const after = prepTasks(mia, none, new Date(2027, 8, 20));
  check('after the day it stays open until he closes it', after.length === 1 && after[0].open && after[0].ref === 'birthday:2027-09-04:mia:prep', JSON.stringify(after));
  check('closed after the day, it is gone', prepTasks(mia, new Set(['birthday:2027-09-04:mia:prep']), new Date(2027, 8, 20)).length === 0);
  check('a run-up that opened before the feature existed is not raised', prepTasks(mia, none, new Date(2026, 9, 16)).length === 0);
  check('an unclosed one from last year and this year both show',
        prepTasks(mia, none, new Date(2028, 7, 25)).map((o) => o.ref).join(',') === 'birthday:2027-09-04:mia:prep,birthday:2028-09-04:mia:prep');
  check('a close in the logbook reads back closed', prepTasks(mia, new Set(['birthday:2027-09-04:mia:prep']), new Date(2027, 7, 25))[0]?.open === false);
  check('no birthday-prep line, no run-up', prepTasks([{ ...mia[0], prep: null }], none, new Date(2027, 7, 25)).length === 0);
  check('a January birthday seen from late December looks into next year',
        prepTasks([{ ...mia[0], md: '01-03' }], none, new Date(2026, 11, 28)).at(-1)?.ref === 'birthday:2027-01-03:mia:prep');
}

/* Two times are one session each. Alex, 2026-09-09: "two times means one for
 * each of us. we go together so the calendar should be from the first one, to
 * the later one + 30 min." This reverses the reading that stood from
 * 2026-08-30, and the cost of the old one is why it is pinned: the triage saw
 * "930 & 940" on 09-08 and "920 & 930" on 09-09, concluded both were Mia's,
 * and moved nothing — so his morning read 09:00 on two days he was at the gym
 * at 09:20. */
console.log('\nthe block a pair of times means');
{
  const { blockFor } = await import('../gym.mjs');
  const eq = (got, want) => !!got && got.start === want[0] && got.end === want[1];
  check('two times span the earlier to the later plus 30',
        eq(blockFor(['09:20', '09:30']), ['09:20', '10:00']), JSON.stringify(blockFor(['09:20', '09:30'])));
  check('  ...so 930 & 940 would have been 09:30-10:10',
        eq(blockFor(['09:30', '09:40']), ['09:30', '10:10']));
  check('Pete writes 9:20, not 09:20', eq(blockFor(['9:20', '9:30']), ['09:20', '10:00']));
  check('order does not matter', eq(blockFor(['09:30', '09:20']), ['09:20', '10:00']));
  check('one time is still one session, still an hour', eq(blockFor(['09:20']), ['09:20', '10:20']));
  check('the same time twice is one session', eq(blockFor(['09:20', '09:20']), ['09:20', '10:20']));
  check('three times span the whole of it', eq(blockFor(['09:20', '09:30', '09:40']), ['09:20', '10:10']));
  check('nothing usable is null', blockFor([]) === null && blockFor(['soon']) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
