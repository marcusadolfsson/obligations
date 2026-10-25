/**
 * A Google access token, from a refresh token.
 *
 * No SDK. Minting a token is one form POST and the response is JSON, so the
 * `googleapis` dependency would buy nothing and cost a supply-chain surface in
 * the process that reads Alex's mail.
 *
 * ## Where the credentials come from
 *
 * The same two files the MCP server uses, in `deploy/gmail-state/` — the client
 * from `gcp-oauth.keys.json` and the refresh token from `credentials.json`.
 * Deliberately not a second copy in `.env`: one grant, one place, and no way
 * for the agent's mail access and the service's to drift apart.
 *
 * `deploy/integrations/install-gmail.sh` produces both, once.
 *
 * ## The trap
 *
 * A Google OAuth app left in **Testing** mode issues refresh tokens that expire
 * after seven days. Mail would work for a week and then stop, with a `400
 * invalid_grant` that says nothing about why. The app has to be Published (or
 * Internal, on a Workspace domain). The installer checks and says so; this file
 * turns that failure into a message that names the cause rather than a stack
 * trace at 07:00 in a scheduled job.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Refresh a minute early. A token that expires between the check and the call
// fails a job for no reason anyone can reproduce.
const SKEW_MS = 60_000;

let cached = null;              // { token, expiresAt }

/**
 * The client and refresh token for one mailbox.
 *
 * Missing files return empty rather than throwing: `accessToken` below turns
 * that into a message naming the installer to run, which is more use at 07:00
 * in a scheduled job than a stack trace about a path.
 */
/**
 * ## Grants are per ACCOUNT, and capabilities are scopes inside them
 *
 * Alex, 2026-09-02: "You add a google account, and can then enable
 * mail/drive/calendar independently or all together. you can add one or many
 * different google accounts."
 *
 * The old layout keyed grants by *capability* — `deploy/calendar-state`,
 * `deploy/drive-state`, `deploy/gmail-state-<id>` — which quietly permitted
 * many mailboxes but exactly one calendar and exactly one Drive, and had no way
 * to say "this second account also has Drive". The capability was the identity,
 * so a second one of anything had nowhere to live.
 *
 * Now the account is the identity:
 *
 *     deploy/google/<account>/credentials.json     one token, every granted scope
 *     deploy/google/<account>/gcp-oauth.keys.json  the OAuth client for its project
 *
 * A capability is not a directory, it is a scope present in that token. Adding
 * Drive to an account later is Google's own incremental authorisation: consent
 * again with the extra scope and `include_granted_scopes=true`, and the token
 * comes back carrying both. One grant per account, however many capabilities.
 *
 * ## The legacy layout still resolves
 *
 * Four working grants predate this — gmail-state, gmail-state-work,
 * calendar-state, drive-state — and three of them are the same Google account
 * with different scopes. They keep resolving until they are re-granted, because
 * breaking a working login-code path to tidy a directory layout is a bad trade.
 * `legacyDirs()` is the whole of that compatibility and it is meant to be
 * deleted once nothing needs it.
 */
export const GOOGLE_DIR = 'deploy/google';

/** Capability → the scope that proves it. */
export const CAPABILITY = {
  mail: 'https://www.googleapis.com/auth/gmail.modify',
  send: 'https://www.googleapis.com/auth/gmail.send',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive.file',
};

/**
 * Where the old capability-keyed grants live, newest naming first.
 *
 * Ordered so an account that has been re-granted under the new layout wins:
 * `credentials()` tries `deploy/google/<account>` before any of these.
 */
function legacyDirs(account) {
  return {
    gmail: ['deploy/gmail-state'],
    calendar: ['deploy/calendar-state'],
    drive: ['deploy/drive-state'],
  }[account] ?? [`deploy/gmail-state-${account}`];
}

/**
 * Every directory that might hold this account's grant, in order of preference.
 */
export function stateDirs(account = 'gmail') {
  return [`${GOOGLE_DIR}/${account}`, ...legacyDirs(account)];
}

/**
 * The directory actually holding this account's grant, or null.
 *
 * The difference from `stateDirs()` matters to anything that writes config: a
 * path that merely *should* hold a grant is not one the MCP server can read,
 * and pointing it at a directory that does not exist yet is how mail breaks
 * between a migration and a reconcile.
 */
export async function resolvedDir(vault, account) {
  for (const dir of stateDirs(account)) {
    try {
      await readFile(join(vault, dir, 'credentials.json'), 'utf8');
      await readFile(join(vault, dir, 'gcp-oauth.keys.json'), 'utf8');
      return dir;
    } catch { /* try the next */ }
  }
  return null;
}

/** The one directory a NEW grant should be written to. */
export function stateDir(account = 'gmail') {
  return `${GOOGLE_DIR}/${account}`;
}

/**
 * Every account with a grant on this box.
 *
 * Reads the directory rather than a list someone maintains: a manifest would be
 * a second place to forget, and the grant either exists on disk or it does not.
 */
export async function accounts(vault = process.env.OBLIGATIONS ?? '/obligations') {
  const found = new Set();
  const superseded = new Set();

  try {
    for (const name of await readdir(join(vault, GOOGLE_DIR))) {
      if (name.startsWith('.')) continue;
      found.add(name);
      // A migrated account declares which capability-keyed grants it replaces.
      // Without this both would be listed and one mailbox would appear twice —
      // accountsWith('mail') returning ['personal','gmail'] means the extractor
      // pulls the same inbox under two names, and the duplicate looks like real
      // volume rather than a half-finished migration.
      //
      // Declared at grant time rather than inferred, because inferring means
      // matching identities across tokens and a drive.file grant cannot tell
      // you whose it is.
      try {
        const c = JSON.parse(await readFile(join(vault, GOOGLE_DIR, name, 'credentials.json'), 'utf8'));
        for (const old of c.supersedes ?? []) {
          // An account cannot supersede itself, and saying so is not pedantry:
          // the new `work` grant legitimately replaces the legacy `work`
          // directory, so `--supersedes=work` is the natural thing to write and
          // it deleted the account from this list entirely. The mailbox then
          // had no grant behind it and reconcile-mcp reported its server as
          // orphaned — one instruction away from a migration that silently
          // stops an inbox being read.
          //
          // Superseding a legacy directory of the SAME name needs no
          // declaration at all: stateDirs() already prefers deploy/google/<id>
          // over the legacy path, so the new grant wins by resolution order.
          if (old !== name) superseded.add(old);
        }
      } catch { /* unreadable is handled by credentials() */ }
    }
  } catch { /* nothing migrated yet */ }

  // Legacy capability-keyed directories, while they still exist.
  try {
    for (const name of await readdir(join(vault, 'deploy'))) {
      if (name === 'gmail-state') found.add('gmail');
      else if (name === 'calendar-state') found.add('calendar');
      else if (name === 'drive-state') found.add('drive');
      else if (name.startsWith('gmail-state-')) found.add(name.slice('gmail-state-'.length));
    }
  } catch { /* deploy/ unreadable is someone else's problem */ }

  for (const old of superseded) found.delete(old);
  return [...found].sort();
}

/**
 * Capabilities an account HAS been granted, and capabilities it may USE.
 *
 * They are not the same thing and pretending otherwise would be dishonest in a
 * specific way: a scope cannot be narrowed. Once `drive.file` is in a token, no
 * setting takes it out — only revoking the whole grant and consenting again
 * does. So "turn Drive off for this account" is a decision about what the assistant
 * WILL use, not about what it CAN. Obligations-Dev-Mac made this point about a
 * checkbox that would imply a revocation it does not perform, and it is right:
 * the two scopes anyone would actually want to switch off are drive.file and
 * gmail.send, which are exactly the two where the difference matters.
 *
 * The policy is tracked in git because it is a decision, unlike the tokens.
 */
const POLICY = 'integrations/google-policy.json';

async function policy(vault) {
  try {
    return JSON.parse(await readFile(join(vault, POLICY), 'utf8'));
  } catch {
    return {};                                   // nothing disabled
  }
}

/** Capabilities the grant carries, whether or not they are in use. */
export async function grantedCapabilities(account, vault = process.env.OBLIGATIONS ?? '/obligations') {
  const { scopes } = await credentials(vault, account);
  return Object.entries(CAPABILITY)
    .filter(([, scope]) => scopes.includes(scope))
    .map(([name]) => name);
}

/** What is disabled by policy, and therefore granted but deliberately unused. */
export async function disabledCapabilities(account, vault = process.env.OBLIGATIONS ?? '/obligations') {
  const p = await policy(vault);
  const off = new Set(p[account]?.disabled ?? []);
  return (await grantedCapabilities(account, vault)).filter((c) => off.has(c));
}

/**
 * Which accounts can do a thing — `mail`, `send`, `calendar`, `drive`.
 *
 * This is what replaced hardcoding `'calendar'` as an account name. Asking
 * "who has calendar" rather than "read the calendar account" is what permits a
 * second account to have one, which was the whole point of the change: the old
 * layout allowed many mailboxes but exactly one calendar and one Drive,
 * because the capability WAS the identity.
 */
export async function accountsWith(capability, vault = process.env.OBLIGATIONS ?? '/obligations') {
  const scope = CAPABILITY[capability];
  if (!scope) throw new Error(`unknown capability: ${capability}`);
  const out = [];
  for (const account of await accounts(vault)) {
    if ((await capabilitiesOf(account, vault)).includes(capability)) out.push(account);
  }
  return out;
}

/**
 * What one account will actually be used for: granted, minus disabled.
 *
 * This is the one callers want. `grantedCapabilities` is what the token
 * carries, and the gap between them is visible on purpose — a capability that
 * is present but switched off should be reportable as exactly that, not absent.
 */
export async function capabilitiesOf(account, vault = process.env.OBLIGATIONS ?? '/obligations') {
  const off = new Set(await disabledCapabilities(account, vault));
  return (await grantedCapabilities(account, vault)).filter((c) => !off.has(c));
}

/** How to obtain a grant, when it is absent. */
const installerFor = (a) =>
  `node deploy/integrations/google-auth-cli.mjs --account=${a} (on a machine with a browser)`;

/**
 * Granted scopes, as full URLs, whatever shape the file is in.
 *
 * `tokens.scope` is authoritative and present in every grant on this box today.
 * The fallback exists for the case where it is not: the top-level array may
 * hold short names, and a bare `gmail.modify` compared against a full URL
 * matches nothing — silently, which is how a working account reports as having
 * no capabilities.
 */
const SCOPE_ROOT = 'https://www.googleapis.com/auth/';

export function normaliseScopes(creds) {
  const fromToken = String(creds?.tokens?.scope ?? '').split(/\s+/).filter(Boolean);
  const raw = fromToken.length ? fromToken : (creds?.scopes ?? []);
  return raw.map((s) => (String(s).startsWith('http') ? String(s) : SCOPE_ROOT + s));
}

export async function credentials(vault = process.env.OBLIGATIONS ?? '/obligations',
                                  account = 'gmail') {
  // First directory that actually has both files wins. A half-migrated account
  // — new directory created, credentials not yet copied — must fall through to
  // the working legacy grant rather than resolve to an empty new one.
  let keys = null;
  let creds = null;
  for (const dir of stateDirs(account)) {
    const read = async (name) => {
      try {
        return JSON.parse(await readFile(join(vault, dir, name), 'utf8'));
      } catch {
        return null;   // the error below names the fix; a stack trace would not
      }
    };
    const [k, c] = await Promise.all([read('gcp-oauth.keys.json'), read('credentials.json')]);
    if (k && c) { keys = k; creds = c; break; }
  }
  const client = keys?.installed ?? keys?.web ?? {};

  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    refreshToken: creds?.tokens?.refresh_token,
    // What Google actually GRANTED, from tokens.scope — never the top-level
    // `scopes` array beside it.
    //
    // Those two are not the same thing and, worse, the array is not written in
    // one format: @klodr/gmail-mcp records ["gmail.modify","gmail.send"] while
    // this repo's own auth scripts record full URLs. Obligations-Dev-Mac read the
    // array in the Mac app and both mail accounts reported as having no
    // capabilities while working perfectly, with calendar and drive correct —
    // the worst possible split, because it looks like a mail-specific outage
    // rather than a parsing bug.
    //
    // tokens.scope is what Google returned, always full URLs, and it is what
    // was granted rather than what was asked for. Anything reading capabilities
    // reads this.
    scopes: normaliseScopes(creds),
  };
}

export function forgetToken() {
  cached = null;
}

export async function accessToken(vault, fetchImpl = fetch, account = 'gmail') {
  if (cached && cached.account === account && cached.expiresAt - SKEW_MS > Date.now()) {
    return cached.token;
  }

  const { clientId, clientSecret, refreshToken } = await credentials(vault, account);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `Google is not connected for "${account}". Looked in ` +
      `${stateDirs(account).join(', ')}. Run ${installerFor(account)}, ` +
      'then copy the files up.');
  }

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant is almost always the seven-day Testing-mode expiry, and the
    // raw message ("Token has been expired or revoked.") sends you looking in
    // the wrong place entirely.
    if (body.error === 'invalid_grant') {
      throw new Error(
        'Google refused the refresh token (invalid_grant). Either it was ' +
        'revoked, or the OAuth app is still in Testing mode — Testing tokens ' +
        'expire after 7 days. Publish the app in the Google Cloud console, ' +
        `then re-run ${installerFor(account)}.`);
    }
    throw new Error(`Google token refresh failed (${res.status}): ` +
                    `${body.error ?? ''} ${body.error_description ?? ''}`.trim());
  }

  cached = {
    account,
    token: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return cached.token;
}
