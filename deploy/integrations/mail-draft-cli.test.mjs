/**
 * mail-draft.mjs run as a script — the way every job calls it.
 *
 * Alex, 2026-09-25: "The mail-drafting path has failed every evening it has
 * been tried since 09-15; this is the seventh time." Exit 13, "unsettled
 * top-level await", every time: a module deadlock between this script's
 * top-level await and mail-drafts.mjs importing it back. The service never
 * saw it because it imports the file as a module. So the test runs it the
 * jobs' way, against a repo with no Google credentials: the right answer is
 * a clean "not connected" error, and exit 13 is the bug.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'mail-draft.mjs');
const vault = mkdtempSync(join(tmpdir(), 'obligations-draftcli-'));
let pass = 0, fail = 0;
const check = (m, c, d) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}${d ? ` -> ${d}` : ''}`); } };
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, OBLIGATIONS: vault }, encoding: 'utf8', timeout: 30000 });

console.log('run as a script, the way a job runs it');
const draft = run('personal', 't-1', '--body', 'hello');
check('a new draft reaches the auth step and fails cleanly, not exit 13',
      draft.status === 1 && /not connected/.test(draft.stderr), `status ${draft.status}: ${draft.stderr.slice(0, 160)}`);
const upd = run('personal', '--update', 'r-1', '--body', 'hello');
check('--update — the path that imports mail-drafts.mjs first — does too',
      upd.status === 1 && /not connected/.test(upd.stderr), `status ${upd.status}: ${upd.stderr.slice(0, 160)}`);
check('neither reports an unsettled await', !/unsettled top-level await/.test(draft.stderr + upd.stderr));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
