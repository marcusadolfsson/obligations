/**
 * The two things that let a whole mailbox go missing for hours without anyone
 * being told.
 *
 * On 2026-09-03 personal stopped being ingested at about 19:00. Two independent
 * failures had to line up, and each is covered here.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { health } from '../pipeline-health.mjs';
import { resumeFrom, escapesToProbe, isNotFound } from '../integrations/gmail-extract.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

/* ------------------------------------------------------- the cursor deadlock */

console.log('A missing cursor must not ask for days of history');
{
  const now = Date.parse('2026-09-03T23:00:00Z');
  // No cursor. Flooring to days back asked for ~600 threads of all-label mail,
  // which exceeded the per-minute quota, which failed the account, which meant
  // the cursor was never written — so the next run asked for the same again.
  // It could not escape on its own.
  const first = resumeFrom({}, 'personal', now);
  check('a first run starts from now, not from the floor',
        first.since === Math.floor(now / 1000) && first.first === true, JSON.stringify(first));
  check('  ...and is not reported as floored, because nothing was truncated',
        first.floored === false, JSON.stringify(first));

  // A real cursor resumes from it, minus a little overlap so mail arriving
  // during an extract is not missed by the next one.
  const saved = { personal: { at: Math.floor(now / 1000) - 900 } };
  const resumed = resumeFrom(saved, 'personal', now);
  check('an existing cursor is resumed from, with overlap',
        resumed.since < Math.floor(now / 1000) - 900 && resumed.first === false,
        JSON.stringify(resumed));

  // An ancient cursor is capped, and says so — being floored is incompleteness.
  const old = { personal: { at: Math.floor(now / 1000) - 30 * 86400 } };
  const capped = resumeFrom(old, 'personal', now);
  check('a very old cursor is capped AND reports it', capped.floored === true,
        JSON.stringify(capped));
}

/* ------------------------------------------- an escape Gmail no longer has */

// Alex, 2026-10-20: two escaped threads 404'd on every mail run and led the
// morning brief. The extractor asks Gmail about the unjudged ones by id.
console.log('Escaped threads are asked about by id, and only a 404 means gone');
{
  const escaped = {
    a: { thread_id: 'a', account: 'personal' },
    b: { thread_id: 'b', account: 'personal' },
    c: { thread_id: 'c', account: 'personal', gone: '2026-10-20 08:00' },
    d: { thread_id: 'd', account: 'work' },
    e: { thread_id: 'e', account: 'personal' },
  };
  const state = { threads: [{ thread_id: 'b', conclusion: { open: false } },
                            { thread_id: 'e', conclusion: { rejudge: true } }] };
  const probe = escapesToProbe(escaped, state, 'personal');
  check('unjudged escapes for this account are probed, a rejudge counting as unjudged',
        JSON.stringify(probe) === '["a","e"]', JSON.stringify(probe));
  check('  ...never one already marked gone, or another mailbox\'s',
        !probe.includes('c') && !probe.includes('d'), JSON.stringify(probe));
  check('  ...and the count is capped',
        escapesToProbe(escaped, state, 'personal', 1).length === 1);
  check('a 404 from the api is not-found',
        isNotFound(new Error('gmail threads/a (404): Requested entity was not found.')));
  check('  ...a rate limit or a server error is not',
        !isNotFound(new Error('gmail threads/a (429): slow down'))
        && !isNotFound(new Error('gmail threads/a (500): oops')));
}

/* ------------------------------------------------- a partial extract is not ok */

console.log('\nOne mailbox failing is not a clean bill of health');
async function box(extract) {
  const dir = await mkdtemp(join(tmpdir(), 'health-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });
  await writeFile(join(dir, 'integrations', 'gmail.json'), JSON.stringify(extract));
  await writeFile(join(dir, 'integrations', 'gmail-changed.json'),
    JSON.stringify({ needs_judgement: [], counts: {} }));
  await writeFile(join(dir, 'integrations', 'calendar.json'), JSON.stringify({ today: [] }));
  await writeFile(join(dir, 'integrations', 'imessage.json'), JSON.stringify({ threads: [] }));
  return health(dir);
}
{
  // `error` is set only when EVERY account fails, so one mailbox failing alone
  // reported "pipeline ok" while nothing from it had been ingested for hours.
  const partial = await box({
    mailboxes: [{ account: 'work', threads: 3 }],
    partial: [{ account: 'personal', error: 'gmail threads (403): Quota exceeded' }],
    threads: [],
  });
  const said = partial.problems.join(' | ');
  check('a mailbox missing from the extract is a problem',
        !partial.ok && /personal/.test(said), said || '(reported ok)');
  check('  ...and says nothing from it has been ingested',
        /could not be read at all|nothing from it/.test(said), said);

  const clean = await box({
    mailboxes: [{ account: 'work', threads: 3 }, { account: 'personal', threads: 127 }],
    threads: [],
  });
  check('a whole extract raises nothing about mailboxes',
        !clean.problems.some((p) => /mailbox/.test(p)), clean.problems.join(' | '));
}

/* The Reminders bridge fails in two directions and they are not the same
 * failure. A stale extract means his own reminders and his ticks stop arriving.
 * A stale mirror means the list on his phone is a photograph of an older day —
 * worse, because a list of closed things still reads as a list of things to do.
 * Alex, 2026-09-18, the day it went live. */
console.log('\nThe Reminders bridge, both directions');
{
  const { health: h } = await import('../pipeline-health.mjs');
  const { mkdtemp: mk, mkdir: md, writeFile: wf, utimes } = await import('node:fs/promises');
  const rig = async (apple, { age = 0 } = {}) => {
    const dir = await mk(join(tmpdir(), 'health-rem-'));
    await md(join(dir, 'integrations'), { recursive: true });
    await md(join(dir, '.log'), { recursive: true });
    await wf(join(dir, 'integrations', 'gmail.json'), JSON.stringify({ mailboxes: [{ account: 'a', threads: 1 }], threads: [] }));
    await wf(join(dir, 'integrations', 'gmail-changed.json'), JSON.stringify({ needs_judgement: [], counts: {} }));
    await wf(join(dir, 'integrations', 'calendar.json'), JSON.stringify({ today: [] }));
    await wf(join(dir, 'integrations', 'imessage.json'), JSON.stringify({ threads: [] }));
    if (apple) {
      const f = join(dir, 'integrations', 'reminders-apple.json');
      await wf(f, JSON.stringify(apple));
      if (age) { const t = new Date(Date.now() - age * 60000); await utimes(f, t, t); }
    }
    return h(dir);
  };
  const live = { generated_at: '2026-09-18 09:17', lists: ['Obligations', 'Reminders'], reminders: [
    { id: 'a', list: 'Obligations', completed: false, has_alarm: false, obligations_id: 'todo:1' },
    { id: 'b', list: 'Reminders', completed: false, has_alarm: false },
  ] };

  const off = await rig(null);
  check('no bridge at all raises nothing — it is opt-in and the Mac half may not be running',
        !off.problems.some((p) => /reminders:/.test(p)), off.problems.join(' | '));

  const fresh = await rig(live);
  check('a fresh extract is quiet, and counts both sides',
        !fresh.problems.some((p) => /reminders:/.test(p))
        && fresh.reminders.mirrored === 1 && fresh.reminders.his === 1, JSON.stringify(fresh.reminders));

  const old = await rig(live, { age: 240 });
  check('a stale extract says his own reminders are not arriving',
        old.problems.some((p) => /reminders: the Mac last read his lists/.test(p)), old.problems.join(' | '));

  const noisy = await rig({ ...live, reminders: [{ id: 'a', list: 'Obligations', completed: false, has_alarm: true, obligations_id: 'todo:1' }] });
  check('an alarm on a mirrored item is a problem, because the assistant never sets one',
        noisy.problems.some((p) => /alarm set/.test(p)), noisy.problems.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
