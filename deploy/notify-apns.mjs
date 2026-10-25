#!/usr/bin/env node
/**
 * Push to his phone, iPad and Mac through APNs — the sender behind notify.py's
 * "apns" channel.
 *
 * Alex, 2026-09-05: an iOS/iPadOS/macOS app that wraps the web UI "with push
 * notification support." notify.py said from the start that adding APNs meant
 * one more `_send_*` function and no call-site changes; this is the function's
 * other half, in Node because APNs is HTTP/2 and the Python here is stdlib-only.
 *
 * Reads ONE JSON document on stdin — never argv, never the environment — and
 * prints one JSON result:
 *
 *   in : { cfg: { APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY_FILE, APNS_ENV },
 *          devices: [{ token, env }], message: { title, body, priority, tag, meta: { kind, url, id } } }
 *   out: { ok, sent: [token], failed: [{ token, status, reason }], stale: [token] }
 *
 * `stale` is a token APNs said is gone (410, or 400 BadDeviceToken); the caller
 * retires it. `ok` is true if at least one device took the push.
 *
 * Token-based auth: an ES256 JWT from the .p8, valid an hour, one per process —
 * the dispatcher runs this once per push, so there is nothing to cache.
 */
import { readFileSync } from 'node:fs';
import { createSign, createPrivateKey } from 'node:crypto';
import { connect } from 'node:http2';

const b64u = (x) => Buffer.from(x).toString('base64url');

/** The provider token APNs wants: ES256 over {iss: team, iat}, kid in the header. Exported for the tests. */
export function apnsJwt(keyPem, keyId, teamId, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64u(JSON.stringify({ iss: teamId, iat: nowSec }));
  const key = createPrivateKey(keyPem);
  // Node signs ES256 as DER by default; APNs wants the raw r||s (IEEE P1363) form.
  const sig = createSign('SHA256').update(`${header}.${claims}`).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(sig)}`;
}

export const hostFor = (env) => (String(env ?? '').toLowerCase() === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');

/** The notification, in the shape the app was told to expect. Exported for the tests. */
export function payload({ title, body, priority = 'default', tag = null, meta = {} } = {}) {
  const level = priority === 'high' ? 'time-sensitive' : 'active';
  const kind = meta?.kind ?? tag ?? 'note';
  return {
    aps: {
      alert: { title: String(title ?? 'Obligations'), body: String(body ?? '') },
      sound: 'default',
      'interruption-level': level,
      'thread-id': kind,
    },
    obligations: { kind, url: meta?.url ?? '/', id: meta?.id ?? null },
  };
}

function pushOne(client, { token, bundle, jwt, body, priority, kind }) {
  return new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`, 'apns-topic': bundle, 'apns-push-type': 'alert',
      'apns-priority': priority === 'high' ? '10' : '5', 'apns-collapse-id': kind.slice(0, 64),
      'content-type': 'application/json',
    });
    let status = 0, text = '';
    req.on('response', (h) => { status = Number(h[':status'] ?? 0); });
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      let reason = null; try { reason = JSON.parse(text).reason ?? null; } catch {}
      resolve({ token, status, reason });
    });
    req.on('error', (e) => resolve({ token, status: 0, reason: e.message }));
    req.setTimeout(10000, () => { req.close(); resolve({ token, status: 0, reason: 'timeout' }); });
    req.end(JSON.stringify(body));
  });
}

export async function sendAll({ cfg, devices, message }) {
  const out = { ok: false, sent: [], failed: [], stale: [] };
  const need = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'].filter((k) => !cfg?.[k]);
  if (need.length) { out.failed.push({ token: null, status: 0, reason: `missing in notify.env: ${need.join(', ')}` }); return out; }
  let keyPem;
  try { keyPem = readFileSync(cfg.APNS_KEY_FILE || `deploy/apns/AuthKey_${cfg.APNS_KEY_ID}.p8`, 'utf8'); }
  catch (e) { out.failed.push({ token: null, status: 0, reason: `key file: ${e.message}` }); return out; }
  const jwt = apnsJwt(keyPem, cfg.APNS_KEY_ID, cfg.APNS_TEAM_ID);
  const body = payload(message);
  const kind = body.aps['thread-id'];
  // One connection per environment; a device says which it was built for.
  const byEnv = new Map();
  for (const d of devices ?? []) {
    if (!d?.token) continue;
    const env = d.env || cfg.APNS_ENV || 'sandbox';
    if (!byEnv.has(env)) byEnv.set(env, []);
    byEnv.get(env).push(d.token);
  }
  for (const [env, tokens] of byEnv) {
    const client = connect(hostFor(env));
    const err = await new Promise((r) => { client.once('connect', () => r(null)); client.once('error', (e) => r(e)); });
    if (err) { for (const t of tokens) out.failed.push({ token: t, status: 0, reason: `connect: ${err.message}` }); continue; }
    for (const token of tokens) {
      const r = await pushOne(client, { token, bundle: cfg.APNS_BUNDLE_ID, jwt, body, priority: message?.priority, kind });
      if (r.status === 200) out.sent.push(token);
      else if (r.status === 410 || (r.status === 400 && r.reason === 'BadDeviceToken')) out.stale.push(token);
      else out.failed.push(r);
    }
    client.close();
  }
  out.ok = out.sent.length > 0;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) text += c;
  let input;
  try { input = JSON.parse(text || '{}'); } catch (e) { console.log(JSON.stringify({ ok: false, sent: [], failed: [{ token: null, status: 0, reason: `bad input: ${e.message}` }], stale: [] })); process.exit(0); }
  const r = await sendAll(input);
  await new Promise((done) => process.stdout.write(JSON.stringify(r) + '\n', done));
  process.exit(0);
}
