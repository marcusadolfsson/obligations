/**
 * `node deploy/link.mjs <id> <into> --why "one purchase across several threads"`
 *
 * The door for recording that two obligations are one. Judgement stays with
 * whoever calls it — the triage, the chat, his tap on /todo — and the write
 * goes through `linkObligations`, which refuses a chain, a closed item and a
 * self-link, and keeps the older one as the parent so the merged row keeps
 * the day it started. Until 2026-09-20 the triage hand-wrote
 * `integrations/obligation-links.json`; the record now lives in
 * `integrations/obligation-state.json` and nothing hand-writes that.
 */
import { linkObligations } from './agent-service/obligations.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1] ?? null; };
const [id, into] = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
const why = flag('why');
if (!id || !into || !why) {
  console.error('usage: node deploy/link.mjs <id> <into> --why "why these are one thing"');
  process.exit(2);
}
try {
  const r = await linkObligations(OBLIGATIONS, id, into, why);
  console.log(`merged ${r.merged} into ${r.id} — ${r.title}`);
} catch (e) {
  console.error(`could not link: ${e.message}`);
  process.exit(1);
}
