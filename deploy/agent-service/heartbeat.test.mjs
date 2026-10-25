/**
 * What the Obligations menu on the Mac reads about this server, and the one request
 * it may make of it (heartbeat.mjs).
 *
 * Alex, 2026-10-01: the server's status lives in the existing Obligations app.
 * The menu reads a file, so three things carry the weight:
 *
 *  - **Never half a document.** The menu reads every few seconds; the write
 *    is atomic, and the epoch is there so "stale" is arithmetic.
 *  - **Which Claude credential, never the credential.** "none" on the menu is
 *    the answer to "why did nothing run" — and the token must not leak into a
 *    file Obligations.app and a human both read.
 *  - **A reconcile request is consumed once** and leaves a result behind,
 *    whether reconcile succeeded or not.
 */
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeartbeat, claudeAuth, lastRun, reconcileIfAsked,
         STATUS_FILE, RECONCILE_FLAG, RECONCILE_RESULT, RESTART_EXIT } from './heartbeat.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const vault = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'heartbeat-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await mkdir(join(dir, 'deploy'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });
  return dir;
};

console.log('Which Claude credential:');
{
  check('a setup-token token wins', (await claudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', ANTHROPIC_API_KEY: 'k' })) === 'token');
  check('then an API key', (await claudeAuth({ ANTHROPIC_API_KEY: 'k' })) === 'api-key');
  const dir = await vault();
  await writeFile(join(dir, '.credentials.json'), '{}');
  check('then a CLI login in CLAUDE_CONFIG_DIR', (await claudeAuth({ CLAUDE_CONFIG_DIR: dir })) === 'login');
  check('and "none" when there is nothing — the menu says so', (await claudeAuth({})) === 'none');
}

console.log('\nThe newest run:');
{
  const runs = {
    morning: { slot: 'a', at: '2026-10-01 07:04', ok: true },
    mail: { slot: 'b', at: '2026-10-01 11:35', ok: false },
    evening: { slot: 'c' },                 // never finished: no `at`
  };
  const r = lastRun(runs);
  check('picks the latest finish', r?.name === 'mail' && r.at === '2026-10-01 11:35', JSON.stringify(r));
  check('carries whether it worked', r?.ok === false);
  check('an empty ledger is null, not a crash', lastRun({}) === null && lastRun(undefined) === null);
}

console.log('\nThe heartbeat:');
{
  const dir = await vault();
  const now = new Date(2026, 9, 1, 13, 40, 0);
  const doc = await writeHeartbeat(dir, {
    busyWith: 'mail', runs: { mail: { at: '2026-10-01 13:39', ok: true } }, started: 'x', now,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SECRETSECRETSECRETSECRET' },
  });
  const onDisk = JSON.parse(await readFile(STATUS_FILE(dir), 'utf8'));
  check('lands in .log/server-status.json and parses', onDisk.at === '2026-10-01 13:40', onDisk.at);
  check('carries an epoch, so staleness is arithmetic', onDisk.at_epoch === Math.floor(now.getTime() / 1000));
  check('says what it is busy with', onDisk.busy === 'mail');
  check('names the credential kind', onDisk.claude === 'token');
  const raw = await readFile(STATUS_FILE(dir), 'utf8');
  check('never the credential itself', !raw.includes('SECRET'), 'token text found in the heartbeat');
  check('absent model switch reads as on', onDisk.model_enabled === true);
  check('and returns what it wrote', doc.pid === process.pid);
  const left = (await import('node:fs/promises')).readdir;
  const files = await left(join(dir, '.log'));
  check('leaves no temp file behind (the write is a rename)', files.every((f) => !f.endsWith('.tmp')), files.join(','));
}

console.log('\nA reconcile asked for from the menu:');
{
  const dir = await vault();
  check('nothing asked, nothing done', (await reconcileIfAsked(dir)) === false);
  // A stand-in reconcile-mcp.mjs: the real one needs grants this test does not have.
  await writeFile(join(dir, 'deploy', 'reconcile-mcp.mjs'),
                  "console.log('would add work'); process.exit(process.argv.includes('--write') ? 0 : 1);\n");
  await writeFile(RECONCILE_FLAG(dir), '');
  check('a flag runs it', (await reconcileIfAsked(dir)) === true);
  check('and the flag is consumed — one request, one run', !(await exists(RECONCILE_FLAG(dir))));
  const res = JSON.parse(await readFile(RECONCILE_RESULT(dir), 'utf8'));
  check('it ran with --write', res.ok === true && res.code === 0, JSON.stringify(res));
  check('the result says what reconcile said', /would add work/.test(res.output));
  check('a second tick does nothing', (await reconcileIfAsked(dir)) === false);

  await writeFile(join(dir, 'deploy', 'reconcile-mcp.mjs'), "console.error('boom'); process.exit(2);\n");
  await writeFile(RECONCILE_FLAG(dir), '');
  await reconcileIfAsked(dir);
  const failed = JSON.parse(await readFile(RECONCILE_RESULT(dir), 'utf8'));
  check('a failed reconcile is recorded as failed, with why', failed.ok === false && /boom/.test(failed.output));
  check('the restart exit is non-zero, so launchd brings it back', RESTART_EXIT !== 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
