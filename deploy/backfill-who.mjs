#!/usr/bin/env node
/**
 * Fill in `who` on the conclusions that never had one.
 *
 * Alex, 2026-09-06, on the digest: "Why are all these unknown sender". 138
 * conclusions — every one from the first two triage runs on 09-02 and 09-03 —
 * were written before the skill required a sender, and 134 of them are no
 * longer in the extract, so the page had nothing to show. This asks Gmail for
 * the From header of each thread once, writes the address (not the name — the
 * same rule the triage follows), and touches nothing else on the record.
 * Idempotent; a thread Gmail no longer has is left as it was and counted.
 *
 *   node deploy/backfill-who.mjs [--dry]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, accounts } from './mcp/google-auth.mjs';
import { withRepoLock } from './agent-service/lock.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const addr = (s) => (String(s ?? '').match(/<([^>]+)>/)?.[1] ?? String(s ?? '')).trim().toLowerCase();

const file = join(OBLIGATIONS, 'integrations', 'email-state.json');
const state = JSON.parse(await readFile(file, 'utf8'));
const missing = state.threads.filter((t) => t.conclusion && !t.conclusion.who);
console.log(`${missing.length} conclusions without a sender`);
if (!missing.length) process.exit(0);

const known = new Set(await accounts(OBLIGATIONS));
const tokens = new Map();
const own = new Set();
for (const a of known) {
  try {
    const tok = await accessToken(OBLIGATIONS, fetch, a); tokens.set(a, tok);
    const p = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${tok}` } })).json();
    if (p.emailAddress) own.add(p.emailAddress.toLowerCase());
  } catch (err) { console.log(`  ${a}: no token (${err.message})`); }
}

let filled = 0, gone = 0, self = 0;
for (const t of missing) {
  const tok = tokens.get(t.account || 'personal');
  if (!tok) { gone++; continue; }
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(t.thread_id)}`);
  url.searchParams.set('format', 'metadata'); url.searchParams.append('metadataHeaders', 'From');
  // A 429 is not "gone": the first real pass counted 83 rate-limited replies
  // as threads Gmail no longer had. Back off and retry; only a 404 is gone.
  let res = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.ok || res.status === 404) break;
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  if (!res?.ok) { gone++; if (res?.status !== 404) console.log(`  ${t.thread_id}: HTTP ${res?.status}`); continue; }
  await new Promise((r) => setTimeout(r, 120));
  const th = await res.json();
  const froms = (th.messages ?? []).map((m) => addr((m.payload?.headers ?? []).find((h) => h.name.toLowerCase() === 'from')?.value)).filter(Boolean);
  const theirs = [...froms].reverse().find((f) => !own.has(f)) ?? null;
  if (!theirs) { self++; continue; }
  t.conclusion.who = theirs; filled++;
}
console.log(`filled ${filled} · ${gone} no longer readable in Gmail · ${self} only ever from him`);
if (!dry && filled) {
  await withRepoLock(OBLIGATIONS, async () => { await writeFile(file, JSON.stringify(state, null, 1) + '\n'); });
  console.log('written');
}
