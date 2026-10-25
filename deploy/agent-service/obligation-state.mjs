/**
 * One record per obligation.
 *
 * Alex, 2026-09-20, after a day in which every silent un-close traced to one
 * line: `open = members.some((m) => m.open)`. An obligation was owned jointly
 * by every source that evidenced it, and any one of them could reopen it
 * without a decision. So the obligation owns its state, here, keyed by the
 * merged id. Sources are EVIDENCE.
 *
 * And then, the same evening, the second finding of the review: the obligation
 * was a record spread over seven files — merges in `obligation-links.json`,
 * tags in `obligation-tags.json`, snoozes in `snoozed.json`, chases in
 * `.log/chases.json`, the close here — and every pair could disagree. Now it
 * is one file, `integrations/obligation-state.json`, with one slice per fact:
 *
 *   closed   { id: { at, by, outcome } }          the close — see below
 *   links    { child: { into, why, at } }         his merges, and the triage's
 *   tags     { id: [tag] }                        his tags ([] means "no project")
 *   snoozed  { id: 'YYYY-MM-DD HH:MM' }           hidden from Today/Work until then
 *   chased   { id: { at, who, channel, text } }   the follow-up put in front of him
 *
 * The old files are read as a fallback while a slice is absent, so a fixture
 * or a box that has not migrated still works; the first write carries the
 * whole record forward and the old file is never consulted again.
 *
 * ## The one way a closed record loses
 *
 * The newest decision wins. Evidence that is NEWER than the close reopens it:
 * the triage re-reading a thread after a new message and writing `open: true`
 * with a `reviewed` stamp later than the close. Evidence with no timestamp at
 * all cannot outvote a dated decision; reopening those goes through
 * `reopenObligation`, a decision with a name on it. `reconcileState` tidies
 * records that newer evidence has already outvoted.
 *
 * `mutate()` writes without the lock, for callers that already hold it (a
 * close, a reopen). `updateState()` takes the lock. Never call the second from
 * inside the first's callers.
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withRepoLock } from './lock.mjs';
import { localStamp } from './time.mjs';

const FILE = ['integrations', 'obligation-state.json'];
const CHANGES = ['integrations', 'obligation-changes.jsonl'];
const ID = /^[a-z0-9_:;.@+%-]+$/i;
export const SLICES = ['closed', 'links', 'tags', 'snoozed', 'chased'];

async function readJson(vault, rel) {
  try { return JSON.parse(await readFile(join(vault, rel), 'utf8')); } catch { return null; }
}

/** The old side files, each folded into the slice it becomes. */
const FALLBACK = {
  links: async (vault) => {
    const d = await readJson(vault, 'integrations/obligation-links.json');
    const out = {};
    for (const m of d?.merges ?? []) {
      if (!m?.id || !Array.isArray(m.members)) continue;
      for (const child of m.members) if (child !== m.id) out[child] = { into: m.id, why: m.why ?? m.note ?? null };
    }
    return out;
  },
  tags: async (vault) => { const d = await readJson(vault, 'integrations/obligation-tags.json'); return d && typeof d.tags === 'object' && d.tags ? d.tags : {}; },
  snoozed: async (vault) => { const d = await readJson(vault, 'integrations/snoozed.json'); return d?.until && typeof d.until === 'object' ? d.until : {}; },
  chased: async (vault) => { const d = await readJson(vault, '.log/chases.json'); return d && typeof d === 'object' ? d : {}; },
};

/** Every slice, with an absent one read from the file it used to be. */
export async function readObligationState(vault) {
  const d = (await readJson(vault, join(...FILE))) ?? {};
  const out = {};
  for (const s of SLICES) {
    if (d[s] && typeof d[s] === 'object') out[s] = d[s];
    else out[s] = FALLBACK[s] ? await FALLBACK[s](vault) : {};
  }
  return out;
}

async function write(vault, d) {
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, ...FILE), JSON.stringify(d, null, 1) + '\n');
}

/** Read, change, write — WITHOUT the lock; the caller holds it. */
export async function mutate(vault, fn) {
  const d = await readObligationState(vault);
  const r = await fn(d);
  await write(vault, d);
  return r;
}

/** Read, change, write, under the repo lock. */
export const updateState = (vault, fn) => withRepoLock(vault, () => mutate(vault, fn));

async function change(vault, row) {
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await appendFile(join(vault, ...CHANGES), JSON.stringify({ at: localStamp(), ...row }) + '\n');
}

/** The close. Idempotent; the caller holds the lock. */
export async function markClosed(vault, id, { at = localStamp(), by, outcome = null } = {}) {
  const key = String(id ?? '').trim();
  if (!key || !ID.test(key)) throw new Error('not an obligation id');
  if (!by) throw new Error('a close needs a name on it');
  return mutate(vault, (d) => { d.closed[key] = { at, by, outcome: outcome ? String(outcome).slice(0, 300) : null }; return d.closed[key]; });
}

/** The reopen — a decision, so it needs a name and a reason, and it is logged. The caller holds the lock. */
export async function clearClosed(vault, id, { by, why } = {}) {
  const key = String(id ?? '').trim();
  const was = await mutate(vault, (d) => { const w = d.closed[key]; delete d.closed[key]; return w; });
  if (!was) return { id: key, reopened: false };
  await change(vault, { action: 'reopened', id: key, by: by ?? null, why: why ?? null, was });
  return { id: key, reopened: true, was };
}

/**
 * Drop close records that newer evidence has already outvoted, so the file
 * and the list agree. Called after each triage.
 */
export async function reconcileState(vault, obligations) {
  const dropped = [];
  await updateState(vault, (d) => {
    for (const o of obligations ?? []) {
      const rec = d.closed[o.id];
      if (rec && o.open && o.reopened_by_evidence) {
        dropped.push({ id: o.id, was: rec, evidence_at: o.reopened_by_evidence });
        delete d.closed[o.id];
      }
    }
  });
  for (const x of dropped) await change(vault, { action: 'reopened', id: x.id, by: 'evidence', why: `a newer conclusion (${x.evidence_at}) says it is open again`, was: x.was });
  return dropped;
}
