/**
 * Later. Alex, 2026-09-05: swipe left on any list hides the thing from Today
 * and Work until a time — tomorrow 07:00 by default — and touches nothing else.
 *
 * **The jobs do not see it.** A snoozed debt is still a debt in every brief,
 * because "I did not want to look at this on Friday" is not information about
 * whether it is owed. Only the two pages he browses read this.
 *
 * Stored in the obligation's own record since 2026-09-20 (the `snoozed` slice
 * of `integrations/obligation-state.json`); `snoozed.json` is read as a
 * fallback until the first write.
 */
import { localStamp } from './time.mjs';
import { readObligationState, updateState } from './obligation-state.mjs';

const ID = /^[a-z0-9_:;.@+-]+$/i;

export async function snoozed(vault, now = localStamp()) {
  const { snoozed: until } = await readObligationState(vault);
  const out = new Map();
  // String comparison on ISO-shaped local stamps: sorts correctly, never grows a
  // timezone on the way through a Date.
  for (const [id, u] of Object.entries(until ?? {})) if (u > now) out.set(id, u);
  return out;
}

export function tomorrowMorning(now = new Date()) {
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(7, 0, 0, 0);
  return localStamp(d);
}

export async function snooze(vault, id, until = tomorrowMorning()) {
  const key = String(id ?? '').trim();
  if (!key || !ID.test(key)) throw new Error('not an obligation id');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(until)) throw new Error('until must be a local stamp');
  await updateState(vault, (d) => {
    d.snoozed[key] = until;
    // Drop what has already woken, so the record does not keep every swipe forever.
    const now = localStamp();
    for (const [k, v] of Object.entries(d.snoozed)) if (v <= now) delete d.snoozed[k];
  });
  return { id: key, until };
}

export async function unsnooze(vault, id) {
  let removed = false;
  await updateState(vault, (d) => { if (d.snoozed[id]) { delete d.snoozed[id]; removed = true; } });
  return { id, removed };
}
