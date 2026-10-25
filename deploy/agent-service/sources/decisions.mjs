/**
 * `decisions.md` as a source: choices waiting on Alex, kept apart from debts.
 *
 * Alex, 2026-09-05, from the chief-of-staff audit: "Decisions are modelled as
 * debts, and they aren't. The cabinet quotes: five bids, one choice. The assistant
 * tracked five obligations — five threads you 'owe' a reply to. But choosing a
 * vendor isn't owed to anyone; it's a decision with options, a recommendation,
 * and a deadline."
 *
 * So a decision is its own thing in its own file, and this reads it into the
 * same task list as everything else — because "what is outstanding" has to
 * include "what have I not decided", and a second list is a list he stops
 * reading. It arrives tagged `decision`, owed by him, so the tasks page and the
 * briefs can pull it into its own section without a second merge.
 *
 * The file format is a heading per decision and a few labelled lines under it:
 *
 *   ## Cabinetry vendor for ONE 2201/2202  !due:2026-09-12  #one
 *   - options: MWC $220,716 · ARKO · Summitline (install incl.) · Quality Cabinets Co · Crestline
 *   - recommend: Summitline — only bid with install; get a firm number
 *   - blocked: Quality Cabinets Co proposal not yet in
 *   - decided: 2026-09-10 Summitline — <why>            <- closes it
 *
 * `decided:` is the close. A decision is discharged by making it, and the line
 * that records the choice IS the outcome — which is why close() here writes
 * that line rather than deleting the section. A decided decision stays in the
 * file as the record of why, the same way a ticked todo stays in todo.md.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseStamp, localStamp } from '../time.mjs';

export const SOURCE = 'decision';
const FILE = 'decisions.md';

export function decisionId(title) {
  return 'decision:' + createHash('sha1').update(title.trim().toLowerCase()).digest('hex').slice(0, 12);
}

/** Split the file into decisions. Exported for the tests. */
export function parseDecisions(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text ?? '').split('\n')) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      let title = h[1];
      const due = title.match(/\s*!due:(\d{4}-\d{2}-\d{2})\b/);
      const project = title.match(/(?:^|\s)#([^\s@#!]+)/);
      title = title.replace(/\s*!due:\d{4}-\d{2}-\d{2}\b/, '').replace(/(?:^|\s)#[^\s@#!]+/, '').trim();
      if (!title) { cur = null; continue; }
      cur = { title, due: due ? due[1] : null, project: project ? project[1] : null,
              options: [], recommend: null, blocked: null, decided: null, notes: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = raw.match(/^\s*[-*]\s+(options|recommend|blocked|decided|why)\s*:\s*(.*\S)\s*$/i);
    if (kv) {
      const k = kv[1].toLowerCase(), v = kv[2];
      // Split on the middle dot or a bar only. A semicolon lives inside an
      // option ("laundry, pantry; 3 PDFs") and splitting on it made five
      // options read as eight.
      if (k === 'options') cur.options = v.split(/\s+·\s+|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
      else if (k === 'why') cur.notes.push(v);
      else cur[k] = v;
    } else if (/^\s*[-*]\s+\S/.test(raw)) {
      cur.notes.push(raw.replace(/^\s*[-*]\s+/, '').trim());
    }
  }
  return out;
}

export async function read(vault) {
  let raw;
  try { raw = await readFile(join(vault, FILE), 'utf8'); } catch { return []; }
  const now = Date.now();
  return parseDecisions(raw)
    .filter((d) => !d.decided)                        // decided ones are the record, not the list
    .map((d) => ({
      ref: decisionId(d.title),
      who: null,                                      // owed to nobody — that is the point
      what: d.title,
      since: null,
      due: d.due,
      priority: d.due && parseStamp(d.due + ' 23:59') < now ? 'high' : 'normal',
      owed_by: 'me',
      open: true,
      closes: 'a `decided:` line under it in decisions.md',
      project: d.project,
      // `decision` rides in as a tag so the tasks page and the briefs can pull
      // these into their own section from the merged list, without a second
      // merge or a second page.
      tags: ['decision'],
      detail: { kind: 'decision', options: d.options, recommend: d.recommend,
                blocked: d.blocked, notes: d.notes, project: d.project },
    }));
}

/**
 * Decide it. Appends `- decided: <date> <outcome>` under the heading. The
 * section stays — a decision's record is the reasons, and deleting them is how
 * you end up re-litigating the same choice in six months.
 */
export async function close(vault, ref, who = 'agent', outcome = '') {
  const path = join(vault, FILE);
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch { return { ref, alreadyClosed: true }; }
  const lines = raw.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!h) continue;
    const title = h[1].replace(/\s*!due:\d{4}-\d{2}-\d{2}\b/, '').replace(/(?:^|\s)#[^\s@#!]+/, '').trim();
    if (decisionId(title) === ref) { start = i; break; }
  }
  if (start < 0) return { ref, alreadyClosed: true };
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  if (lines.slice(start, end).some((l) => /^\s*[-*]\s+decided\s*:/i.test(l))) return { ref, alreadyClosed: true };
  // His day, not UTC's: closed after 20:00 in the state, toISOString was tomorrow.
  const today = localStamp().slice(0, 10);
  // Insert before the trailing blank lines of the section, so the file stays tidy.
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, `- decided: ${today} ${outcome || '(no reason recorded)'}`.trimEnd());
  await writeFile(path, lines.join('\n'));
  return { ref, closed: true };
}
