/**
 * Filed documents on a task's pane (filed-docs.mjs).
 *
 * The case it was written for: C4KF, the Lakeside Jet Hangar Co flap actuator
 * invoice, 2026-10-15 — both PDFs filed the day the mail came, and the task
 * had no link to either.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFiled, attachFiled } from './filed-docs.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const LINES = [
  '# Statements and filed documents',
  '',
  '- 2026-10-12 — **Invoice INV26-00102- Flap Actuator Core** from Simone Reyes dreyes@jetcenter.example · [2026-10-12 Simone Reyes — Invoice INV26-00102- Flap Actuator Core.pdf](https://drive.google.com/file/d/AAA/view?usp=drivesdk) · 69KB · Aced · $3,912.64 · terms: due on receipt · invoiced 2026-10-12 · msg:1a131b50df2559ad',
  '- 2026-10-12 — **Invoice INV26-00102- Flap Actuator Core** from Simone Reyes dreyes@jetcenter.example · [2026-10-12 Simone Reyes — Invoice INV26-00102- Flap Actuator Core.pdf](https://drive.google.com/file/d/BBB/view?usp=drivesdk) · 63KB · terms: of our contract of carriage. To learn more about · msg:1a131b50df2559ad',
  // Re-filed: the same link again must not show twice.
  '- 2026-10-12 — **Invoice INV26-00102- Flap Actuator Core** from Simone Reyes dreyes@jetcenter.example · [2026-10-12 Simone Reyes — Invoice INV26-00102- Flap Actuator Core.pdf](https://drive.google.com/file/d/AAA/view?usp=drivesdk) · 69KB · msg:1a131b50df2559ad',
  // A later message on another thread, known only through the mail cache.
  '- 2026-10-13 — **Re: Statement** from LFC billing@co136a.example · [2026-10-13 LFC — Statement.pdf](https://drive.google.com/file/d/CCC/view?usp=drivesdk) · 12KB · msg:bbbb0002',
  'not a line at all',
].join('\n');

console.log('The record:');
{
  const m = parseFiled(LINES);
  check('two documents on the invoice message, the repeat dropped', m.get('1a131b50df2559ad')?.length === 2, JSON.stringify(m.get('1a131b50df2559ad')));
  check('size and link read off the line', m.get('1a131b50df2559ad')[1].kb === 63 && m.get('1a131b50df2559ad')[1].link.endsWith('BBB/view?usp=drivesdk'));
  check('a heading or stray line is not a document', m.size === 2, [...m.keys()].join(','));
}

const vault = await mkdtemp(join(tmpdir(), 'filed-docs-'));
await mkdir(join(vault, 'reference'), { recursive: true });
await mkdir(join(vault, '.log', 'mail-cache', 'personal'), { recursive: true });
await writeFile(join(vault, 'reference', 'statements.md'), LINES);
await writeFile(join(vault, '.log', 'mail-cache', 'personal', 'bbbb0001.json'),
  JSON.stringify({ thread_id: 'bbbb0001', messages: [{ id: 'bbbb0001' }, { id: 'bbbb0002' }] }));
const mail = (thread) => ({ source: 'email', detail: { account: 'personal', thread_id: thread } });

console.log('On the tasks:');
{
  const items = [
    { id: 'mail:personal:1a131b50df2559ad', evidence: [mail('1a131b50df2559ad')] },
    { id: 'mail:personal:bbbb0001', evidence: [mail('bbbb0001')] },
    { id: 'mail:personal:cccc0001', evidence: [mail('cccc0001')] },
    { id: 'todo:x', evidence: [{ source: 'todo' }] },
    { id: 'two-threads', evidence: [mail('1a131b50df2559ad'), mail('bbbb0001')] },
  ];
  await attachFiled(vault, items);
  check('C4KF carries both PDFs', items[0].filed?.length === 2, JSON.stringify(items[0].filed));
  check('a later message is matched through the cache', items[1].filed?.[0]?.link.includes('CCC'), JSON.stringify(items[1].filed));
  check('a thread with nothing filed gets no field', !('filed' in items[2]));
  check('a task with no mail is untouched', !('filed' in items[3]));
  check('a merged task carries every thread\'s documents', items[4].filed?.length === 3);
}

console.log('Nothing to read:');
{
  const empty = await mkdtemp(join(tmpdir(), 'filed-docs-'));
  const items = [{ id: 'm', evidence: [mail('1a131b50df2559ad')] }];
  await attachFiled(empty, items);
  check('no record, no field and no throw', !('filed' in items[0]));
  const traversal = [{ id: 't', evidence: [{ source: 'email', detail: { account: '../..', thread_id: 'bbbb0001' } }] }];
  await attachFiled(vault, traversal);
  check('a bad account name reads no cache file', !('filed' in traversal[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
