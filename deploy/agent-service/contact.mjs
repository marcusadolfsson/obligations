/**
 * Has he been in touch with this person since a moment — by text, email or a
 * connected call?
 *
 * Alex, 2026-09-15, three times in one morning:
 *
 *   - a drafted text to Henry Pike still offered to promise him the new plan
 *     set "before we sit down Tuesday", when Alex had emailed him the drawings
 *     at 14:04 the day before and Henry had replied "Looks good to me";
 *   - the morning brief said of the same plans "nothing has gone" — "I did sent
 *     them yesterday";
 *   - and that Ruth Ellis had said "yes, now is good" to a call sixteen hours
 *     earlier — "I did call right away".
 *
 * Every one of those is the same blindness. Each part of the assistant watches one
 * thread on one channel, and he deals with things on whichever channel is to
 * hand. A text answered by an email, an email answered by a call, looks like
 * silence to anything that only reads the thread it started on.
 *
 * This is the one place that reads all three and joins them on the PERSON,
 * using the address book to turn a phone number into every handle that person
 * has. It is arithmetic over files the extractors already write, and it only
 * ever reports contact that happened — it never infers what was said.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadContacts, matchKey } from './contacts.mjs';

const read = async (vault, rel) => { try { return JSON.parse(await readFile(join(vault, rel), 'utf8')); } catch { return null; } };

/** `Name <addr>` or a bare handle → its lookup key. */
function keyOf(handle) {
  const s = String(handle ?? '');
  const m = s.match(/<([^>]+)>/);
  return matchKey(m ? m[1] : s.split(';').pop());
}

/**
 * Every handle that belongs to the same person as `who`.
 *
 * `who` may be a handle (a number, an address, a chat id) or a name. A string
 * naming more than one person — "Hank Mercer and Ruth Ellis (PHOA)" —
 * resolves to NOTHING on purpose: contact with one of a group is not evidence
 * the group's question was dealt with, and a false "you were in touch" is the
 * one error here that would make a real debt quietly disappear.
 */
export function handlesFor(contacts, who) {
  const index = contacts?.index ?? {};
  const out = new Set();
  const direct = keyOf(who);
  let name = direct ? index[direct] ?? null : null;
  if (direct) out.add(direct);
  if (!name && !direct) {
    const s = String(who ?? '').trim();
    if (!s || /\b(and|&)\b|,/.test(s)) return out;             // a group, not a person
    name = s.replace(/\s*\(.*\)\s*$/, '').trim();
  }
  if (name) {
    const want = name.toLowerCase();
    for (const [k, v] of Object.entries(index)) if (String(v).toLowerCase() === want) out.add(k);
  }
  return out;
}

/**
 * The three extracts, read once. A brief asks this question of every open item
 * and the message extract alone is megabytes, so a caller asking many times
 * reads them here and passes them in.
 */
export async function loadContactFiles(vault) {
  const [im, mail, calls] = await Promise.all([
    read(vault, 'integrations/imessage.json'), read(vault, 'integrations/gmail.json'), read(vault, 'integrations/calls.json')]);
  return { im, mail, calls };
}

/**
 * What passed between him and them after `since` ("YYYY-MM-DD HH:MM"), oldest
 * first.
 *
 * `direction` picks whose words count:
 *
 *   'mine'   what HE sent — "did I ever get back to them"
 *   'theirs' what THEY sent — "did they ever answer me"
 *   'both'   the conversation
 *
 * Alex, 2026-09-18, looking at "Chase Dana on the Elmwood water leak check"
 * four days after he asked her: "She did respond via email." She had — the day
 * before, on the Bayport utility bill thread, saying the city had found the
 * usage and her landscaper was on it. The text thread he asked on was still
 * silent, so the message triage called it unanswered and the list asked him to
 * chase his sister about something she had already dealt with.
 *
 * The same blindness as the one this file was written for, pointing the other
 * way: each half of the assistant watches one thread on one channel, and people
 * answer wherever is to hand.
 */
export async function contactSince(vault, who, since, { contacts = null, files = null, direction = 'mine' } = {}) {
  const wantMine = direction === 'mine' || direction === 'both';
  const wantTheirs = direction === 'theirs' || direction === 'both';
  const book = contacts ?? await loadContacts(vault);
  const keys = handlesFor(book, who);
  if (!keys.size || !since) return [];
  // Same minute counts. Stamps here are whole minutes, and "I did call right
  // away" is exactly a call in the minute she said now is good: Ruth wrote
  // at 14:32 and the call connected at 14:32, which a strict comparison threw
  // away as happening before the thing it answered.
  const after = (at) => String(at ?? '') >= String(since);
  const out = [];

  const { im, mail, calls } = files ?? await loadContactFiles(vault);
  for (const t of im?.threads ?? []) {
    const people = [...(t.participants ?? []), t.chat_id].map(keyOf).filter(Boolean);
    // One-to-one only: a text into a group he shares with them is not a reply to them.
    if (t.is_group || !people.some((k) => keys.has(k))) continue;
    for (const m of t.messages ?? []) {
      if (!after(m.at) || (m.from_me ? !wantMine : !wantTheirs)) continue;
      out.push({ at: m.at, channel: 'text', from: m.from_me ? 'you' : 'them',
                 detail: String(m.text ?? '').slice(0, 80), thread: t.chat_id });
    }
  }

  for (const t of mail?.threads ?? []) {
    const people = (t.participants ?? []).map(keyOf).filter(Boolean);
    if (!people.some((k) => keys.has(k))) continue;
    // Sent mail only. An unsent draft is in the thread as a message from him,
    // and counting it would call a draft proof of itself.
    for (const m of t.messages ?? []) {
      // Sent mail only. An unsent draft is in the thread as a message from him,
      // and counting it would call a draft proof of itself.
      if (m.draft || !after(m.at) || (m.from_me ? !wantMine : !wantTheirs)) continue;
      out.push({ at: m.at, channel: 'email', from: m.from_me ? 'you' : 'them',
                 detail: t.subject ?? '', thread: t.thread_id,
                 // Who actually wrote it, when the extract says. A thread the
                 // person is merely cc'd on has other people's replies in it;
                 // without this every one of those read as THEM answering.
                 sender: m.from ?? m.sender ?? null });
    }
  }

  for (const c of calls?.calls ?? []) {
    // Connected, either direction: he picked up or they did. A missed call is
    // an attempt, and an attempt is not the thing having been dealt with.
    // A connected call is the conversation itself, so it counts whichever way
    // the question is asked — neither side spoke without the other hearing it.
    if (c.connected && keys.has(c.key) && after(c.at)) {
      out.push({ at: c.at, channel: 'call', from: c.direction === 'out' ? 'you' : 'them',
                 detail: `${c.direction === 'out' ? 'you called' : 'they called'}, ${Math.round((c.duration_s ?? 0) / 60)} min` });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** One line for a brief or a card: "email 09-14 14:04 (ONE Springfield updated drawings)". */
export function describeContact(rows) {
  return rows.map((r) => `${r.channel} ${String(r.at).slice(5, 16)}${r.detail ? ` (${r.detail})` : ''}`).join('; ');
}

/** The same, said from the other side: "email 09-17 10:32 (Utility Bill)". */
export function describeReply(rows) {
  return rows.map((r) => `${r.channel} ${String(r.at).slice(5, 16)}${r.detail ? ` (${r.detail})` : ''}`).join('; ');
}
