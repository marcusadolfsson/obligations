/**
 * The obligation model.
 *
 * Two things earn a test here, and they are the two reasons the model exists:
 *
 *  1. The same debt arriving on two channels is ONE obligation, not two.
 *  2. Closing it discharges EVERY channel — the failure this replaced is
 *     answering the email and leaving the text open forever.
 *
 * Everything writes to real files in a temp dir, because the write is the part
 * that matters: two of the three sources are markdown Alex maintains by hand.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listObligations, listOpen, closeObligation, sortObligations, kindTagsOf } from './obligations.mjs';
import { todoId } from './sources/todo.mjs';
import { reminderRef, urgency, reschedule } from './sources/reminders.mjs';
import { setDue } from './obligations.mjs';
import { mailRef } from './sources/email.mjs';
import { decisionId } from './sources/decisions.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const TODO = `# Todo

## Now

- [ ] send Anna the October flight dates @anna !since:2026-08-26
- [ ] chase the lock audit @hank !waiting !since:2026-08-27

## Someday

- [ ] learn to sail
`;

const REMINDERS = `# Reminders

## Active

- [ ] 2026-09-20 09:00 | Re-run deploy/login.sh before the token expires | hard | repeat:none | nags:0 | last:-
- [ ] 2026-09-02 14:00 | send Anna the October flight dates | normal | repeat:none | nags:1 | last:2026-08-28T09:00

## Stalled

- [ ] 2026-08-01 09:00 | something nobody dispositioned | normal | repeat:none | nags:4 | last:2026-08-05T09:00

## Done
`;

const STATE = {
  updated: '2026-08-29 07:00',
  threads: [
    { chat_id: 'any;-;+15551110000', watermark: '2026-08-26 09:00',
      conclusion: { open: true, what: 'owes Anna the October flight dates', who: 'anna',
                    since: '2026-08-26 09:00', priority: 'high', owed_by: 'me' } },
    { chat_id: 'any;-;+15552220000', watermark: '2026-08-20 09:00',
      conclusion: { open: false, what: 'settled', who: 'someone', since: '2026-08-20 09:00' } },
  ],
};

const ANNA_TODO = todoId('send Anna the October flight dates');
const ANNA_REM = reminderRef('send Anna the October flight dates');

async function make(links) {
  const dir = await mkdtemp(join(tmpdir(), 'obl-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });
  await writeFile(join(dir, 'todo.md'), TODO);
  await writeFile(join(dir, 'reminders.md'), REMINDERS);
  await writeFile(join(dir, 'integrations', 'imessage-state.json'), JSON.stringify(STATE, null, 1));
  if (links) {
    await writeFile(join(dir, 'integrations', 'obligation-links.json'), JSON.stringify(links, null, 1));
  }
  return dir;
}

/* ------------------------------------------------ unmerged: one per source */

console.log('Reading every source');
{
  const dir = await make(null);
  const all = await listObligations(dir);
  const open = await listOpen(dir);

  check('all three sources are read',
        new Set(all.flatMap((o) => o.evidence.map((e) => e.source))).size === 3,
        [...new Set(all.flatMap((o) => o.evidence.map((e) => e.source)))].join(','));
  check('a closed triage conclusion is returned but not open',
        all.some((o) => !o.open) && !open.some((o) => !o.open));

  const rem = open.find((o) => o.what.startsWith('Re-run'));
  check('a reminder carries its due date', rem?.due === '2026-09-20 09:00', rem?.due);
  check('  ...and how far off it is', typeof rem?.lead_days === 'number', String(rem?.lead_days));

  // rules/reminders.md: stalled reminders are reviewed on Sundays and not
  // nagged in between. Listing them daily is the nagging that rule forbids.
  check('a stalled reminder is not surfaced',
        !open.some((o) => o.what.includes('nobody dispositioned')));

  check('a task he is waiting on keeps its direction',
        open.find((o) => o.what.startsWith('chase the lock'))?.owed_by === 'them');
  check('unmerged, the same wording is still three separate items',
        open.filter((o) => o.what.toLowerCase().includes('flight dates')).length === 3,
        'code must never merge on its own — that is judgement');
}

/* ------------------------------------------------------------ merged */

console.log('\nOne obligation, three channels');
const LINKS = {
  merges: [{
    id: 'im:any;-;+15551110000',
    members: ['im:any;-;+15551110000', ANNA_TODO, ANNA_REM],
    note: 'Anna asked by text; the todo and the reminder are the same thing',
  }],
};
{
  const dir = await make(LINKS);
  const open = await listOpen(dir);
  const anna = open.find((o) => o.id === 'im:any;-;+15551110000');

  check('three pieces of evidence become one obligation',
        open.filter((o) => o.what.toLowerCase().includes('flight dates')).length === 1);
  check('  ...carrying all three', anna?.evidence.length === 3,
        String(anna?.evidence.length));
  check('  ...with the canonical wording', anna?.what === 'owes Anna the October flight dates',
        anna?.what);
  check('  ...the earliest start', anna?.since === '2026-08-26 09:00', anna?.since);
  check('  ...the deadline the reminder brought', anna?.due === '2026-09-02 14:00', anna?.due);
  check('  ...and the strongest priority', anna?.priority === 'high', anna?.priority);
  check('the thread is still reachable for the drill-down',
        anna?.chat_id === 'any;-;+15551110000', anna?.chat_id);
}

/* -------------------------------------------------------- closing it once */

console.log('\nClosing discharges every channel');
{
  const dir = await make(LINKS);
  const r = await closeObligation(dir, 'im:any;-;+15551110000', 'alex@rivera.example',
                                  'she confirmed by text');

  check('all three sources report closed', r.closed.length === 3 && !r.failed.length,
        JSON.stringify(r));

  const todoAfter = await readFile(join(dir, 'todo.md'), 'utf8');
  check('the todo line is ticked',
        todoAfter.includes('- [x] send Anna the October flight dates @anna'));
  check('  ...and the other tasks are untouched',
        todoAfter.includes('- [ ] chase the lock audit @hank !waiting !since:2026-08-27')
        && todoAfter.includes('- [ ] learn to sail'));

  const remAfter = await readFile(join(dir, 'reminders.md'), 'utf8');
  const doneIdx = remAfter.indexOf('## Done');
  check('the reminder moved to Done',
        remAfter.indexOf('send Anna the October flight dates | normal') > doneIdx,
        'it must leave ## Active or the dispatcher keeps nagging');
  check('  ...checked, with its fields intact',
        /- \[x\] 2026-09-02 14:00 \| send Anna the October flight dates \| normal \| repeat:none \| nags:1 \| last:\S+/
          .test(remAfter));
  check('  ...and the other reminder still active',
        remAfter.slice(0, doneIdx).includes('Re-run deploy/login.sh'));

  const state = JSON.parse(await readFile(join(dir, 'integrations', 'imessage-state.json'), 'utf8'));
  const t = state.threads.find((x) => x.chat_id === 'any;-;+15551110000');
  check('the thread conclusion is closed', t.conclusion.open === false);
  check('  ...naming who closed it', t.conclusion.closed_by === 'alex@rivera.example');
  check('  ...with the watermark that makes it stay closed',
        t.conclusion.closed_watermark === '2026-08-26 09:00');

  const log = await readFile(join(dir, 'logbook.md'), 'utf8');
  check('the close is recorded in the logbook', log.includes('im:any;-;+15551110000'),
        'ticking a box says an item is not outstanding; it does not say when or by whom');
  check('  ...naming who, what, and the outcome given',
        log.includes('by alex@rivera.example')
        && log.includes('owes Anna the October flight dates')
        && log.includes('she confirmed by text'), log.trim().split('\n').pop());

  check('it is gone from the open list',
        !(await listOpen(dir)).some((o) => o.id === 'im:any;-;+15551110000'));

  let threw = null;
  try { await closeObligation(dir, 'im:any;-;+15551110000', 'x'); } catch (e) { threw = e.message; }
  check('closing it twice is refused, not silently re-done', threw === 'already closed', String(threw));
}

/* ------------------------------------------------------------- urgency */

// CLASS is not urgency. `hard` says the consequence is real when the day comes,
// not that the day is close — and mapping it straight to `high` put a token
// expiry three weeks out above messages that had sat unanswered for twelve
// days, which is exactly backwards.
console.log('\nUrgency comes from the deadline, not just the class');
{
  const at = (due, now) => urgency('hard', due, Date.parse(now));

  check('a hard reminder three weeks out is low, not high',
        at('2026-09-20 09:00', '2026-08-29T10:00') === 'low',
        at('2026-09-20 09:00', '2026-08-29T10:00'));
  check('  ...normal two weeks out', at('2026-09-20 09:00', '2026-09-08T10:00') === 'normal',
        at('2026-09-20 09:00', '2026-09-08T10:00'));
  check('  ...high three days out', at('2026-09-20 09:00', '2026-09-17T10:00') === 'high',
        at('2026-09-20 09:00', '2026-09-17T10:00'));
  check('  ...and high once it has passed', at('2026-09-20 09:00', '2026-09-21T10:00') === 'high');

  check('a normal reminder never shouts early',
        urgency('normal', '2026-09-20 09:00', Date.parse('2026-09-08T10:00')) === 'low');
  check('  ...but is high when overdue',
        urgency('normal', '2026-09-20 09:00', Date.parse('2026-09-21T10:00')) === 'high');

  // gentle exists precisely to say "tell me, but do not make a noise about it".
  check('a gentle reminder stays quiet even overdue',
        urgency('gentle', '2026-09-20 09:00', Date.parse('2026-09-30T10:00')) === 'normal');
  check('  ...and low before then',
        urgency('gentle', '2026-09-20 09:00', Date.parse('2026-09-01T10:00')) === 'low');

  check('an unparseable due date does not throw', urgency('hard', 'whenever') === 'high');
}

/* ------------------------------------------------------------- robustness */

console.log('\nWhen things are wrong');
{
  const dir = await make(null);
  await writeFile(join(dir, 'integrations', 'imessage-state.json'), '{ not json');
  const open = await listOpen(dir);
  check('a broken source does not take the others down',
        open.length > 0 && open.some((o) => o.evidence[0].source === 'todo'),
        'one unreadable file must not blank the list');
}
{
  const dir = await make({ merges: [{ id: 'nonsense', members: 'not an array' }] });
  const open = await listOpen(dir);
  check('a malformed links file falls back to no merges',
        open.filter((o) => o.what.toLowerCase().includes('flight dates')).length === 3,
        'failing towards duplicates is safe; failing towards a wrong merge hides a debt');
}
{
  const dir = await make(null);
  let threw = null;
  try { await closeObligation(dir, 'todo:nope', 'x'); } catch (e) { threw = e.message; }
  check('closing something that does not exist is refused',
        threw === 'no such obligation', String(threw));
}
{
  const rows = [
    { priority: 'low', days: 30 }, { priority: 'high', days: 1 }, { priority: 'normal', days: 9 },
  ];
  check('sorting by priority puts high first',
        sortObligations(rows, 'priority')[0].priority === 'high');
  check('sorting by age puts the oldest first',
        sortObligations(rows, 'days')[0].days === 30);
}

// Tags are Alex's browsing handles, keyed by the merged id in
// integrations/obligation-tags.json. A todo line's #project is the same idea
// written where it lives, so it shows as a tag too.
{
  const { cleanTags } = await import('./obligations.mjs');
  const c = cleanTags(['#ONE', 'one', ' Aircraft ', '', '#', 'x'.repeat(41), 'tax']);
  check('cleanTags lower-cases, strips #, de-duplicates, drops empty and over-long',
        JSON.stringify(c) === JSON.stringify(['aircraft', 'one', 'tax']), JSON.stringify(c));
}

// Deadlines are CALENDAR days. Elapsed milliseconds is the obvious
// implementation and it is wrong: most due dates carry no time and parse to
// midnight, so yesterday read as two days overdue, today read as one AND
// overdue at 00:01, and tomorrow read as zero — which put tomorrow's items
// under TODAY. Caught by the morning brief of 2026-09-03.
{
  const { deadline } = await import('./obligations.mjs');
  const noon = new Date('2026-09-03T12:00:00').getTime();
  const cases = [
    ['2026-09-02', -1, true,  'a bare date yesterday is one day overdue'],
    ['2026-09-03',  0, false, 'a bare date today is due, not overdue'],
    ['2026-09-04',  1, false, 'a bare date tomorrow is one day out, not today'],
    ['2026-07-16', -49, true, 'and a long-overdue one counts calendar days'],
  ];
  for (const [due, lead, over, name] of cases) {
    const d = deadline(due, noon);
    check(name, d.lead_days === lead && d.overdue === over,
          `lead=${d.lead_days} overdue=${d.overdue}`);
  }
  // A time makes "overdue" mean the moment, not the day.
  check('09:00 today is overdue by noon',
        deadline('2026-09-03 09:00', noon).overdue === true);
  check('  ...and 18:00 today is not',
        deadline('2026-09-03 18:00', noon).overdue === false);
  check('  ...both still read as due today',
        deadline('2026-09-03 09:00', noon).lead_days === 0
        && deadline('2026-09-03 18:00', noon).lead_days === 0);
}

console.log('\nreminders — a due date moved by hand');
{
  const dir = await mkdtemp(join(tmpdir(), 'obligations-'));
  await writeFile(join(dir, 'reminders.md'), '# Reminders\n\n## Active\n\n- [ ] 2026-09-04 09:00 | Add WhatsApp integration to obligations | normal | repeat:none | nags:2 | last:2026-09-05T18:28\n\n## Stalled\n\n## Done\n');
  const ref = reminderRef('Add WhatsApp integration to obligations');
  const r = await reschedule(dir, ref, '2026-10-01 09:00', 'alex@rivera.example');
  const after = await readFile(join(dir, 'reminders.md'), 'utf8');
  check('the line carries the new due, and the ladder starts over', /- \[ \] 2026-10-01 09:00 \| Add WhatsApp integration to obligations \| normal \| repeat:none \| nags:0 \| last:-/.test(after), after);
  check('the ref survives (the text is the id)', reminderRef('Add WhatsApp integration to obligations') === ref && r.was === '2026-09-04 09:00');
  let err = null; try { await reschedule(dir, ref, '2026-13-01 09:00', 'x'); } catch (e) { err = e; }
  check('a bad date is refused', /not a real date|must be/.test(err?.message ?? ''));
  err = null; try { await reschedule(dir, 'rem:000000000000', '2026-10-01 09:00', 'x'); } catch (e) { err = e; }
  check('an unknown id is refused', /no open reminder/.test(err?.message ?? ''));
  await rm(dir, { recursive: true, force: true });
}

console.log('\nsetDue — one door, whatever source holds the date');
{
  const dir = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'todo.md'), '# Todo\n\n- [ ] Renew the hangar insurance !due:2026-09-20 #hangar\n- [ ] Call the roofer\n');
  await writeFile(join(dir, 'reminders.md'), '# Reminders\n\n## Active\n\n- [ ] 2026-09-04 09:00 | Add WhatsApp integration to obligations | normal | repeat:none | nags:2 | last:2026-09-05T18:28\n\n## Done\n');
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({ threads: [{ thread_id: 'abc123', account: 'personal', conclusion: { tier: 'action', open: true, due: '2026-09-21', title: 'Forms', what: 'x', who: 'a@b.c' } }] }));
  await writeFile(join(dir, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [{ chat_id: 'any;-;+15550001111', conclusion: { open: true, what: 'y', who: '+15550001111' } }] }));
  await writeFile(join(dir, 'decisions.md'), '# Decisions\n\n## Cabinetry vendor  !due:2026-09-12  #one\n\n- options: A · B\n');
  const t1 = await setDue(dir, todoId('Renew the hangar insurance'), '2026-10-01');
  const todoAfter = await readFile(join(dir, 'todo.md'), 'utf8');
  check('a todo line: !due replaced, tag kept, id unchanged', t1.was === '2026-09-20' && /insurance !due:2026-10-01 #hangar/.test(todoAfter), todoAfter);
  await setDue(dir, todoId('Call the roofer'), '2026-10-02');
  check('a todo line without a due gets one appended', /Call the roofer !due:2026-10-02/.test(await readFile(join(dir, 'todo.md'), 'utf8')));
  const r1 = await setDue(dir, reminderRef('Add WhatsApp integration to obligations'), '2026-10-03');
  check('a reminder given only a date is due at 09:00 and the ladder resets', r1.due === '2026-10-03 09:00' && /2026-10-03 09:00 \|.*nags:0 \| last:-/.test(await readFile(join(dir, 'reminders.md'), 'utf8')));
  const m1 = await setDue(dir, mailRef('abc123', 'personal'), '2026-10-04');
  check('a judged mail thread: the conclusion\'s due moves', m1.was === '2026-09-21' && JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8')).threads[0].conclusion.due === '2026-10-04');
  await setDue(dir, 'im:any;-;+15550001111', '2026-10-05 14:00');
  check('a judged text thread: a due is set where there was none', JSON.parse(await readFile(join(dir, 'integrations', 'imessage-state.json'), 'utf8')).threads[0].conclusion.due === '2026-10-05 14:00');
  const d1 = await setDue(dir, decisionId('Cabinetry vendor'), '2026-10-06');
  check('a decision heading: !due replaced, tag kept', d1.was === '2026-09-12' && /## Cabinetry vendor  !due:2026-10-06  #one/.test(await readFile(join(dir, 'decisions.md'), 'utf8')), await readFile(join(dir, 'decisions.md'), 'utf8'));
  let err = null; try { await setDue(dir, 'recur:abc:2026-09', '2026-10-07'); } catch (e) { err = e; }
  check('a recurring item refuses, naming the definition', /recurring\.md/.test(err?.message ?? ''));
  err = null; try { await setDue(dir, todoId('Call the roofer'), 'next tuesday'); } catch (e) { err = e; }
  check('a bad date is refused', /YYYY-MM-DD/.test(err?.message ?? ''));
  await rm(dir, { recursive: true, force: true });
}

/* The four characters he can say out loud. Alex, 2026-09-19: "can you add a
 * unique id (like the reminders have) so I can easily share with you." */
console.log('\nthe short code');
{
  const { shortCode, codesFor } = await import('./obligations.mjs');
  const a = shortCode('mail:personal:1a092bcaffef867f');
  check('a code is four characters from an unambiguous alphabet',
        /^[23456789CDFGHJKLMNPQRSTVWXZ]{4}$/.test(a), a);
  check('the same id always gives the same code — nothing is assigned or stored',
        shortCode('mail:personal:1a092bcaffef867f') === a);
  check('a different id gives a different code', shortCode('todo:631a0731d49e') !== a);
  check('no vowels, so a code cannot spell a word by accident',
        !/[AEIOU]/.test([...Array(200)].map((_, i) => shortCode('x' + i)).join('')));

  // A code pointing at two things is worse than a long one: he quotes it and
  // gets the wrong debt, and neither of us knows.
  const collide = ['a', 'b', 'c'];
  const forced = codesFor(collide);
  check('every id in a list gets a code', collide.every((id) => forced.get(id)));
  check('  ...and they are unique', new Set([...forced.values()]).size === collide.length);
  // Build a real collision by searching for one, so the lengthening path runs.
  const seen = new Map();
  let pair = null;
  for (let i = 0; i < 200000 && !pair; i++) {
    const id = `todo:${i}`, c = shortCode(id);
    if (seen.has(c)) pair = [seen.get(c), id]; else seen.set(c, id);
  }
  if (pair) {
    const out = codesFor(pair);
    check('two ids that collide on four characters both get six',
          out.get(pair[0]).length === 6 && out.get(pair[1]).length === 6
          && out.get(pair[0]) !== out.get(pair[1]),
          `${pair.join(' vs ')} -> ${out.get(pair[0])}, ${out.get(pair[1])}`);
  } else {
    check('two ids that collide on four characters both get six', true, 'no collision found in 200k ids');
  }
}


/* NO IDENTITY IS NOT A HUMAN. Review 2026-09-20: a close that arrived with no
 * `who` wrote closed_by 'manual' — truthy, no agent: prefix — which the
 * differs read as a decision of his and never re-offer. A close nobody signed
 * became permanent, the wrong way to fail. Unknown gets the agent's treatment. */
console.log('\na close with nobody behind it');
{
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { close: closeIm } = await import('./sources/imessage.mjs');
  const { close: closeMail } = await import('./sources/email.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-whom-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [{ chat_id: 'c1', watermark: '2026-09-10 10:00', conclusion: { open: true, title: 'x', what: 'x' } }] }));
  await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [{ thread_id: 't1', account: 'personal', watermark: '2026-09-10 10:00', conclusion: { open: true, tier: 'action', title: 'y', what: 'y' } }] }));
  await closeIm(vault, 'c1', null, 'done');
  await closeMail(vault, 'mail:personal:t1', null, 'done');   // the ref, as mailRef() builds it
  const im = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8')).threads[0].conclusion;
  const ml = JSON.parse(await readFile(join(vault, 'integrations', 'email-state.json'), 'utf8')).threads[0].conclusion;
  check('a message close with no who is agent:unknown, so it gets its second look', im.closed_by === 'agent:unknown', im.closed_by);
  check('and so is a mail close', ml.closed_by === 'agent:unknown', ml.closed_by);
}


/* A TEXT CAN CARRY A TIER NOW, LIKE MAIL. Review item 6, 2026-09-20. And only
 * `action` is ever a debt: the tier IS the reason nothing is owed, so a memory
 * text marked open is a contradiction the adapter refuses rather than lists. */
console.log('\na text with a tier');
{
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { read: readIm } = await import('./sources/imessage.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-tier-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'c-act', conclusion: { open: true, tier: 'action', title: 'Answer Anna', what: 'x', since: '2026-09-10 10:00', closes: 'she confirms a date', due: '2026-09-25' } },
    { chat_id: 'c-old', conclusion: { open: true, title: 'Before tiers existed', what: 'x', since: '2026-09-10 10:00' } },
    { chat_id: 'c-mem', conclusion: { open: true, tier: 'memory', title: 'The gate code is 4471', what: 'gate code 4471', since: '2026-09-10 10:00' } },
    { chat_id: 'c-aw', conclusion: { open: false, tier: 'awareness', title: 'Water off Tuesday', what: 'x', since: '2026-09-10 10:00', surfaced_for: '2026-09-23' } },
  ] }));
  const rows = await readIm(vault);
  const by = Object.fromEntries(rows.map((r) => [r.ref, r]));
  check('an action text is open, with closes and due passed through', by['c-act'].open && by['c-act'].closes === 'she confirms a date' && by['c-act'].due === '2026-09-25', JSON.stringify(by['c-act']));
  check('a conclusion from before tiers is still a debt', by['c-old'].open === true);
  check('a memory text marked open is refused as a debt', by['c-mem'].open === false, JSON.stringify(by['c-mem']));
  check('and an awareness text carries its date for the brief', by['c-aw'].detail.tier === 'awareness' && by['c-aw'].detail.surfaced_for === '2026-09-23');
}


/* ONE STATE PER OBLIGATION. Review item 2, 2026-09-20. The obligation owns
 * its close; sources are evidence. A merged text-promise and Apple reminder —
 * the text half closes, the Apple half refuses (an agent may not tick his
 * list) — is CLOSED, with the refusal reported, and stays closed on the next
 * read. (Earlier the same day this test pinned the opposite: a half-close was
 * not a close and wrote no logbook line, because the sources still owned the
 * state and any one of them could reopen it.) */
console.log('\none state per obligation: a half-propagated close is a close');
{
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { closeObligation, linkObligations, reopenObligation, listObligations } = await import('./obligations.mjs');
  const { readObligationState, reconcileState } = await import('./obligation-state.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-half-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  const imState = { threads: [
    { chat_id: 'c-half', watermark: '2026-09-10 10:00', reviewed: '2026-09-19 10:00', conclusion: { open: true, title: 'Send Anna the dates', what: 'x', since: '2026-09-10 10:00' } } ] };
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(imState));
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({ generated_at: '2026-09-19 10:00', lists: ['Obligations'], reminders: [
    { id: 'u-half', title: 'Send Anna the dates', list: 'Reminders', completed: false, created: '2026-09-10 10:00' } ] }));
  const { listOpen } = await import('./obligations.mjs');
  const open = await listOpen(vault);
  const im = open.find((o) => o.id === 'im:c-half'); const ap = open.find((o) => o.id.startsWith('apple:'));
  if (im && ap) {
    await linkObligations(vault, im.id, ap.id);
    const r = await closeObligation(vault, im.id, 'agent:drafts', 'the text went out').catch((e) => ({ error: e.message }));
    check('the text half closes and the Apple half is reported as not closed', r.closed?.includes('imessage') && r.failed?.some((f) => /apple/.test(f)) && r.partial === true, JSON.stringify(r));
    const st = await readObligationState(vault);
    check('  the obligation\'s own record says closed, by whom, with the outcome',
      st.closed[im.id]?.by === 'agent:drafts' && st.closed[im.id]?.outcome === 'the text went out', JSON.stringify(st));
    const after = await listOpen(vault);
    check('  ...and it is OFF the list although the Apple half still reports it open', !after.some((o) => o.id === im.id), JSON.stringify(after.map((o) => o.id)));
    const row = (await listObligations(vault)).find((o) => o.id === im.id);
    check('  the merged row carries closed_at / closed_by / outcome from the record', row && !row.open && row.closed_by === 'agent:drafts' && row.outcome === 'the text went out' && row.closed_at, JSON.stringify(row && { open: row.open, closed_by: row.closed_by, closed_at: row.closed_at }));
    let log = ''; try { log = await readFile(join(vault, 'logbook.md'), 'utf8'); } catch {}
    check('  the logbook records the decision (it was made, whatever the sources did with it)', /c-half/.test(log) && /the text went out/.test(log), log.slice(-200));

    /* THE NEWEST DECISION WINS. Evidence NEWER than the close reopens it — the
     * triage re-reading the thread after a new message. Undated or older
     * evidence does not. */
    console.log('\nthe newest decision wins');
    const closedAt = st.closed[im.id].at;
    // Older evidence, flipped open by hand: the record stands.
    imState.threads[0].conclusion.open = true;
    imState.threads[0].reviewed = '2026-09-19 10:00';
    await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(imState));
    check('an older conclusion saying open does not outvote a dated close', !(await listOpen(vault)).some((o) => o.id === im.id), closedAt);
    // Newer evidence: a re-judgement after the close.
    const later = new Date(Date.parse(closedAt.replace(' ', 'T')) + 3600e3);
    const stamp = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')} ${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;
    /* A NEW READING OF THE SAME MESSAGES IS NOT NEW EVIDENCE. Alex,
       2026-09-24: "my last email in that thread says i signed it." He had
       closed the Riverton Ventures e-file item himself; the triage re-read a
       thread with nothing on it since August, misread it, and its newer
       conclusion reopened his close. */
    imState.threads[0].reviewed = stamp;
    await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(imState));
    check('a conclusion re-read AFTER the close, with no new message, does not reopen it',
          !(await listOpen(vault)).some((o) => o.id === im.id), JSON.stringify({ reviewed: stamp, watermark: imState.threads[0].watermark, closedAt }));
    // Somebody wrote after the close: that is evidence.
    imState.threads[0].watermark = stamp;
    await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(imState));
    const all = await listObligations(vault);
    const re = all.find((o) => o.id === im.id);
    check('a message AFTER the close, judged open, reopens it', re?.open === true, JSON.stringify(re && { open: re.open, watermark: stamp, closedAt }));
    check('  ...and says which evidence did it', re?.reopened_by_evidence === stamp, JSON.stringify(re?.reopened_by_evidence));
    const dropped = await reconcileState(vault, all);
    check('  reconcileState drops the outvoted record and logs the reopen', dropped.length === 1 && !(await readObligationState(vault)).closed[im.id], JSON.stringify(dropped));
    let changes = ''; try { changes = await readFile(join(vault, 'integrations', 'obligation-changes.jsonl'), 'utf8'); } catch {}
    check('  ...in obligation-changes.jsonl, by "evidence"', /"action":"reopened"/.test(changes) && /"by":"evidence"/.test(changes), changes.slice(0, 200));

    /* THE REOPEN DOOR. A decision with a name and a reason. */
    console.log('\nreopen is a decision with a name on it');
    const r2 = await closeObligation(vault, im.id, 'alex@example.com', 'done');
    check('closed again, by him', r2.closed?.length >= 1 && (await readObligationState(vault)).closed[im.id]?.by === 'alex@example.com', JSON.stringify(r2));
    const noName = await reopenObligation(vault, im.id, '', 'why').catch((e) => e.message);
    check('refuses without a name', /name/.test(String(noName)), String(noName));
    const noWhy = await reopenObligation(vault, im.id, 'alex@example.com', ' ').catch((e) => e.message);
    check('refuses without a reason', /reason/.test(String(noWhy)), String(noWhy));
    const ro = await reopenObligation(vault, im.id, 'alex@example.com', 'she never got the dates');
    check('reopens: record cleared, the message conclusion flipped open and marked', ro.reopened === true && ro.flipped.includes('imessage'), JSON.stringify(ro));
    const imNow = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8')).threads[0];
    check('  the conclusion says open, reopened by whom and why', imNow.conclusion.open === true && imNow.conclusion.reopened?.by === 'alex@example.com' && /never got/.test(imNow.conclusion.reopened?.why), JSON.stringify(imNow.conclusion));
    check('  ...and is back on the list', (await listOpen(vault)).some((o) => o.id === im.id));
    const again = await reopenObligation(vault, im.id, 'alex@example.com', 'twice');
    check('reopening an open one is a no-op, not an error', again.reopened === false, JSON.stringify(again));
  } else {
    check('fixture loads both halves', false, JSON.stringify(open.map((o) => o.id)));
  }
}

/* SOURCES CARRY THEIR EVIDENCE STAMP. Without `at` on a mail or text row the
 * rule above has nothing to compare, and every conclusion would read as
 * undated — able neither to reopen nor to be told apart from a todo line. */
console.log('\nmail and text evidence is dated');
{
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const email = await import('./sources/email.mjs');
  const im = await import('./sources/imessage.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-at-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: 't1', account: 'a', watermark: '2026-09-10 10:00', reviewed: '2026-09-19 10:00', conclusion: { open: true, tier: 'action', title: 'x' } },
    { thread_id: 't2', account: 'a', watermark: '2026-09-11 10:00', conclusion: { open: true, tier: 'action', title: 'y' } } ] }));
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'c1', watermark: '2026-09-10 10:00', reviewed: '2026-09-18 09:00', conclusion: { open: true, title: 'x', what: 'x' } } ] }));
  const rows = await email.read(vault);
  check('a mail row carries `reviewed` as its evidence stamp', rows.find((r) => r.ref === 'mail:a:t1')?.at === '2026-09-19 10:00', JSON.stringify(rows.map((r) => r.at)));
  check('  ...falling back to the watermark when never reviewed', rows.find((r) => r.ref === 'mail:a:t2')?.at === '2026-09-11 10:00');
  const trows = await im.read(vault);
  check('a text row carries `reviewed` too', trows[0]?.at === '2026-09-18 09:00', JSON.stringify(trows[0]));
}

/* THE OUTCOME SURVIVES ON A MESSAGE CLOSE. imessage.close() took no outcome
 * and dropped the one closeObligation passed. */
console.log('\na message close keeps its outcome');
{
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { close: closeIm } = await import('./sources/imessage.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-oc-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [{ chat_id: 'c1', watermark: '2026-09-10 10:00', conclusion: { open: true, title: 'x', what: 'x' } }] }));
  await closeIm(vault, 'c1', 'agent:test', 'she confirmed by text');
  const c = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8')).threads[0].conclusion;
  check('the outcome is on the conclusion', c.outcome === 'she confirmed by text', JSON.stringify(c));
}

/* A DISMISSAL IS A LESSON. Review item 3, 2026-09-20: "Not a task" on the
 * page becomes a verdict in rules/verdicts.md, scoped to the source that
 * opened it, in his words. */
console.log('\na dismissal becomes a verdict');
{
  const { dismissalVerdict } = await import('./obligations.mjs');
  const mail = { id: 'mail:a:1', title: 'Renew the Frankel membership', who: 'Frankel', since: '2026-09-10 08:00', evidence: [{ source: 'email' }] };
  const v = dismissalVerdict(mail, 'it auto-renews; the mail was a receipt');
  check('a mail-opened item gives a mail-scoped verdict', v.scope === 'mail', v.scope);
  check('  the call names the title, the source, the person and the date', /"Renew the Frankel membership" was not a task — opened from a mail thread \(Frankel\) on 2026-09-10/.test(v.call), v.call);
  check('  the why is his reason', v.why === 'it auto-renews; the mail was a receipt');
  check('  and the outcome says not a task', v.outcome === 'not a task: it auto-renews; the mail was a receipt');
  check('a text-opened item is message-scoped', dismissalVerdict({ title: 'x', evidence: [{ source: 'imessage' }] }, 'no').scope === 'message');
  check('a todo line is general', dismissalVerdict({ title: 'x', evidence: [{ source: 'todo' }] }, '').scope === 'general');
  check('no reason still records something honest', /without a reason/.test(dismissalVerdict({ title: 'x', evidence: [] }, '  ').why));
  check('pipes and newlines cannot break the verdict line', !/[|\n]/.test(dismissalVerdict({ title: 'a | b\nc', evidence: [] }, 'x |\n y').why));
}

/* ONE RECORD PER OBLIGATION. The review, 2026-09-20: merges, tags, snoozes,
 * chases and the close were five files that could disagree. They are slices
 * of obligation-state.json now; the old files are read only while a slice is
 * absent, and the first write carries everything forward. */
console.log('\none record per obligation');
{
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readObligationState, updateState, SLICES } = await import('./obligation-state.mjs');
  const { setTags, linkObligations, listOpen } = await import('./obligations.mjs');
  const { snooze, snoozed } = await import('./snooze.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-rec-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  check('five slices', SLICES.join(',') === 'closed,links,tags,snoozed,chased');
  // The old files, as they were.
  await writeFile(join(vault, 'integrations', 'obligation-links.json'), JSON.stringify({ merges: [{ id: 'todo:p', members: ['todo:p', 'apple:c'], why: 'same thing' }] }));
  await writeFile(join(vault, 'integrations', 'obligation-tags.json'), JSON.stringify({ tags: { 'todo:p': ['one'] } }));
  await writeFile(join(vault, 'integrations', 'snoozed.json'), JSON.stringify({ until: { 'todo:p': '2999-01-01 07:00' } }));
  await writeFile(join(vault, '.log', 'chases.json'), JSON.stringify({ 'mail:a:1': { at: '2026-09-18 10:00', who: 'Dana', channel: 'mail', text: 'x' } }));
  const st = await readObligationState(vault);
  check('an absent slice is read from the file it used to be: links (child → parent)', st.links['apple:c']?.into === 'todo:p' && st.links['apple:c'].why === 'same thing', JSON.stringify(st.links));
  check('  ...tags', JSON.stringify(st.tags['todo:p']) === '["one"]');
  check('  ...snoozed', st.snoozed['todo:p'] === '2999-01-01 07:00');
  check('  ...chased', st.chased['mail:a:1']?.who === 'Dana');
  check('  ...and the close slice is empty, not missing', st.closed && Object.keys(st.closed).length === 0);
  await setTags(vault, 'todo:q', ['two']);
  const file = JSON.parse(await readFile(join(vault, 'integrations', 'obligation-state.json'), 'utf8'));
  check('the first write carries every slice into the record', file.links['apple:c'] && file.tags['todo:p'] && file.tags['todo:q'] && file.snoozed['todo:p'] && file.chased['mail:a:1'], Object.keys(file).join(','));
  await writeFile(join(vault, 'integrations', 'obligation-tags.json'), JSON.stringify({ tags: { 'todo:p': ['STALE'] } }));
  check('  ...after which the old file is never consulted again', JSON.stringify((await readObligationState(vault)).tags['todo:p']) === '["one"]');
  check('snoozed() reads the record', (await snoozed(vault)).get('todo:p') === '2999-01-01 07:00');
  await snooze(vault, 'todo:r', '2999-02-01 07:00');
  check('  ...and writes it', (await readObligationState(vault)).snoozed['todo:r'] === '2999-02-01 07:00');

  // A native link, through the door, on real obligations.
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] File the sales tax return !since:2026-09-02\n- [ ] Sales tax !since:2026-09-05\n');
  const open = await listOpen(vault);
  const [a, b] = open.filter((o) => /sales tax/i.test(o.title));
  const r = await linkObligations(vault, b.id, a.id, 'one return');
  check('a link is recorded on the child, pointing at the older parent, with the reason and a stamp', r.id === a.id && (await readObligationState(vault)).links[b.id]?.into === a.id && /one return/.test((await readObligationState(vault)).links[b.id].why));
  check('  ...and the list shows one row', (await listOpen(vault)).filter((o) => /sales tax/i.test(o.title)).length === 1);
  let chain = null; try { await linkObligations(vault, b.id, a.id, 'x'); } catch (e) { chain = e.message; }
  check('  a merged item is no longer its own obligation, so it cannot be merged again', /no open obligation/.test(String(chain)), String(chain));
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] File the sales tax return !since:2026-09-02\n- [ ] Sales tax !since:2026-09-05\n- [ ] Call the accountant !since:2026-09-01\n');
  const c = (await listOpen(vault)).find((o) => /accountant/.test(o.title));
  let parentChain = null; try { await linkObligations(vault, c.id, a.id, 'x'); } catch (e) { parentChain = e.message; }
  check('  ...and a parent with children cannot become a child of something older (no chains)', /already has items merged into it/.test(String(parentChain)), String(parentChain));
}

/* INVOICES. Alex, 2026-09-28: "In the todo list, I want to add a tag for
 * invoices." A kind tag beside the project tag, from the title, timid — every
 * case below is a real title from that day's list. */
console.log('\na tag for invoices');
{
  const is = (title, owed_by = 'me') => kindTagsOf({ title, owed_by }).includes('invoice');
  check('"Pay the …" is an invoice', is('Pay the Webber invoice INV-00001001') && is('Pay the Power Co bill') && is('Pay the Riverton County business tax'));
  check('  so is "Settle …", and a title that names an invoice', is('Settle the Northwind late-payment interest charge') && is('Review the new PEC ESP invoice (5552000010)'));
  check('the lookalikes are not', !is('Give Ruth the go on the PHOA auto-renewal email') && !is("Tell Pete Rourke how to bill Mia's sessions")
        && !is("Confirm Jared Hanley's capital call wire landed") && !is('Update Social Verified payment method'), '');
  check('something THEY owe is not his invoice', !is('Pay the Webber invoice', 'them'));
  check('"Settle" only over money — settling a timeline is a decision',
        !is('Settle the Elmwood listing timeline with Dana and Dora') && is('Settle the 123 Security Products the state tax'));

  const dir = await mkdtemp(join(tmpdir(), 'obligations-inv-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await mkdir(join(dir, 'projects'), { recursive: true });
  await writeFile(join(dir, 'projects', 'one.md'), '---\ntype: project\nname: ONE\nstatus: active\ntag: one\nmatch-people:\nmatch-words: charging\n---\n');
  await writeFile(join(dir, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] Pay the unit 2202 EV charging invoice\n- [ ] Tell Pete Rourke how to bill the sessions\n- [ ] Pay the GasCo propane invoice\n');
  const edited = todoId('Pay the GasCo propane invoice');
  await writeFile(join(dir, 'integrations', 'obligation-state.json'), JSON.stringify({ closed: {}, links: {}, tags: { [edited]: [] }, snoozed: {}, chased: {} }));
  const rows = await listOpen(dir);
  const tagsOf = (t) => rows.find((o) => o.title === t)?.tags ?? null;
  check('an invoice on a project carries both tags — the kind does not stop the project',
        JSON.stringify(tagsOf('Pay the unit 2202 EV charging invoice')) === '["invoice","one"]', JSON.stringify(tagsOf('Pay the unit 2202 EV charging invoice')));
  check('the lookalike gets nothing', JSON.stringify(tagsOf('Tell Pete Rourke how to bill the sessions')) === '[]', JSON.stringify(tagsOf('Tell Pete Rourke how to bill the sessions')));
  check('once he has edited an item\'s tags, his list is the whole answer — a removed #invoice stays removed',
        JSON.stringify(tagsOf('Pay the GasCo propane invoice')) === '[]', JSON.stringify(tagsOf('Pay the GasCo propane invoice')));
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
