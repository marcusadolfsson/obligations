/**
 * Auto-approval: what may be remembered, and what must always be asked.
 *
 * The negative half is the point. A remembered yes is only ever reachable for a
 * tool that got as far as the approval card, so nothing here can touch the deny
 * lists or a scheduled job — but within that set, the difference between "you
 * have approved this tool" and "you have approved every payload anyone can put
 * in this tool" is the whole safety argument, and it is one regex away from
 * being wrong.
 */
import { canRemember, remember, forget, autoApproved } from './approvals.mjs';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('May be remembered: reads, whose name is the whole story');
for (const t of [
  'mcp__claude_ai_Google_Drive__read_file_content',
  'mcp__claude_ai_Google_Drive__search_files',
  'mcp__personal__get_thread',
  'mcp__personal__search_emails',
  'mcp__personal__list_drafts',
  'Read', 'Grep', 'Glob',
]) check(t, canRemember(t));

console.log('\nMust always be asked: the payload IS the decision');
// "Always allow Bash" is not a decision about a tool. It is a decision about
// every command anyone can ever put in one, including a command suggested by an
// injected email body. Same for anything taking a destination.
for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'NotebookEdit']) {
  check(t, !canRemember(t));
}

console.log('\nMust always be asked: acts outward as him, or changes something');
for (const t of [
  'mcp__personal__send_email',
  'mcp__personal__reply_to_email',
  'mcp__personal__forward_email',
  'mcp__claude_ai_Superhuman_Mail__send_draft',
  'mcp__personal__batch_modify_emails',
  'mcp__personal__delete_email',
  'mcp__personal__download_attachment',      // writes a file out of hostile mail
  'mcp__claude_ai_Google_Drive__share_file',
  'mcp__claude_ai_Gmail__trash_thread',
]) check(t, !canRemember(t));

console.log('\nEdges');
check('empty is not rememberable', !canRemember(''));
check('null does not throw', !canRemember(null));
check('a read verb inside a send tool does not rescue it',
      !canRemember('mcp__personal__get_and_send_report'));

console.log('\nThe file');
{
  const dir = await mkdtemp(join(tmpdir(), 'approvals-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });

  check('no file yet is an empty set, not an error', (await autoApproved(dir)).size === 0);

  await remember(dir, 'mcp__personal__get_thread');
  check('a remembered yes is readable back', (await autoApproved(dir)).has('mcp__personal__get_thread'));

  const raw = JSON.parse(await readFile(join(dir, 'integrations', 'auto-approve.json'), 'utf8'));
  check('it records who and when, not just the name',
        !!raw.tools['mcp__personal__get_thread']?.since && !!raw.tools['mcp__personal__get_thread']?.by,
        JSON.stringify(raw));

  await remember(dir, 'mcp__personal__get_thread');
  check('remembering twice is idempotent', (await autoApproved(dir)).size === 1);

  // The server decides, never the page. A client is something a browser sends.
  let refused = false;
  try { await remember(dir, 'Bash'); } catch { refused = true; }
  check('the write path refuses what canRemember() refuses, not just the button', refused);
  check('...and did not record it', !(await autoApproved(dir)).has('Bash'));

  await forget(dir, 'mcp__personal__get_thread');
  check('a yes can be taken back', (await autoApproved(dir)).size === 0);

  await remember(dir, 'Read');
  await remember(dir, 'Grep');
  await forget(dir, null);
  check('all of them can be taken back at once', (await autoApproved(dir)).size === 0);

  check('forgetting something that was never there is not an error',
        (await forget(dir, 'nope')).removed === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
