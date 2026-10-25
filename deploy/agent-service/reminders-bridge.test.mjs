/**
 * Apple Reminders: what goes on his phone, what comes back, and what neither
 * side may do to the other.
 *
 * Alex, 2026-09-18: "can we tie it in Apple Reminders through the mac
 * bridge?" — then two decisions that are the whole shape of it: mirror the
 * dated items and the projects he is for, and **no alarms**, because the
 * dispatcher owns the push channel and a second nagger is what
 * `rules/reminders.md` exists to prevent.
 *
 * The refusals are most of this file. A bridge between two lists is where
 * duplicates breed: his own reminders read back as a second copy of every debt,
 * a mirrored item read back as a new task, a tick on one side quietly undone by
 * the other.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFor, itemFor, bridge, LIST, MIRROR } from '../reminders-bridge.mjs';
import { read as readApple, mirrorOf, appleId, close as closeApple } from './sources/apple-reminders.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const ob = (over) => ({ id: 'x', title: 't', owed_by: 'me', open: true, tags: [], days: 1, due: null, lead_days: null, overdue: false, ...over });

console.log('what goes on his phone');
{
  const focusTags = new Set(['one', 'phoa']);
  const rows = [
    ob({ id: 'due-today', due: '2026-09-18', lead_days: 0 }),
    ob({ id: 'overdue', due: '2026-08-01', lead_days: -48, overdue: true }),
    ob({ id: 'next-month', due: '2026-10-30', lead_days: 42 }),
    ob({ id: 'focus-undated', tags: ['one'], days: 9 }),
    ob({ id: 'focus-older', tags: ['phoa'], days: 30 }),
    ob({ id: 'nothing', days: 60 }),
    ob({ id: 'theirs', owed_by: 'them', due: '2026-09-18', lead_days: 0 }),
    ob({ id: 'closed', open: false, due: '2026-09-18', lead_days: 0 }),
  ];
  const got = chooseFor(rows, { focusTags }).map((o) => o.id);
  check('a date inside the week goes', got.includes('due-today') && got.includes('overdue'));
  check('a project he is for goes, dated or not', got.includes('focus-undated') && got.includes('focus-older'));
  check('a date a month out does not', !got.includes('next-month'));
  check('something on no project with no date does not — that is the list he already cannot read',
        !got.includes('nothing'));
  check('what somebody else owes him is not a reminder for him', !got.includes('theirs'));
  check('a closed one never reaches the phone', !got.includes('closed'));
  check('dated first, soonest first, then the longest waiting',
        got.join(',') === 'overdue,due-today,focus-older,focus-undated', got.join(','));
}

console.log('\nwhat one item looks like');
{
  const i = itemFor(ob({ id: 'mail:work:1a0a', title: 'Pay the Carta invoice', who: 'investorservices@carta.example',
                         due: '2026-07-16 09:00', overdue: true, tags: ['acme', 'decision'], closes: 'the invoice is paid' }));
  check('it carries a date and never a time — a timed reminder is one Apple alerts on',
        i.due === '2026-07-16', i.due);
  check('the url is the to-do page, which is both the tap and the join',
        i.url === 'https://obligations.example.com/todo#pane=mail%3Awork%3A1a0a', i.url);
  check('the note says who, how late, the project and what closes it',
        /with investorservices@carta.example/.test(i.notes) && /overdue since 2026-07-16/.test(i.notes)
        && /#acme/.test(i.notes) && /closes when: the invoice is paid/.test(i.notes), i.notes);
  check('the kind tags stay out of the note — he never sees "decision" anywhere else',
        !/#decision/.test(i.notes));
  // Three markers, any one of which is enough. EventKit has no custom field,
  // so the Mac writes what it can and the reader accepts whichever survives
  // iCloud and his own editing. Asked by the Mac session, 2026-09-18.
  check('a mirrored item is recognisable from its url alone',
        mirrorOf({ url: i.url }) === 'mail:work:1a0a');
  check('  ...or from obligations_id on the pushed record',
        mirrorOf({ obligations_id: 'mail:work:1a0a' }) === 'mail:work:1a0a');
  check('  ...or from a trailing obligations: line in the notes',
        mirrorOf({ notes: 'with someone · #acme\nobligations:mail:work:1a0a' }) === 'mail:work:1a0a');
  check('a note that merely mentions the word is not a marker',
        mirrorOf({ notes: 'ask the assistant: what is this' }) === null,
        String(mirrorOf({ notes: 'ask the assistant: what is this' })));
  check('nothing at all is not a mirror', mirrorOf({ title: 'Buy milk' }) === null);
}

console.log('\nreading his own lists');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-rem-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 08:00',
    reminders: [
      { id: 'u1', list: 'Reminders', title: 'Call the roofer back', due: '2026-09-19', created: '2026-09-17 14:00', completed: false },
      { id: 'u2', list: 'Reminders', title: 'Ticked already', completed: true, completed_at: '2026-09-17 15:00' },
      { id: 'u3', list: 'Obligations', title: 'Pay the Carta invoice', completed: false,
        url: 'https://obligations.example.com/todo#pane=mail%3Awork%3A1a0a' },
      { id: 'u4', list: 'Groceries', title: '   ', completed: false },
      { id: 'u5', list: 'Reminders', title: 'Buy oil for the mower', priority: 'high', completed: false },
    ],
  }));
  const rows = await readApple(vault);
  const ids = rows.map((r) => r.ref);
  check('what he typed or said into Reminders becomes an obligation', ids.includes(appleId('u1')));
  check('  ...with its date and the day he made it', rows.find((r) => r.ref === appleId('u1')).due === '2026-09-19'
        && rows.find((r) => r.ref === appleId('u1')).since === '2026-09-17 14:00');
  check('  ...and his own priority, not one we invented',
        rows.find((r) => r.ref === appleId('u5')).priority === 'high');
  check('a ticked one is done, like a ticked todo line', !ids.includes(appleId('u2')));
  check('a MIRROR is not read back as a task — that is how one debt becomes two',
        !ids.includes(appleId('u3')));
  check('an empty title is not a task', !ids.includes(appleId('u4')));
  check('no extract at all is silence, not an error', (await readApple(await mkdtemp(join(tmpdir(), 'empty-')))).length === 0);

  // Not every list is a task list. The first real extract, 2026-09-18, made an
  // obligation out of "Thank you for Smoking" — on his Shows & Movies list
  // since 2024, due nothing, owed to nobody. Alex, the same morning: the
  // default list only.
  const { skipped } = await import('./sources/apple-reminders.mjs');
  const watch = await mkdtemp(join(tmpdir(), 'obligations-lists-'));
  await mkdir(join(watch, 'integrations'), { recursive: true });
  await writeFile(join(watch, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 09:01',
    lists: ['Reminders', 'Family', 'Shows & Movies'],
    reminders: [
      { id: 'a', list: 'Reminders', title: 'Sales Tax', due: '2026-09-18', completed: false },
      { id: 'b', list: 'Shows & Movies', title: 'Thank you for Smoking', created: '2024-10-27 13:01', completed: false },
      { id: 'c', list: 'Family', title: 'Book the sitter', completed: false },
    ],
  }));
  check('by default only his task list becomes debt',
        (await readApple(watch)).map((r) => r.what).join(',') === 'Sales Tax',
        (await readApple(watch)).map((r) => r.what).join(','));
  check('  ...and what was skipped is counted per list, so it is never a silence',
        JSON.stringify(await skipped(watch)) === '{"Shows & Movies":1,"Family":1}',
        JSON.stringify(await skipped(watch)));
  await writeFile(join(watch, 'integrations', 'reminders-lists.json'), JSON.stringify({ lists: ['Reminders', 'Family'] }));
  check('naming a list in his file brings it in',
        (await readApple(watch)).map((r) => r.what).sort().join(',') === 'Book the sitter,Sales Tax',
        (await readApple(watch)).map((r) => r.what).join(','));
  check('  ...and the watchlist still stays out', (await skipped(watch))['Shows & Movies'] === 1);

  // A task he types into the assistant's own list. Alex, 2026-09-18: "should I
  // put new ones in the Obligations category?" He should not have to think about it,
  // and an unmarked item there cannot be anything but his — the writer never
  // creates one without a marker. Swallowing it would be the worst of both.
  await writeFile(join(watch, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 11:00',
    reminders: [
      { id: 'own', list: 'Obligations', title: 'Call the roofer', completed: false },
      { id: 'mir', list: 'Obligations', title: 'Pay the invoice', completed: false, obligations_id: 'mail:personal:1a0a' },
      { id: 'watch', list: 'Shows & Movies', title: 'Thank you for Smoking', completed: false },
    ],
  }));
  check('a task he types into the Obligations list counts, wherever he put it',
        (await readApple(watch)).map((r) => r.what).join(',') === 'Call the roofer',
        (await readApple(watch)).map((r) => r.what).join(','));
  check('  ...while the mirrored one beside it still does not',
        !(await readApple(watch)).some((r) => /Pay the invoice/.test(r.what)));
  check('  ...and the Obligations list is never reported as seen-and-skipped',
        (await skipped(watch))['Obligations'] === undefined, JSON.stringify(await skipped(watch)));
}

console.log('\nthe pass, both directions');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-bridge-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] Call the roofer !due:2026-09-19 !since:2026-09-17\n');
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 08:00', reminders: [],
  }));
  const r = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T08:00:00') });
  check('the mirror is written for the Obligations list and nothing else', r.list === LIST);
  const doc = JSON.parse(await readFile(join(vault, MIRROR), 'utf8'));
  check('it says out loud that it must not alarm', doc.alarms === false);
  check('the todo line is on it', doc.items.some((i) => /Call the roofer/.test(i.title)), JSON.stringify(doc.items));

  // He ticks it on his phone. The Mac reports it completed on the next extract.
  const id = doc.items[0].id;
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 09:00',
    reminders: [{ id: 'm1', list: 'Obligations', title: 'Call the roofer', completed: true,
                  completed_at: '2026-09-18 08:40', obligations_id: id }],
  }));
  const r2 = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T09:00:00') });
  check('his tick on the phone closes the obligation here', r2.closed.some((c) => c.id === id && !c.error),
        JSON.stringify(r2.closed));
  check('  ...and with HIS name on it, so nothing reopens it later',
        /- \[x\]/.test(await readFile(join(vault, 'todo.md'), 'utf8')));
  const r3 = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T10:00:00') });
  check('a tick is acted on once, not every pass', r3.closed.length === 0 && r3.ticked.length === 0);
  const doc3 = JSON.parse(await readFile(join(vault, MIRROR), 'utf8'));
  check('and it is gone from the list', !doc3.items.some((i) => i.id === id));
  // He ticked it himself, so the phone already shows it done: asking the Mac to
  // complete it again would be work for nothing. complete[] is what is open
  // THERE and unwanted here, which this no longer is.
  check('something he ticked himself is not then asked to be completed',
        !doc3.complete.some((c) => c.id === id), JSON.stringify(doc3.complete));
  check('and nothing is left standing on his phone', r3.stranded === 0, String(r3.stranded));
}

/* A TICK IS SPENT ONCE. Alex, 2026-09-23: "I don't recall that." He ticked
 * the Gail Quinn item on 09-19 and it closed then. Four days later the mail
 * triage reopened the same thread as a new debt, the old completed reminder was
 * still in the extract under that id, and the bridge closed the live item in
 * his name on a tick he had already spent. */
console.log('\nan old tick does not close a reopened item');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-bridge-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] Get Gail\'s answer !due:2026-09-24 !since:2026-09-17\n');
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({ generated_at: '2026-09-23 08:00', reminders: [] }));
  await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-23T08:00:00') });
  const id = JSON.parse(await readFile(join(vault, MIRROR), 'utf8')).items[0].id;
  // Ticked on the 19th, closed on it at 10:05 — and since reopened, so open again now.
  await writeFile(join(vault, 'logbook.md'),
    `# Logbook\n\n- 2026-09-19 10:05 | ${id} | Update Gail | by alex | ticked off in Reminders\n`);
  const stale = { id: 'm-old', list: 'Obligations', title: 'Update Gail', completed: true, completed_at: '2026-09-19 09:34', obligations_id: id };
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({ generated_at: '2026-09-23 12:31', reminders: [stale] }));
  const r = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-23T12:43:00') });
  check('a completion the logbook already closed on does not close it again',
        r.closed.length === 0 && r.ticked.length === 0, JSON.stringify(r.ticked));
  check('  ...so the reopened item is still open', /- \[ \]/.test(await readFile(join(vault, 'todo.md'), 'utf8')));
  // A NEW tick, after that close, is his decision and still counts.
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({ generated_at: '2026-09-23 14:00',
    reminders: [stale, { id: 'm-new', list: 'Obligations', title: "Get Gail's answer", completed: true, completed_at: '2026-09-23 13:55', obligations_id: id }] }));
  const r2 = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-23T14:00:00') });
  check('a tick made after the last close still closes it, with his name',
        r2.closed.some((c) => c.id === id && !c.error), JSON.stringify(r2.closed));
}

/* The trap the Mac session found before either half had run: when the writer
 * completes something the mirror asked it to complete, the next extract shows
 * it completed WITH a marker — the same shape as him ticking it on his phone.
 * Closing on that would put his name on a decision he never made, and his
 * closes never come back for another look. */
console.log('\nthe Mac obeying is not him deciding');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-obey-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  const todo = (due) => writeFile(join(vault, 'todo.md'),
    `# Todo\n\n## Now\n\n- [ ] Call the roofer !due:${due} !since:2026-09-17\n`);
  const phone = (rows) => writeFile(join(vault, 'integrations', 'reminders-apple.json'),
    JSON.stringify({ generated_at: '2026-09-18 08:00', reminders: rows }));

  await todo('2026-09-19');
  await phone([]);
  const first = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T08:00:00') });
  const id = first.items[0].id;
  // The Mac has created it, so the phone now shows it open.
  await phone([{ id: 'm1', list: 'Obligations', title: 'Call the roofer', completed: false, obligations_id: id }]);

  // He pushes the date out to next month. It leaves the mirror, still open.
  await todo('2026-11-20');
  const second = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T09:00:00') });
  check('an item that merely left the list is asked to be completed, not closed',
        second.complete.some((c) => c.id === id) && second.closed.length === 0, JSON.stringify(second.complete));

  // The Mac does as it was told. The extract now looks exactly like a tick.
  await phone([{ id: 'm1', list: 'Obligations', title: 'Call the roofer', completed: true,
                 completed_at: '2026-09-18 09:30', obligations_id: id }]);
  const third = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T10:00:00') });
  check('the Mac completing what we asked for does NOT close anything',
        third.closed.length === 0 && third.ticked.length === 0, JSON.stringify(third.ticked));
  check('  ...and it is reported as obedience, with a number, rather than silently dropped',
        third.obeyed.includes(id), JSON.stringify(third.obeyed));
  check('  ...so the task is still open and still his',
        /- \[ \] Call the roofer/.test(await readFile(join(vault, 'todo.md'), 'utf8')));

  // It comes back onto the list, so the Mac creates a NEW reminder — and this
  // time HE ticks it. A different reminder for the same item is his decision.
  await todo('2026-09-19');
  await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-19T08:00:00') });
  await phone([{ id: 'm2', list: 'Obligations', title: 'Call the roofer', completed: true,
                 completed_at: '2026-09-19 08:40', obligations_id: id }]);
  const his = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-19T09:00:00') });
  check('a tick the bridge never asked for still closes, as his',
        his.closed.some((c) => c.id === id && !c.error), JSON.stringify(his.closed));

  // An alarm on a mirrored item is not ours and is worth a number.
  await phone([{ id: 'm3', list: 'Obligations', title: 'Something', completed: false, has_alarm: true, obligations_id: 'todo:zzz' }]);
  const noisy = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-19T10:00:00') });
  check('a mirrored item that came back with an alarm is counted, not ignored',
        noisy.alarmed.includes('todo:zzz'), JSON.stringify(noisy.alarmed));
}

/* Stranded items: open on his phone, wanted by nobody, named in complete[] by
 * nobody. Found by the Mac session on 2026-09-18 after nineteen closes left 23
 * standing — the pass that dropped them named them once, the next pass rewrote
 * its own ledger without them, and the writer had not run in between. The diff
 * belongs against the list itself, not against this side's memory of it. */
console.log('\nnothing is left standing on his phone');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-strand-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] Live one !due:2026-09-19 !since:2026-09-17\n');
  // The phone holds three mirrors: one still wanted, one whose obligation has
  // gone, and one completed already.
  const phone = (extra = []) => writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 10:05',
    reminders: [
      { id: 'r-gone', list: 'Obligations', title: 'Closed thing', completed: false, obligations_id: 'mail:personal:gone' },
      { id: 'r-done', list: 'Obligations', title: 'Already ticked', completed: true, completed_at: '2026-09-18 09:00', obligations_id: 'mail:personal:done' },
      ...extra,
    ],
  }));
  await phone();
  const r = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T10:10:00') });
  check('an item open on his phone that the mirror no longer wants is ticked off',
        r.complete.some((c) => c.id === 'mail:personal:gone'), JSON.stringify(r.complete));
  check('  ...and one already completed is not asked for again',
        !r.complete.some((c) => c.id === 'mail:personal:done'));
  check('nothing is left standing', r.stranded === 0, String(r.stranded));

  // The bug itself: the same state on a SECOND pass must still ask. The old
  // ledger-based version announced it once and forgot.
  const again = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T11:10:00') });
  check('and it is asked for again on the next pass, until the phone reports it done',
        again.complete.some((c) => c.id === 'mail:personal:gone'), JSON.stringify(again.complete));

  // Once the Mac has done it, it stops being asked for — and it is not read as
  // his tick either, because we asked for it.
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 11:30',
    reminders: [{ id: 'r-gone', list: 'Obligations', title: 'Closed thing', completed: true,
                  completed_at: '2026-09-18 11:20', obligations_id: 'mail:personal:gone' }],
  }));
  const after = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T12:10:00') });
  check('once the phone reports it completed, it stops being asked for',
        !after.complete.some((c) => c.id === 'mail:personal:gone'), JSON.stringify(after.complete));
  check('  ...and it does not close anything in his name — we asked for it',
        after.closed.length === 0 && after.ticked.length === 0, JSON.stringify(after));
}

/* "So once they are linked, closing one closes both?" — Alex, 2026-09-18.
 * It has to be yes, or linking is a label rather than a join. The half that was
 * missing: his own reminder stayed open on his phone, the source kept reporting
 * it, and the obligation sprang back the moment it was closed. */
console.log('\nclosing one closes both');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-both-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  const { listOpen, linkObligations, closeObligation } = await import('./obligations.mjs');
  const phone = (rows) => writeFile(join(vault, 'integrations', 'reminders-apple.json'),
    JSON.stringify({ generated_at: '2026-09-18 11:00', reminders: rows }));
  const setup = async () => {
    await writeFile(join(vault, 'todo.md'),
      '# Todo\n\n## Now\n\n- [ ] File the sales tax return !due:2026-09-18 !since:2026-09-02\n');
    await writeFile(join(vault, 'integrations', 'obligation-links.json'), JSON.stringify({ merges: [] }));
    // A fresh scenario on a reused obligations: the obligation's own close record
    // (obligation-state.mjs) would otherwise outrank the re-created line.
    await writeFile(join(vault, 'integrations', 'obligation-state.json'), JSON.stringify({ closed: {} }));
    await writeFile(join(vault, '.log', 'reminders-ticked.json'), '{}');
    await phone([{ id: 'u2', list: 'Reminders', title: 'Sales Tax', due: '2026-09-18', created: '2026-09-18 07:53', completed: false }]);
    const all = await listOpen(vault);
    await linkObligations(vault, all.find((o) => o.id.startsWith('apple')).id,
                                 all.find((o) => o.id.startsWith('todo')).id, 'same thing');
    return (await listOpen(vault))[0];
  };

  const one = await setup();
  check('the linked pair is one row, evidenced by both',
        (one.evidence ?? []).map((e) => e.source).sort().join(',') === 'apple,todo');
  await closeObligation(vault, one.id, 'alex', 'filed');
  check('closing it here closes it, and it does not spring back',
        (await listOpen(vault)).length === 0, JSON.stringify((await listOpen(vault)).map((o) => o.id)));
  const r = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T11:10:00') });
  check('  ...and the Mac is asked to tick his own reminder, by name',
        r.complete.some((c) => c.reminder === 'u2' && /he closed it here/.test(c.why)), JSON.stringify(r.complete));
  await phone([{ id: 'u2', list: 'Reminders', title: 'Sales Tax', completed: true, completed_at: '2026-09-18 11:30' }]);
  const r2 = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T12:10:00') });
  check('  ...once done, it stops being asked for', !r2.complete.some((c) => c.reminder === 'u2'), JSON.stringify(r2.complete));
  check('  ...and his own tick of it closes nothing twice', r2.closed.length === 0 && r2.ticked.length === 0);

  // The asymmetry: an AGENT close never reaches into his own list.
  const two = await setup();
  await closeObligation(vault, two.id, 'agent:messages', 'looks handled');
  const r3 = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T13:10:00') });
  check('an agent close does NOT tick a reminder of his',
        !r3.complete.some((c) => c.reminder === 'u2'), JSON.stringify(r3.complete));
  check('  ...so it stays on his phone until he agrees with it',
        (await readFile(join(vault, 'integrations', 'reminders-apple.json'), 'utf8')).includes('"completed":false'));
}

/* The Mac's reader drops every copy of a duplicated id rather than keeping the
 * first — so a duplicate emitted here does not make two reminders, it makes the
 * item vanish. Insurance, counted rather than silent. */
console.log('\none entry per id');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-dup-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] One thing !due:2026-09-19 !since:2026-09-17\n');
  // The same obligation mirrored twice on the phone — two reminders, one id.
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 13:00',
    reminders: [
      { id: 'a', list: 'Obligations', title: 'Gone thing', completed: false, obligations_id: 'mail:personal:gone' },
      { id: 'b', list: 'Obligations', title: 'Gone thing', completed: false, obligations_id: 'mail:personal:gone' },
    ],
  }));
  const r = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T13:10:00') });
  check('an id the phone holds twice is asked for once',
        r.complete.filter((c) => c.id === 'mail:personal:gone').length === 1, JSON.stringify(r.complete));
  check('  ...and the duplication is counted, not swallowed',
        r.duplicated.includes('mail:personal:gone'), JSON.stringify(r.duplicated));
  const doc = JSON.parse(await readFile(join(vault, MIRROR), 'utf8'));
  check('  ...so the file the Mac reads has no repeated id',
        new Set(doc.complete.filter((c) => c.id).map((c) => c.id)).size === doc.complete.filter((c) => c.id).length);
  check('and the file says what shape it is in', doc.schema === 2, String(doc.schema));
}


/* AN AGENT CLOSE OF HIS REMINDER IS A FAILURE, NOT A SUCCESS. Review
 * 2026-09-20: close() returned { closed: true } for an agent closer while
 * writing nothing, so close.mjs said "closed apple", read() kept seeing the
 * reminder incomplete, and the obligation was open again seconds later. The
 * policy — never tick his own list for him — is unchanged; the report is. */
console.log('\nan agent cannot close his reminder');
{
  const { mkdtemp, mkdir, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-apple-'));
  await mkdir(join(vault, '.log'), { recursive: true });
  let threw = null;
  try { await closeApple(vault, appleId('u9'), 'agent:drafts'); } catch (e) { threw = e.message; }
  check('an agent close throws, so closeObligation reports it as not closed', /left alone|ticks it/.test(threw ?? ''), String(threw));
  const his = await closeApple(vault, appleId('u9'), 'alex');
  const q = JSON.parse(await readFile(join(vault, '.log', 'reminders-ticked.json'), 'utf8'));
  check('his own close queues the tick for the Mac', his.closed === true && q.u9?.by === 'alex', JSON.stringify(q));
}

console.log('\nthe Obligations list switched off (2026-10-08)');
{
  /* Alex: "there is a lot of junk that shows up on my calendar reminders" —
     and, offered four ways to narrow the Obligations list, "Turn the list off". */
  const { MIRRORING } = await import('../reminders-bridge.mjs');
  check('the list is off', MIRRORING === false);
  const vault = await mkdtemp(join(tmpdir(), 'obligations-bridge-off-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] Call the roofer !due:2026-09-19 !since:2026-09-17\n');
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({ generated_at: '2026-09-18 08:00', reminders: [] }));
  const on = await bridge(vault, { mirror: true, write: true, now: Date.parse('2026-09-18T08:00:00') });
  const id = JSON.parse(await readFile(join(vault, MIRROR), 'utf8')).items[0].id;
  // It is on his phone from when the list was on, and his own reminder is beside it.
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 09:00',
    reminders: [{ id: 'm1', list: 'Obligations', title: 'Call the roofer', completed: false, obligations_id: id },
                { id: 'own', list: 'Reminders', title: 'Buy milk', completed: false }],
  }));
  const off = await bridge(vault, { write: true, now: Date.parse('2026-09-18T09:00:00') });
  const doc = JSON.parse(await readFile(join(vault, MIRROR), 'utf8'));
  check('off: nothing is mirrored', doc.items.length === 0, JSON.stringify(doc.items));
  check('  ...and what is already in the Obligations list is completed, not left or deleted',
        doc.complete.some((c) => c.id === id), JSON.stringify(doc.complete));
  check('  ...and his own reminders are never touched', !doc.complete.some((c) => c.id === 'own'));
  check('  (it was mirrored while on)', on.list === LIST);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
