/** deploy/trust.mjs — is the assistant earning its closes? Arithmetic over records that exist. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureFrom, trustLine, trend, measure, record, readTrust } from './trust.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

console.log('the day\'s numbers');
{
  const open = [
    { id: 'a', since: '2026-09-20 09:00', owed_by: 'me', days: 0 },
    { id: 'b', since: '2026-09-01 09:00', owed_by: 'them', days: 19 },
    { id: 'c', since: '2026-09-10 09:00', owed_by: 'them', days: 10 },
    { id: 'd', since: '2026-09-18 09:00', owed_by: 'them', days: 2 },
  ];
  const logbook = [
    { date: '2026-09-20', time: '10:00', id: 'x', by: 'agent:review', outcome: 'closes_when met: …' },
    { date: '2026-09-20', time: '11:00', id: 'y', by: 'agent:drafts', outcome: 'sent' },
    { date: '2026-09-20', time: '12:00', id: 'z', by: 'alex@example.com', outcome: 'not a task: auto-renews' },
    { date: '2026-09-20', time: '13:00', id: 'w', by: 'alex@example.com', outcome: 'done' },
    { date: '2026-09-19', time: '13:00', id: 'v', by: 'agent:mail', outcome: 'yesterday' },
  ];
  const changes = [{ at: '2026-09-20 09:18', id: 'q', was: 'a', now: 'b' }, { at: '2026-09-20 15:00', action: 'reopened', id: 'r' }, { at: '2026-09-19 09:18', id: 's' }];
  const findings = [{ id: 'b' }, { id: 'c' }, { id: 'n' }];
  const previous = { date: '2026-09-19', findings_ids: ['b', 'c', 'gone1', 'gone2'] };
  const r = measureFrom({ date: '2026-09-20', open, logbook, changes, findings, previous });
  check('opened today, from since', r.opened === 1);
  check('closes split by who: agent 2 (review 1), him 2', r.closed === 4 && r.closed_agent === 2 && r.closed_review === 1 && r.closed_him === 2, JSON.stringify(r));
  check('a "not a task" close is a dismissal', r.dismissed === 1);
  check('corrections and reopens from the changes file, today only', r.corrected === 1 && r.reopened === 1);
  check('findings: acted = yesterday\'s that are gone, stand = still there', r.findings === 3 && r.findings_acted === 2 && r.findings_stand === 2, JSON.stringify([r.findings_acted, r.findings_stand]));
  check('waiting on others: count, median, past two weeks', r.owed_them === 3 && r.owed_them_median_days === 10 && r.owed_them_over_14 === 1);
  const first = measureFrom({ date: '2026-09-20', open, logbook, changes, findings, previous: null });
  check('with no yesterday the acted/stand pair is null, not zero', first.findings_acted === null && first.findings_stand === null);
  const line = trustLine(r);
  check('the line is one sentence in words', /opened 1, closed 4 \(2 by the assistant, 1 of them by the review, 2 by you\)/.test(line) && /dismissed 1/.test(line) && /2 were acted on and 2 stand/.test(line) && /median 10d, 1 past two weeks/.test(line), line);
  check('no line yet says so rather than inventing zeros', /no trust line yet/.test(trustLine(null)));
  const t = trend([{ date: '2026-09-14', findings: 40, owed_them_median_days: 12, owed_them_over_14: 9, closed_agent: 3, closed_him: 1 }, r]);
  check('the trend is the week\'s movement', t.findings_delta === -37 && t.owed_them_median_delta === -2 && t.closed_agent === 5 && t.closed_him === 3, JSON.stringify(t));
  check('one day is no trend', trend([r]) === null);
}

console.log('\nthe ledger');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-trust-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'logbook.md'), '# Logbook\n\n- 2026-09-20 10:00 | im:c1 | x | by agent:review | closes_when met\n');
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'c2', watermark: '2026-09-01 08:00', reviewed: '2026-09-01 08:05', conclusion: { open: true, tier: 'action', title: 'Chase X', owed_by: 'them', who: 'X', since: '2026-09-01 08:00' } } ] }));
  const now = new Date('2026-09-20T18:00:00');
  const r1 = await measure(vault, { now });
  check('measure reads the live records', r1.date === '2026-09-20' && r1.closed_review === 1 && r1.owed_them === 1 && r1.findings_acted === null, JSON.stringify(r1));
  check('  ...and writes nothing', (await readTrust(vault)).length === 0);
  await record(vault, r1);
  await record(vault, { ...r1, opened: 99 });
  const rows = await readTrust(vault);
  check('record appends; the last line for a date wins on read', rows.length === 1 && rows[0].opened === 99);
  const r2 = await measure(vault, { now: new Date('2026-09-21T18:00:00') });
  check('the next day reads yesterday\'s findings to say what was acted on', r2.findings_acted !== null, JSON.stringify(r2));
  await rm(vault, { recursive: true, force: true });
}

console.log('\nwhat the day cost');
{
  const { spendOn } = await import('./trust.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-spend-'));
  await mkdir(join(vault, '.log'), { recursive: true });
  const day = (h) => new Date(2026, 8, 20, h, 0).toISOString();   // local → UTC, as the log stamps it
  await writeFile(join(vault, '.log', 'agent-service.log'),
    [`{"at":"${day(9)}","event":"job_done","name":"mail","costUSD":1.5}`,
     `{"at":"${day(10)}","event":"job_done","name":"mail","costUSD":0.5}`,
     `{"at":"${day(11)}","event":"job_done","name":"messages","costUSD":1}`,
     `{"at":"${day(12)}","event":"job_start","name":"mail","costUSD":99}`,   // not a finished run
     'not json at all',
     `{"at":"${new Date(2026, 8, 19, 10, 0).toISOString()}","event":"job_done","name":"mail","costUSD":7}`,
    ].join('\n') + '\n');
  const s = await spendOn(vault, '2026-09-20');
  check('the day\'s finished runs are summed, per job', s.total === 3 && s.runs === 3 && s.by.mail === 2 && s.by.messages === 1, JSON.stringify(s));
  check('  yesterday is not counted', !JSON.stringify(s).includes('7'));
  check('  a start is not a run, and a bad line is skipped not fatal', s.runs === 3);
  check('no log at all is null, never a confident zero', (await spendOn(join(vault, 'nope'), '2026-09-20')) === null);
  const line = trustLine({ ...measureFrom({ date: '2026-09-20', open: [], logbook: [], changes: [], findings: [], previous: null, spend: s }) });
  check('the line says what it cost and over how many runs', /it cost \$3\.00 over 3 runs/.test(line), line);
  check('  ...and says nothing when the log could not be read', !/it cost/.test(trustLine(measureFrom({ date: '2026-09-20', open: [], logbook: [], changes: [], findings: [], previous: null }))));
  await rm(vault, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
