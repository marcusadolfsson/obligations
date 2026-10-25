/**
 * Archiving a trip must not stop it being a trip.
 *
 * Alex, 2026-09-19: "specially for trips, there should be an Archive button.
 * and a filter to see Archived filings."
 *
 * The marker goes in an HTML comment on the `##` heading, and the reason that
 * is safe is not obvious — four other readers parse those headings, and one of
 * them hashes the trip name into a calendar marker. If that hash moved, every
 * booking of the archived trip would be re-created in his diary. So most of
 * what is pinned here is what archiving DOES NOT change.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setArchived, archivedAt, bare } from './trip-archive.mjs';
import { parseBookings } from '../bookings-parse.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

const FILE = `## Pinecrest · 2026-09-22 → 2026-09-27
- 2026-09-22 · **Hotel Joel** · conf 7781234
- 2026-09-23 09:00 · Ski hire · Pinecrest Sports

## Not travel
- 2026-08-29 · **Harbor Inn Express Cape Harbor** · conf 60000041
`;

const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
await mkdir(join(vault, 'reference'), { recursive: true });
const write = (t) => writeFile(join(vault, 'reference', 'bookings.md'), t);
const readBack = () => readFile(join(vault, 'reference', 'bookings.md'), 'utf8');

console.log('the marker');
check('a bare heading is not archived', archivedAt('Pinecrest · 2026-09-22 → 2026-09-27') === null);
check('a marked one gives its date', archivedAt('Pinecrest · dates <!-- archived 2026-09-19 -->') === '2026-09-19');
check('bare() takes the marker back off', bare('Pinecrest · dates <!-- archived 2026-09-19 -->') === 'Pinecrest · dates');
check('and leaves an unmarked heading alone', bare('Pinecrest · dates') === 'Pinecrest · dates');

console.log('\narchiving, and putting it back');
{
  await write(FILE);
  const r = await setArchived(vault, 'Pinecrest', true, { today: new Date('2026-09-19T10:00:00') });
  const out = await readBack();
  check('it reports what it touched', r.ok && r.headings === 1 && r.archived);
  check('the marker lands on the heading', /^## Pinecrest · 2026-09-22 → 2026-09-27 <!-- archived 2026-09-19 -->$/m.test(out), out.split('\n')[0]);
  check('and no other trip is touched', /^## Not travel$/m.test(out));
  check('the bookings under it are untouched', out.includes('conf 7781234') && out.includes('Ski hire'));

  /* THE CALENDAR MARKER MUST NOT MOVE. `parseBookings` hashes
     `trip.name|date|title`, and the name is everything before the first `·` —
     so the comment, which comes after the dates, cannot reach it. If this ever
     fails, archiving a trip silently duplicates every one of its events. */
  const before = parseBookings(FILE).map((b) => b.marker);
  const after = parseBookings(out).map((b) => b.marker);
  check('every calendar marker survives archiving', before.length > 1 && before.join(',') === after.join(','),
    `${before.join(',')}\n         ${after.join(',')}`);
  check('and the trip name is still clean', parseBookings(out)[0].trip.name === 'Pinecrest');
  /* And it is still a trip with a window, so conflicts.mjs keeps seeing it.
     An archived trip he is actually on must still clash with a meeting. */
  const heading = out.split('\n').find((l) => l.startsWith('## Pinecrest'));
  check('the dates are still findable on the heading', /(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})/.test(heading));

  const back = await setArchived(vault, 'Pinecrest', false);
  const restored = await readBack();
  check('restoring removes the marker exactly', !back.archived && /^## Pinecrest · 2026-09-22 → 2026-09-27$/m.test(restored));
  check('and the file is byte-identical to where it started', restored === FILE, JSON.stringify(restored.slice(0, 60)));
}

console.log('\nrefusals — a button that does nothing must say so');
{
  await write(FILE);
  let said = '';
  try { await setArchived(vault, 'Reykjavik', true); } catch (err) { said = err.message; }
  check('a trip that is not there is an error, not a quiet success', /no trip called/.test(said), said);
  let blank = '';
  try { await setArchived(vault, '   ', true); } catch (err) { blank = err.message; }
  check('and so is no name at all', /which trip/.test(blank), blank);
  check('neither wrote anything', (await readBack()) === FILE);

  // Archiving twice is the same as archiving once — no stacked markers.
  await setArchived(vault, 'Pinecrest', true, { today: new Date('2026-09-19T10:00:00') });
  await setArchived(vault, 'Pinecrest', true, { today: new Date('2026-09-20T10:00:00') });
  const twice = await readBack();
  check('archiving twice leaves one marker, not two',
    (twice.match(/archived/g) ?? []).length === 1 && /archived 2026-09-20/.test(twice), twice.split('\n')[0]);
}

await rm(vault, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
