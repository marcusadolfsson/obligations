/**
 * Putting a finished trip away, and getting it back.
 *
 * Alex, 2026-09-19, on `/reference`: "specially for trips, there should be an
 * Archive button. and a filter to see Archived filings."
 *
 * `reference/bookings.md` only grows. Every hotel, car, park day and sitter the
 * mail triage files lands under a `##` trip heading and stays there, so the
 * page opens on a list where last spring's weekend sits above next week's
 * flight. Nothing is wrong with any of it — a trip that has happened is still
 * the answer to "what did that hotel cost" — so this is a shelf, not a bin.
 *
 * ## Why a marker on the heading, not a second file
 *
 * Five things read this file: conflicts.mjs (trip windows for AWAY clashes),
 * bookings-parse.mjs (the calendar entries), bookings-events.mjs,
 * availability.mjs and the reference page. Moving a block to
 * `bookings-archive.md` would hide it from four of them, and the one thing an
 * archived trip must NOT do is quietly stop being a trip — he can archive a
 * future one by mistake, and then his diary and his conflict checks disagree
 * with his own file.
 *
 * So the block does not move. An HTML comment goes on the heading line:
 *
 *     ## Pinecrest · 2026-09-22 → 2026-09-27 <!-- archived 2026-09-19 -->
 *
 * Which every existing reader already ignores, and not by luck:
 *
 *   - `conflicts.trips` takes the name as everything before the first `·` and
 *     finds the dates with a regex, so both still resolve.
 *   - `parseBookings` does the same, and the calendar marker hashes
 *     `trip.name|date|title` — so the hash does not move and no event is
 *     re-created. That mattered: a marker that changed would have put every
 *     booking of that trip in his diary a second time.
 *   - `referenceGroups` strips comments before parsing; it reads the flag off
 *     the raw heading first.
 *
 * It is also reversible by hand in a text editor, which a move is not, and it
 * leaves one file for the triage to append to.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = (vault) => join(vault, 'reference', 'bookings.md');

/** `## Name · dates <!-- archived 2026-09-19 -->` → the stamp, or null. */
export const archivedAt = (heading) =>
  (String(heading ?? '').match(/<!--\s*archived\s+(\d{4}-\d{2}-\d{2})\s*-->/) ?? [])[1] ?? null;

/** The heading with any archive marker removed, trailing space trimmed. */
export const bare = (heading) =>
  String(heading ?? '').replace(/\s*<!--\s*archived[^>]*-->/g, '').trimEnd();

/**
 * Add or remove the marker on one trip.
 *
 * @param name  the trip as the page shows it — the part before the first `·`.
 *              Matched on that alone, because the dates in a heading change
 *              when a booking moves and a button that stops working after an
 *              edit is worse than no button.
 * @returns     { ok, name, archived } or throws with a reason he can read
 */
export async function setArchived(vault, name, archived, { today = new Date() } = {}) {
  const want = String(name ?? '').trim();
  if (!want) throw new Error('which trip?');
  let text;
  try { text = await readFile(FILE(vault), 'utf8'); }
  catch { throw new Error('reference/bookings.md is not there'); }

  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const lines = text.split('\n');
  let hit = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const heading = m[1];
    if (bare(heading).split('·')[0].trim() !== want) continue;
    hit += 1;
    const clean = bare(heading);
    lines[i] = archived ? `## ${clean} <!-- archived ${stamp} -->` : `## ${clean}`;
  }
  /* Nothing matched is an error, never a quiet success. A rename upstream
     would otherwise make the button do nothing for ever, and look fine. */
  if (!hit) throw new Error(`no trip called "${want}" in reference/bookings.md`);

  const next = lines.join('\n');
  if (next !== text) await writeFile(FILE(vault), next);
  return { ok: true, name: want, archived: !!archived, headings: hit, changed: next !== text };
}
