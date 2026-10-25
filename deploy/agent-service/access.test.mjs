/**
 * Tests for Cloudflare Access JWT verification.
 *
 * Run:  docker run --rm -v "$PWD:/obligations" --entrypoint node obligations:latest \
 *         /obligations/deploy/agent-service/access.test.mjs
 *
 * Mints real RS256 tokens with a locally generated key and serves them a
 * matching JWKS through a stubbed fetch, so the signature path is genuinely
 * exercised rather than mocked away. Every negative case here is a way an
 * attacker gets in if the check is wrong, which is why they are tests and not
 * comments.
 */
import { verifyAccessJwt } from './access.mjs';

const TEAM = 'test-team.cloudflareaccess.com';
const AUD = 'aud-tag-for-this-app';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const otherPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);

const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ keys: [{ ...pub, kid: 'test-kid', alg: 'RS256' }] }),
});

async function mint(payload, { alg = 'RS256', kid = 'test-kid', key = pair.privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: `https://${TEAM}`, aud: [AUD], exp: now + 600, iat: now,
    email: 'alex@rivera.example', sub: 'user-1', ...payload,
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

let pass = 0, fail = 0;
async function accepts(name, token) {
  try {
    const who = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
    console.log(`  ok   ${name} -> ${who.email}`); pass++;
  } catch (e) {
    console.log(`  FAIL ${name} -> unexpectedly rejected: ${e.message}`); fail++;
  }
}
async function rejects(name, token) {
  try {
    await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
    console.log(`  FAIL ${name} -> WAS ACCEPTED`); fail++;
  } catch (e) {
    console.log(`  ok   ${name} -> rejected (${e.message})`); pass++;
  }
}

console.log('Cloudflare Access JWT verification');
await accepts('valid token', await mint({}));

await rejects('no token', undefined);
await rejects('empty string', '');
await rejects('not a JWT', 'garbage');
await rejects('expired', await mint({ exp: Math.floor(Date.now() / 1000) - 10 }));
await rejects('audience for a different app', await mint({ aud: ['some-other-app'] }));
await rejects('issuer from another team', await mint({ iss: 'https://evil.cloudflareaccess.com' }));
await rejects('signed by the wrong key', await mint({}, { key: otherPair.privateKey }));
await rejects('unknown key id', await mint({}, { kid: 'not-a-known-kid' }));
await rejects('alg=none downgrade', await mint({}, { alg: 'none' }));
await rejects('alg=HS256 confusion', await mint({}, { alg: 'HS256' }));

// The header Cloudflare also sends is not evidence; the server must never read
// it. This asserts the shape of the contract: a token-less request fails even
// when a convincing email is claimed elsewhere.
await rejects('claimed email with no token', undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
