/**
 * The switch that stops the assistant spending a model call.
 *
 * Alex, 2026-09-21: "I am about to run out of claude credits for the week."
 *
 * Three things carry the weight, and each has a way of failing silently:
 *
 *  - **Absent means ON.** A repo that has never been switched off, and one
 *    whose file will not parse, must both keep judging. Failing closed here
 *    would stop a week of triage over a stray comma.
 *  - **`until` turns it back on by itself**, checked on read. His credits reset
 *    weekly; a switch he has to remember is one that stays off past payday.
 *  - **Off must never render the same as idle.** `statusLine` is what stops a
 *    thrown switch being discovered by a missing brief.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGate, setGate, mayRun, countSkip, statusLine, skipTotal, SPENDERS } from './model-gate.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const vault = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  return dir;
};
const write = (dir, d) => writeFile(join(dir, 'integrations', 'model-enabled.json'), JSON.stringify(d));

console.log('A repo nobody has switched off');
{
  const dir = await vault();
  const g = await readGate(dir);
  check('no file means ON — never fail closed on an absent switch', g.enabled === true);
  check('  and every spender may run', (await mayRun(dir, 'mail')).ok && (await mayRun(dir, 'evening')).ok);

  await writeFile(join(dir, 'integrations', 'model-enabled.json'), '{ this is not json');
  const broken = await readGate(dir);
  check('an unparseable file still runs, and says it could not be read',
        broken.enabled === true && !!broken.unreadable, JSON.stringify(broken));
  await rm(dir, { recursive: true, force: true });
}

console.log('\nSwitched off');
{
  const dir = await vault();
  const r = await setGate(dir, { enabled: false, why: 'out of credits for the week', by: 'alex@rivera.example' });
  check('the flip is recorded with when, who and why',
        r.enabled === false && !!r.since && r.why === 'out of credits for the week', JSON.stringify(r));

  for (const k of Object.keys(SPENDERS)) {
    const m = await mayRun(dir, k);
    if (!m.ok) continue;
    bad(`${k} should be gated`, JSON.stringify(m));
  }
  ok(`every spender is refused — all ${Object.keys(SPENDERS).length}, not a hand-kept subset`);

  const m = await mayRun(dir, 'mail');
  check('  the refusal names the run in words a person reads', m.label === 'the mail triage', m.label);
  check('  and carries the reason back to the caller', m.why === 'out of credits for the week');

  /* A NEW MODEL CALL THAT FORGOT TO REGISTER MUST FAIL CLOSED. The opposite
     default would let the next feature bill him through a switch he had
     thrown, which is the one outcome this whole file exists to prevent. */
  const unknown = await mayRun(dir, 'some-future-classifier');
  check('an unregistered spender is gated too, not waved through', unknown.ok === false);

  /* Turning off with no reason is refused, for the reason an outcome is
     required on a close: in a week he cannot tell credits from a test. */
  let threw = null;
  try { await setGate(dir, { enabled: false }); } catch (e) { threw = e.message; }
  check('switching off needs a reason', /reason/i.test(threw ?? ''), String(threw));
  await rm(dir, { recursive: true, force: true });
}

console.log('\nIt turns itself back on');
{
  const dir = await vault();
  await setGate(dir, { enabled: false, why: 'credits', until: '2026-09-23 07:00',
                       now: new Date('2026-09-21T14:00:00') });

  const during = await readGate(dir, { now: new Date('2026-09-22T09:00:00') });
  check('still off the day before', during.enabled === false);

  const after = await readGate(dir, { now: new Date('2026-09-23T07:00:00') });
  check('on again the minute it is due — no job, no timer', after.enabled === true && after.expired === true,
        JSON.stringify(after));
  check('  and the runs go with it', (await mayRun(dir, 'morning', { now: new Date('2026-09-23T07:00:00') })).ok);

  let threw = null;
  try { await setGate(dir, { enabled: false, why: 'x', until: 'next monday' }); } catch (e) { threw = e.message; }
  check('a date it cannot parse is refused, not silently ignored', /stamp/i.test(threw ?? ''), String(threw));
  await rm(dir, { recursive: true, force: true });
}

console.log('\nWhat a pause cost');
{
  const dir = await vault();
  await setGate(dir, { enabled: false, why: 'credits' });
  await countSkip(dir, 'mail'); await countSkip(dir, 'mail'); await countSkip(dir, 'digest');
  const g = await readGate(dir);
  check('refusals are counted per run', g.skipped.mail === 2 && g.skipped.digest === 1, JSON.stringify(g.skipped));
  check('  and totalled', skipTotal(g) === 3);

  /* The counter must never be the thing that throws inside a gate check: it is
     bookkeeping about a run that is not happening. */
  await countSkip(join(tmpdir(), 'does-not-exist-at-all'), 'mail');
  ok('counting against a repo that is not there does not throw');

  await setGate(dir, { enabled: true });
  check('coming back on clears the count — it was about that pause',
        skipTotal(await readGate(dir)) === 0);
  await rm(dir, { recursive: true, force: true });
}

console.log('\nOff must not look like a quiet week');
{
  check('on says nothing — no banner when there is nothing to say',
        statusLine({ enabled: true }) === null);

  const line = statusLine({ enabled: false, since: '2026-09-21 14:20', why: 'out of credits',
                            skipped: { mail: 9 }, until: '2026-09-23 07:00' }, { waiting: 31 });
  check('off always says something', typeof line === 'string' && line.length > 0);
  check('  it names when it went off', line.includes('2026-09-21 14:20'), line);
  check('  and why', line.includes('out of credits'), line);
  check('  and what it has cost so far', /9 runs skipped/.test(line), line);
  check('  and the work piled up behind it', /31 threads waiting/.test(line), line);
  check('  and when it comes back', line.includes('2026-09-23 07:00'), line);

  const forever = statusLine({ enabled: false, since: '2026-09-21 14:20', why: 'x' });
  check('with no end date it says so rather than implying one',
        /until you turn it back on/.test(forever), forever);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
