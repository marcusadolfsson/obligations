/**
 * `logbook.md` — every obligation that has been discharged, and how.
 *
 * Append-only, like the journal, and for the same reason: it is the record of
 * what actually happened, not a cache of the current state. Ticking a box in
 * `todo.md` says an item is no longer outstanding; it does not say when it was
 * done, by whom, or on what evidence — and for anything a vendor or a regulator
 * might ask about later, that is the part worth keeping.
 *
 * It is also the recurring adapter's memory. "Did August's hours go to Northwind?"
 * is answered here rather than by a flag on a line that gets rewritten every
 * month, which is why a monthly submission has a history at all.
 *
 * Pipe-delimited to match `reminders.md`, so one grep reads both:
 *
 *   - AT | ID | WHAT | by WHO | OUTCOME
 */
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localStamp } from './time.mjs';

const LINE = /^-\s+(\S+ \S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*by ([^|]*?)\s*(?:\|\s*(.*?))?\s*$/;

const HEADER = `# Logbook

> Append-only. One line per obligation discharged: when, what, who closed it,
> and what closed it. Never edit or delete a line — this is the record, and
> \`rules/knowledge.md\` explains why the recurring adapter depends on it.
>
> \`- AT | ID | WHAT | by WHO | OUTCOME\`

`;

// A free-text field must never eat the delimiter. Newlines would end the record
// entirely, which is worse: the rest of the note would read as a new entry.
const clean = (s) => String(s ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

export async function appendClose(vault, { id, what, who, outcome }) {
  const path = join(vault, 'logbook.md');
  let head = '';
  try {
    await readFile(path, 'utf8');
  } catch {
    head = HEADER;                      // first write creates the file with its contract
  }
  const line = `- ${localStamp()} | ${clean(id)} | ${clean(what)} | by ${clean(who) || 'unknown'}` +
               (outcome ? ` | ${clean(outcome)}` : '') + '\n';
  await appendFile(path, head + line);
  return line.trim();
}

/**
 * Everything ever closed, newest last, indexed by id.
 *
 * An id can appear more than once — a recurring obligation reopened and closed
 * again, or a line hand-corrected. The last entry wins, because the last thing
 * that happened is what is true now.
 */
export async function readCloses(vault) {
  let raw;
  try {
    raw = await readFile(join(vault, 'logbook.md'), 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const line of raw.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    out.set(m[2], { at: m[1], id: m[2], what: m[3], who: m[4], outcome: m[5] ?? null });
  }
  return out;
}
