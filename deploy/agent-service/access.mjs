/**
 * Cloudflare Access verification.
 *
 * Access authenticates at Cloudflare's edge and forwards two things to the
 * origin: a convenience header (Cf-Access-Authenticated-User-Email) and a signed
 * JWT (Cf-Access-Jwt-Assertion). Only the second is evidence. The header is
 * plain text that anything able to reach the origin can set, so trusting it is
 * the classic way an "authenticated" service turns out not to be.
 *
 * So: verify the JWT signature against Cloudflare's published keys, check the
 * audience matches this application, check expiry, and take the identity from
 * the verified payload — never from the header.
 *
 * Configured by two env vars, both from the Zero Trust dashboard:
 *   ACCESS_TEAM_DOMAIN   your-team.cloudflareaccess.com
 *   ACCESS_AUD           the Application Audience (AUD) tag of the Access app
 *
 * When REQUIRE_ACCESS=1 and either is missing, the service refuses to start.
 * That is deliberate: a typo in a variable name should not silently downgrade
 * an authenticated deployment into an open one.
 */
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = { at: 0, keys: new Map() };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

function decodeSegment(seg) {
  return JSON.parse(b64urlToBytes(seg).toString('utf8'));
}

async function jwks(teamDomain) {
  if (Date.now() - jwksCache.at < JWKS_TTL_MS && jwksCache.keys.size) return jwksCache.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const { keys } = await res.json();

  const map = new Map();
  for (const jwk of keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    map.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  if (!map.size) throw new Error('JWKS contained no usable RSA keys');
  jwksCache = { at: Date.now(), keys: map };
  return map;
}

/**
 * Returns the verified identity, or throws. Never returns a partial result:
 * every failure path is a throw, so a caller that forgets to check gets an
 * exception rather than an unauthenticated request treated as authenticated.
 */
export async function verifyAccessJwt(token, { teamDomain, aud }) {
  if (!token) throw new Error('no Cf-Access-Jwt-Assertion header');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeSegment(headerB64);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg: ${header.alg}`);

  const keys = await jwks(teamDomain);
  const key = keys.get(header.kid);
  if (!key) throw new Error(`unknown key id: ${header.kid}`);

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(sigB64),
    Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
  );
  if (!ok) throw new Error('signature does not verify');

  const payload = decodeSegment(payloadB64);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('token expired');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('token not yet valid');
  if (payload.iss && payload.iss !== `https://${teamDomain}`) {
    throw new Error(`unexpected issuer: ${payload.iss}`);
  }

  // aud is an array in Access tokens. This is the check that stops a valid
  // token minted for a *different* application in the same Zero Trust account
  // from being accepted here.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) throw new Error('token audience does not match this app');

  return { email: payload.email ?? null, sub: payload.sub ?? null, exp: payload.exp ?? null };
}
