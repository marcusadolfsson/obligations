/**
 * `recurring.md` — obligations that come back every period.
 *
 * The thing this exists for: **each period is its own obligation.** A monthly
 * submission recorded as one line whose due date gets bumped forward loses the
 * only fact worth keeping — that August's went in on the 5th and September's
 * has not. For anything a vendor or a regulator might ask about later, the
 * history is the point.
 *
 * So nothing here is ever rewritten. Instances are *derived*: the period
 * advances because the calendar advances, and whether one is discharged is
 * answered by `logbook.md` rather than by a flag on a line.
 *
 * ## What it models
 *
 * A completed period, reported on shortly after it ends. That is the shape of
 * hours submissions, expense claims, billing runs and timesheets — you report
 * on the month that just finished, by a date in the month after.
 *
 * It is deliberately *not* "do X on the 15th of every month". That has no
 * reporting period and no per-period record, and `reminders.md` with
 * `repeat:1m` already does it.
 *
 * ## Format
 *
 *     ## Aircraft hours          !every:1m !by:8 !from:2026-08
 *
 *     Prose here is a note on the block; it is shown with the task.
 *
 *     - [ ] N200BB to Northwind    !closes:receipt email from Northwind
 *     - [ ] N300CC to Northwind     !closes:receipt email from Northwind
 *
 * Each item under the heading is its own obligation, each period. Four vendor
 * submissions are four items because four receipts arrive separately: one being
 * late must not make the other three look late, and one being done must not
 * make the block look finished.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { appendClose, readCloses } from '../logbook.mjs';

export const SOURCE = 'recurring';

const ITEM = /^\s*[-*]\s+\[( |x|X)\]\s*(.+?)\s*$/;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// How far back to look for periods that were never closed. A missed submission
// must not disappear because the calendar moved on — that is the failure this
// whole system exists to prevent — but an unbounded look-back would surface
// years of phantom backlog the first time a block is written down.
const MAX_LOOKBACK = 6;

const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------ periods */

/**
 * The periods a block should currently show, newest first: the one that just
 * ended, plus any earlier one still open.
 *
 * `from` bounds it. Without one, only the period that just ended is tracked —
 * writing a block down must not immediately invent six months of history that
 * was very likely handled outside this system.
 */
export function periods(every, from, now = new Date()) {
  const out = [];
  const y = now.getFullYear();
  const m = now.getMonth();

  if (every === '1m' || every === '3m') {
    const step = every === '3m' ? 3 : 1;
    // The period that just ended: the month before the one we are in, or the
    // last quarter that has fully finished.
    let cursor = every === '3m'
      ? new Date(y, Math.floor(m / 3) * 3 - 3, 1)
      : new Date(y, m - 1, 1);
    for (let i = 0; i < MAX_LOOKBACK; i++) {
      out.push(periodOf(every, cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() - step, 1);
    }
  } else if (every === '1y') {
    for (let i = 0; i < MAX_LOOKBACK; i++) {
      out.push({ key: String(y - 1 - i), start: new Date(y - 1 - i, 0, 1) });
    }
  } else if (every === '1w') {
    // The week that just ended: Monday of the previous ISO week.
    const monday = new Date(y, m, now.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 7);
    for (let i = 0; i < MAX_LOOKBACK; i++) {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * i);
      out.push({ key: `${d.getFullYear()}-W${pad(isoWeek(d))}`, start: d });
    }
  } else {
    return [];                       // an unknown cadence surfaces nothing
  }

  return from ? out.filter((p) => p.key >= from) : out.slice(0, 1);
}

function periodOf(every, d) {
  if (every === '3m') {
    return { key: `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`, start: d };
  }
  return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, start: d };
}

function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));      // the week's Thursday
  const jan1 = new Date(t.getFullYear(), 0, 1);
  return Math.ceil(((t - jan1) / 86400000 + 1) / 7);
}

/**
 * When a period's report is due: `by`, after the period ends.
 *
 * Day-of-month is clamped to the length of the target month, so `!by:31` in
 * February is the 28th rather than rolling into March. A deadline that slid
 * past the next period's start would be a deadline for the wrong thing.
 */
export function dueFor(every, period, by) {
  const s = period.start;

  if (every === '1w') {
    const want = WEEKDAYS.indexOf(String(by ?? 'fri').toLowerCase().slice(0, 3));
    const d = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7);   // the following week
    d.setDate(d.getDate() + (((want < 0 ? 5 : want) - d.getDay() + 7) % 7));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 09:00`;
  }

  const months = every === '3m' ? 3 : every === '1y' ? 12 : 1;
  const end = new Date(s.getFullYear(), s.getMonth() + months, 1);   // first day after the period
  const lastDay = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
  const day = Math.min(Math.max(Number(by) || 1, 1), lastDay);
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(day)} 09:00`;
}

/* ------------------------------------------------------------------ parsing */

function tags(raw) {
  let text = raw;
  const take = (re) => {
    const m = re.exec(text);
    if (!m) return null;
    text = (text.slice(0, m.index) + text.slice(m.index + m[0].length))
      .replace(/\s{2,}/g, ' ').trim();
    return m[1];
  };
  return {
    every: take(/\s*!every:(\S+)/i),
    by: take(/\s*!by:(\S+)/i),
    from: take(/\s*!from:(\S+)/i),
    priority: take(/\s*!(high|low|normal)\b/i),
    who: take(/\s*@([^\s@#!]+)/),
    // Last, and greedy to end of line: what "done" looks like is a sentence,
    // and every other tag has already been lifted out of the text.
    closes: take(/\s*!closes:(.+)$/i),
  };
}

const strip = (s) => s.replace(/\s*!closes:.*$/i, '')
  .replace(/\s*![a-z]+:\S*/gi, '')
  .replace(/\s*!(high|low|normal)\b/gi, '')
  .replace(/\s{2,}/g, ' ').trim();

function blocks(raw) {
  const out = [];
  let current = null;
  let inComment = false;

  for (const line of raw.split('\n')) {
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.trimStart().startsWith('<!--')) { inComment = !line.includes('-->'); continue; }
    if (line.trimStart().startsWith('>')) continue;         // header documentation

    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = { title: strip(h[1]), ...tags(h[1]), note: '', items: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;

    const m = ITEM.exec(line);
    if (m) {
      if (m[1] !== ' ') continue;              // a ticked template line is not an item
      const body = m[2].trim();
      const t = tags(body);
      const text = strip(body);
      if (text) current.items.push({ text, closes: t.closes, priority: t.priority, who: t.who });
      continue;
    }
    if (line.trim() && !current.items.length) {
      current.note += (current.note ? ' ' : '') + line.trim();
    }
  }
  return out.filter((b) => b.every && b.items.length);
}

export function recurRef(title, item, periodKey) {
  const h = createHash('sha1').update(`${title} ${item}`).digest('hex').slice(0, 12);
  return `recur:${h}:${periodKey}`;
}

/* -------------------------------------------------------------------- source */

export async function read(vault, now = new Date()) {
  let raw;
  try {
    raw = await readFile(join(vault, 'recurring.md'), 'utf8');
  } catch {
    return [];
  }

  const closed = await readCloses(vault);
  const out = [];

  for (const b of blocks(raw)) {
    for (const period of periods(b.every, b.from, now)) {
      const due = dueFor(b.every, period, b.by);
      for (const item of b.items) {
        const ref = recurRef(b.title, item.text, period.key);
        const done = closed.get(ref);
        out.push({
          ref,
          who: item.who ?? null,
          // The period is part of the sentence. "August" is the entire
          // difference between this obligation and next month's.
          title: `${b.title}: ${item.text} (${period.key})`,
          what: `${b.title}: ${item.text} (${period.key})`,
          since: null,
          due,
          priority: item.priority || b.priority || 'normal',
          owed_by: 'me',
          open: !done,
          closes: item.closes ?? b.closes ?? null,
          detail: {
            period: period.key,
            every: b.every,
            note: b.note || null,
            closed_at: done?.at ?? null,
            outcome: done?.outcome ?? null,
          },
        });
      }
    }
  }
  return out;
}

/**
 * What a ref refers to, in words.
 *
 * Deliberately independent of today's date: the ref carries its own period, and
 * looking the label up through the current window would fail for any instance
 * outside it — including, at the start of a month, the very period being
 * closed. A logbook line that says only `recur:9a1c4f:2026-08` is not a record.
 */
async function describe(vault, ref) {
  const period = String(ref).split(':')[2];
  if (!period) return null;

  let raw;
  try {
    raw = await readFile(join(vault, 'recurring.md'), 'utf8');
  } catch {
    return null;
  }
  for (const b of blocks(raw)) {
    for (const item of b.items) {
      if (recurRef(b.title, item.text, period) !== ref) continue;
      return {
        what: `${b.title}: ${item.text} (${period})`,
        closes: item.closes ?? b.closes ?? null,
      };
    }
  }
  return null;
}

/**
 * Discharge one period's instance.
 *
 * Nothing in `recurring.md` changes — it is a definition, not a state file. The
 * close is a line in `logbook.md`, which is also what `read` consults, so the
 * record and the state are the same thing and cannot disagree.
 */
export async function close(vault, ref, who, outcome) {
  const closed = await readCloses(vault);
  if (closed.has(ref)) return { ref, alreadyClosed: true };

  // The ref alone would make the logbook unreadable to a human, which defeats
  // the point of keeping one.
  const row = await describe(vault, ref);

  await appendClose(vault, {
    id: ref,
    what: row?.what ?? ref,
    who,
    outcome: outcome ?? (row?.closes ? `expected: ${row.closes}` : null),
  });
  return { ref, closed: true };
}
