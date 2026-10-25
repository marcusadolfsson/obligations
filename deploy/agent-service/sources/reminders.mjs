/**
 * `reminders.md` as an obligation source.
 *
 * A reminder and an unanswered message are the same kind of thing — something
 * owed, with a since and a who — and the only real difference is that a
 * reminder carries a time somebody chose. So it is a source like any other, and
 * `due` is the field that makes it sort to the top.
 *
 * The dispatcher owns this file's *nagging*: `nags:` and `last:` are its state
 * and nothing here touches them. Closing is the one write, and it does what
 * `rules/reminders.md` says a disposition of "done" does — check the box, move
 * it to `## Done`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { localDate, parseStamp } from '../time.mjs';

export const SOURCE = 'reminder';

// The field order the dispatcher's regex depends on. Kept identical here on
// purpose: two parsers for one line format, and the other one is load-bearing
// every minute. If this drifts, reminders stop being pushed.
const LINE =
  /^- \[( |x|X)\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \| (.+?) \| (gentle|normal|hard) \| repeat:(\S+) \| nags:(\d+) \| last:(\S+)\s*$/;

export function reminderRef(text) {
  return 'rem:' + createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/**
 * How loud a reminder should be *today*, from its class and how far off it is.
 *
 * CLASS on its own is not urgency. `hard` says the consequence is real when the
 * day comes — it does not say the day is close. Mapping hard straight to `high`
 * put a token expiry three weeks out above messages that had been sitting
 * unanswered for twelve days, which is precisely backwards: one of those needs
 * doing today and the other does not.
 *
 * So: class sets the ceiling, lead time decides how much of it applies. A hard
 * reminder climbs to high three days out and is overdue-high after that; a
 * gentle one never shouts, which is what gentle means.
 */
export function urgency(cls, due, now = Date.now()) {
  const at = parseStamp(due);
  if (!Number.isFinite(at)) return cls === 'hard' ? 'high' : 'normal';

  // Whole days until it is due; negative once it has passed.
  const lead = Math.floor((at - now) / 86400000);

  if (cls === 'gentle') return lead < 0 ? 'normal' : 'low';
  if (lead < 0) return 'high';                     // overdue is always loud
  if (cls === 'hard') return lead <= 3 ? 'high' : lead <= 14 ? 'normal' : 'low';
  return lead <= 3 ? 'normal' : 'low';             // normal class
}

/** Whole days until due; negative when overdue, null when unparseable. */
export function leadDays(due, now = Date.now()) {
  const at = parseStamp(due);
  return Number.isFinite(at) ? Math.floor((at - now) / 86400000) : null;
}

/**
 * Active reminders only. `## Stalled` is deliberately excluded: those are
 * reminders that were nagged four times without a disposition, and
 * `rules/reminders.md` says they are reviewed on Sundays and not nagged in
 * between. Putting them back on the tasks page every day is the nagging that
 * rule exists to stop.
 */
export async function read(vault) {
  let raw;
  try {
    raw = await readFile(join(vault, 'reminders.md'), 'utf8');
  } catch {
    return [];
  }

  const out = [];
  let section = '';
  let inComment = false;

  for (const line of raw.split('\n')) {
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.trimStart().startsWith('<!--')) { inComment = !line.includes('-->'); continue; }

    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    if (section !== 'active') continue;

    const m = LINE.exec(line);
    if (!m || m[1] !== ' ') continue;

    const [, , due, text, cls, repeat, nags, last] = m;
    out.push({
      ref: reminderRef(text),
      who: null,
      what: text,
      // A reminder's "since" is when it was set, which the line does not
      // record — only when it is next due. Age is meaningless here and the due
      // date is the whole point, so it says so rather than inventing one.
      since: null,
      due,
      priority: urgency(cls, due),
      owed_by: 'me',
      open: true,
      detail: {
        class: cls, repeat, nags: Number(nags), last: last && last !== '-' ? last.replace('T', ' ') : null,
        lead_days: leadDays(due),
        overdue: parseStamp(due) < Date.now(),
      },
    });
  }
  return out;
}

/**
 * Disposition "done": check the box and move it under `## Done`.
 *
 * The line's fields are carried across untouched. `rules/reminders.md` requires
 * that a reminder the *agent* closed says so; a close from here is Alex
 * pressing the button, so it does not — an unannotated `[x]` means he did it.
 */
/**
 * Move a reminder's due date by hand. Alex, 2026-09-06: "on a reminder, add
 * the ability to change the due date manually." rules/reminders.md's snooze
 * row is the contract: a new DUE resets `nags:0` and `last:-`, because the
 * ladder starts again from the new time. The text is untouched, so the ref —
 * a hash of the text — survives and the pane stays on the same item.
 */
export async function reschedule(vault, ref, due, who) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(due ?? ''))) throw new Error('due must be YYYY-MM-DD HH:MM');
  if (Number.isNaN(Date.parse(String(due).replace(' ', 'T')))) throw new Error(`${due} is not a real date`);
  const path = join(vault, 'reminders.md');
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');
  let section = '', found = -1, m = null;
  for (let i = 0; i < lines.length && found < 0; i++) {
    const h = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    if (section !== 'active') continue;
    const mm = LINE.exec(lines[i]);
    if (mm && mm[1] === ' ' && reminderRef(mm[3]) === ref) { found = i; m = mm; }
  }
  if (found < 0) throw new Error('no open reminder with that id');
  const [, , was, text, cls, repeat] = m;
  lines[found] = `- [ ] ${due} | ${text} | ${cls} | repeat:${repeat} | nags:0 | last:-`;
  await writeFile(path, lines.join('\n'));
  return { ref, text, was, due, by: who ?? null };
}

export async function close(vault, ref, who) {
  const path = join(vault, 'reminders.md');
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');

  let section = '';
  let found = -1;
  for (let i = 0; i < lines.length && found < 0; i++) {
    const h = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    if (section !== 'active') continue;
    const m = LINE.exec(lines[i]);
    if (m && m[1] === ' ' && reminderRef(m[3]) === ref) found = i;
  }
  if (found < 0) return { ref, alreadyClosed: true };

  const line = lines[found].replace('- [ ]', '- [x]');
  lines.splice(found, 1);

  // Insert directly under the `## Done` heading, newest first, so the weekly
  // sweep reads them in the order they were closed.
  let done = lines.findIndex((l) => /^##\s+Done\s*$/i.test(l));
  if (done < 0) {
    lines.push('', '## Done', '');
    done = lines.length - 2;
  }
  lines.splice(done + 1, 0, '', line);

  await writeFile(path, lines.join('\n'));
  return { ref, closed: true, at: localDate() };
}
