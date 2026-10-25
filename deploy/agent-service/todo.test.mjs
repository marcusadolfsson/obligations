/**
 * todo.md as a task source.
 *
 * The risk here is not parsing — it is writing. `completeTodo` edits a file
 * Alex maintains by hand, so every test below is really asking the same
 * question: did it change exactly one character and leave the rest alone?
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read as listTodos, close as completeTodo, todoId } from './sources/todo.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const FILE = `# Todo

> Format: \`- [ ] thing @person !due:YYYY-MM-DD #project\`

## Now

- [ ] call the surgery scheduler @clara !since:2026-08-20
- [ ] chase the lock audit @hank !waiting
- [ ] grant gmail-api-push@system.gserviceaccount.com Publisher on the work topic
- [x] already done, should not appear

## Next

- [ ] renew the hangar lease !due:2099-09-30 #aviation !since:2026-08-28
- [ ]

## Someday

- [ ] learn to sail

## Done

- [ ] this one is in Done and must be ignored
`;

const dir = await mkdtemp(join(tmpdir(), 'todo-'));
await writeFile(join(dir, 'todo.md'), FILE);
const items = await listTodos(dir);
const by = (t) => items.find((i) => i.what.startsWith(t));
const idOf = (t) => by(t).ref;

console.log('Reading');
check('only unchecked items outside Done are listed', items.length === 5,
      items.map((i) => i.what).join(' | '));
check('a checked item is not a task', !items.some((i) => i.what.includes('already done')));
check('the Done section is ignored', !items.some((i) => i.what.includes('must be ignored')));
check('an empty bracket is not a task', !items.some((i) => !i.what.trim()));

check('@person becomes who', by('call the surgery')?.who === 'clara',
      by('call the surgery')?.who);

// An email address is not an assignee. The tag regex allowed zero spaces before
// the @, so a task naming a service account had "system.gserviceaccount.com"
// lifted out as the person who owed it and CUT from the text — leaving a task
// on the page that named a different address than the one Alex wrote.
const svc = by('grant gmail-api-push');
check('the service-account task is found at all', !!svc, String(svc));
check('an email address is not an assignee', svc && svc.who === null, svc?.who);
check('...and the address survives in the text',
      !!svc?.what?.includes('gmail-api-push@system.gserviceaccount.com'), svc?.what);
check('  ...and is stripped from the text',
      by('call the surgery')?.what === 'call the surgery scheduler',
      by('call the surgery')?.what);

check('!waiting means someone else owes it', by('chase the lock')?.owed_by === 'them');
check('everything else is his to do', by('call the surgery')?.owed_by === 'me');

check('!since: becomes the start date', by('call the surgery')?.since === '2026-08-20',
      String(by('call the surgery')?.since));
check('  ...and is stripped from the text',
      !by('call the surgery')?.what.includes('!since'),
      by('call the surgery')?.what);
check('a task with no !since: reports none rather than guessing',
      by('learn to sail')?.since === null, String(by('learn to sail')?.since));

check('!due: becomes a deadline, not prose',
      by('renew the hangar')?.due === '2099-09-30'
      && !by('renew the hangar')?.what.includes('due'),
      JSON.stringify([by('renew the hangar')?.due, by('renew the hangar')?.what]));
check('#project is captured, not left in the prose',
      by('renew the hangar')?.detail?.project === 'aviation'
      && !by('renew the hangar')?.what.includes('#'),
      by('renew the hangar')?.what);

console.log('\nPriority');
check('Now is high', by('call the surgery')?.priority === 'high');
check('Next is normal', by('renew the hangar')?.priority === 'normal');
check('Someday is low', by('learn to sail')?.priority === 'low');

console.log('\nCompleting');
{
  const id = idOf('call the surgery');
  await completeTodo(dir, id);
  const after = await readFile(join(dir, 'todo.md'), 'utf8');

  check('the box is ticked', after.includes('- [x] call the surgery scheduler @clara'));
  check('nothing else changed',
        after.split('\n').length === FILE.split('\n').length
        && after.replace('- [x] call the surgery', '- [ ] call the surgery') === FILE,
        'the file must differ by exactly one character');

  const left = await listTodos(dir);
  check('it leaves the list', !left.some((i) => i.ref === id));
}
{
  // Idempotent by design: the obligation layer closes every piece of evidence
  // it has, and one of them being already done is normal, not an error.
  const before = await readFile(join(dir, 'todo.md'), 'utf8');
  const r = await completeTodo(dir, 'todo:deadbeef1234');
  check('an id it cannot find changes nothing', r.alreadyClosed === true
        && (await readFile(join(dir, 'todo.md'), 'utf8')) === before, JSON.stringify(r));
}
{
  // Ids are content-derived, so the same line always closes the same task even
  // after the file is reordered.
  check('the id is stable for the same text',
        todoId('a thing') === todoId('a thing') && todoId('a thing') !== todoId('a thing '));

  // The dispatcher stamps !since: onto lines a minute after they are typed. If
  // that changed the id, the close button on an already-open page would fail.
  const stamped = await listTodos(dir);
  check('the ref survives the dispatcher adding a date',
        stamped.find((i) => i.what.startsWith('learn to sail'))?.ref
          === items.find((i) => i.what.startsWith('learn to sail'))?.ref);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
