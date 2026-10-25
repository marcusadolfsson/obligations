#!/usr/bin/env node
/**
 * Put a vendor on his autopay list, from chat. The page's "On autopay" button
 * is the other door; both write integrations/autopay.json through
 * agent-service/autopay.mjs and close the open bills it now covers.
 *
 *   node deploy/autopay.mjs <address | @domain> [--account 5464] [--name "Power Co"] --why "what he said"
 *   node deploy/autopay.mjs --list
 *
 * His list, like the ignore list: a job never adds to it (not on the allow
 * list). Alex, 2026-09-30: "I only want to be a task if autopay fails. How
 * can we make that systematic so we can apply to other vendors too."
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAutopay, closeCovered, readAutopay } from './agent-service/autopay.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] ?? null : null; };

if (argv.includes('--list')) {
  const v = await readAutopay(OBLIGATIONS);
  const keys = Object.keys(v);
  if (!keys.length) console.log('nothing on the autopay list yet.');
  for (const k of keys) console.log(`${k}${v[k].accounts ? `  accounts ${v[k].accounts.join(', ')}` : '  every account'}${v[k].name ? `  — ${v[k].name}` : ''}  (since ${v[k].since})`);
  process.exit(0);
}
const key = argv.find((a, i) => !a.startsWith('--') && !['--account', '--name', '--why'].includes(argv[i - 1]));
const why = flag('--why');
if (!key || !why) {
  console.error('usage: autopay.mjs <address | @domain> [--account 5464] [--name "Vendor"] --why "what he said"');
  process.exit(1);
}
try {
  const e = await addAutopay(OBLIGATIONS, key, { account: flag('--account'), name: flag('--name'), note: why.slice(0, 160), by: 'chat' });
  console.log(`on autopay: ${e.key}${e.accounts ? ` (accounts ${e.accounts.join(', ')})` : ' (every account)'}`);
  for (const c of await closeCovered(OBLIGATIONS)) console.log(`  closed ${c.code ?? c.id} — ${c.title}`);
} catch (err) {
  console.error(`autopay: ${err.message}`);
  process.exit(1);
}
