/**
 * Birthdays as a source: today's, as things to do.
 *
 * Alex, 2026-09-05: "Today is my brother's birthday. It should show as a
 * reminder to call him. Get the birthdays from my contact list. For non
 * relatives, help me draft iMessages to send."
 *
 * Two places a birthday can come from, and both are read:
 *
 *   integrations/contacts.json   `birthday: "MM-DD"` per contact, once the Mac
 *                                 extractor is rebuilt to read ZBIRTHDAY (see
 *                                 inbox/2026-09-05-mac-contacts-rebuild.md).
 *                                 Until then this field is simply absent.
 *   people/*.md                   `birthday: MM-DD` in the frontmatter, for the
 *                                 people he has told the assistant about directly.
 *                                 Mia's is there; the Contacts one is not.
 *
 * `relation:` in a people/ file decides the verb. Family is called; everyone
 * else gets a text — and the text is DRAFTED, never sent: an `outbox/` draft
 * with status: draft, which he approves. The obligation here is the reminder;
 * the evening and morning briefs write the draft.
 *
 * Open only on the day. It is a source like todo.md, so it lands on Today and
 * Work with everything else, and a close (the call made, the text sent) writes
 * the logbook like any other.
 *
 * THE RUN-UP. `birthday-prep:` in a people/ file is what has to be ready
 * before the day (dinner plans, flowers), and it is one task that opens
 * PREP_DAYS before the birthday and stays open until he closes it. Alex,
 * 2026-10-16, of two yearly reminders for Mia due eleven months out: "I
 * don't want them existing as a todo until her birthday is actually two
 * weeks out." A reminder is a to-do from the day it is written; this is not
 * one until the window opens, and the next year's comes back by itself.
 * Alex, the same day, of "it stays open through the day": "it should stay
 * open until I close it." A run-up past its birthday is still owed.
 */
import { readCloses } from '../logbook.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SOURCE = 'birthday';
const FAMILY = new Set(['wife', 'husband', 'partner', 'mother', 'father', 'mom', 'dad', 'brother', 'sister',
  'son', 'daughter', 'grandmother', 'grandfather', 'aunt', 'uncle', 'niece', 'nephew', 'cousin',
  'mother-in-law', 'father-in-law', 'brother-in-law', 'sister-in-law']);

const pad = (n) => String(n).padStart(2, '0');
export const PREP_DAYS = 14;
// The run-up existed from this day. Without it the first read would raise
// every birthday of the past year as an unclosed run-up.
export const PREP_SINCE = '2026-10-16';
export const todayMD = (d = new Date()) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** People files with a birthday, plus their relation and a handle to text. */
export async function fromPeople(vault) {
  const dir = join(vault, 'people');
  let names;
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('_')); } catch { return []; }
  const out = [];
  for (const n of names) {
    let text;
    try { text = await readFile(join(dir, n), 'utf8'); } catch { continue; }
    const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const get = (k) => fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const bd = get('birthday').match(/(\d{2})-(\d{2})$/);
    if (!bd) continue;
    const phone = text.match(/\+\d{10,15}/)?.[0] ?? null;
    out.push({ name: get('name') || n.slice(0, -3), md: `${bd[1]}-${bd[2]}`, relation: get('relation').toLowerCase(),
               handle: phone, file: `people/${n}`, prep: get('birthday-prep') || null });
  }
  return out;
}

/** Contacts with a birthday, once the extractor supplies one. */
export async function fromContacts(vault) {
  let d;
  try { d = JSON.parse(await readFile(join(vault, 'integrations', 'contacts.json'), 'utf8')); } catch { return []; }
  const recs = Array.isArray(d) ? d : (d.contacts ?? []);
  const out = [];
  for (const c of recs) {
    const bd = String(c.birthday ?? '').match(/(\d{2})-(\d{2})$/);
    if (!bd) continue;
    const phone = (c.handles ?? []).find((h) => h.kind === 'phone');
    out.push({ name: c.name, md: `${bd[1]}-${bd[2]}`, relation: '', handle: phone ? '+' + String(phone.key).replace(/^\+/, '') : null, file: null });
  }
  return out;
}

/** Merge by name (case-folded); a people/ file wins because it carries relation. */
export function mergeBirthdays(people, contacts) {
  const by = new Map();
  for (const c of contacts) by.set(c.name.toLowerCase(), c);
  for (const p of people) by.set(p.name.toLowerCase(), { ...by.get(p.name.toLowerCase()), ...p });
  return [...by.values()];
}

/**
 * The run-up task for each birthday with a `birthday-prep:`: the next
 * occurrence once it is PREP_DAYS or fewer days away, and the last one while
 * it is not closed. Local dates, midnight to midnight, so the window does not
 * move with the hour of the read.
 */
export function prepTasks(all, closed, now = new Date()) {
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const out = [];
  for (const b of all) {
    if (!b.prep) continue;
    const [m, d] = b.md.split('-').map(Number);
    let next = new Date(day0.getFullYear(), m - 1, d);
    if (next < day0) next = new Date(day0.getFullYear() + 1, m - 1, d);
    const last = new Date(next.getFullYear() - 1, m - 1, d);
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    for (const day of [last, next]) {
      const opens = new Date(day.getFullYear(), day.getMonth(), day.getDate() - PREP_DAYS);
      if (opens > day0 || stamp(opens) < PREP_SINCE) continue;
      const ref = `birthday:${stamp(day)}:${slug}:prep`;
      // A past one that is closed is history, not a row.
      if (day === last && closed.has(ref)) continue;
      out.push({
        ref,
        who: b.handle ?? b.name,
        what: `${b.name}'s birthday is ${day.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} — ${b.prep}`,
        since: `${stamp(opens)} 00:00`,
        due: `${stamp(opens)} 09:00`,
        priority: 'normal',
        owed_by: 'me',
        open: !closed.has(ref),
        closes: `done: ${b.prep}`,
        tags: ['birthday'],
        detail: { kind: 'birthday-prep', relation: b.relation || null, file: b.file, birthday: stamp(day) },
      });
    }
  }
  return out;
}

export async function read(vault, today = todayMD(), now = new Date()) {
  const all = mergeBirthdays(await fromPeople(vault), await fromContacts(vault));
  const y = new Date().getFullYear();
  // "A close is the logbook line" — so the logbook has to be read, or a
  // birthday he has already handled sits on Today until midnight. It did:
  // Ben's stayed open after its close on 2026-09-05, the day this was found.
  const closed = await readCloses(vault);
  return [...all.filter((b) => b.md === today).map((b) => {
    const family = FAMILY.has(b.relation);
    const ref = `birthday:${y}-${b.md}:${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return {
      ref,
      who: b.handle ?? b.name,
      what: family ? `Call ${b.name} — birthday today${b.relation ? ` (${b.relation})` : ''}`
                   : `Wish ${b.name} a happy birthday — text (draft in outbox/)`,
      since: `${y}-${b.md} 00:00`,
      due: `${y}-${b.md} 21:00`,
      priority: 'high',
      owed_by: 'me',
      open: !closed.has(ref),
      closes: family ? 'the call happened' : 'the text was sent',
      tags: ['birthday'],
      detail: { kind: 'birthday', relation: b.relation || null, family, file: b.file, handle: b.handle },
    };
  }), ...prepTasks(all, closed, now)];
}

/** Nothing to write: the day passes and it is gone. A close is the logbook line. */
export async function close(vault, ref) { return { ref, closed: true }; }
