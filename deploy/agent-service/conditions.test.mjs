/**
 * Conditions: an alert and its recovery are one story with a clock.
 */
import { conditionsFrom } from './conditions.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const NOW = Date.parse('2026-09-06T13:30:00');
const th = (id, since, condition, extra = {}) => ({ thread_id: id, account: 'personal', reviewed: since, conclusion: { tier: 'awareness', who: 'alerts@ups.example', title: condition.what, since, condition, ...extra } });

console.log('open, resolved, and the clock');
{
  const r = conditionsFrom([
    th('a', '2026-09-06 13:02', { key: 'ups:hangar', status: 'open', severity: 'high', what: 'UPS at the hangar on battery' }),
    th('b', '2026-09-06 13:12', { key: 'UPS:hangar', status: 'resolved', what: 'UPS at the hangar back on utility power' }),
    th('c', '2026-09-06 12:50', { key: 'piaware:3407', status: 'open', severity: 'normal', what: 'PiAware 3407 not reporting' }),
    th('d', '2026-09-05 09:00', { key: 'backup:nas', status: 'open', severity: 'critical', what: 'NAS backup failed' }),
    th('e', '2026-09-05 11:00', { key: 'backup:nas', status: 'resolved', what: 'NAS backup succeeded' }),
  ], { now: NOW, today: '2026-09-06' });
  check('one condition still open, with minutes since', r.open.length === 1 && r.open[0].key === 'piaware:3407' && r.open[0].minutes === 40, JSON.stringify(r.open));
  check('the UPS pair folds into one resolved line, keyed case-insensitively, 10 minutes long', r.resolved.length === 1 && r.resolved[0].key === 'ups:hangar' && r.resolved[0].minutes === 10 && r.resolved[0].severity === 'high', JSON.stringify(r.resolved));
  check('yesterday\'s resolved backup is not today\'s news', !r.resolved.some((x) => x.key === 'backup:nas'));
  const r2 = conditionsFrom([
    th('a', '2026-09-06 13:02', { key: 'ups:hangar', status: 'open', severity: 'critical', what: 'x' }),
    th('c', '2026-09-06 13:20', { key: 'piaware:3407', status: 'open', severity: 'normal', what: 'y' }),
  ], { now: NOW, today: '2026-09-06' });
  check('open ones sort by severity, critical first', r2.open.map((x) => x.key).join(',') === 'ups:hangar,piaware:3407');
  const r3 = conditionsFrom([th('z', '2026-09-06 08:00', { key: 'alarm:home', status: 'resolved', what: 'alarm cleared' })], { now: NOW, today: '2026-09-06' });
  check('a clear with no known open is still a line, with no duration', r3.resolved.length === 1 && r3.resolved[0].minutes === null && r3.open.length === 0);
  check('threads without a condition are ignored', conditionsFrom([{ thread_id: 'q', conclusion: { tier: 'awareness', title: 'plain' } }], { now: NOW }).open.length === 0);
}

console.log('stuck: open past a day becomes a to-do (2026-10-17)');
{
  const { rowOf, condRef } = await import('./sources/conditions.mjs');
  const LATER = Date.parse('2026-10-17T08:00:00');
  const r = conditionsFrom([
    th('u', '2026-09-08 08:01', { key: 'ups-quicktest:harborview-pantry', status: 'open', what: 'Pantry UPS quick test overdue at ONE Springfield' }),
    th('h1', '2026-09-11 01:12', { key: 'hvac-comm:3rd-floor', status: 'open', what: 'Trane 3rd Floor zone offline' }),
    th('h2', '2026-09-12 16:15', { key: 'hvac-comm:3rd-floor', status: 'open', what: 'Trane 3rd Floor zone still offline' }),
    th('n', '2026-10-17 07:30', { key: 'nvr:harborview', status: 'open', what: 'NVR down' }),
  ], { now: LATER, today: '2026-10-17' });
  const by = Object.fromEntries(r.open.map((c) => [c.key, c]));
  check('five weeks open is stuck; half an hour is not', by['ups-quicktest:harborview-pantry'].stuck === true && by['nvr:harborview'].stuck === false);
  check('a repeat alert keeps the first open time and carries the newest as last', by['hvac-comm:3rd-floor'].since === '2026-09-11 01:12' && by['hvac-comm:3rd-floor'].last === '2026-09-12 16:15');
  const row = rowOf(by['hvac-comm:3rd-floor']);
  check('the ref is the key and the minute it opened', row.ref === 'cond:hvac-comm:3rd-floor:202609110112' && condRef(by['hvac-comm:3rd-floor']) === row.ref, row.ref);
  check('the row is his, open, titled, and judged as of the newest alert', row.owed_by === 'me' && row.open && row.title.startsWith('Still no all-clear: ') && row.at === '2026-09-12 16:15');
  const back = conditionsFrom([
    th('a', '2026-09-08 08:01', { key: 'ups:x', status: 'open', what: 'x' }),
    th('b', '2026-09-09 08:01', { key: 'ups:x', status: 'resolved', what: 'x ok' }),
    th('c', '2026-10-10 08:01', { key: 'ups:x', status: 'open', what: 'x again' }),
  ], { now: LATER, today: '2026-10-17' });
  check('cleared and back again is a new ref, not the old one reopened', condRef(back.open[0]) === 'cond:ups:x:202610100801');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
