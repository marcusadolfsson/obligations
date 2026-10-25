#!/usr/bin/env node
/**
 * Connect a Google account, and choose what it may do.
 *
 *   node deploy/integrations/google-auth-cli.mjs --account=personal --enable=mail,calendar,drive
 *   node deploy/integrations/google-auth-cli.mjs --account=work --enable=mail
 *   node deploy/integrations/google-auth-cli.mjs --account=personal --enable=drive   # add one later
 *
 * Run it on a machine with a browser, then copy the two files it writes up.
 * Replaces calendar-auth.mjs and drive-auth.mjs, which were the same flow three
 * times over with one scope hardcoded into each.
 *
 * ## One grant per account, capabilities inside it
 *
 * The old layout keyed grants by capability, so there could be many mailboxes
 * but exactly one calendar and exactly one Drive — the capability was the
 * identity, and a second one of anything had nowhere to live. Here the account
 * is the identity and a capability is a scope in its token.
 *
 * ## Adding a capability does not drop the others
 *
 * `--enable=drive` on an account that already has mail asks Google for drive
 * *and* passes `include_granted_scopes=true`, so the token comes back carrying
 * both. That is Google's incremental authorisation, and it is why "enable them
 * independently or all together" is one mechanism rather than two.
 *
 * Without that flag the new token would carry only the scope just asked for,
 * and mail would stop working the moment Drive was added — the kind of failure
 * that looks like the new feature breaking the old one.
 *
 * ## The scopes, and the ones deliberately absent
 *
 * mail      gmail.modify + gmail.send. Read, file, archive, and send — sending
 *           still asks Alex in chat and is refused in scheduled jobs.
 * calendar  calendar.events + calendar.calendarlist.readonly. Events on his own
 *           calendars, plus the ability to know which calendars exist.
 * drive     drive.file. Create files and see only files this app created.
 *
 * NEVER offered, whatever is asked for: `gmail.settings.basic` creates filters,
 * which are standing rules that keep acting after a session ends;
 * `gmail.labels` would put a second classifier over mail Superhuman already
 * files; `calendar` and `drive` in their full forms reach everything he owns
 * when the narrow ones do the job.
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

const SCOPES = {
  mail: ['https://www.googleapis.com/auth/gmail.modify',
         'https://www.googleapis.com/auth/gmail.send'],
  calendar: ['https://www.googleapis.com/auth/calendar.events',
             'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
  drive: ['https://www.googleapis.com/auth/drive.file'],
};

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const note = (s) => console.log(`  ${s}`);

/* ------------------------------------------------------------- arguments */

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; }));

const account = String(args.account ?? '').trim();
if (!/^[a-z][a-z0-9_-]*$/.test(account)) {
  console.error('usage: --account=<slug> --enable=mail,calendar,drive');
  console.error('  slug: lowercase, starts with a letter. It names the directory');
  console.error('  and is how every script refers to this account. Use who it IS');
  console.error('  (personal, work), never what it does — that was the old mistake.');
  process.exit(2);
}

const wanted = String(args.enable ?? 'mail').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Capability-keyed grants this account replaces — `--supersedes=gmail,calendar,drive`.
 *
 * Declared rather than inferred. Once `deploy/google/personal` exists, the old
 * `deploy/gmail-state` is the same mailbox under another name, and listing both
 * makes one inbox appear as two accounts: the extractor pulls it twice and the
 * duplicate reads as real volume. Inferring the overlap would mean matching
 * identities across separate tokens, and a drive.file grant cannot tell you
 * whose it is — so the person doing the migration says so, once.
 */
const supersedes = String(args.supersedes ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const unknown = wanted.filter((w) => !SCOPES[w]);
if (unknown.length) {
  console.error(`unknown capability: ${unknown.join(', ')}. Known: ${Object.keys(SCOPES).join(', ')}`);
  process.exit(2);
}

const STATE = join(OBLIGATIONS, 'deploy', 'google', account);
const scopes = [...new Set(wanted.flatMap((w) => SCOPES[w]))];

/* ------------------------------------------------------------ the client */

say(`1/3  The OAuth client for "${account}"`);
note('The Google Cloud project must have the APIs enabled for what you are');
note('enabling, and the consent screen must list those scopes. This grants what');
note('the screen offers; it cannot grant what it does not.');
note('');
note('An account on a DIFFERENT Workspace tenant needs its own project and its');
note('own client — an Internal app cannot consent a user outside its own org.');

const existingKeys = join(STATE, 'gcp-oauth.keys.json');
const fallback = join(OBLIGATIONS, 'deploy', 'gmail-state', 'gcp-oauth.keys.json');
let defaultKeys = fallback;
try { await readFile(existingKeys, 'utf8'); defaultKeys = existingKeys; } catch { /* first time */ }

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
note(`client: ${client.client_id.slice(0, 24)}...`);

// What this account already has, so the request can say "keep those too".
let already = [];
try {
  const prev = JSON.parse(await readFile(join(STATE, 'credentials.json'), 'utf8'));
  already = String(prev?.tokens?.scope ?? '').split(/\s+/).filter(Boolean);
} catch { /* first grant for this account */ }
if (already.length) {
  note('');
  note(`already granted: ${already.map((s) => s.split('/').pop()).join(', ')}`);
  note('Those are kept — Google is asked to include previously granted scopes.');
}

/* -------------------------------------------------------- the browser leg */

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(Buffer.from(verifier)).digest('base64url');
const stateToken = randomBytes(16).toString('base64url');

let resolveCode, rejectCode;
const received = {
  promise: new Promise((res, rej) => { resolveCode = res; rejectCode = rej; }),
  resolve: (v) => resolveCode(v),
  reject: (e) => rejectCode(e),
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  const done = (title, body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem;max-width:32rem">`
          + `<h1>${title}</h1><p>${body}</p></body>`);
  };
  if (url.searchParams.get('state') !== stateToken) {
    done('Rejected', 'That response did not match this request.');
    return received.reject(new Error('state mismatch — the redirect did not come from this run'));
  }
  const err = url.searchParams.get('error');
  if (err) {
    done('Refused', `Google said: ${err}`);
    return received.reject(new Error(`Google refused consent: ${err}`));
  }
  const code = url.searchParams.get('code');
  if (!code) return void done('Nothing to do', 'No code in that request.');
  done('Connected', 'You can close this tab and go back to the terminal.');
  received.resolve(code);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const redirect = `http://localhost:${server.address().port}`;

const consent = `${AUTH_URL}?` + new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: redirect,
  response_type: 'code',
  scope: scopes.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  // The line that makes "enable them independently" work. Without it the new
  // token carries only what was just asked for, and adding Drive would silently
  // revoke mail.
  include_granted_scopes: 'true',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: stateToken,
}).toString();

say('2/3  Approve it in the browser');
note(`Sign in as the account you are calling "${account}".`);
note(`Enabling: ${wanted.join(', ')}`);
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

/* --------------------------------------------------------- the token leg */

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
  console.error(`\n  token exchange failed (${res.status}): `
              + `${body.error ?? ''} ${body.error_description ?? ''}`.trim());
  process.exit(1);
}
if (!body.refresh_token) {
  console.error('\n  Google returned no refresh_token, so this grant dies in an hour.');
  console.error('  Revoke at https://myaccount.google.com/permissions and re-run.');
  process.exit(1);
}

const granted = String(body.scope ?? scopes.join(' ')).split(/\s+/).filter(Boolean);
const missing = scopes.filter((s) => !granted.includes(s));

/**
 * Which Google account this actually turned out to be.
 *
 * Asked after the exchange, because the slug is a label chosen before anyone
 * knows the answer — Obligations-Dev-Mac's point, and a fair one: a typo makes a
 * second account for one identity and nothing notices. Recording the address
 * means a duplicate is at least visible afterwards.
 *
 * Only mail and calendar grants can answer. A drive.file token cannot say whose
 * Drive it is, which is the scope working correctly.
 */
let address = null;
if (granted.some((x) => x.includes('gmail'))) {
  address = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',
                        { headers: { Authorization: `Bearer ${body.access_token}` } })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.emailAddress ?? null).catch(() => null);
} else if (granted.some((x) => x.includes('calendar'))) {
  address = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary',
                        { headers: { Authorization: `Bearer ${body.access_token}` } })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.id ?? null).catch(() => null);
}

await mkdir(STATE, { recursive: true });
await chmod(STATE, 0o700);

// Same shape @klodr/gmail-mcp writes and deploy/mcp/google-auth.mjs reads. One
// shape, one parser: a second would be a second thing to keep in step.
const credPath = join(STATE, 'credentials.json');
await writeFile(credPath, JSON.stringify({
  tokens: {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    scope: granted.join(' '),
    token_type: body.token_type ?? 'Bearer',
    expiry_date: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  },
  scopes: granted,
  account,
  ...(supersedes.length ? { supersedes } : {}),
  ...(address ? { address } : {}),
}, null, 1) + '\n');
await chmod(credPath, 0o600);

const keysOut = join(STATE, 'gcp-oauth.keys.json');
await writeFile(keysOut, JSON.stringify(keys, null, 1) + '\n');
await chmod(keysOut, 0o600);

say('3/3  Copy it to the server');
console.log(`
  scp ${credPath} linuxbox:obligations/deploy/google/${account}/
  scp ${keysOut} linuxbox:obligations/deploy/google/${account}/

  granted: ${granted.map((s) => s.split('/').pop()).join(', ')}${address ? `\n  account:  ${address}` : ''}
`);
if (!supersedes.length) {
  console.log(`  If this replaces capability-keyed grants, say so once — otherwise one`);
  console.log(`  mailbox is listed as two accounts and gets extracted twice:`);
  console.log(`      --account=${account} --enable=${wanted.join(',')} --supersedes=gmail,calendar,drive\n`);
}
if (missing.length) {
  console.log(`  NOT granted, though asked for: ${missing.map((s) => s.split('/').pop()).join(', ')}`);
  console.log('  Those scopes are missing from the consent screen, or were declined.\n');
}
console.log('  deploy/google/ is gitignored — refresh tokens must never reach a commit.\n');
