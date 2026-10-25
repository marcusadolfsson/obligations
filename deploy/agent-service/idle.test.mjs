/**
 * deploy/idle.sh — whether a restart would cut work in half.
 *
 * 2026-09-30: a restart landed eleven seconds after the evening brief's
 * job_done, while its mail digest was being written and attached, and the
 * brief went out without one. Those steps now log post_job_start/done; this
 * pins that idle.sh reads the window as busy.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'idle.sh');
let pass = 0, fail = 0;
const check = (m, c, d) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}${d ? ` -> ${d}` : ''}`); } };
const run = (events) => {
  const vault = mkdtempSync(join(tmpdir(), 'obligations-idle-'));
  mkdirSync(join(vault, '.log'));
  writeFileSync(join(vault, '.log', 'agent-service.log'), events.map((e) => JSON.stringify({ at: '2026-09-30T22:10:44Z', event: e })).join('\n') + '\n');
  return spawnSync('bash', [IDLE], { env: { ...process.env, OBLIGATIONS: vault }, encoding: 'utf8' });
};

check('a job in flight is busy', run(['job_start']).status === 1);
check('a finished job is idle', run(['job_start', 'job_done']).status === 0);
check('the brief\'s digest and audit, after job_done, are busy', run(['job_start', 'job_done', 'post_job_start']).status === 1,
      run(['job_start', 'job_done', 'post_job_start']).stdout);
check('  ...and idle once they finish', run(['job_start', 'job_done', 'post_job_start', 'post_job_done']).status === 0);
check('a chat turn in flight is busy', run(['turn_start']).status === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
