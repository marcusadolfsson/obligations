/**
 * Every test here is a way a stranger makes Alex's phone ring at 03:00.
 *
 * The route this guards is exempt from Cloudflare Access — Google cannot log in
 * — so `verifyPushToken` is the entire authentication for a public endpoint
 * whose effect is a push notification. Mirrors access.test.mjs's attack set,
 * because the same mistakes are available in both places.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifyPushToken, _setKeys } from './oidc.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const AUD = 'https://hook.example.com/hooks/gmail';
const SA = 'gmail-push@obligations-rivera.iam.gserviceaccount.com';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Import the public half the way the module would from Google's certs. */
const jwk = publicKey.export({ format: 'jwk' });
const imported = await crypto.subtle.importKey(
  'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
  { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
_setKeys(new Map([['k1', imported]]));

const now = () => Math.floor(Date.now() / 1000);

function token({ header = {}, payload = {}, key = privateKey, tamper = false } = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const p = b64({
    iss: 'https://accounts.google.com',
    aud: AUD,
    email: SA,
    email_verified: true,
    exp: now() + 600,
    iat: now(),
    ...payload,
  });
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).end().sign(key).toString('base64url');
  return `${h}.${p}.${tamper ? sig.slice(0, -4) + 'AAAA' : sig}`;
}

const refused = async (what, t, opts = {}) => {
  try {
    await verifyPushToken(t, { aud: AUD, serviceAccount: SA, ...opts });
    check(what, false, 'ACCEPTED — this is a way in');
  } catch (e) {
    check(what, true);
    return e.message;
  }
};

console.log('The happy path, so the rest means something');
{
  const payload = await verifyPushToken(token(), { aud: AUD, serviceAccount: SA });
  check('a genuine Google push token verifies', payload.email === SA);
}

console.log('\nForged and malformed tokens');
await refused('alg: none is refused', token({ header: { alg: 'none' } }));
await refused('alg: HS256 (algorithm confusion) is refused',
              token({ header: { alg: 'HS256' } }));
await refused('a token signed with the wrong key is refused', token({ key: otherKey }));
await refused('a tampered signature is refused', token({ tamper: true }));
await refused('an unknown key id is refused', token({ header: { kid: 'nope' } }));
await refused('a malformed token is refused', 'not.a.jwt.at.all');
await refused('an empty token is refused', '');
await refused('a missing token is refused', undefined);

console.log('\nValid Google signatures that are still not for us');
{
  // The important one. Google signs tokens for millions of services; without
  // the audience check, any of them replayed here would be accepted.
  const m = await refused('a token minted for another audience is refused',
                          token({ payload: { aud: 'https://someone-else.example' } }));
  check('  ...and says it was the audience', /audience/.test(m ?? ''), m);

  const s = await refused('a token for a different service account is refused',
                          token({ payload: { email: 'someone@else.iam.gserviceaccount.com' } }));
  check('  ...and names the account it saw', /service account/.test(s ?? ''), s);

  await refused('an unverified email is refused',
                token({ payload: { email_verified: false } }));
  await refused('a missing email_verified is refused',
                token({ payload: { email_verified: undefined } }));
  await refused('a token from another issuer is refused',
                token({ payload: { iss: 'https://evil.example' } }));
}

console.log('\nBoth issuer spellings are real and both must work');
{
  const p = await verifyPushToken(token({ payload: { iss: 'accounts.google.com' } }),
                                  { aud: AUD, serviceAccount: SA });
  check('the bare accounts.google.com issuer is accepted', p.email === SA);
}

console.log('\nSeveral service accounts, one per GCP project');
{
  // Not a loosening. Gmail requires a watch topic to be in the OAuth client's
  // own project, so a second mailbox in a second project pushes as a service
  // account in THAT project. Each is still matched exactly.
  const OTHER = 'gmail-push@obligations-123456.iam.gserviceaccount.com';
  const both = `${SA}, ${OTHER}`;

  let p = await verifyPushToken(token(), { aud: AUD, serviceAccount: both });
  check('the first listed account verifies', p.email === SA);

  p = await verifyPushToken(token({ payload: { email: OTHER } }),
                            { aud: AUD, serviceAccount: both });
  check('the second does too', p.email === OTHER);

  await refused('one not on the list is still refused',
                token({ payload: { email: 'someone@else.iam.gserviceaccount.com' } }),
                { serviceAccount: both });
}

console.log('\nTime');
await refused('an expired token is refused', token({ payload: { exp: now() - 120 } }));
await refused('a token with no exp at all is refused',
              token({ payload: { exp: undefined } }));
await refused('a token not yet valid is refused', token({ payload: { nbf: now() + 600 } }));
{
  // Pub/Sub retries for days after an outage; a token a few seconds past
  // expiry against a drifting clock is not an attack.
  const p = await verifyPushToken(token({ payload: { exp: now() - 5 } }),
                                  { aud: AUD, serviceAccount: SA });
  check('a token seconds past expiry is allowed for clock skew', p.email === SA);
}

console.log('\nMisconfiguration must fail closed, not open');
{
  // The dangerous shape: a missing expectation silently disabling its check
  // would leave the endpoint accepting any Google-signed token in existence.
  const a = await refused('no expected audience configured refuses everything',
                          token(), { aud: undefined });
  check('  ...and says which expectation is missing', /audience/.test(a ?? ''), a);
  await refused('no expected service account configured refuses everything',
                token(), { serviceAccount: undefined });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
