/**
 * When a filed thread is due to be mentioned — the one answer, for both readers.
 *
 * `deploy/digest.mjs` prints the digest for a job to read; `deploy/brief-input.mjs`
 * puts the same set in the brief input document. They had the same filter written
 * out twice, and this file exists so that adding `surfaced_for` did not make that
 * three times. Two readers of one window is exactly the shape this repo keeps
 * finding a bug in.
 *
 * ## The window
 *
 * `digest.mjs` explains why the window is a window and not a `surfaced` flag: a
 * flag exists on the conclusion, 4 of 605 carry it, so trusting it would silently
 * drop the rest. Today's brief covers what was judged since the last DELIVERED
 * brief, and nothing is surfaced twice because nothing is judged twice.
 *
 * ## What `surfaced_for` adds
 *
 * `rules/email-triage.md` has described a time-sensitive awareness item since
 * 2026-09-02 — "a date or window attaches, but the doing is someone else's" —
 * and named the field: "If the awareness has a date attached, that is
 * `surfaced_for`." Eighteen conclusions carry one. **No code had ever read a
 * single one of them.** So the Justworks 2pm cutoff, the RAS battery STC
 * closing on the 15th and the ONE Springfield finance committee were each reported
 * on the day they were JUDGED and silent on the day they MATTERED.
 *
 * ## Twice, and the two read differently
 *
 * Alex, 2026-09-19, on the first cut of this, which held the item out of
 * every brief until its day: "I do also need to be made aware of the email
 * before the date, with a reminder on the date."
 *
 * Holding was the wrong direction, and the rules file's own words led me there
 * — "surfaces in the brief for that day, then stops". The cost of holding is
 * that the one thing he might want to do early, he cannot: renew the thing
 * before it lapses, put the meeting in his diary, answer while the sender is
 * still expecting it. He had never been told it existed.
 *
 * So a dated item surfaces **twice**:
 *
 *   `new`  — when it is judged, like anything else, carrying its date
 *   `due`  — again on the day, as the reminder
 *
 * and `reasonFor` says which, because two identical lines three weeks apart is
 * how a reader learns to skim. An item judged on its own date gets `new` only:
 * one event, one line.
 *
 * **The day-of surfacing is the brief, not a push.** CLAUDE.md and
 * `rules/reminders.md` both hold that an email may not manufacture an
 * interrupt — a stranger who can write to him could otherwise ring his phone by
 * naming a date. The brief on that morning is the reminder, on the channel
 * awareness has always used.
 */

/** A stamp here is local wall-clock with no offset — see CLAUDE.md. */
export const parseMs = (s) => {
  const t = Date.parse(String(s ?? '').replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
};

/**
 * The moment a `surfaced_for` date is due.
 *
 * A bare `YYYY-MM-DD` is local midnight, so an item dated today is already due
 * when the 07:00 brief runs — which is the whole point of it. A stamp carrying a
 * time is taken at that time. Anything unparseable is treated as absent rather
 * than as "now": a typo must not turn a deferral into an immediate surfacing,
 * because that is the failure the field exists to prevent.
 */
export function dueAt(conclusion) {
  const raw = conclusion?.surfaced_for;
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseMs(`${s} 00:00`);
  return parseMs(s);
}

/**
 * Why this brief should mention it, or null for not at all.
 *
 * @param t      a thread record from integrations/email-state.json
 * @param since  the delivered-through cursor, in ms
 * @param now    the clock, in ms
 * @returns      'new' (first sight), 'due' (its date has come), or null
 */
export function reasonFor(t, since, now = Date.now()) {
  const reviewed = parseMs(t?.reviewed);
  if (reviewed == null) return null;
  // First sight wins over the reminder: an item judged on its own date is one
  // event and gets one line, not the same fact said twice in one brief.
  if (reviewed >= since) return 'new';
  const due = dueAt(t?.conclusion);
  if (due != null && due <= now && due >= since) return 'due';
  return null;
}

/** The boolean, for callers that only need to know whether to print it. */
export function surfaces(t, since, now = Date.now()) {
  return reasonFor(t, since, now) != null;
}

/**
 * Dated items whose day is still ahead — already mentioned on arrival, and due
 * to come back.
 *
 * A COUNT for the brief, not a list. He has been told about each of these once
 * already; re-listing them in all three briefs every day until their date is
 * the repetition CLAUDE.md says to delete the midday brief over. But the number
 * has to be there, because a silence and an empty queue must not look the same
 * — that is how this field sat unread with eighteen live deferrals in it.
 */
export function upcoming(threads, tiers, now = Date.now()) {
  return (threads ?? []).filter((t) => {
    const c = t?.conclusion;
    if (!c || !tiers.includes(c.tier)) return false;
    const due = dueAt(c);
    return due != null && due > now;
  }).sort((a, b) => dueAt(a.conclusion) - dueAt(b.conclusion));
}
