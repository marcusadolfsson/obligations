/**
 * Turning the triage's paragraph into something readable.
 *
 * Alex, 2026-09-08, opening one obligation on the To Do page: "this is just
 * a wall of text, how can we present cleaner?" The `what` behind it was 795
 * words in a single unbroken run, rendered into one `<div>`.
 *
 * The length is not really the problem, and shortening it would lose the thing
 * that makes the list trustworthy — the amounts, the dates and the reasoning
 * are why he does not have to go and re-read the thread. The problem is that
 * `what` has quietly become **append-only**. Each run adds to the front or the
 * back rather than rewriting, so one field carries a changelog:
 *
 *   … the PHOA Pat Morgan evening, Mon 2026-09-28 …
 *   Moved a long way on 2026-09-03: Ruth has built the member invite …
 *   Moved again on the afternoon of 2026-09-03, and the technical half …
 *   On the morning of 2026-09-04 Ruth wrote Hank …
 *   UPDATE 2026-09-08: no reply of his own has gone out since …
 *
 * Read in order that is a history. What he needs when he opens the item is the
 * last entry — where it stands now — and the rest on request. So this splits on
 * the markers the triage already writes, hands back the newest as the state and
 * the others as history, and never invents or drops a word: `join()` of the
 * parts is the input, which the test asserts.
 *
 * No model, and nothing is rewritten on disk. This is a reading of a string.
 */

/** Where a new entry starts. Each must match at the start of a sentence. */
const MARKERS = [
  /* The parenthetical is why this whole file stopped working. The skill says
     to start an entry exactly `UPDATE YYYY-MM-DD:`, and the message triage has
     been writing `UPDATE 2026-09-15 (21:33 run):` since about 09-15 — the run
     stamp is useful and nobody thought to widen the reader. So the marker
     matched nothing, `split()` reported the whole field as current state with
     no history, and the fold silently showed everything.

     Alex, 2026-09-20, of an obligation carrying 28 of these: "there is a lot
     of barely readable reasoning on that task." 949 words, none of it folded,
     by a component built in 2026-09-08 to fold exactly this.

     Three shapes are live in the record, all written by the same instruction:

       UPDATE 2026-09-08:                 the documented one
       UPDATE 2026-09-15 (21:33 run):     the run stamp, parenthesised
       UPDATE 2026-09-18 14:39:           the run stamp, bare

     A reader of a format somebody else writes has to be the tolerant half, so
     it takes an optional time and an optional parenthetical before the colon.
     Tightening the WRITER instead would fix nothing already on disk. */
  /\bUPDATE\s+\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?(?:\s*\([^)\n]{0,60}\))?\s*:/g,
  /\bMoved (?:a long way |again |on again )?(?:on|again on) (?:the (?:morning|afternoon|evening) of )?\d{4}-\d{2}-\d{2}/g,
  /\bOn the (?:morning|afternoon|evening) of \d{4}-\d{2}-\d{2}\b/g,
  /\b(?:Moved|Updated|Changed) again\b/g,
];

/** The date an entry announces, when it announces one. */
export function dateOf(text) {
  const m = String(text ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/**
 * Split a `what` into entries, oldest first.
 *
 * Returns one entry for a paragraph with no markers, which is the common case
 * and must stay untouched — most obligations are two sentences and splitting
 * them would be worse than leaving them.
 */
export function entries(what) {
  const text = String(what ?? '').trim();
  if (!text) return [];
  const cuts = new Set([0]);
  for (const re of MARKERS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) cuts.add(m.index);
  }
  const at = [...cuts].sort((a, b) => a - b);
  // A date is only an update date when it came from the marker that opened the
  // entry. The first entry has no marker — it is whatever the triage wrote
  // originally — and the first date in it is usually a fact about the world,
  // not about when it was written. Labelling this one "2026-09-28" because the
  // event is on the 28th would date the history wrongly and confidently.
  return at.map((start, i) => {
    const body = text.slice(start, at[i + 1] ?? text.length).trim();
    return { body, date: start === 0 ? null : dateOf(body.slice(0, 70)) };
  }).filter((e) => e.body);
}

/**
 * What to show, and what to tuck away.
 *
 * `state` is the newest entry — the answer to "where does this stand". `history`
 * is everything before it, oldest first. A short `what` comes back whole with
 * no history, because a disclosure control over two sentences is friction for
 * nothing.
 */
export function split(what, { minWords = 70 } = {}) {
  const all = entries(what);
  if (all.length <= 1) return { state: all[0]?.body ?? '', history: [], whole: true };
  const words = String(what ?? '').split(/\s+/).length;
  if (words < minWords) return { state: String(what ?? '').trim(), history: [], whole: true };
  return { state: all[all.length - 1].body, history: all.slice(0, -1), whole: false };
}

/**
 * Break one entry into paragraphs for display.
 *
 * The triage writes long runs of sentences with no blank lines, so even a
 * single entry can be a wall. Grouped in threes: enough to keep a thought
 * together, short enough to give the eye somewhere to rest.
 */
export function paragraphs(text, { per = 3 } = {}) {
  const sentences = String(text ?? '').match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];
  const out = [];
  for (let i = 0; i < sentences.length; i += per) {
    const chunk = sentences.slice(i, i + per).join('').trim();
    if (chunk) out.push(chunk);
  }
  return out.length ? out : [String(text ?? '').trim()].filter(Boolean);
}
