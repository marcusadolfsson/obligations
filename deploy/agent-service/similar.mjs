/**
 * Two entries for one thing — and which of them is worth showing him.
 *
 * Alex, 2026-09-18, once his Reminders lists started arriving: "sometimes a
 * manual reminder matches an existing todo in the assistant. how can we get them
 * linked?" He said "Sales Tax" into his phone in the morning; the mail triage
 * had already concluded something about the same sales tax from an accountant's
 * thread. Two rows, one debt, and closing either leaves the other standing.
 *
 * The merge itself is old machinery — `integrations/obligation-links.json`,
 * which the mail triage has used for weeks. What was missing is a way to notice
 * the pair without reading the whole list.
 *
 * **This proposes and never merges.** A duplicate in the list is visible and
 * annoying; a wrong merge hides one of two real debts behind the other, and
 * nothing would ever tell him. So it is arithmetic over words and dates, it
 * refuses anything it is not sure about, and the link is his tap.
 */

// Words that carry no signal about WHICH thing this is. Deliberately short: a
// long list starts throwing away the words that make a title distinctive.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'on', 'in', 'at', 'by', 'with',
  'from', 'into', 'about', 'his', 'her', 'their', 'my', 'it', 'is', 'are', 'was',
  'be', 'get', 'got', 'do', 'does', 'did', 'send', 'reply', 'answer', 'call',
  'email', 'mail', 'text', 'chase', 'ask', 'tell', 'check', 'make', 'take',
  'this', 'that', 'these', 'those', 'him', 'them', 'out', 'up', 'back', 'new',
]);

/** The distinctive words of a title, lower-cased, stemmed only of plurals. */
export function words(s) {
  const out = new Set();
  for (const raw of String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9'&./-]*/g) ?? []) {
    const w = raw.replace(/'s$/, '').replace(/([a-z]{4,})s$/, '$1');
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** The capitalised names in a title, normalised like `words()`. */
export function capsOf(s) {
  return new Set((String(s ?? '').match(/(?<![.!?]\s)\b[A-Z][A-Za-z0-9'&.-]{1,}\b/g) ?? [])
    .map((w) => w.toLowerCase().replace(/'s$/, '').replace(/([a-z]{4,})s$/, '$1')));
}

/** The scoring, over word sets already computed. */
function likenessOf(a, b) {
  const shared = [...a.w].filter((w) => b.w.has(w));
  let score = shared.length / Math.min(a.w.size, b.w.size);
  const why = [];
  if (shared.length) why.push(`both say ${shared.slice(0, 4).map((w) => `"${w}"`).join(', ')}`);
  const sameDay = a.o?.due && b.o?.due && String(a.o.due).slice(0, 10) === String(b.o.due).slice(0, 10);
  if (sameDay) { score += 0.15; why.push(`both due ${String(a.o.due).slice(0, 10)}`); }
  const who = (x) => String(x?.who ?? '').trim().toLowerCase();
  if (who(a.o) && who(a.o) === who(b.o)) { score += 0.1; why.push(`both with ${a.o.who}`); }
  return { score: Math.min(score, 1), why };
}

/** distinguished(), over sets already computed. */
function distinguishedOf(a, b) {
  const onlyA = [...a.w].filter((w) => !b.w.has(w) && a.c.has(w));
  if (!onlyA.length) return null;
  const onlyB = [...b.w].filter((w) => !a.w.has(w) && b.c.has(w));
  return onlyB.length ? { a: onlyA, b: onlyB } : null;
}

/**
 * How alike two obligations are, 0–1, and why.
 *
 * Shared distinctive words carry it, because that is what he actually typed
 * twice. The date and the person are corroboration rather than evidence on
 * their own: a dozen unrelated things are due on the same Friday, and a person
 * he owes four separate things to would otherwise match all four.
 */
export function likeness(a, b) {
  // The share is over the SMALLER set: "Sales Tax" against "File the August
  // the state sales and use tax return" should read as a strong match, and
  // dividing by the union would punish the longer title for being descriptive.
  const A = { o: a, w: words(a?.title ?? a?.what), c: capsOf(a?.title ?? a?.what) };
  const B = { o: b, w: words(b?.title ?? b?.what), c: capsOf(b?.title ?? b?.what) };
  if (!A.w.size || !B.w.size) return { score: 0, why: [] };
  return likenessOf(A, B);
}

/**
 * A word that is capitalised in the title and belongs to only one of the pair.
 *
 * This is what separates a duplicate from a sibling, and on the first live run
 * it was the difference between a useful list and a list he would learn to
 * skim. "Aircraft hours: Northwind" and "Aircraft hours: Pinewood Engines" score
 * 0.98 on words alone and are two different vendors; so are Dana's Birchwood dock
 * and Dana's Elmwood generator, and the Bayport and Fairview CFN missions.
 *
 * The rule: if EACH side names something the other does not, and those names
 * are capitalised in his own writing, they are two things that rhyme. One side
 * having extra detail ("Pay the OCTOBER Prime Store Card statement") is not
 * that — it is the same thing said twice.
 */
function distinguished(a, b) {
  const A = { o: a, w: words(a?.title ?? a?.what), c: capsOf(a?.title ?? a?.what) };
  const B = { o: b, w: words(b?.title ?? b?.what), c: capsOf(b?.title ?? b?.what) };
  return distinguishedOf(A, B);
}

export const THRESHOLD = 0.7;
/** At or above this, two titles are the same words: copies, not siblings. */
export const IDENTICAL = 0.95;

/**
 * The one other obligation this is probably the same as, or null.
 *
 * Refuses on a tie, the way the project assignment does: if two candidates are
 * within a hair of each other, the machine has not identified a duplicate, it
 * has found a family of similar things, and picking one would be a guess he
 * cannot see. Already-merged pairs never come back — `listObligations` has
 * folded them, so they arrive here as one row.
 */
export function twinOf(o, all, { threshold = THRESHOLD } = {}) {
  if (!o?.id) return null;
  const rows = [];
  for (const other of all ?? []) {
    if (!other?.id || other.id === o.id || other.open === false) continue;
    // Two things owed in opposite directions are not one thing.
    if ((other.owed_by ?? 'me') !== (o.owed_by ?? 'me')) continue;
    const { score, why } = likeness(o, other);
    if (score < threshold) continue;
    // Two things that rhyme are not one thing. See distinguished().
    if (distinguished(o, other)) continue;
    rows.push({ id: other.id, title: other.title ?? other.what, score, why });
  }
  rows.sort((a, b) => b.score - a.score);
  if (!rows.length) return null;
  /* A TIE AT THE TOP IS A FAMILY — unless it is the same thing N times.
   *
   * Review 2026-09-20: six identical "Download the corrected Fivefold K-1s",
   * five identical "Answer Crestline Cabinetry on the quote", and this proposed
   * none of them, ever. Every candidate scored 1.0 against every other, so
   * the top two were always within a hair and the refusal built for "a family
   * of similar things" fired on the one case that is not a family at all.
   * The refusal designed to prevent a wrong merge guaranteed that exact
   * copies were the only duplicates never surfaced.
   *
   * So: a tie at or above IDENTICAL is N copies of one obligation, and the
   * nearest is proposed. Below that the refusal stands — "Aircraft hours:
   * Northwind" and "Aircraft hours: Pinewood Engines" tie at 0.8 and are two
   * things. */
  if (rows.length > 1 && rows[0].score - rows[1].score < 0.08 && rows[0].score < IDENTICAL) return null;
  return rows[0];
}

/**
 * Every pair worth offering, newest first. One row per pair — the page shows it
 * on whichever of the two he opens, and linking either way records the same
 * merge.
 */
export function twins(all, opts = {}) {
  const open = (all ?? []).filter((o) => o.open !== false);
  // Tokenise once per item, not once per pair. The pair loop is quadratic —
  // 242 open items is 29,000 comparisons — and re-tokenising inside it took
  // 617ms, which is too slow to sit in front of a page load. Hoisting the word
  // sets makes it set arithmetic and it falls to tens of milliseconds.
  const prep = open.map((o) => ({ o, w: words(o.title ?? o.what), c: capsOf(o.title ?? o.what) }));
  const seen = new Set();
  const out = [];
  for (let i = 0; i < prep.length; i++) {
    const rows = [];
    for (let j = 0; j < prep.length; j++) {
      if (i === j) continue;
      const a = prep[i], b = prep[j];
      if ((a.o.owed_by ?? 'me') !== (b.o.owed_by ?? 'me')) continue;
      if (!a.w.size || !b.w.size) continue;
      const { score, why } = likenessOf(a, b);
      if (score < (opts.threshold ?? THRESHOLD)) continue;
      if (distinguishedOf(a, b)) continue;
      rows.push({ id: b.o.id, title: b.o.title ?? b.o.what, score, why });
    }
    rows.sort((x, y) => y.score - x.score);
    if (!rows.length) continue;
    // The same tie rule as twinOf, with the same exception — written twice,
    // which is how the fix above landed in one and not the other on the
    // first try. Identical is copies, not a family.
    if (rows.length > 1 && rows[0].score - rows[1].score < 0.08 && rows[0].score < IDENTICAL) continue;
    const t = rows[0];
    const key = [prep[i].o.id, t.id].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: prep[i].o.id, title: prep[i].o.title ?? prep[i].o.what, twin: t });
  }
  return out;
}
