/**
 * Which task a draft belongs to — and, mostly, when it belongs to none.
 *
 * Alex, 2026-09-19: "here are the To Do's with items Drafted so you can see
 * which task the entry is for." The asymmetry is the same one merges have
 * everywhere in this repo: a draft shown under no task is visible and
 * annoying, a draft shown under the WRONG task makes that task look answered
 * and the real one look untouched.
 */
import { joinDrafts, draftKeys, taskKeys, digits } from './task-drafts.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const task = (id, over = {}) => ({ id, title: id, owed_by: 'me', evidence: [], ...over });
const mailTask = (id, threadId, account = 'personal') =>
  task(id, { evidence: [{ source: 'email', detail: { thread_id: threadId, account } }] });

console.log('the identifiers the two sides already share');
{
  // Real shapes: outbox/2026-09-18-1811-15552000013.md against the obligation
  // the message triage wrote for the same conversation.
  const d = { id: 'd1', kind: 'text', to: '+15552000013', chatId: 'any;-;+15552000013' };
  const t = task('im:any;-;+15552000013', { chat_id: 'any;-;+15552000013', who: 'Glen Marsh' });
  const { taskOf, byTask, loose } = joinDrafts([t], [d]);
  check('a text joins its task on the chat id', taskOf.get('d1') === t.id, JSON.stringify([...taskOf]));
  check('  ...and the task carries it', byTask.get(t.id)?.length === 1);
  check('  ...and nothing is loose', loose.length === 0);

  const m = { id: 'm1', kind: 'mail', account: 'personal', threadId: '1a05edfc', subject: 'Re: quote' };
  const mt = mailTask('mail:personal:1a05edfc', '1a05edfc');
  check('a Gmail draft joins on the thread id', joinDrafts([mt], [m]).taskOf.get('m1') === mt.id);

  // One obligation, eight threads — the SaunaCo shape. Any of them joins.
  const many = task('mail:personal:t1', { evidence: ['t1', 't2', 't8'].map((x) => ({ source: 'email', detail: { thread_id: x } })) });
  check('a draft on any thread of a merged obligation joins it',
        joinDrafts([many], [{ id: 'm2', kind: 'mail', threadId: 't8' }]).taskOf.get('m2') === many.id);
}

console.log('\nthe handle, as a fallback');
{
  const d = { id: 'd2', kind: 'text', to: '+1 (555) 200-0014', chatId: null };
  const t = task('im:x', { who: '+15552000014' });
  check('a text with no chat id falls back to the number',
        joinDrafts([t], [d]).taskOf.get('d2') === 'im:x');
  check('  ...matched on the last ten digits, however it is written',
        digits('+1 (555) 200-0014') === digits('15552000014') && digits('+15552000014') === '5552000014');
  // The refusal that matters: a person can owe him four things.
  const two = [task('a', { who: '+15552000014' }), task('b', { who: '+15552000014' })];
  check('two open tasks with the same person match neither',
        joinDrafts(two, [d]).loose.length === 1, JSON.stringify([...joinDrafts(two, [d]).taskOf]));
  check('a short number is not a handle at all', digits('1234') === '');
  check('  ...so it cannot join anything',
        joinDrafts([task('a', { who: '1234' })], [{ id: 'd3', kind: 'text', to: '1234' }]).loose.length === 1);
}

console.log('\nwhat stays loose, and is therefore still shown');
{
  const invite = { id: 'i1', kind: 'invite', to: 'carl@x.com', when: 'Wed 11:00' };
  const orphan = { id: 'm3', kind: 'mail', threadId: 'nobody-owes-this' };
  const { loose, taskOf } = joinDrafts([mailTask('mail:a:t1', 't1')], [invite, orphan]);
  check('an invite belongs to no task', !taskOf.has('i1'));
  check('a reply on a thread nobody owes anything on belongs to no task', !taskOf.has('m3'));
  check('both are loose rather than dropped', loose.length === 2, JSON.stringify(loose.map((d) => d.id)));
  check('nothing at all is not a crash', joinDrafts(undefined, undefined).loose.length === 0);
  check('drafts with no tasks are all loose', joinDrafts([], [invite]).loose.length === 1);
}

console.log('\nkeys');
{
  check('a mail draft is keyed by its thread only',
        draftKeys({ kind: 'mail', threadId: 't', to: '+15552000013' }).handles.size === 0);
  check('a task with no identifiers has no keys', (() => {
    const k = taskKeys(task('x'));
    return !k.threads.size && !k.chats.size && !k.handles.size;
  })());
  check('  ...so it joins nothing',
        joinDrafts([task('x')], [{ id: 'd', kind: 'text', chatId: 'c' }]).loose.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
