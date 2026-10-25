/**
 * What would close it, as data.
 *
 * Alex, 2026-09-20: "how does this feed into the brief, it will self
 * correct because it looks at the obligations?" It could not, quite. Every
 * mail conclusion carried a `closes` sentence — "the dec page arrives", "she
 * confirms a date" — and 202 of them were read by nothing but the page. The
 * triage knew, in words, what would settle each debt; the arithmetic that
 * reads the outbox, the logbook, the calendar and the other person's mail had
 * no way to ask it.
 *
 * `closes_when` is the same knowledge in a shape the review pass can test:
 *
 *   [{ kind: 'reply-from', who: 'Dana', words: ['leak'] }]
 *   [{ kind: 'receipt' }]
 *   [{ kind: 'sent-by-me' }, { kind: 'reply-from' }]
 *
 * A list is a disjunction — most sentences are "he pays it OR a receipt
 * arrives" — and ANY satisfied entry closes it. `words` narrows: every word
 * must appear in the evidence. The kinds, and what each is tested against:
 *
 *   reply-from   a message from `who` (default the obligation's counterparty)
 *                since the debt began, on a conversation that is NOT this one.
 *                The thread itself is re-offered to the triage on new mail, so
 *                a reply there is the triage's to judge; what it cannot see is
 *                Dana answering on the utility-bill thread. Machine mail —
 *                invitations, bounces, auto-replies — never counts.
 *   sent-by-me   something he sent on this obligation's own thread or chat
 *                after it began — an Outbox send, or sent mail in the extract.
 *   receipt      a receipt or payment confirmation filed under
 *                reference/statements.md after the debt began, from a sender
 *                sharing a word with the title.
 *   event        an event on his calendar that shares the title's words and
 *                has STARTED — "the call happens", not "the call is booked".
 *   booking      a line under the trip in reference/bookings.md matching the
 *                words. Words are required: "something is booked for Pinecrest"
 *                is true the moment the flight is filed.
 *   logbook      a logbook line closed this id after the debt began — a
 *                source re-reporting open after a close.
 *
 * **Only an explicit `closes_when` counts.** The first cut also parsed the
 * old prose sentences best-effort and asked the triage about matches; a
 * regex over English is a guess, and the six guesses it produced joined a
 * pile of findings nobody acted on. Deleted the same evening. The triage
 * writes `closes_when` when it means it; the review pass closes on it with
 * `agent:review` and the evidence as the outcome, the same expiry and the
 * same evening cross-check as every other agent close.
 */

export const KINDS = ['reply-from', 'sent-by-me', 'receipt', 'event', 'booking', 'logbook'];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lower = (s) => norm(s).toLowerCase();

/** Every word of `words` appears in `text`, whole-word, case-insensitive. */
export function hasWords(text, words) {
  const hay = lower(text);
  return (words ?? []).every((w) => new RegExp(`\\b${String(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay));
}

/** Shape-check one entry; returns the cleaned entry or null. */
export function validSpec(s) {
  if (!s || typeof s !== 'object' || !KINDS.includes(s.kind)) return null;
  const out = { kind: s.kind };
  if (s.who && typeof s.who === 'string') out.who = norm(s.who);
  if (Array.isArray(s.words)) { const w = s.words.map(norm).filter(Boolean); if (w.length) out.words = w; }
  if (out.kind === 'booking' && !out.words) return null;
  return out;
}

/**
 * Is one spec met, given what context.mjs knows about the obligation?
 * Returns `{ kind, evidence, at }` or null. Pure over `known`; the one async
 * case is a reply from someone other than the obligation's own counterparty.
 */
export async function satisfied(spec, o, known, { now = new Date() } = {}) {
  const s = validSpec(spec);
  if (!s) return null;
  const words = s.words ?? [];
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  switch (s.kind) {
    case 'reply-from': {
      if (!o?.since) return null;                              // unbounded — could match a message from before the debt
      let rows = known.elsewhere ?? [];
      if (s.who && known.from && !known.samePerson?.(s.who, o?.who)) rows = await known.from(s.who);
      /* A THREAD KNOWN ONLY BY ITS SUBJECT IS NOT ENOUGH TO CLOSE ON.
       *
       * `elsewhere` grew on 2026-09-22 to include every thread the mail job has
       * judged — the durable record, so an answer that was filed and archived
       * could still be found (Wendy Fuller's flood declaration page). That is
       * right for the they-replied FINDING, which only asks the triage to look.
       * It is too much for an automatic CLOSE: all those rows carry is a
       * subject, and hours later this closed "Chase ONE on the Brokerly
       * proposal" on Lena's mail about a delivery robot. Alex, 2026-09-22:
       * "Why did KWW6 close. That was a task unrelated to Brokerly."
       *
       * So a judged-only row counts here only when `words` are given and its
       * subject carries them — evidence about THIS debt rather than evidence
       * that the person exists. The live extract's rows, which the triage has
       * not filed away, are unchanged. */
      if (!words.length) rows = rows.filter((x) => !x.judged);
      const hit = rows.filter((x) => x.from !== 'you' && hasWords(x.detail, words)).pop();
      return hit ? { kind: s.kind, at: hit.at, evidence: `${s.who ?? o?.who ?? 'they'} wrote by ${hit.channel} on ${hit.at}${hit.detail ? `: "${String(hit.detail).slice(0, 80)}"` : ''}${hit.thread ? ` (${hit.thread})` : ''}` } : null;
    }
    case 'sent-by-me': {
      const sent = (known.sent ?? []).filter((d) => hasWords(d.text, words)).map((d) => ({ at: d.sentAt, evidence: `you sent a ${d.kind === 'mail' ? 'mail' : 'text'} to ${d.to} on this thread on ${d.sentAt} (outbox/${d.id})` }));
      const mine = (known.mineOnThread ?? []).filter((x) => hasWords(x.detail, words)).map((x) => ({ at: x.at, evidence: `you wrote by ${x.channel} on this thread on ${x.at}${x.detail ? ` ("${String(x.detail).slice(0, 60)}")` : ''}` }));
      const hit = [...sent, ...mine].sort((a, b) => String(a.at).localeCompare(String(b.at))).pop();
      return hit ? { kind: s.kind, ...hit } : null;
    }
    case 'receipt': {
      const hit = (known.paidOnFile ?? []).filter((st) => hasWords(`${st.title} ${st.sender}`, words)).pop();
      return hit ? { kind: s.kind, at: hit.date, evidence: `a receipt was filed on ${hit.date}: "${hit.title}" from ${hit.sender} (reference/statements.md)` } : null;
    }
    case 'event': {
      const hit = (known.onCalendar ?? []).filter((ev) => String(ev.startsOn ?? '') <= today && hasWords(ev.summary, words)).pop();
      return hit ? { kind: s.kind, at: hit.startsOn, evidence: `"${hit.summary}" was on his calendar on ${hit.startsOn}${hit.startsAt ? ' ' + hit.startsAt : ''}` } : null;
    }
    case 'booking': {
      const hit = (known.bookings ?? []).filter((b) => hasWords(`${b.title} ${b.description ?? ''}`, words)).pop();
      return hit ? { kind: s.kind, at: hit.date, evidence: `filed under ${hit.trip?.name ?? 'the trip'} in reference/bookings.md: ${hit.date} · ${hit.title}` } : null;
    }
    case 'logbook': {
      // Its own line only. A match by invoice number is another item's close,
      // a question for the triage (closed-in-logbook), never a close by itself.
      const l = known.logged?.invoice ? null : known.logged;
      return l ? { kind: s.kind, at: l.at, evidence: `the logbook closed it on ${l.at} by ${l.who}${l.outcome ? `: "${l.outcome.slice(0, 80)}"` : ''}` } : null;
    }
    default: return null;
  }
}

/** The obligation's `closes_when` specs, and the first that is met. */
export async function whenMet(o, known, { now = new Date() } = {}) {
  const specs = Array.isArray(o?.closes_when) ? o.closes_when.map(validSpec).filter(Boolean) : [];
  for (const s of specs) {
    const met = await satisfied(s, o, known, { now });
    if (met) return { spec: s, ...met };
  }
  return null;
}
