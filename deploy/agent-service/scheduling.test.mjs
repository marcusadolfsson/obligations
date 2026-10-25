/**
 * Picking a slot out of the windows someone else offered — the Brava case of
 * 2026-09-08, where the times sat unanswered for four days.
 */
import { span, busyOn, pick, reply } from '../scheduling.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const ev = (date, start, end, summary = 'x') => ({ startsOn: date, startsAt: `${date} ${start}`, endsAt: `${date} ${end}`, summary, allDay: false });
const allDay = (date, summary) => ({ startsOn: date, startsAt: null, endsAt: null, summary, allDay: true });

console.log('span — a window inside working hours');
{
  check('"before 15:00" runs from the start of his day', JSON.stringify(span({ date: 'd', before: '15:00' })) === JSON.stringify({ date: 'd', from: 540, to: 900 }));
  check('"after 11:00" runs to the end of it', JSON.stringify(span({ date: 'd', after: '11:00' })) === JSON.stringify({ date: 'd', from: 660, to: 1020 }));
  check('a window entirely outside the working day is nothing', span({ date: 'd', after: '19:00' }) === null);
}

console.log('\npick — the Brava windows against his real Wednesday');
{
  const events = [
    allDay('2026-09-09', 'Apple Event'), allDay('2026-09-09', 'Anniversary'),
    ev('2026-09-09', '10:30', '11:00', 'Intro- PV Fund II'),
    ev('2026-09-09', '13:00', '15:00', 'Apple Event'),
    ev('2026-09-09', '14:00', '16:00', 'Seedcircle MC meeting'),
    ev('2026-09-10', '09:00', '10:00', 'Gym — Mia'),
  ];
  const windows = [{ date: '2026-09-09', before: '15:00' }, { date: '2026-09-10', after: '11:00' }];
  const p = pick(windows, events, { len: 45 });
  check('takes the first window offered and the first free slot in it', p.date === '2026-09-09' && p.start === '09:00' && p.end === '09:45', JSON.stringify(p));
  check('and names the weekday, which is what the reply says', p.day === 'Wednesday');
  const long = pick(windows, events, { len: 90 });
  check('a 90-minute call will not squeeze into the 90 before a 10:30 — it goes after it',
        long.date === '2026-09-09' && long.start === '11:10', JSON.stringify(long));
  const packed = pick([{ date: '2026-09-09', after: '10:00', before: '13:00' }], events, { len: 90 });
  check('a window that cannot hold it moves past the meeting', packed.start === '11:10', JSON.stringify(packed));
  const full = pick([{ date: '2026-09-09', after: '13:00', before: '15:00' }], events, { len: 45 });
  check('a genuinely full window returns none, with the reason', full.none && /nothing free/.test(full.tried[0].why), JSON.stringify(full));
  const away = pick([{ date: '2026-09-11', before: '15:00' }], [allDay('2026-09-11', 'Alex out — Pinecrest trip')], { len: 30 });
  check('a day he is away is skipped, and says so', away.none && /away/.test(away.tried[0].why), JSON.stringify(away));
}

console.log('\nreply — one line, in his voice');
{
  const p = pick([{ date: '2026-09-09', before: '15:00' }], [], { len: 45 });
  const text = reply(p, { who: 'Carl', what: 'the Brava intro call' });
  check('names the person, the day, the time and what happens next',
        text === 'Carl — Wednesday at 9:00 works for the Brava intro call. Sending an invite now.', text);
  check('nothing free means no reply to send', reply({ none: true, tried: [] }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
