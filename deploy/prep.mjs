#!/usr/bin/env node
/**
 * Meeting prep: what a chief of staff hands you walking into the room.
 *
 * Alex, 2026-09-05, from the audit: "It reports, but doesn't prepare. Meeting
 * prep today is a one-line 'who is this' per attendee. A CoS walking you into
 * Hank's meeting says: last time he raised donor privacy; you owe him the
 * Industry Day spec; he's chased once; here's the doc." All of that was in the
 * repo and none of it was assembled before a meeting.
 *
 * This assembles it. Deterministic — no model. Every line here is a fact the
 * system already holds (people.mjs, open obligations, the last exchange), and
 * assembling facts is arithmetic. A model could write a nicer paragraph; it
 * would also cost $2 per meeting and occasionally invent a detail, and the one
 * thing a prep note must never do is tell him something about a person that is
 * not true.
 *
 * Runs from the dispatcher's minute tick. For each event starting within
 * LEAD_MIN minutes that has attendees other than him, and has not been prepped
 * (.log/prep-sent.json), it writes a `prep` message. `prep` is pushable: this is
 * the one message whose value is entirely in its timing.
 *
 * Events with no other attendees — "Apple Event", a dentist — get nothing: a
 * prep note about a meeting with nobody is a reminder, and reminders have their
 * own channel with its own budget.
 *
 *   node deploy/prep.mjs             # write any due prep notes
 *   node deploy/prep.mjs --dry       # print what would be written
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { peopleIndex, handle } from './agent-service/people.mjs';
import { localStamp } from './agent-service/time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEAD_MIN = 60;                  // how far ahead a prep goes out
const SENT = join(OBLIGATIONS, '.log', 'prep-sent.json');
const DRY = process.argv.includes('--dry');

const ms = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };

/** Events starting in the next LEAD_MIN minutes, with someone else in them. */
export function dueEvents(cal, now = Date.now(), lead = LEAD_MIN) {
  const all = [...(cal?.today ?? []), ...(cal?.upcoming ?? [])];
  return all.filter((e) => {
    const start = e.startsAt ? ms(e.startsAt) : 0;
    if (!start) return false;                        // all-day: nothing to walk into
    const others = (e.attendees ?? []).filter((a) => !a.self && a.email);
    if (!others.length) return false;
    const ahead = start - now;
    return ahead > 0 && ahead <= lead * 60000;
  });
}

/** The note itself, from the graph. Exported so it can be tested without a clock. */
export function composePrep(event, people) {
  const others = (event.attendees ?? []).filter((a) => !a.self && a.email);
  const lines = [];
  const when = String(event.startsAt ?? '').slice(11, 16);
  lines.push(`**${event.summary ?? '(untitled)'}** · ${when}`
    + (event.location ? ` · ${event.location}` : '')
    + (event.conference ? ` · ${event.conference}` : ''));
  if (event.myResponse === 'needsAction') {
    lines.push('', '_You have not answered this invitation._');
  }

  let youOwe = 0, theyOwe = 0, strangers = 0;
  for (const a of others) {
    const p = people.find((x) => x.handles.includes(handle(a.email)) || x.key === handle(a.email));
    const label = p?.name && p.name !== handle(a.email) ? p.name : (a.name || a.email);
    lines.push('', `### ${label}` + (p?.org ? ` — ${p.org}` : '') + (a.organizer ? ' (organiser)' : ''));
    if (!p) {
      strangers++;
      lines.push(`- ${a.email} — no history with them here.`);
      continue;
    }
    if (p.how) lines.push(`- ${p.how}`);
    if (p.last) lines.push(`- Last exchange ${p.last}${p.lastSubject ? ` — ${p.lastSubject}` : ''}. ${p.threads} thread${p.threads === 1 ? '' : 's'} on record.`);
    if (p.owedByMe.length) {
      youOwe += p.owedByMe.length;
      lines.push(`- **You owe them:**`);
      for (const o of p.owedByMe) lines.push(`  - ${o.title}${o.overdue ? ' — **overdue**' : o.due ? ` — due ${String(o.due).slice(0, 10)}` : ` — ${o.days}d`}`);
    }
    if (p.owedByThem.length) {
      theyOwe += p.owedByThem.length;
      lines.push(`- **They owe you:**`);
      for (const o of p.owedByThem) lines.push(`  - ${o.title} — ${o.days}d`);
    }
    if (!p.owedByMe.length && !p.owedByThem.length) lines.push('- Nothing open between you.');
    if (p.file) lines.push(`- [${p.file}](/notes#${encodeURIComponent(p.file)})`);
  }

  // The title is the whole note for someone who only reads titles.
  const bits = [];
  if (youOwe) bits.push(`you owe ${youOwe}`);
  if (theyOwe) bits.push(`owed ${theyOwe}`);
  if (strangers) bits.push(`${strangers} new`);
  const title = `${when} ${event.summary ?? 'meeting'} — ${others.length === 1
    ? (people.find((x) => x.handles.includes(handle(others[0].email)))?.name ?? others[0].email)
    : others.length + ' people'}${bits.length ? ': ' + bits.join(', ') : ''}`;

  return { title, body: lines.join('\n') };
}

/** Write one messages/ file. Same shape as deploy/messages.py write_message. */
async function writeMessage(vault, kind, title, body, when = new Date()) {
  const dir = join(vault, 'messages');
  await mkdir(dir, { recursive: true });
  const stamp = localStamp(when).replace(' ', '-').replace(':', '');
  let path = join(dir, `${stamp}-${kind}.md`);
  for (let n = 2; ; n++) {
    try { await readFile(path); path = join(dir, `${stamp}-${kind}-${n}.md`); }
    catch { break; }
  }
  const esc = (v) => String(v).replace(/\n/g, ' ').replace(/^(['"])/, '\\$1');
  await writeFile(path,
    `---\ntype: message\nkind: ${kind}\nat: ${localStamp(when)}\ntitle: ${esc(title)}\n`
    + `read: false\ndelivered: none\n---\n\n${body.trimEnd()}\n`);
  return path;
}

export async function run(vault = OBLIGATIONS, now = Date.now()) {
  let cal;
  try { cal = JSON.parse(await readFile(join(vault, 'integrations', 'calendar.json'), 'utf8')); }
  catch { return { written: [], skipped: 'calendar.json unreadable' }; }
  if (cal.error) return { written: [], skipped: `calendar: ${cal.error}` };

  let sent = {};
  try { sent = JSON.parse(await readFile(SENT, 'utf8')); } catch { /* first run */ }

  const due = dueEvents(cal, now).filter((e) => !sent[e.id]);
  if (!due.length) return { written: [], skipped: null };

  const { people } = await peopleIndex(vault);
  const written = [];
  for (const e of due) {
    const { title, body } = composePrep(e, people);
    if (DRY) { console.log(`--- ${title}\n${body}\n`); continue; }
    written.push(await writeMessage(vault, 'prep', title, body));
    sent[e.id] = localStamp();
  }
  if (!DRY) {
    // Prune anything older than two days so this file does not grow forever.
    const cutoff = localStamp(new Date(now - 2 * 86400000));
    for (const [id, at] of Object.entries(sent)) if (at < cutoff) delete sent[id];
    await mkdir(dirname(SENT), { recursive: true });
    await writeFile(SENT, JSON.stringify(sent, null, 2) + '\n');
  }
  return { written, skipped: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await run();
  if (r.skipped) console.log(`prep: skipped — ${r.skipped}`);
  else if (r.written.length) console.log(`prep: wrote ${r.written.length}\n  ${r.written.join('\n  ')}`);
  else if (!DRY) console.log('prep: nothing due');
}
