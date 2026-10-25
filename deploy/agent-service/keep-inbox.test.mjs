/**
 * Keep in Inbox (keep-inbox.mjs).
 *
 * Alex, 2026-10-09: "moves the message back to Inbox, and keeps it there
 * until I manually archive OR we determine that the task is closed." The cases
 * that matter: nothing of ours can archive a kept thread; his own archive lets
 * it go quietly; a task closing after he kept it is what archives it; and a
 * task already closed when he kept it does not.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keep, release, keepPass, readKept, archiveGuard, messageIndex, keepInboxHook, taskState } from './keep-inbox.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const vault = await mkdtemp(join(tmpdir(), 'keep-'));
await mkdir(join(vault, 'integrations'), { recursive: true });
const calls = [];
const modify = async (_b, account, threadId, body) => { calls.push({ account, threadId, ...body }); return {}; };
const T = 'a1b2c3d4e5f60718';

console.log('Keeping:');
{
  const r = await keep(vault, { account: 'personal', threadId: T, by: 'alex@rivera.example', now: new Date('2026-10-09T13:00:00'), modify });
  check('INBOX goes back on the thread', calls.at(-1)?.addLabelIds?.[0] === 'INBOX' && calls.at(-1).threadId === T);
  const kept = await readKept(vault);
  check('and it is recorded, by whom and when', kept[`personal:${T}`]?.by === 'alex@rivera.example' && kept[`personal:${T}`].at === '2026-10-09 13:00', JSON.stringify(kept));
  check('not yet seen in the inbox', kept[r.key].seen_in_inbox === null);
  let threw = false; try { await keep(vault, { account: 'personal', threadId: '../x', by: 'm', modify }); } catch { threw = true; }
  check('a thread id that is not one is refused', threw);
}

console.log('\nThe minute pass:');
{
  const key = `personal:${T}`;
  const inbox = { threads: [{ account: 'personal', thread_id: T, in_inbox: true, messages: [{ id: 'm1' }] }] };
  const out = { threads: [] };
  const task = (over) => ({ id: `mail:${key}`, open: true, evidence: [], ...over });

  await keepPass(vault, { extract: out, obligations: [task()], now: new Date('2026-10-09T13:01:00'), modify });
  check('before the extract has caught up with the tap, nothing is released', !!(await readKept(vault))[key]);

  await keepPass(vault, { extract: inbox, obligations: [task()], now: new Date('2026-10-09T13:05:00'), modify });
  check('seen in the inbox is noted', (await readKept(vault))[key]?.seen_in_inbox === '2026-10-09 13:05');

  await keepPass(vault, { extract: { ...out, partial: true }, obligations: [task()], modify });
  check('a partial extract releases nothing', !!(await readKept(vault))[key]);

  const r = await keepPass(vault, { extract: out, obligations: [task()], modify });
  check('gone from the inbox after being seen there: he archived it, and it is let go', r.released[0]?.why === 'he archived it' && !(await readKept(vault))[key]);
  check('  ...without touching Gmail', !calls.some((c) => c.removeLabelIds));

  // Kept again; the task closes after.
  await keep(vault, { account: 'personal', threadId: T, by: 'm', now: new Date('2026-10-09T14:00:00'), modify });
  const r2 = await keepPass(vault, { extract: inbox, obligations: [task({ open: false, closed_at: '2026-10-09 15:00' })], modify });
  check('its task closing after he kept it archives it', r2.released[0]?.why === 'task closed' && calls.at(-1)?.removeLabelIds?.[0] === 'INBOX');
  check('  ...and lets it go', !(await readKept(vault))[key]);

  // Kept when the task was already done.
  await keep(vault, { account: 'personal', threadId: T, by: 'm', now: new Date('2026-10-09T16:00:00'), modify });
  const r3 = await keepPass(vault, { extract: inbox, obligations: [task({ open: false, closed_at: '2026-10-09 15:00' })], modify });
  check('a task already closed when he kept it does not archive it', !r3.released.length && !!(await readKept(vault))[key]);
  check('a thread with no task is his to let go', taskState(key, []).closed === false);
  const viaEvidence = taskState(key, [{ id: 'todo:x', open: false, closed_at: '2026-10-09 17:00', evidence: [{ source: 'email', detail: { thread_id: T, account: 'personal' } }] }], '2026-10-09 16:00');
  check('a task that names the thread in its evidence counts too', viaEvidence.closed && viaEvidence.tasks[0] === 'todo:x');

  const off = await release(vault, { account: 'personal', threadId: T, archive: true, modify });
  check('his "let go" with archive takes it out of the inbox and the record', off.released && off.archived && !(await readKept(vault))[key] && calls.at(-1)?.removeLabelIds?.[0] === 'INBOX');
}

console.log('\nThe guard:');
{
  const kept = { [`personal:${T}`]: {}, 'work:ffff0001': {} };
  const idx = messageIndex({ threads: [
    { account: 'personal', thread_id: T, messages: [{ id: 'm1' }, { id: 'm2' }] },
    { account: 'personal', thread_id: 'bbbb0002', messages: [{ id: 'm3' }] },
    { account: 'work', thread_id: 'ffff0001', messages: [{ id: 't1' }] },
  ] });
  check('an archive batch that includes a kept thread is refused',
        archiveGuard('mcp__personal__batch_modify_emails', { messageIds: ['m3', 'm2'], removeLabelIds: ['INBOX'] }, kept, idx)?.[0] === `personal:${T}`);
  check('one without a kept thread goes through', archiveGuard('mcp__personal__batch_modify_emails', { messageIds: ['m3'], removeLabelIds: ['INBOX'] }, kept, idx) === null);
  check('marking a kept thread read is not archiving it', archiveGuard('mcp__personal__batch_modify_emails', { messageIds: ['m1'], removeLabelIds: ['UNREAD'] }, kept, idx) === null);
  check('the mailbox is read off the tool name', archiveGuard('mcp__work__modify_email', { messageId: 't1', removeLabelIds: ['INBOX'] }, kept, idx)?.[0] === 'work:ffff0001');
  check('a whole-thread archive is refused too', archiveGuard('mcp__personal__modify_thread', { threadId: T, removeLabelIds: ['INBOX'] }, kept, idx)?.length === 1);
  check('any other tool is none of its business', archiveGuard('mcp__personal__read_email', { messageId: 'm1' }, kept, idx) === null);

  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [{ account: 'personal', thread_id: T, messages: [{ id: 'm1' }] }] }));
  await keep(vault, { account: 'personal', threadId: T, by: 'm', modify });
  const hook = keepInboxHook(vault);
  const no = await hook({ tool_name: 'mcp__personal__batch_modify_emails', tool_input: { messageIds: ['m1'], removeLabelIds: ['INBOX'] } });
  check('the hook denies, and says why', no.hookSpecificOutput?.permissionDecision === 'deny' && /Keep in Inbox/.test(no.hookSpecificOutput.permissionDecisionReason), JSON.stringify(no));
  const yes = await hook({ tool_name: 'mcp__personal__batch_modify_emails', tool_input: { messageIds: ['zz'], removeLabelIds: ['INBOX'] } });
  check('  ...and stays out of the way otherwise', !yes.hookSpecificOutput);
  const doc = JSON.parse(await readFile(join(vault, 'integrations', 'keep-in-inbox.json'), 'utf8'));
  const { checkFile } = await import('../contract.mjs');
  const c = await checkFile(vault, 'keepInInbox');
  check('the record passes its contract', c.ok && c.records === Object.keys(doc.threads).length, JSON.stringify(c));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
