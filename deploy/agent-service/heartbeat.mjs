/**
 * What the Obligations menu on the Mac knows about this server, and the one thing
 * it may ask of it.
 *
 * Since the server moved onto the Mac mini (2026-10-01), Obligations.app is the
 * server's only UI — Alex: "add the server status to the existing Obligations app,
 * we don't need a separate UI for the server." It cannot ask over HTTP:
 * every route but the Gmail hook sits behind Cloudflare Access, and a local
 * menu has no Access token. And it must not run anything from this repo,
 * because the agent can write the repo and Obligations.app holds Full Disk Access.
 * So the two talk through files under .log/, the same way `.log/run-<job>`
 * has always let a shell on the box ask for a run:
 *
 *   .log/server-status.json   written here every minute — Obligations.app reads it
 *   .log/run-reconcile        written by Obligations.app — this process acts on it
 *
 * Reading a file is all the menu does. A stale heartbeat is the menu's signal
 * that the server is down, which is why it carries an epoch beside the stamp.
 */
import { readFile, writeFile, rename, access, unlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { localStamp } from './time.mjs';
import { readGate } from './model-gate.mjs';

export const STATUS_FILE = (vault) => join(vault, '.log', 'server-status.json');
export const RECONCILE_FLAG = (vault) => join(vault, '.log', 'run-reconcile');
export const RECONCILE_RESULT = (vault) => join(vault, '.log', 'reconcile-last.json');

/**
 * Which credential the Claude CLI will use — the same order the CLI resolves
 * them, and the same four answers Curated's src/lib/claude-auth.ts gives, so
 * "why is nothing running" has an answer on the menu rather than in a log.
 * Never the value; only which kind is present.
 */
export async function claudeAuth(env = process.env) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'token';
  if (env.ANTHROPIC_API_KEY) return 'api-key';
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir) {
    try { await access(join(dir, '.credentials.json')); return 'login'; } catch {}
  }
  return 'none';
}

/** The newest run in job-runs.json: which job, and when it finished. */
export function lastRun(runs) {
  let best = null;
  for (const [name, r] of Object.entries(runs ?? {})) {
    if (!r?.at) continue;
    if (!best || r.at > best.at) best = { name, at: r.at, ok: r.ok ?? null };
  }
  return best;
}

/**
 * Write the heartbeat. Atomic — temp file, then rename — because Obligations.app
 * reads it every few seconds and must never see half a document.
 */
export async function writeHeartbeat(vault, { busyWith = null, runs = {}, started, now = new Date(), env = process.env } = {}) {
  let gate = null;
  try { gate = await readGate(vault, { now }); } catch {}
  const doc = {
    at: localStamp(now, ' '),
    at_epoch: Math.floor(now.getTime() / 1000),
    pid: process.pid,
    started,
    busy: busyWith,
    last_job: lastRun(runs),
    claude: await claudeAuth(env),
    model_enabled: gate ? gate.enabled !== false : null,
    node: process.version,
    smoke: Boolean(env.OBLIGATIONS_SMOKE),
  };
  const file = STATUS_FILE(vault);
  await mkdir(join(vault, '.log'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
  await rename(tmp, file);
  return doc;
}

/**
 * A reconcile Obligations.app asked for. Returns true when one ran, and the caller
 * then exits so launchd brings the server back with the new .mcp.json.
 *
 * On linuxbox this was Obligations.app over ssh running reconcile-mcp.mjs, then
 * `docker ps` and `sudo systemctl restart obligations-agent`. On the Mac it must not
 * run repo code itself (see the header), so it leaves the flag and this
 * process — already sandboxed, already the server — does the work.
 *
 * Only adds: reconcile-mcp.mjs never removes a server entry or a deny rule, so
 * the worst a spurious flag can do is a restart.
 */
export async function reconcileIfAsked(vault, { now = new Date(), nodeBin = process.execPath } = {}) {
  const flag = RECONCILE_FLAG(vault);
  try { await access(flag); } catch { return false; }
  await unlink(flag).catch(() => {});
  const result = await new Promise((resolve) => {
    const child = spawn(nodeBin, [join(vault, 'deploy', 'reconcile-mcp.mjs'), '--write'],
                        { cwd: vault, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: -1, out: String(e?.message ?? e) }));
  });
  const doc = {
    at: localStamp(now, ' '),
    ok: result.code === 0,
    code: result.code,
    // The tail is enough to say what changed; the whole run is in the service log.
    output: result.out.trim().split('\n').slice(-20).join('\n'),
    restarting: true,
  };
  await writeFile(RECONCILE_RESULT(vault), JSON.stringify(doc, null, 2) + '\n').catch(() => {});
  return true;
}

export const RESTART_EXIT = 75;   // EX_TEMPFAIL: non-zero, so launchd's KeepAlive brings it back
