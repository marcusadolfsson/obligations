#!/usr/bin/env node
/**
 * Connect Google Calendar, once. `node deploy/integrations/calendar-auth.mjs`
 *
 * Run it on a machine with a browser — your Mac, not the server — then copy the
 * two files it writes up to linuxbox, exactly like the mail installer.
 *
 * ## Why this is not part of install-gmail.sh
 *
 * That script drives `@klodr/gmail-mcp`'s own `auth` command, which owns
 * `deploy/gmail-state/credentials.json` and asks Google only for the gmail
 * scopes it knows about. Bolting calendar onto that file would mean the MCP
 * server rewriting it on its next auth run and silently dropping the calendar
 * grant — a failure that shows up weeks later as an empty brief.
 *
 * So calendar gets its own grant, in its own directory, from the same OAuth
 * client. One capability per file. Revoking calendar never touches mail.
 *
 * ## Why the flow is written out rather than pulled from a library
 *
 * `googleapis` is a large dependency, and this is the one place a supply-chain
 * problem would be handed a live refresh token. The whole exchange is two HTTP
 * calls, and `google-auth.mjs` already refreshes without an SDK for the same
 * reason.
 *
 * The scope is `calendar.events`: read and write events, on calendars he
 * already has. Not `calendar`, which also grants managing the calendar list and
 * ACLs — reaching other people's diaries. CLAUDE.md allows creating and
 * updating events freely and draws its line at inviting other people, so
 * `calendar.events` is the scope that matches the rule.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = join(OBLIGATIONS, 'deploy', 'calendar-state');
/**
 * `calendar.events` is the capability: view and edit events on all his
 * calendars. It matches CLAUDE.md — create and update freely, the line is
 * inviting other people.
 *
 * `calendar.calendarlist.readonly` is not more capability, it is *discovery*.
 * events.list needs a calendar id, and under events alone the only id we can
 * name is `primary`, so every secondary or shared calendar is invisible. This
 * scope only answers "which calendars are you subscribed to" — read-only, no
 * events, no sharing permissions, no subscribing or unsubscribing. Verified
 * against the Calendar API discovery document: it is the narrowest of the four
 * scopes calendarList.list accepts.
 *
 * Deliberately NOT `calendar` or `calendar.readonly`. Both also work, and both
 * reach far past what is needed.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const note = (s) => console.log(`  ${s}`);

/* ------------------------------------------------------------ the client */

say('1/3  The OAuth client');
note('Reuse the one from Gmail: same Google Cloud project, same Desktop client.');
note('Calendar API must be enabled on that project, and .../auth/calendar.events');
note('must be on its consent screen. If it is not, add it and re-run — the');
note('consent screen decides what is grantable, this decides what is granted.');

const defaultKeys = join(OBLIGATIONS, 'deploy', 'gmail-state', 'gcp-oauth.keys.json');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`  Path to the OAuth client JSON [${defaultKeys}]: `)).trim();
rl.close();

const keysPath = (answer || defaultKeys).replace(/^~/, process.env.HOME ?? '~');
let keys;
try {
  keys = JSON.parse(await readFile(keysPath, 'utf8'));
} catch (e) {
  console.error(`\n  cannot read ${keysPath}: ${e.message}`);
  process.exit(1);
}
const client = keys.installed ?? keys.web ?? {};
if (!client.client_id || !client.client_secret) {
  console.error('\n  that file has no client_id/client_secret — is it the OAuth client JSON?');
  process.exit(1);
}
if (keys.web) {
  note('note: this is a Web client. A Desktop client is simpler; a Web client');
  note('      needs the loopback URL below as an authorised redirect URI.');
}
note(`client: ${client.client_id.slice(0, 24)}...`);

/* ------------------------------------------------------- the browser leg */

// PKCE. Not strictly required for an installed client that has a secret, but a
// client secret in a desktop app is not really secret, and this is what stops a
// local process that observes the redirect from redeeming the code.
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');

// Written out rather than Promise.withResolvers(): that landed in Node 22 and
// the server runs 20. A helper that only works on the newest Node is a helper
// that fails on the one machine it has to run on.
let resolveCode, rejectCode;
const received = {
  promise: new Promise((res, rej) => { resolveCode = res; rejectCode = rej; }),
  resolve: (v) => resolveCode(v),
  reject: (e) => rejectCode(e),
};
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }

  const done = (msg) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset=utf-8>` +
            `<body style="font:16px system-ui;padding:3rem;max-width:32rem">` +
            `<h1>${msg.title}</h1><p>${msg.body}</p></body>`);
  };

  if (url.searchParams.get('state') !== state) {
    done({ title: 'Rejected', body: 'That response did not match this request.' });
    received.reject(new Error('state mismatch — the redirect did not come from this run'));
    return;
  }
  const err = url.searchParams.get('error');
  if (err) {
    done({ title: 'Refused', body: `Google said: ${err}` });
    received.reject(new Error(`Google refused consent: ${err}`));
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) return void done({ title: 'Nothing to do', body: 'No code in that request.' });
  done({ title: 'Connected', body: 'You can close this tab and go back to the terminal.' });
  received.resolve(code);
});

// Port 0: the OS picks a free one and we read it back. A hardcoded port is a
// collision waiting to happen on a laptop, and Desktop clients accept any
// loopback port without pre-registering it.
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const redirect = `http://localhost:${server.address().port}`;

const consent = `${AUTH_URL}?` + new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirect,
  response_type: 'code',
  scope: SCOPES.join(' '),
  // Both are needed for a refresh token: offline asks for one, and consent
  // forces the prompt even when this client was already approved — without it
  // a re-run returns an access token only, and the file it writes is useless
  // an hour later.
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
}).toString();

say('2/3  Approve it in the browser');
note('Sign in as the owner of the calendar you want the assistant to read.');
note('');
note(consent);
note('');
spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [consent],
      { stdio: 'ignore', detached: true }).on('error', () => {
  note('(could not open a browser — paste the URL above)');
}).unref();

const timeout = setTimeout(() => received.reject(new Error('no response within 5 minutes')), 300_000);
let code;
try {
  code = await received.promise;
} catch (e) {
  console.error(`\n  ${e.message}`);
  process.exit(1);
} finally {
  clearTimeout(timeout);
  server.close();
}

/* ------------------------------------------------------- the token leg */

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }).toString(),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\n  token exchange failed (${res.status}): ` +
                `${body.error ?? ''} ${body.error_description ?? ''}`.trim());
  process.exit(1);
}
if (!body.refresh_token) {
  console.error('\n  Google returned no refresh_token, so this grant dies in an hour.');
  console.error('  That happens when the client was already approved and the prompt was');
  console.error('  skipped. Revoke it at https://myaccount.google.com/permissions and re-run.');
  process.exit(1);
}

/* ------------------------------------------------------------ write it out */

// The same shape @klodr/gmail-mcp writes, because deploy/mcp/google-auth.mjs
// reads both through one code path. A second shape would be a second parser.
await mkdir(STATE, { recursive: true });
await chmod(STATE, 0o700);
const credPath = join(STATE, 'credentials.json');
await writeFile(credPath, JSON.stringify({
  tokens: {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    scope: body.scope,
    token_type: body.token_type ?? 'Bearer',
    expiry_date: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  },
  scopes: SCOPES,
}, null, 1) + '\n');
await chmod(credPath, 0o600);

const keysOut = join(STATE, 'gcp-oauth.keys.json');
await writeFile(keysOut, JSON.stringify(keys, null, 1) + '\n');
await chmod(keysOut, 0o600);

say('3/3  Copy it to the server');
console.log(`
  scp ${credPath} linuxbox:obligations/deploy/calendar-state/
  scp ${keysOut} linuxbox:obligations/deploy/calendar-state/

  granted: ${(body.scope ?? '').split(' ').map((s) => s.split('/').pop()).join(', ')}

  deploy/calendar-state/ is gitignored — the refresh token must never reach a
  commit.
`);
