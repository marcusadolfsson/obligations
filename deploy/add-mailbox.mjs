/**
 * `node deploy/add-mailbox.mjs <name>` — register a second mailbox.
 *
 * This server has no multi-account support: every call is `userId: "me"`, so a
 * second mailbox is a second server instance with its own credentials. Each
 * instance gets its own tool-name prefix — `mcp__phoa__search_emails` — which
 * means **its own deny rules**. The first mailbox's rules do not cover it.
 *
 * That is the whole reason this script exists rather than a paragraph in the
 * README. Adding a mailbox by hand means editing two files and remembering
 * thirteen tool names; forget them and the new account is completely unfenced
 * while `mcp-check` still says "all fences in place" for the old one. Today
 * alone, two bugs had exactly that shape — a check passing for the wrong
 * reason.
 *
 * Writes `.mcp.json` and `.claude/settings.json`, then tells you to restart and
 * verify. It never touches credentials; those come from
 * `deploy/integrations/install-gmail.sh --account=<name>` on a machine with a
 * browser.
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { MUST_DENY } from './mcp-fences.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const name = process.argv[2];

if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
  console.error('usage: node deploy/add-mailbox.mjs <name>   (lowercase, [a-z0-9_])');
  process.exit(2);
}

// What the triage may call. Everything else is denied or asks.
const ALLOW = [
  'search_emails', 'read_email', 'get_thread', 'list_inbox_threads',
  'get_inbox_with_threads', 'list_email_labels', 'list_drafts', 'get_draft',
  'batch_modify_emails', 'draft_email', 'update_draft',
];

// Registered under gmail.modify and never wanted. MUST_DENY is the outward and
// destructive set, shared with the checker so the two cannot drift; these are
// the rest.
const ALSO_DENY = [
  'delete_draft', 'modify_email', 'modify_thread', 'download_attachment',
  'create_label', 'update_label', 'delete_label', 'get_or_create_label',
];

const stateDir = name === 'gmail' ? 'deploy/gmail-state' : `deploy/gmail-state-${name}`;

try {
  await access(join(OBLIGATIONS, stateDir, 'credentials.json'));
} catch {
  console.error(`No credentials at ${stateDir}/credentials.json.\n` +
                `Run this first, on a machine with a browser:\n` +
                `  bash deploy/integrations/install-gmail.sh --account=${name}\n` +
                `then copy the two files up. Registering a mailbox with no token\n` +
                `would put a server in the config that fails on every call.`);
  process.exit(1);
}

/* ------------------------------------------------------------------ .mcp.json */

const mcpPath = join(OBLIGATIONS, '.mcp.json');
const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
const existing = mcp.mcpServers?.[name];

// Copy the first mailbox's fences rather than restating them: the rate limits
// and the pairing switch are decisions with reasons written down in .mcp.json,
// and a second copy would be the one that goes stale.
//
// The credential paths below are then overridden, and nothing else is. In
// particular the SCOPES come across unchanged, so a second mailbox gets the
// same send posture as the first: the verbs register, they are in neither
// permission list, and they reach the prompt. If that is not wanted for this
// org, narrow --scopes for its own auth run rather than editing this.
const template = mcp.mcpServers?.gmail;
if (!template) {
  console.error('no `gmail` server in .mcp.json to copy the fences from');
  process.exit(1);
}

mcp.mcpServers[name] = {
  command: template.command,
  args: [...(template.args ?? [])],
  env: {
    ...template.env,
    GMAIL_OAUTH_PATH: `${stateDir}/gcp-oauth.keys.json`,
    GMAIL_CREDENTIALS_PATH: `${stateDir}/credentials.json`,
    GMAIL_MCP_STATE_DIR: stateDir,
    GMAIL_ACCOUNT: name,
  },
};
await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
console.log(`${existing ? 'updated' : 'added'} mcpServers.${name} in .mcp.json`);
console.log(`  fences copied from the gmail server: pairing, rate limits, scope`);

/* --------------------------------------------------------- settings.json */

const setPath = join(OBLIGATIONS, '.claude', 'settings.json');
const settings = JSON.parse(await readFile(setPath, 'utf8'));
const perms = settings.permissions ??= {};
perms.allow ??= [];
perms.deny ??= [];

let added = 0;
for (const t of ALLOW) {
  const rule = `mcp__${name}__${t}`;
  if (!perms.allow.includes(rule)) { perms.allow.push(rule); added++; }
}
let denied = 0;
for (const t of [...MUST_DENY, ...ALSO_DENY]) {
  const rule = `mcp__${name}__${t}`;
  if (!perms.deny.includes(rule)) { perms.deny.push(rule); denied++; }
}
await writeFile(setPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`added ${added} allow and ${denied} deny rules for mcp__${name}__*`);

console.log(`
Next:
  sudo systemctl restart obligations-agent
  docker run --rm -v ~/obligations:/obligations -e OBLIGATIONS=/obligations \\
      --entrypoint node obligations:latest /obligations/deploy/mcp-check.mjs

That must say "All fences in place" for BOTH mailboxes, and it runs in the
container — the MCP server is not installed on the host.

And commit: .mcp.json and .claude/settings.json changed, the credentials did not
(deploy/gmail-state-*/ is gitignored).`);
