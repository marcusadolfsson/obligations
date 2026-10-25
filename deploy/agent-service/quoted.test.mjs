/**
 * The reply, without the conversation stapled underneath it.
 *
 * Alex, 2026-09-19: "on the inline threads, can we try to remove the static
 * in-line content that clutters 'On Fri, Sep 18, 2026 at 11:49 AM
 * <wmercer@mac.com> wrote:' etc."
 *
 * The refusals are the point. Trimming a quote is a convenience; trimming a
 * message is losing mail. Nothing is ever dropped — what is cut comes back as
 * `quoted` and the pane folds it rather than discarding it — but a cut in the
 * wrong place still hides the thing he opened the thread to read.
 */
import { trimQuoted } from './web/links.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

console.log('what a mail client staples on');
{
  const r = trimQuoted("Sounds good, thanks.\n\nOn Fri, Sep 18, 2026 at 11:49 AM <wmercer@mac.com>\nwrote:\n\n> the previous message\n> line two");
  check('the "On … wrote:" header, wrapped across two lines', r.text === 'Sounds good, thanks.', JSON.stringify(r.text));
  check('  ...and the quote is kept, not dropped', /previous message/.test(r.quoted));

  check('a bare quoted block', trimQuoted("Yes, go ahead with that one.\n\n> quoted\n> more").text === 'Yes, go ahead with that one.');
  check("Outlook's Original Message rule",
        trimQuoted("Approved, see the attached invoice.\n\n-----Original Message-----\nFrom: x").text === 'Approved, see the attached invoice.');
  check("Outlook's header block",
        trimQuoted("Please action this one today.\n\nFrom: Someone <a@b.com>\nSent: Friday\nTo: Alex").text === 'Please action this one today.');
  check("Apple Mail's forward",
        trimQuoted("Passing this along for your file.\n\nBegin forwarded message:\n\nFrom: x").text === 'Passing this along for your file.');
  check("Outlook's underscore divider",
        trimQuoted("Here is the number you asked for.\n\n________________________________\nFrom: x").text === 'Here is the number you asked for.');
}

console.log('\nwhat it must not touch');
{
  const all = '> just a quote and nothing else';
  check('a message that is ALL quote is a forward, not an empty note',
        trimQuoted(all).text === all && trimQuoted(all).quoted === '');
  const plain = 'No markers here at all, an ordinary reply.';
  check('plain prose is returned unchanged', trimQuoted(plain).text === plain);
  /* The marker must START a line. "…as I said on Monday, he wrote: no." is
     prose, and cutting there would take the rest of the message with it. */
  const mid = 'I asked and, on Monday when we spoke, he wrote: no.\nSo we are stuck for now.';
  check('a marker mid-sentence is prose, not a header', trimQuoted(mid).text === mid, JSON.stringify(trimQuoted(mid).text));
  check('  ...and a short note above a quote is kept whole',
        trimQuoted('ok\n\n> a very long quoted thing').quoted === '');
  check('nothing at all is not a crash', trimQuoted(undefined).text === '' && trimQuoted(null).quoted === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
