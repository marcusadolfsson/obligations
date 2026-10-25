/**
 * `node deploy/mcp-check.mjs` — what can the assistant actually do to Alex's mail?
 *
 * Not what `.mcp.json` says and not what the deny list says on its own: what the
 * server registers with the credentials on this box, cross-checked against the
 * rules that are supposed to fence it in.
 *
 * This mattered less when the scope was `gmail.readonly`, because nothing
 * dangerous was registered at all. Under `gmail.modify` the send, reply, forward
 * and spam tools all exist and are callable, and the deny list is the thing
 * stopping them. A list that has quietly stopped matching the tool names is
 * indistinguishable from a list that works, right up until it isn't — so this
 * compares the two directly.
 *
 * It also checks the layers behind the deny list, because that is the point of
 * having them: an empty pairing allowlist, and rate limits that keep a confused
 * run from archiving a mailbox.
 *
 * **Run it inside the container, not on the host.** `.mcp.json` names the server
 * by its container-absolute path, because that is the only place it is
 * installed; on a host checkout there is nothing to ask. The preflight below
 * says so and prints the command rather than letting it look like a hang.
 *
 * Run after connecting Gmail, after editing `.mcp.json` or the permissions, and
 * any time credentials change — a scope can be re-granted from a browser
 * without touching a file in this repo.
 */
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { checkFences } from './mcp-fences.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let bad = 0;
const fail = (m, detail) => { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); bad++; };
const ok = (m) => console.log(`  ok   ${m}`);

const config = JSON.parse(await readFile(join(OBLIGATIONS, '.mcp.json'), 'utf8'));
const settings = JSON.parse(await readFile(join(OBLIGATIONS, '.claude', 'settings.json'), 'utf8'));

// Every Gmail server, not the one called "gmail". A second mailbox is a second
// server instance — this one has no multi-account support, every call is
// userId:"me" — and checking only the first would report "all fences in place"
// while the second account had none of them. Each server gets its own tool
// prefix, so each needs its own deny rules.
const servers = Object.entries(config.mcpServers ?? {})
  .filter(([, spec]) => (spec.args ?? []).some((a) => String(a).includes('gmail-mcp')));

if (!servers.length) {
  console.error('no gmail server in .mcp.json');
  process.exit(2);
}

const denied = new Set(settings.permissions?.deny ?? []);
const allowed = new Set(settings.permissions?.allow ?? []);

/* ------------------------------------------------ ask each server directly */

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/**
 * What has to be true before spawning is worth trying.
 *
 * Every one of these used to present identically: the child died or blocked, no
 * listener noticed, and the 20-second timer threw a stack trace naming the
 * timer. The cause — no credentials, or the container-absolute module path on a
 * host checkout — was nowhere in the output, so the natural next move was to
 * debug the MCP server rather than run the installer.
 */
/**
 * `${VAR}` and `${VAR:-default}`, the way Claude Code expands `.mcp.json`.
 *
 * The paths are written that way since the server moved onto the Mac mini
 * (2026-10-01): inside the container the MCP server is at /node_modules and the
 * repo at /obligations; on the Mac it is the repo's own deploy/agent-service/
 * node_modules, named by OBLIGATIONS_NODE_MODULES. Spawning the spec unexpanded would
 * check a path that exists on neither.
 */
const expand = (v) => String(v).replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
  (_, name, fallback) => process.env[name] ?? fallback ?? '');

function expandSpec(spec) {
  return {
    ...spec,
    command: expand(spec.command),
    args: (spec.args ?? []).map(expand),
    env: Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(v)])),
  };
}

async function preflight(spec) {
  const out = [];

  const mod = (spec.args ?? []).find((a) => String(a).includes('gmail-mcp'));
  if (mod && isAbsolute(mod) && !(await exists(mod))) {
    out.push(`the server is not at ${mod}`,
             'On the Mac the server lives in deploy/agent-service/node_modules:',
             '  (cd deploy/agent-service && npm ci) and set OBLIGATIONS_NODE_MODULES to it.',
             'On linuxbox it is inside the container; run it there:',
             '',
             '  docker run --rm -v ~/obligations:/obligations -e OBLIGATIONS=/obligations \\',
             '      --entrypoint node obligations:latest /obligations/deploy/mcp-check.mjs');
  }

  for (const key of ['GMAIL_OAUTH_PATH', 'GMAIL_CREDENTIALS_PATH']) {
    const rel = spec.env?.[key];
    if (!rel) continue;
    const abs = isAbsolute(rel) ? rel : join(OBLIGATIONS, rel);
    if (!(await exists(abs))) {
      out.push(`${key} is not on this box: ${rel}`);
    }
  }
  if (out.some((l) => l.startsWith('GMAIL_'))) {
    out.push('Gmail is not connected here. Run deploy/integrations/install-gmail.sh',
             'on a machine with a browser, then scp the two files into deploy/gmail-state/.');
  }
  return out;
}

async function toolsOf(spec) {
  const child = spawn(spec.command, spec.args ?? [], {
    cwd: OBLIGATIONS,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

  const tools = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      // Blocked rather than dead — an OAuth prompt waiting on a browser that is
      // not there is the usual one.
      () => reject(new Error('the server started but never answered tools/list in 20s')),
      20_000);
    // Without these two the failure mode for anything that stops the child —
    // a missing module, a bad node, an immediate crash — is the timeout above,
    // which describes the symptom and hides the cause.
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not start it: ${e.message}`)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`it exited with status ${code} before answering`));
    });
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (m.id === 2) {
          clearTimeout(timer);
          resolve(m.result?.tools ?? []);
        }
      }
    });
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {},
                clientInfo: { name: 'obligations-mcp-check', version: '1' } },
    });
  }).finally(() => child.kill());

  return { names: tools.map((t) => t.name).sort(), stderr };
}

/* -------------------------------------------------------------- per account */

let anyRegistered = false;
let unchecked = 0;

for (const [server, raw] of servers) {
  const spec = expandSpec(raw);
  const account = spec.env?.GMAIL_ACCOUNT ?? server;

  const blockers = await preflight(spec);
  if (blockers.length) {
    console.log(`\n── ${server}${account !== server ? `  (${account})` : ''} — cannot check`);
    for (const l of blockers) console.log(`   ${l}`);
    // Not a fence failure. Saying "0 problems" would be worse, so this exits
    // non-zero, but it must not read as "the fences are broken".
    unchecked++;
    continue;
  }

  let names, stderr;
  try {
    ({ names, stderr } = await toolsOf(spec));
  } catch (e) {
    console.log(`\n── ${server}${account !== server ? `  (${account})` : ''} — cannot check`);
    console.log(`   ${e.message}`);
    if (String(e.stderr ?? '').trim()) {
      console.log(String(e.stderr).trim().split('\n').map((l) => '   ' + l).join('\n'));
    }
    unchecked++;
    continue;
  }

  console.log(`\n── ${server}${account !== server ? `  (${account})` : ''} ` +
              `— ${names.length} tools registered`);

  if (!names.length) {
    console.log('   none. Either the credentials are missing or the token carries no scope.');
    if (stderr.trim()) console.log(stderr.trim().split('\n').map((l) => '   ' + l).join('\n'));
    console.log('   Run deploy/integrations/install-gmail.sh on a machine with a browser.');
    continue;
  }
  anyRegistered = true;

  for (const n of names) {
    const t = `mcp__${server}__${n}`;
    const mark = denied.has(t) ? 'denied ' : allowed.has(t) ? 'allowed' : 'asks   ';
    console.log(`   ${mark}  ${n}`);
  }

  let paired = [];
  try {
    const raw = JSON.parse(await readFile(spec.env?.GMAIL_MCP_PAIRED_PATH ?? '', 'utf8'));
    paired = Array.isArray(raw) ? raw : (raw.recipients ?? raw.paired ?? []);
  } catch { /* absent is the intended state */ }

  // Each server has its own tool prefix, so each needs its own deny rules. A
  // second mailbox added without them would be entirely unfenced while the
  // first still reported clean.
  const { problems, notes, passed } = checkFences(names, settings, spec.env ?? {}, paired, server);
  for (const m of passed) ok(m);
  for (const m of notes) console.log(`   note  ${m}`);
  for (const m of problems) fail(m);
}

if (unchecked) {
  console.log(`\n${unchecked} server(s) could not be checked — see above. ` +
              'Nothing here says the fences are wrong; it says they are unverified.');
  process.exit(2);
}
if (!anyRegistered) process.exit(1);
console.log(bad ? `\n${bad} problem(s).` : '\nAll fences in place.');
process.exit(bad ? 1 : 0);
