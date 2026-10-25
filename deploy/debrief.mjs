#!/usr/bin/env node
/**
 * The debrief: prep's other half.
 *
 * Alex, 2026-09-05, re-audit: "Prep walks you into the room. Nothing asks what
 * happened when you walk out. The journal only fills at 18:00 from calendar and
 * mail, so a meeting's agreements — 'I told Hank Tuesday' — exist only if you
 * type them."
 *
 * Twenty minutes after a meeting with someone else in it ends, this writes a
 * `debrief` message: who it was, what you owed them going in, and one question
 * — what was agreed, and what do you now owe? It links to the chat with the
 * answer box pre-filled ("Debrief PHOA — Industry Day: "), so the reply is one
 * tap and a sentence. The chat then does what CLAUDE.md says a debrief reply
 * means: journal `## Happened` and `## Said I'd do` today, obligations for what
 * he committed to, and nothing else.
 *
 * Deterministic, like prep.mjs, and for the same reason: it assembles facts the
 * repo holds and asks one question. Idempotent through .log/debrief-sent.json.
 * Pushable — a debrief an hour late is answered from memory that has already
 * faded, and the whole value is catching the agreements while they are fresh.
 *
 *   node deploy/debrief.mjs         # write any due debriefs
 *   node deploy/debrief.mjs --dry
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { peopleIndex, handle } from './agent-service/people.mjs';
import { localStamp } from './agent-service/time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AFTER_MIN = 20;          // how long after the end it asks
export const WINDOW_MIN = 120;        // and for how long it is still worth asking
const SENT = join(OBLIGATIONS, '.log', 'debrief-sent.json');
const DRY = process.argv.includes('--dry');
const ms = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };

/** Meetings that ended AFTER_MIN..AFTER_MIN+WINDOW_MIN minutes ago, with someone else in them. */
export function endedEvents(cal, now = Date.now(), { after = AFTER_MIN, window = WINDOW_MIN } = {}) {
  const all = [...(cal?.today ?? []), ...(cal?.upcoming ?? [])];
  return all.filter((e) => {
    if (e.mine === false) return false;                                   // not his meeting
    const end = e.endsAt ? ms(e.endsAt) : 0;
    if (!end) return false;                                               // all-day: nothing to debrief
    const others = (e.attendees ?? []).filter((a) => !a.self && a.email);
    if (!others.length) return false;
    const since = now - end;
    return since >= after * 60000 && since <= (after + window) * 60000;
  });
}

/** The message. Exported for the tests. */
export function composeDebrief(event, people) {
  const others = (event.attendees ?? []).filter((a) => !a.self && a.email);
  const names = others.map((a) => {
    const p = people.find((x) => x.handles.includes(handle(a.email)) || x.key === handle(a.email));
    return p?.name && p.name !== handle(a.email) ? p.name : (a.name || a.email);
  });
  const owed = others.flatMap((a) => {
    const p = people.find((x) => x.handles.includes(handle(a.email)));
    return (p?.owedByMe ?? []).map((o) => `${p.name}: ${o.title}`);
  });
  const who = names.length === 1 ? names[0] : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
  const lines = [
    `**${event.summary ?? 'Meeting'}** with ${names.join(', ')} — ended ${String(event.endsAt).slice(11, 16)}.`,
    '',
  ];
  if (owed.length) {
    lines.push('Going in, you owed them:');
    for (const o of owed) lines.push(`- ${o}`);
    lines.push('');
  }
  lines.push('**What was agreed, and what do you now owe?** One sentence is enough — the assistant');
  lines.push('writes the journal and the tasks from it.');
  const prefill = `Debrief ${event.summary ?? 'meeting'} with ${who}: `;
  lines.push('', `[answer in chat ›](/chat?say=${encodeURIComponent(prefill)})`);
  return { title: `How did ${event.summary ?? 'the meeting'} go? — ${who}`, body: lines.join('\n'), prefill };
}

async function writeMessage(vault, kind, title, body, when = new Date()) {
  const dir = join(vault, 'messages');
  await mkdir(dir, { recursive: true });
  const stamp = localStamp(when).replace(' ', '-').replace(':', '');
  let path = join(dir, `${stamp}-${kind}.md`);
  for (let n = 2; ; n++) { try { await readFile(path); path = join(dir, `${stamp}-${kind}-${n}.md`); } catch { break; } }
  const esc = (v) => String(v).replace(/\n/g, ' ').replace(/^(['"])/, '\\$1');
  await writeFile(path, `---\ntype: message\nkind: ${kind}\nat: ${localStamp(when)}\ntitle: ${esc(title)}\nread: false\ndelivered: none\n---\n\n${body.trimEnd()}\n`);
  return path;
}

export async function run(vault = OBLIGATIONS, now = Date.now()) {
  let cal;
  try { cal = JSON.parse(await readFile(join(vault, 'integrations', 'calendar.json'), 'utf8')); }
  catch { return { written: [], skipped: 'calendar.json unreadable' }; }
  if (cal.error) return { written: [], skipped: `calendar: ${cal.error}` };
  let sent = {};
  try { sent = JSON.parse(await readFile(SENT, 'utf8')); } catch { /* first run */ }
  const due = endedEvents(cal, now).filter((e) => !sent[e.id]);
  if (!due.length) return { written: [], skipped: null };
  const { people } = await peopleIndex(vault);
  const written = [];
  for (const e of due) {
    const { title, body } = composeDebrief(e, people);
    if (DRY) { console.log(`--- ${title}\n${body}\n`); continue; }
    written.push(await writeMessage(vault, 'debrief', title, body));
    sent[e.id] = localStamp();
  }
  if (!DRY) {
    const cutoff = localStamp(new Date(now - 2 * 86400000));
    for (const [id, at] of Object.entries(sent)) if (at < cutoff) delete sent[id];
    await mkdir(dirname(SENT), { recursive: true });
    await writeFile(SENT, JSON.stringify(sent, null, 2) + '\n');
  }
  return { written, skipped: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await run();
  if (r.skipped) console.log(`debrief: skipped — ${r.skipped}`);
  else if (r.written.length) console.log(`debrief: wrote ${r.written.length}\n  ${r.written.join('\n  ')}`);
  else if (!DRY) console.log('debrief: nothing due');
}
