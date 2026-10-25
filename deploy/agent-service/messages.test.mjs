/**
 * messages.mjs: taking back an urgent push whose task has been dealt with.
 *
 * Alex, 2026-09-23: "Urgent briefs that are unread and the underlaying task
 * is resolved, rewoke them." Rita's cleaning question was pushed at 19:10, he
 * answered her himself at 19:16, the task closed at 19:31 — and "Needs you
 * now" sat unread on the Briefs badge until he opened it to find nothing.
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revokeResolved, listMessages } from './messages.mjs';

let pass = 0, fail = 0;
const check = (m, c, d) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}${d ? ` -> ${d}` : ''}`); } };

const dir = await mkdtemp(join(tmpdir(), 'obligations-msgs-'));
const msg = (name, { kind = 'urgent', at = '2026-09-23 19:10', read = 'false', task = 'im:any;-;+15552000011' } = {}) =>
  writeFile(join(dir, name), `---\ntype: message\nkind: ${kind}\nat: ${at}\ntitle: Needs you now — Tell Rita OK to clean tomorrow at 11am\nread: ${read}\ndelivered: apns\n---\n\n**Rita** said at 15:42.\n\n[Open the task](/todo#pane=${encodeURIComponent(task)})\n`);

await msg('rosa.md');
await msg('open.md', { task: 'im:any;-;+15552000012' });
await msg('seen.md', { read: 'true' });
await msg('note.md', { kind: 'note' });
await msg('older.md', { at: '2026-09-23 20:00' });
const closed = {
  'im:any;-;+15552000011': { at: '2026-09-23 19:31', by: 'agent:assistant',
    outcome: 'He texted Rita himself at 19:16 to skip this week; she confirmed at 19:17' },
};

console.log('an urgent push whose task has closed');
const gone = await revokeResolved(dir, closed);
const rosa = await readFile(join(dir, 'rosa.md'), 'utf8');
check('an unread urgent push on a closed task is taken back', gone.some((g) => g.id === 'rosa.md'), JSON.stringify(gone));
check('  ...it no longer counts as unread', /^read: true$/m.test(rosa));
check('  ...and says when and on what', /^revoked: 2026-09-23 19:31 — He texted Rita himself/m.test(rosa), rosa);
check('  ...with the words it pushed left exactly as written', rosa.includes('**Rita** said at 15:42.'));
const listed = (await listMessages(dir)).find((m) => m.id === 'rosa.md');
check('the page is told, so it can say "resolved"', /19:31/.test(listed?.revoked ?? ''), JSON.stringify(listed));

console.log('\nwhat it leaves alone');
check('a push whose task is still open', !gone.some((g) => g.id === 'open.md'));
check('one he has already read — that is his record, not ours to touch', !gone.some((g) => g.id === 'seen.md')
      && !/revoked:/.test(await readFile(join(dir, 'seen.md'), 'utf8')));
check('anything that is not an urgent push', !gone.some((g) => g.id === 'note.md'));
check('a push newer than the close — the task was reopened and this is about the live one',
      !gone.some((g) => g.id === 'older.md'));
check('and a second pass changes nothing', (await revokeResolved(dir, closed)).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
