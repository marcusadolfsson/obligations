/**
 * Verify the Google-signed OIDC token on a Pub/Sub push.
 *
 * Structurally `access.mjs` with different constants, and deliberately so: that
 * file is the one piece of this system that has been attacked in tests from
 * every angle, and a second verifier written from scratch would be a second
 * chance to get `alg=none` wrong.
 *
 * ## What this is actually defending
 *
 * The route it guards is exempt from Cloudflare Access — it has to be, because
 * Google cannot log in. So this function *is* the authentication for an
 * endpoint on the public internet whose effect is to make Alex's phone buzz.
 * Everything that reaches the classifier has passed through here first.
 *
 * ## Every check earns its place
 *
 * - **alg** must be RS256. `alg: none` is the oldest JWT attack and the cheapest
 *   to be wrong about; an unrecognised alg is refused rather than skipped.
 * - **signature** against Google's published keys. Nothing else proves origin.
 * - **iss** must be Google. A validly-signed token from another issuer is a
 *   token someone else's identity provider minted.
 * - **aud** must be the audience configured on the subscription. This is what
 *   stops a token minted for *any other* Google-integrated service — of which
 *   there are millions — being replayed here. Without it, "signed by Google" is
 *   a near-worthless assertion.
 * - **email** must be the service account on the subscription, and
 *   **email_verified** must be true. `aud` says who the token was for; this says
 *   who it was about.
 * - **exp/nbf** with a small skew. Pub/Sub retries for days after an outage.
 *
 * ## Failing is throwing
 *
 * Every path either returns a verified claim set or throws. There is no
 * partial result and no boolean, so a caller that forgets to check gets an
 * exception rather than an unauthenticated request treated as authenticated.
 */

/** Google's OIDC signing keys. */
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * Both spellings are legitimate and Google uses each in different products, so
 * accepting only one would reject real tokens intermittently — the worst kind
 * of bug to diagnose in a push endpoint.
 */
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const JWKS_TTL_MS = 60 * 60 * 1000;
/** Clocks drift. Sixty seconds is the same allowance access.mjs makes. */
const SKEW_S = 60;

let jwksCache = { at: 0, keys: new Map() };

/** Test seam only. Never called in production; see oidc.test.mjs. */
export function _setKeys(map, at = Date.now()) {
  jwksCache = { at, keys: map };
}

function b64urlToBytes(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeSegment(seg) {
  return JSON.parse(b64urlToBytes(seg).toString('utf8'));
}

async function jwks(fetchImpl = fetch) {
  if (Date.now() - jwksCache.at < JWKS_TTL_MS && jwksCache.keys.size) return jwksCache.keys;

  const res = await fetchImpl(CERTS_URL);
  if (!res.ok) throw new Error(`Google certs fetch failed: HTTP ${res.status}`);
  const { keys } = await res.json();

  const map = new Map();
  for (const jwk of keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    map.set(jwk.kid, await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    ));
  }
  if (!map.size) throw new Error('Google certs contained no usable RSA keys');
  jwksCache = { at: Date.now(), keys: map };
  return map;
}

/**
 * @param token            the bearer token from the Authorization header
 * @param opts.aud         the audience configured on the push subscription
 * @param opts.serviceAccount  the service account(s) the subscription pushes
 *   as — one email, or several separated by commas. Several is not a
 *   loosening: Gmail requires a watch topic to live in the OAuth client's own
 *   project, so a second mailbox in a second GCP project necessarily pushes as
 *   a service account in that project. Each is still matched exactly.
 * @returns the verified payload
 */
export async function verifyPushToken(token, { aud, serviceAccount, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('no bearer token');
  // Refusing to run without them, rather than skipping the check, is the
  // difference between a misconfiguration and an open endpoint. A missing
  // `aud` that silently disabled the audience check would leave the route
  // accepting any Google-signed token in existence.
  if (!aud) throw new Error('no expected audience configured');
  if (!serviceAccount) throw new Error('no expected service account configured');

  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeSegment(headerB64);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg: ${header.alg}`);

  const keys = await jwks(fetchImpl);
  const key = keys.get(header.kid);
  if (!key) throw new Error(`unknown key id: ${header.kid}`);

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64urlToBytes(sigB64),
    Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
  );
  if (!ok) throw new Error('signature does not verify');

  const payload = decodeSegment(payloadB64);
  const now = Math.floor(Date.now() / 1000);

  if (!payload.exp || payload.exp + SKEW_S < now) throw new Error('token expired');
  if (payload.nbf && payload.nbf > now + SKEW_S) throw new Error('token not yet valid');
  if (!ISSUERS.has(payload.iss)) throw new Error(`unexpected issuer: ${payload.iss}`);

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) throw new Error('token audience does not match this endpoint');

  const accepted = String(serviceAccount).split(',')
    .map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!accepted.includes(String(payload.email ?? '').toLowerCase())) {
    throw new Error(`unexpected service account: ${payload.email}`);
  }
  // A Google-signed token whose email is unverified says nothing about who sent
  // it. Checked explicitly because the field is easy to read past.
  if (payload.email_verified !== true) throw new Error('email is not verified');

  return payload;
}
