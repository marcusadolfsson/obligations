/**
 * The devices that take a push: integrations/devices.json.
 *
 * Written only by the app, through POST /api/devices with the signed-in
 * identity on the request; the agent reads it and never adds to it (it would
 * be adding a place its own pushes go). A token is retired when APNs says it
 * is gone, never deleted — the record of which phone was registered when is
 * worth keeping, and the file is small.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { localStamp } from './time.mjs';

const FILE = (vault) => join(vault, 'integrations', 'devices.json');
const PLATFORMS = ['ios', 'ipados', 'macos'];
const ENVS = ['sandbox', 'production'];

export async function listDevices(vault) {
  try { const d = JSON.parse(await readFile(FILE(vault), 'utf8')); return Array.isArray(d.devices) ? d.devices : []; }
  catch { return []; }
}
const save = async (vault, devices) => {
  await mkdir(dirname(FILE(vault)), { recursive: true });
  await writeFile(FILE(vault), JSON.stringify({ devices }, null, 1) + '\n');
};

/** Active tokens, for the sender. */
export const activeDevices = async (vault) => (await listDevices(vault)).filter((d) => !d.stale_at);

export async function registerDevice(vault, { token, platform, bundle, env = 'sandbox', name = null }, who) {
  if (!who) throw new Error('registering a device needs the signed-in identity');
  if (!/^[0-9a-f]{32,200}$/i.test(String(token ?? ''))) throw new Error('token must be the hex APNs device token');
  if (!PLATFORMS.includes(platform)) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}`);
  if (!/^[a-z0-9.-]+$/i.test(String(bundle ?? ''))) throw new Error('bundle id is required');
  if (!ENVS.includes(env)) throw new Error(`env must be one of ${ENVS.join(', ')}`);
  const devices = await listDevices(vault);
  const stamp = localStamp(), ms = Date.now();
  const cur = devices.find((d) => d.token === token);
  if (cur) {
    Object.assign(cur, { platform, bundle, env, name: name ?? cur.name ?? null, who, last_seen: stamp, last_seen_ms: ms, stale_at: null });
  } else {
    devices.push({ token, platform, bundle, env, name, who, registered_at: stamp, registered_at_ms: ms, last_seen: stamp, last_seen_ms: ms, stale_at: null });
  }
  await save(vault, devices);
  return { token, platform, env, registered: !cur, count: devices.filter((d) => !d.stale_at).length };
}

export async function removeDevice(vault, token) {
  const devices = await listDevices(vault);
  const cur = devices.find((d) => d.token === token);
  if (!cur) return { token, removed: false };
  cur.stale_at = localStamp(); cur.stale_reason = 'unregistered by the app';
  await save(vault, devices);
  return { token, removed: true };
}

/** APNs said these tokens are gone. Called by notify.py's channel via the CLI below. */
export async function retireDevices(vault, tokens, reason = 'APNs: gone') {
  const devices = await listDevices(vault);
  let n = 0;
  for (const d of devices) if (tokens.includes(d.token) && !d.stale_at) { d.stale_at = localStamp(); d.stale_reason = reason; n++; }
  if (n) await save(vault, devices);
  return n;
}
