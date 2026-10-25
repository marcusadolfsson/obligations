#!/usr/bin/env node
/**
 * `node deploy/reconcile-mcp.mjs [--write]` — make `.mcp.json` and the
 * permissions agree with the grants that actually exist.
 *
 * Default is a CHECK: it reports drift and exits non-zero, changing nothing.
 * `--write` applies. That way round because this rewrites the two files that
 * decide what the assistant may do to Alex's mail, and a tool that silently
 * edited them on a schedule would be a tool nobody could reason about.
 *
 * ## Why it exists
 *
 * The MCP server reads its credential paths straight out of `.mcp.json`. It
 * does not go through `deploy/mcp/google-auth.mjs`, so it knows nothing about
 * account-keyed grants, legacy directories or supersession. Re-granting a mail
 * account moves its token to `deploy/google/<account>/` and the server keeps
 * reading the old path — mail breaks in the window between the two, and the
 * failure is a 403 that looks like a revoked grant.
 *
 * Obligations-Dev-Mac's point, and the right one: the Mac app must not be what edits
 * this. That machine already holds the only capability that acts outward as
 * Alex, and "edits the assistant's tool configuration" does not belong beside it.
 * The app writes a grant; this reconciles config, here, where the lock is.
 *
 * ## Adding is safe, removing is not
 *
 * A new mail account gains a server entry AND its deny rules, because a server
 * without them is unfenced — `mcp__<account>__trash` would be callable while
 * every other account's is denied. Deny rules are only ever added.
 *
 * Removal is reported and never performed. An account whose grant disappeared
 * might be mid-migration, and deleting a server entry to tidy up is how a
 * mailbox silently stops being read. Alex removes those by hand, having read
 * the sentence saying which.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { accounts, capabilitiesOf, resolvedDir } from './mcp/google-auth.mjs';
import { MUST_DENY } from './mcp-fences.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

/** What the triage may call without being asked. Mirrors add-mailbox.mjs. */
const ALLOW = [
  'search_emails', 'read_email', 'get_thread', 'list_inbox_threads',
  'get_inbox_with_threads', 'list_email_labels', 'list_drafts', 'get_draft',
  'batch_modify_emails', 'draft_email', 'update_draft',
];

/** Registered under gmail.modify and never wanted. MUST_DENY covers the rest. */
const ALSO_DENY = [
  'delete_draft', 'modify_email', 'modify_thread', 'download_attachment',
  'create_label', 'update_label', 'delete_label', 'get_or_create_label',
];

const mcpPath = join(OBLIGATIONS, '.mcp.json');
const setPath = join(OBLIGATIONS, '.claude', 'settings.json');
const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
const settings = JSON.parse(await readFile(setPath, 'utf8'));

const isGmailServer = (spec) => (spec.args ?? []).some((a) => String(a).includes('gmail-mcp'));
const template = Object.values(mcp.mcpServers ?? {}).find(isGmailServer);
if (!template) {
  console.error('no gmail MCP server in .mcp.json to copy the fences from');
  process.exit(2);
}

const changes = [];
const warnings = [];

/* ------------------------------------------------- servers for mail accounts */

const mailAccounts = [];
for (const account of await accounts(OBLIGATIONS)) {
  if (!(await capabilitiesOf(account, OBLIGATIONS)).includes('mail')) continue;
  const dir = await resolvedDir(OBLIGATIONS, account);
  if (!dir) {
    warnings.push(`${account} has mail but no readable grant directory; leaving config alone`);
    continue;
  }
  mailAccounts.push(account);

  const want = {
    command: template.command,
    args: [...(template.args ?? [])],
    env: {
      // Fences copied from an existing server rather than restated: the rate
      // limits and the scope list are decisions with reasons written in
      // .mcp.json, and a second copy is the one that goes stale.
      ...template.env,
      GMAIL_OAUTH_PATH: `${dir}/gcp-oauth.keys.json`,
      GMAIL_CREDENTIALS_PATH: `${dir}/credentials.json`,
      GMAIL_MCP_STATE_DIR: dir,
      GMAIL_ACCOUNT: account,
    },
  };

  const have = mcp.mcpServers?.[account];
  const differs = !have
    || have.env?.GMAIL_CREDENTIALS_PATH !== want.env.GMAIL_CREDENTIALS_PATH
    || have.env?.GMAIL_OAUTH_PATH !== want.env.GMAIL_OAUTH_PATH
    || have.env?.GMAIL_MCP_STATE_DIR !== want.env.GMAIL_MCP_STATE_DIR;

  if (differs) {
    changes.push(have
      ? `${account}: credential paths → ${dir}` + (have.env?.GMAIL_MCP_STATE_DIR
          ? ` (was ${have.env.GMAIL_MCP_STATE_DIR})` : '')
      : `${account}: add MCP server → ${dir}`);
    mcp.mcpServers[account] = want;
  }
}

/* -------------------------------------------------- fences for every server */

const perms = settings.permissions ??= {};
perms.allow ??= [];
perms.deny ??= [];

for (const account of mailAccounts) {
  for (const tool of ALLOW) {
    const rule = `mcp__${account}__${tool}`;
    if (!perms.allow.includes(rule)) { perms.allow.push(rule); changes.push(`allow ${rule}`); }
  }
  for (const tool of [...MUST_DENY, ...ALSO_DENY]) {
    const rule = `mcp__${account}__${tool}`;
    if (!perms.deny.includes(rule)) { perms.deny.push(rule); changes.push(`deny ${rule}`); }
  }
}

/* ------------------------------------------------------- report what is left */

for (const [name, spec] of Object.entries(mcp.mcpServers ?? {})) {
  if (!isGmailServer(spec) || mailAccounts.includes(name)) continue;
  warnings.push(
    `.mcp.json has a server "${name}" with no mail-capable grant behind it. `
    + 'Not removed: it may be mid-migration, and deleting it is how a mailbox '
    + 'silently stops being read. Remove it by hand when you are sure.');
}

/* ---------------------------------------------------------------- the answer */

if (!changes.length) {
  console.log('.mcp.json and permissions already match the grants on disk.');
} else {
  console.log(WRITE ? 'Applied:' : 'Would change (run with --write):');
  for (const c of changes) console.log(`  ${c}`);
}
for (const w of warnings) console.log(`  note: ${w}`);

if (changes.length && WRITE) {
  await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  await writeFile(setPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('\nRestart obligations-agent, then verify against the running server:');
  console.log('  docker run --rm -v ~/obligations:/obligations -e OBLIGATIONS=/obligations \\');
  console.log('      --entrypoint node obligations:latest /obligations/deploy/mcp-check.mjs');
}

// Non-zero when there is drift and nothing was written, so a watchdog can use
// this without parsing prose.
process.exit(changes.length && !WRITE ? 1 : 0);
