/**
 * Reading the triage's paragraph without losing any of it.
 *
 * Alex, 2026-09-08, opening one obligation: "this is just a wall of text,
 * how can we present cleaner?" It was 795 words in a single run.
 *
 * The rule that matters most here is that nothing may disappear. Shortening a
 * `what` would take away the reason the list is trustworthy — the amounts and
 * dates are why he does not have to go back and read the thread — so this only
 * ever *reorders and folds*. Every test below either asserts that the parts
 * rejoin to the input, or that a short paragraph is left completely alone.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entries, split, paragraphs, dateOf } from './web/what.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

console.log('Short things are left alone');
{
  const short = 'Owes Wendy the flood declaration page for Marisol II.';
  const r = split(short);
  check('one sentence comes back whole', r.state === short && r.whole && !r.history.length);
  check('a two-sentence what is not chopped up',
        split('He asked on Tuesday. Nothing has come back since.').history.length === 0);
  check('an empty what does not throw', split('').state === '' && split(undefined).state === '');
  check('paragraphs of a short string is one paragraph', paragraphs(short).length === 1);
}

console.log('\nAn append-only what becomes a state and a history');
{
  const w = 'The original position, written when it started. '
    + 'Moved a long way on 2026-09-03: the second thing happened. '
    + 'On the morning of 2026-09-04 Ruth wrote Hank. '
    + 'UPDATE 2026-09-08: nothing has gone out since.';
  const all = entries(w);
  check('every marker starts an entry', all.length === 4, String(all.length));
  check('nothing is lost', norm(all.map((e) => e.body).join(' ')) === norm(w));
  const r = split(w, { minWords: 5 });
  check('the newest entry is what he sees first', /UPDATE 2026-09-08/.test(r.state));
  check('the rest is history, oldest first', r.history.length === 3);
  check('and it is in order', r.history[1].date === '2026-09-03' && r.history[2].date === '2026-09-04');
  check('the first entry claims no update date', r.history[0].date === null);
}

console.log('\nA date in the opening text is not an update date');
{
  // The real failure this guards: the PHOA item opens "the Pat Morgan
  // evening, Mon 2026-09-28", and labelling that entry 2026-09-28 would date
  // the history by when the event is, confidently and wrongly.
  const w = 'The Morgan evening, Mon 2026-09-28, room held 16:30-18:30. '
    + 'UPDATE 2026-09-08: nothing has gone out since.';
  const r = split(w, { minWords: 5 });
  check('the opening entry is undated rather than dated by an event',
        r.history[0].date === null, String(r.history[0].date));
  check('the marker entry keeps its own date', dateOf('UPDATE 2026-09-08: x') === '2026-09-08');
}

console.log('\nParagraphs');
{
  const long = Array.from({ length: 9 }, (_, i) => `Sentence number ${i + 1}.`).join(' ');
  const ps = paragraphs(long);
  check('nine sentences become three paragraphs', ps.length === 3, String(ps.length));
  check('nothing is lost splitting into paragraphs', norm(ps.join(' ')) === norm(long));
  check('text with no full stop still comes back', paragraphs('no full stop here')[0] === 'no full stop here');
}

/* Against every conclusion actually on disk. A splitter that works on the one
 * example he complained about and drops a word on another is worse than none. */
console.log('\nEvery live conclusion survives the round trip');
{
  const state = JSON.parse(await readFile(join(OBLIGATIONS, 'integrations/email-state.json'), 'utf8'));
  const whats = (state.threads ?? []).map((t) => t.conclusion?.what).filter((w) => typeof w === 'string' && w.trim());
  let lost = 0, longest = 0, folded = 0;
  for (const w of whats) {
    const all = entries(w);
    if (norm(all.map((e) => e.body).join(' ')) !== norm(w)) lost++;
    longest = Math.max(longest, w.split(/\s+/).length);
    if (!split(w).whole) folded++;
  }
  check(`no words lost across ${whats.length} live conclusions`, lost === 0, `${lost} lost`);
  if (whats.length) check('the longest one is the kind that needed this', longest > 300, `longest is ${longest} words`);

  /* ANYTHING THAT ANNOUNCES AN UPDATE MUST FOLD, and this is an assertion now
   * rather than the note it used to be.
   *
   * `folded` was counted here from the day this file was written and only ever
   * printed. It sat at zero for twelve days while the message triage wrote
   * `UPDATE 2026-09-15 (21:33 run):` and the marker regex required the colon
   * straight after the date — so every obligation rendered its whole changelog
   * and the component built to prevent that did nothing. Alex, 2026-09-20:
   * "there is a lot of barely readable reasoning on that task." 949 words, 28
   * entries, none folded.
   *
   * A count printed and not asserted is a silence that looks like a success,
   * which is the one thing the guards in this repo exist to make impossible. */
  /* Long enough to be worth folding: `split` deliberately leaves anything under
     70 words whole, because a disclosure control over two sentences is friction
     for nothing. A 30-word conclusion with one UPDATE in it is doing the right
     thing and must not be dragged in here. */
  const marked = whats.filter((w) => /\bUPDATE\s+\d{4}-\d{2}-\d{2}/.test(w) && w.split(/\s+/).length >= 70);
  const unfolded = marked.filter((w) => split(w).whole);
  check(`every long conclusion that writes UPDATE folds it (${marked.length} checked)`,
    (marked.length > 0 || !whats.length) && unfolded.length === 0,
    unfolded.length ? `${unfolded.length} unfolded, e.g. ${unfolded[0].slice(0, 160)}…` : 'no live conclusion uses UPDATE at all');
  console.log(`  note ${folded} of ${whats.length} are long enough to fold; the longest is ${longest} words`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
