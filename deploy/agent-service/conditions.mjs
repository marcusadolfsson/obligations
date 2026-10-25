#!/usr/bin/env node
/**
 * Stateful awareness: conditions that open and clear.
 *
 * Alex, 2026-09-06: "Some emails are status alerts, and while they should
 * go awareness some have urgency. Like a UPS device going offline. But if it
 * recovers 10 min later it is closed. So it is a stateful awareness."
 *
 * The mail triage records, on an awareness conclusion, a `condition`:
 *   { key: 'ups:hangar', status: 'open' | 'resolved', severity: 'normal' |
 *     'high' | 'critical', what: 'UPS at the hangar on battery' }
 * The same key on the recovery mail, status resolved, closes it. This module
 * is the arithmetic over those records: what is open now and for how long,
 * what resolved today and how long it lasted. Today shows the open ones, the
 * dispatcher pushes a high one once and its all-clear once, the brief recaps.
 * Nothing here judges; the triage does.
 *
 * STUCK. Alex, 2026-10-17, of six conditions open 36 to 39 days that the
 * brief reported every morning: "Where are these? I don't see a todo." A
 * condition only clears on a recovery mail, and the ONE UPS alerter and
 * Trane's MyComfort never send one. Every condition that has cleared did
 * so within 80 minutes; one open past a day is no longer something to watch
 * but something someone has to go and deal with. Past STUCK_MINUTES it is
 * marked `stuck`, sources/conditions.mjs makes it a to-do, and Today and the
 * brief stop listing it as a condition. Its recovery mail still clears it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localStamp } from './time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SEVERITIES = ['normal', 'high', 'critical'];
export const STUCK_MINUTES = 24 * 60;
const ms = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };

/** Fold every condition record into its latest state per key. Exported for the tests. */
export function conditionsFrom(threads, { now = Date.now(), today = localStamp(new Date(now)).slice(0, 10) } = {}) {
  const events = [];
  for (const t of threads ?? []) {
    const c = t.conclusion, k = c?.condition;
    if (!k?.key) continue;
    const at = ms(c.since) || ms(t.reviewed) || 0;
    events.push({ key: String(k.key).toLowerCase(), status: k.status === 'resolved' ? 'resolved' : 'open',
                  severity: SEVERITIES.includes(k.severity) ? k.severity : 'normal', what: k.what || c.title || c.what || k.key,
                  who: c.who ?? null, at, atText: c.since ?? t.reviewed ?? '', threadId: t.thread_id, account: t.account || 'personal' });
  }
  events.sort((a, b) => a.at - b.at);
  const byKey = new Map();
  for (const e of events) {
    const s = byKey.get(e.key) ?? { key: e.key, opened: null, history: [] };
    if (e.status === 'open') { if (!s.opened) s.opened = e; s.last = e; s.severity = e.severity; s.what = e.what; s.who = e.who; s.threadId = e.threadId; s.account = e.account; }
    else if (s.opened) { s.history.push({ opened: s.opened, resolved: e }); s.opened = null; }
    else s.history.push({ opened: null, resolved: e });      // a clear with no known open: still worth a line
    byKey.set(e.key, s);
  }
  const open = [], resolved = [];
  for (const s of byKey.values()) {
    if (s.opened) {
      const minutes = Math.max(0, Math.round((now - s.opened.at) / 60000));
      // `last` is the newest alert for the key: a fresh one after he closed
      // the to-do is new evidence and reopens it (obligation-state's rule).
      open.push({ key: s.key, what: s.what, who: s.who, severity: s.severity, since: s.opened.atText, since_ms: s.opened.at, minutes,
                  last: s.last?.atText ?? s.opened.atText, stuck: minutes >= STUCK_MINUTES, threadId: s.threadId, account: s.account });
    }
    for (const h of s.history) {
      if (String(h.resolved.atText).slice(0, 10) !== today) continue;
      resolved.push({ key: s.key, what: h.opened?.what ?? h.resolved.what, severity: h.opened?.severity ?? h.resolved.severity, opened: h.opened?.atText ?? null, resolved: h.resolved.atText,
                      minutes: h.opened ? Math.max(0, Math.round((h.resolved.at - h.opened.at) / 60000)) : null, threadId: h.resolved.threadId, account: h.resolved.account });
    }
  }
  open.sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || b.since_ms - a.since_ms);
  resolved.sort((a, b) => ms(b.resolved) - ms(a.resolved));
  return { open, resolved };
}

export async function conditions(vault = OBLIGATIONS, opts = {}) {
  let st;
  try { st = JSON.parse(await readFile(join(vault, 'integrations', 'email-state.json'), 'utf8')); }
  catch (err) { return { open: [], resolved: [], error: String(err?.message ?? err) }; }
  return { ...conditionsFrom(st.threads ?? [], opts), error: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await conditions(OBLIGATIONS);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
  if (out.error) { console.log(`conditions: ${out.error}`); process.exit(0); }
  if (!out.open.length && !out.resolved.length) console.log('no open conditions; nothing resolved today.');
  for (const c of out.open) console.log(`OPEN      ${c.severity.padEnd(8)} ${c.key}  ${c.what} — since ${c.since} (${c.minutes} min)`);
  for (const c of out.resolved) console.log(`resolved  ${(c.severity ?? '').padEnd(8)} ${c.key}  ${c.what} — ${c.opened ?? '?'} → ${c.resolved}${c.minutes != null ? ` (${c.minutes} min)` : ''}`);
}
