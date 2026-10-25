/**
 * Time formatting, in one place.
 *
 * This was copy-pasted into four modules, each carrying its own comment
 * explaining why it is not `toISOString()`. Time handling is exactly where this
 * system has already been burned — the containers ran UTC and the evening job
 * fired at 14:00 — and four copies of the fix is three chances to miss one.
 *
 * Everything a human sees here is local time, and every timestamp written into
 * the repo is local, because every timestamp already in the repo is.
 */

const p = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:MM` in local time. `sep` is 'T' for fields that forbid a space. */
export function localStamp(d = new Date(), sep = ' ') {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `${sep}${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Parse a stamp this repo wrote: `YYYY-MM-DD HH:MM`, `YYYY-MM-DDTHH:MM`, or a
 * bare `YYYY-MM-DD`. Returns NaN rather than throwing — a malformed date in a
 * hand-edited file must not take a page down.
 *
 * Deliberately not `new Date(str)`: a bare date string is parsed as UTC by the
 * spec, so `2026-08-29` becomes the 28th at 20:00 in this timezone, and an
 * obligation gains a day of age the moment it is written down.
 */
export function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s ?? ''));
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)).getTime();
}

/** Whole days between a stamp and now. Null when the stamp is unusable. */
export function daysSince(s, now = Date.now()) {
  const t = parseStamp(s);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null;
}

/**
 * Identifies one firing of a scheduled job: `YYYY-MM-DDTHH:MM`, local.
 *
 * **The separator is load-bearing and the `T` is not decoration.** The host
 * watchdog in `deploy/reminder-dispatch.py` recomputes this key independently,
 * in python, and compares it to what the service wrote in `.log/job-runs.json`.
 * If the two formats disagree the comparison never matches and every job looks
 * missed — which is exactly what happened on 2026-08-30, when consolidating
 * `localStamp` into this file changed its default separator from `T` to a
 * space and the 07:00 brief was reported missing 45 minutes after it had
 * finished successfully.
 *
 * Both sides are pinned to a literal: `slot-key` in the node tests, and
 * `reminder-dispatch.test.py` in the python ones.
 */
export function slotKey(d, [h, m]) {
  const at = new Date(d);
  at.setHours(h, m, 0, 0);
  return localStamp(at, 'T');
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * The clock as a person reads it off a page: `Sat 19 Sep, 16:17`.
 *
 * `localStamp` is for files and comparisons, and it belonged in every header
 * for as long as the header was a debug line. Alex, 2026-09-19: the UI "feels
 * very component code driven." A page that says `2026-09-19 16:17` at the top
 * is telling him what the machine wrote down, not what day it is.
 */
export function humanStamp(d = new Date()) {
  return `${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}, ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `Saturday 19 September` — the headline of the desk. */
export function humanDate(d = new Date()) {
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

/**
 * The wall clock, stated to the model at the top of every turn.
 *
 * Nothing used to tell the chat what day it was. On 2026-09-07 at 17:10 it
 * recorded "tomorrow, 2026-09-07 … Alex, 2026-09-06" for something he had
 * just said — a day behind, so the evening brief reported the task as missed
 * on the day he actually asked for it. Alex: "How was tomorrow today?"
 * Both dates are spelled out because that is the arithmetic that went wrong.
 */
export function nowLine(d = new Date()) {
  const day = (n) => localStamp(new Date(d.getTime() + n * 86400000)).slice(0, 10);
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* no ICU */ }
  return `[Now: ${DAY_NAMES[d.getDay()]} ${localStamp(d)}${zone ? ' ' + zone : ''}. Today is ${day(0)}; `
    + `tomorrow is ${day(1)}; yesterday was ${day(-1)}. Use these, never a date you infer from a file.]`;
}
