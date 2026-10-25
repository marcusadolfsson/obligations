/**
 * The day's closes, as a cross-check.
 *
 * Almost all of this is the parser, because logbook.md is append-only and
 * authoritative: a line that parses wrong is a close that gets reported against
 * the wrong obligation, or an outcome that reads as part of the conclusion. And
 * the `what` field is prose a model wrote about a mail thread, so it contains
 * pipes, newlines' worth of clauses, and the word "by" — every separator this
 * format uses.
 */
import { parseLogbook, closedSince } from '../closed.mjs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('Parsing a logbook line');
{
  const one = parseLogbook(
    '- 2026-09-04 18:02 | im:any;-;clara@rivera.example | his mother\'s surgery '
    + '| by agent:assistant | He rang and spoke to Della')[0];
  check('the date and time come out', one?.date === '2026-09-04' && one?.time === '18:02');
  check('the id comes out', one?.id === 'im:any;-;clara@rivera.example', one?.id);
  check('the conclusion comes out', one?.what === "his mother's surgery", one?.what);
  check('who closed it comes out', one?.by === 'agent:assistant', one?.by);
  check('the outcome comes out', one?.outcome === 'He rang and spoke to Della', one?.outcome);
}

console.log('\nThe separators that actually appear in the data');
{
  // A real conclusion contains pipes. Splitting naively on "|" mangles it and
  // the outcome ends up holding half the conclusion.
  const piped = parseLogbook(
    '- 2026-09-03 18:19 | mail:a:1 | boxes 1 | 20 are accurate | and item L | rolled forward '
    + '| by agent:assistant | DeLuca confirmed payment')[0];
  check('a conclusion containing pipes survives',
        piped?.what === 'boxes 1 | 20 are accurate | and item L | rolled forward', piped?.what);
  check('...and the outcome is still just the outcome',
        piped?.outcome === 'DeLuca confirmed payment', piped?.outcome);

  // "by" appears in ordinary prose, so anchoring on the FIRST " | by " is wrong.
  const by = parseLogbook(
    '- 2026-09-03 10:00 | mail:a:2 | filed by the preparer | and reviewed '
    + '| by agent:assistant | closed on the receipt')[0];
  check('a conclusion containing the word "by" does not split early',
        by?.what === 'filed by the preparer | and reviewed', by?.what);
  check('...and who closed it is right', by?.by === 'agent:assistant', by?.by);

  // An outcome may contain pipes too — only the first " | " after "by" splits.
  const po = parseLogbook('- 2026-09-03 10:00 | mail:a:3 | x | by agent:assistant | a | b')[0];
  check('an outcome containing a pipe survives', po?.outcome === 'a | b', po?.outcome);
}

console.log('\nLines that are not closes');
{
  check('a heading is skipped', parseLogbook('# logbook').length === 0);
  check('a blank line is skipped', parseLogbook('\n\n').length === 0);
  check('prose is skipped', parseLogbook('- something without a stamp').length === 0);
  check('null does not throw', parseLogbook(null).length === 0);
  const noOutcome = parseLogbook('- 2026-09-04 10:00 | mail:a:4 | just a conclusion')[0];
  check('a line with no "by" still parses', noOutcome?.id === 'mail:a:4', JSON.stringify(noOutcome));
  check('...with a null outcome rather than a guess', noOutcome?.outcome === null);
}

console.log('\nThe report');
{
  const dir = await mkdtemp(join(tmpdir(), 'closed-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'logbook.md'),
    '# logbook\n'
    + '- 2026-09-01 09:00 | mail:a:old | old thing | by agent:assistant | done then\n'
    + '- 2026-09-04 07:05 | mail:a:1 | a thing | by agent:assistant | evidence one\n'
    + '- 2026-09-05 07:03 | mail:a:2 | another | by alex | he ticked it\n'
    + '- 2026-09-04 18:02 | mail:a:3 | third | by agent:evening | evidence three\n');

  const out = await closedSince(dir, '2026-09-04');
  check('the window excludes older lines', out.rows.length === 3, JSON.stringify(out.rows.map(r => r.id)));
  check('rows are in chronological order',
        out.rows.map((r) => r.id).join(',') === 'mail:a:1,mail:a:3,mail:a:2',
        out.rows.map((r) => `${r.date} ${r.time}`).join(' | '));

  // The distinction that makes this a cross-check rather than a summary.
  check('agent closes are marked', out.rows.filter((r) => r.agent).length === 2);
  check('...and his own are not', out.rows.find((r) => r.by === 'alex')?.agent === false);
  check('the agent count is reported', out.counts.byAgent === 2);

  // Titles come from the obligations; with none available it falls back to the
  // conclusion rather than showing nothing.
  check('a missing title falls back to the conclusion', out.rows[0].title === 'a thing',
        out.rows[0].title);

  const missing = await closedSince(join(dir, 'nope'), '2026-09-04');
  check('an unreadable logbook is an error, not an empty day',
        missing.error !== null && missing.rows.length === 0,
        'nothing closed and could not check must never look the same');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
