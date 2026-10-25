/**
 * Stuck conditions as a source: an alert nobody has cleared, as a thing to do.
 *
 * Alex, 2026-10-17, of six building conditions the brief had reported every
 * morning for five weeks: "Where are these? I don't see a todo." A condition
 * is awareness with a clock and clears only on its recovery mail
 * (conditions.mjs). Some senders never send one, and then the clock runs for
 * ever on Today with nothing he can tap. Past a day it is one of these.
 *
 * Arithmetic on read, like birthdays: nothing is written here. The ref carries
 * the key and the minute it opened, so a condition that clears and comes back
 * is a new to-do rather than the old one reopened. The close lives in the
 * obligation's own record; `at` is the newest alert for the key, so a fresh
 * alert after his close reopens it and the same old mail never does. When the
 * recovery mail lands the row is simply gone, the way a birthday is at
 * midnight.
 */
import { conditions } from '../conditions.mjs';

export const SOURCE = 'condition';

const compact = (stamp) => String(stamp ?? '').replace(/\D/g, '').slice(0, 12);

/** `cond:<key>:<YYYYMMDDHHMM it opened>`. Exported for the tests. */
export const condRef = (c) => `cond:${c.key}:${compact(c.since)}`;

/** One open, stuck condition as an obligation row. Exported for the tests. */
export function rowOf(c) {
  return {
    ref: condRef(c),
    who: c.who ?? null,
    title: `Still no all-clear: ${c.what}`,
    what: `${c.what}. Open since ${c.since} and the sender has sent no all-clear. `
        + 'Close this once it is dealt with; a new alert for it reopens it.',
    since: c.since,
    at: c.last ?? c.since,
    due: null,
    priority: c.severity === 'normal' ? 'normal' : 'high',
    owed_by: 'me',
    open: true,
    closes: 'the recovery mail, or his close',
    detail: { kind: 'condition', key: c.key, severity: c.severity, account: c.account, thread: c.threadId },
  };
}

export async function read(vault, opts = {}) {
  const r = await conditions(vault, opts);
  if (r.error) throw new Error(r.error);
  return r.open.filter((c) => c.stuck).map(rowOf);
}

/** Nothing to write: the obligation's own record holds the close. */
export async function close(vault, ref) { return { ref, closed: true }; }
