/**
 * Push to the apps: the APNs sender's token and payload (no network), and the
 * device registry the app writes through /api/devices.
 */
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apnsJwt, payload, hostFor, sendAll } from '../notify-apns.mjs';
import { registerDevice, removeDevice, retireDevices, listDevices, activeDevices } from './devices.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

console.log('APNs provider token');
{
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = apnsJwt(pem, 'KEY123', 'TEAM456', 1757100000);
  const [h, c, sig] = jwt.split('.');
  check('header names ES256 and the key id', dec(h).alg === 'ES256' && dec(h).kid === 'KEY123', h);
  check('claims carry the team and iat', dec(c).iss === 'TEAM456' && dec(c).iat === 1757100000, c);
  const ok = createVerify('SHA256').update(`${h}.${c}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  check('the signature verifies as raw r||s, which is what Apple checks', ok);
  check('the raw signature is 64 bytes', Buffer.from(sig, 'base64url').length === 64);
}

console.log('\npayload — the shape the app was told to expect');
{
  const p = payload({ title: 'Evening brief', body: '3 due, 1 waiting', priority: 'default', meta: { kind: 'brief', url: '/briefs#pane=x.md', id: 'x.md' } });
  check('aps.alert title/body', p.aps.alert.title === 'Evening brief' && p.aps.alert.body === '3 due, 1 waiting');
  check('default priority is active; thread-id is the kind', p.aps['interruption-level'] === 'active' && p.aps['thread-id'] === 'brief');
  check('obligations.url and id ride along', p.obligations.url === '/briefs#pane=x.md' && p.obligations.id === 'x.md' && p.obligations.kind === 'brief');
  const hi = payload({ title: 'Reminder', body: 'x', priority: 'high', meta: { kind: 'reminder', url: '/todo' } });
  check('high priority is time-sensitive, never critical', hi.aps['interruption-level'] === 'time-sensitive');
  check('no meta still yields a url', payload({ title: 't', body: 'b' }).obligations.url === '/');
  check('sandbox by default, production only when named', hostFor(undefined).includes('sandbox') && hostFor('production') === 'https://api.push.apple.com');
}

console.log('\nsendAll — refuses before the network when unconfigured');
{
  const r = await sendAll({ cfg: { APNS_KEY_ID: 'k' }, devices: [{ token: 'ab'.repeat(32) }], message: { title: 't', body: 'b' } });
  check('missing config is named, nothing sent', !r.ok && r.sent.length === 0 && /missing in notify.env: APNS_TEAM_ID, APNS_BUNDLE_ID/.test(r.failed[0]?.reason ?? ''), JSON.stringify(r));
  const r2 = await sendAll({ cfg: { APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_BUNDLE_ID: 'b', APNS_KEY_FILE: '/nonexistent/AuthKey.p8' }, devices: [{ token: 'ab'.repeat(32) }], message: { title: 't', body: 'b' } });
  check('a missing key file is named, nothing sent', !r2.ok && /key file/.test(r2.failed[0]?.reason ?? ''), JSON.stringify(r2));
}

console.log('\ndevices — the registry the app writes');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  const tok = 'ab'.repeat(32);
  let err = null; try { await registerDevice(vault, { token: tok, platform: 'ios', bundle: 'com.example.obligations' }, null); } catch (e) { err = e; }
  check('no identity, no registration', /signed-in identity/.test(err?.message ?? ''));
  err = null; try { await registerDevice(vault, { token: 'not-hex!', platform: 'ios', bundle: 'com.example.obligations' }, 'm@x'); } catch (e) { err = e; }
  check('token must be hex', /hex APNs device token/.test(err?.message ?? ''));
  err = null; try { await registerDevice(vault, { token: tok, platform: 'android', bundle: 'com.example.obligations' }, 'm@x'); } catch (e) { err = e; }
  check('platform is one of three', /platform must be/.test(err?.message ?? ''));
  const r = await registerDevice(vault, { token: tok, platform: 'ios', bundle: 'com.example.obligations', env: 'sandbox', name: 'iPhone' }, 'alex@rivera.example');
  check('first registration counts one active device', r.registered && r.count === 1);
  const again = await registerDevice(vault, { token: tok, platform: 'ios', bundle: 'com.example.obligations', env: 'production' }, 'alex@rivera.example');
  check('re-POST is idempotent and updates env', !again.registered && again.count === 1 && (await listDevices(vault))[0].env === 'production');
  const d = (await listDevices(vault))[0];
  check('stamps have epoch siblings (wall-clock rule)', typeof d.registered_at_ms === 'number' && typeof d.last_seen_ms === 'number' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d.registered_at));
  check('the file is under integrations/', JSON.parse(await readFile(join(vault, 'integrations', 'devices.json'), 'utf8')).devices.length === 1);
  await retireDevices(vault, [tok], 'APNs: gone');
  check('a retired token is kept, not deleted, and is no longer active', (await listDevices(vault)).length === 1 && (await activeDevices(vault)).length === 0);
  const back = await registerDevice(vault, { token: tok, platform: 'ios', bundle: 'com.example.obligations' }, 'alex@rivera.example');
  check('re-registering a retired token revives it', (await activeDevices(vault)).length === 1 && !back.registered);
  check('remove marks stale with a reason', (await removeDevice(vault, tok)).removed && /unregistered/.test((await listDevices(vault))[0].stale_reason));
  check('removing an unknown token is a no-op', !(await removeDevice(vault, 'cd'.repeat(32))).removed);
  await rm(vault, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
