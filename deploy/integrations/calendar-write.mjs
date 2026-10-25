#!/usr/bin/env node
/**
 * The one door for writing to his calendar.
 *
 * CLAUDE.md: "Calendar: create and update freely. Putting an appointment in
 * Alex's own diary is bookkeeping, not an outward action — it reaches nobody
 * but him." The scope (`calendar.events`) has been granted since the calendar
 * was connected and nothing had ever used it — every calendar feature here was
 * read-only until 2026-09-05, when the gym blocks needed a writer.
 *
 * Like mail-body.mjs and batch_modify for mail, this is deliberately the ONLY
 * place that POSTs or PATCHes an event. It never adds attendees — that is the
 * line CLAUDE.md draws, because an event with attendees sends mail in his name
 * — and it refuses an event that arrives with any. Everything it creates is
 * marked in `extendedProperties.private.obligations`, so it can find its own events
 * again and never mistakes one of his for one of its.
 *
 *   import { insertEvent, patchEvent, findMarked } from './calendar-write.mjs'
 *   node deploy/integrations/calendar-write.mjs --list-marked gym     # see its own
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken } from '../mcp/google-auth.mjs';
import { localStamp } from '../agent-service/time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'https://www.googleapis.com/calendar/v3/';

/** The account and calendar the extract treats as his own diary. */
export async function ownCalendar(vault = OBLIGATIONS) {
  const cal = JSON.parse(await readFile(join(vault, 'integrations', 'calendar.json'), 'utf8'));
  const mine = (cal.calendars ?? []).find((c) => c.primary && c.mine !== false) ?? (cal.calendars ?? [])[0];
  const account = mine?.account ?? (cal.accounts ?? [])[0];
  if (!account) throw new Error('calendar.json names no account — is the calendar connected?');
  return { account, calendarId: mine?.id ?? 'primary' };
}

async function call(method, path, token, { params = {}, body } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`calendar ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Refuse anything that would reach a third party — unless he has just tapped
 * Send on it.
 *
 * Until 2026-09-08 this refused attendees on every path, which made CLAUDE.md's
 * "add people only in chat, when he says to" a rule with no implementation:
 * there was no way to do it at all, and Alex added Carl to the Brava hold by
 * hand. `approvedBy` is the missing half. It is an email address that only the
 * outbox send route can supply, because that route reads it off the signed-in
 * Access identity on the request and refuses before touching the record when
 * there is none — so a scheduled job, and the agent's own HTTP call, still
 * cannot reach this. Exactly the fence mail sending already uses.
 */
function guard(event, approvedBy = null) {
  const invites = (Array.isArray(event.attendees) && event.attendees.length) || event.conferenceData;
  if (invites && !approvedBy) {
    throw new Error('refusing: an event with attendees or a meeting link reaches other people — '
      + 'it goes out from the Outbox, on his tap, not from here');
  }
}

/**
 * Add attendees (and optionally a meeting link) to an event that already exists.
 *
 * Separate from patchEvent because this is the one call here that acts outward,
 * and it should be impossible to reach it by accident while editing a field.
 * It patches only these three things: whatever the event already says about
 * when and what is his, and is not rewritten by an invite going out.
 */
export async function addAttendees(vault, eventId, { attendees, conference = false, approvedBy }) {
  if (!approvedBy) throw new Error('addAttendees needs the identity of the person who approved it');
  const list = [...new Set((attendees ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  if (!list.length) throw new Error('refusing: no attendees to add');
  const { account, calendarId } = await ownCalendar(vault);
  const token = await accessToken(vault, fetch, account);
  // Read first. Google replaces the whole attendee list on a PATCH, so sending
  // only the new person would silently uninvite everyone already on it.
  const current = await call('GET', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, token);
  const have = new Set((current.attendees ?? []).map((a) => String(a.email).toLowerCase()));
  const merged = [...(current.attendees ?? []), ...list.filter((e) => !have.has(e)).map((email) => ({ email }))];
  const body = { attendees: merged };
  if (conference && !current.conferenceData) {
    body.conferenceData = { createRequest: { requestId: `obligations-${eventId}`.slice(0, 64),
                                             conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  guard(body, approvedBy);
  // sendUpdates=all is the point of the whole call: it is what mails them.
  const made = await call('PATCH',
    `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    + `?sendUpdates=all&conferenceDataVersion=1`, token, { body });
  return { id: made.id, htmlLink: made.htmlLink,
           attendees: (made.attendees ?? []).map((a) => a.email),
           conference: made.conferenceData?.entryPoints?.[0]?.uri ?? null };
}

/**
 * Create an event, marked as the assistant's.
 * @param marker  a short tag like `gym:2026-09-08`; findMarked() looks it up.
 */
export async function insertEvent(vault, { summary, start, end, allDay = false, description = '', location = '', marker,
                                            reminders = 'none' }) {
  if (!marker) throw new Error('a marker is required so the assistant can find its own events');
  const { account, calendarId } = await ownCalendar(vault);
  const token = await accessToken(vault, fetch, account);
  // `reminders`: 'none' (Alex, 2026-09-05: bookings "without reminders"),
  // 'default' (the calendar's own), or a minutes number for one popup. All-day
  // events take dates; `end` is exclusive per the API, so the caller passes the
  // day AFTER the last day.
  const rem = reminders === 'default' ? { useDefault: true }
            : reminders === 'none' ? { useDefault: false, overrides: [] }
            : { useDefault: false, overrides: [{ method: 'popup', minutes: Number(reminders) }] };
  const event = {
    summary, description, location,
    start: allDay ? { date: start } : { dateTime: start },
    end: allDay ? { date: end } : { dateTime: end },
    extendedProperties: { private: { obligations: marker } },
    reminders: rem,
  };
  guard(event);
  const made = await call('POST', `calendars/${encodeURIComponent(calendarId)}/events`, token, { body: event });
  return { id: made.id, htmlLink: made.htmlLink, marker };
}

/** Change fields on an existing event. Only ever called on one this made. */
export async function patchEvent(vault, eventId, patch) {
  const { account, calendarId } = await ownCalendar(vault);
  const token = await accessToken(vault, fetch, account);
  guard(patch);
  const made = await call('PATCH', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, token, { body: patch });
  return { id: made.id, start: made.start, end: made.end };
}

/** Every event in a window, raw — eventType and all. For the duplicate scan. */
export async function listEvents(vault, { timeMin, timeMax }) {
  const { account, calendarId } = await ownCalendar(vault);
  const token = await accessToken(vault, fetch, account);
  const out = [];
  let pageToken;
  do {
    const page = await call('GET', `calendars/${encodeURIComponent(calendarId)}/events`, token, {
      params: { singleEvents: true, orderBy: 'startTime', maxResults: 250, pageToken, timeMin, timeMax },
    });
    out.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Delete an event — the one strong verb here, and it is fenced.
 *
 * It fetches the event first and refuses unless it is one of two things: an
 * event Google made from Gmail (`eventType: fromGmail` — a machine-made stub
 * Gmail will happily make again), or one carrying the assistant's own marker.
 * Anything Alex created by hand is refused by name. CLAUDE.md: deleting his
 * events is his call; these two kinds are not his in that sense.
 */
/**
 * Two events are exact twins when everything a person would compare is the
 * same — title, start, end, all-day-ness, calendar — and neither has anyone
 * but him on it. Deleting one of a pair with attendees sends a cancellation
 * to every invitee, which is not tidying. Exported for the tests.
 */
export function exactTwins(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const when = (e) => `${e.start?.dateTime ?? e.start?.date ?? ''}|${e.end?.dateTime ?? e.end?.date ?? ''}`;
  const others = (e) => (e.attendees ?? []).filter((x) => !x.self).length;
  return norm(a.summary) === norm(b.summary) && when(a) === when(b) && (a.status ?? 'confirmed') !== 'cancelled' && (b.status ?? 'confirmed') !== 'cancelled'
    && others(a) === 0 && others(b) === 0;
}

export async function deleteEvent(vault, eventId, { reason = '', twinOf = null } = {}) {
  const { account, calendarId } = await ownCalendar(vault);
  const token = await accessToken(vault, fetch, account);
  const e = await call('GET', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, token);
  const ours = !!e.extendedProperties?.private?.obligations;
  const gmail = e.eventType === 'fromGmail';
  // His own event may go only as the exact twin of one that stays. Alex,
  // 2026-09-06, on "two of yours get reported": "you are my chief of staff.
  // Handle that." The kept event is fetched and compared here, not trusted
  // from the caller.
  let twin = false;
  if (!ours && !gmail && twinOf) {
    const kept = await call('GET', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(twinOf)}`, token).catch(() => null);
    twin = exactTwins(e, kept);
    if (!twin) throw new Error(`refusing to delete "${e.summary ?? eventId}": not an exact twin of ${twinOf} (or one of them has other people on it)`);
  }
  if (!ours && !gmail) {
    if (!twin) throw new Error(`refusing to delete "${e.summary ?? eventId}": not the assistant's, not made from Gmail, and not an exact twin of one that stays`);
  }
  await call('DELETE', `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, token);
  return { id: eventId, summary: e.summary ?? '', kind: gmail ? 'fromGmail' : twin ? 'twin' : 'obligations', reason, twinOf: twin ? twinOf : null };
}

/** Events this module created, by marker prefix, in a window. */
export async function findMarked(vault, prefix, { timeMin, timeMax } = {}) {
  const { account, calendarId } = await ownCalendar(vault);
  const token = await accessToken(vault, fetch, account);
  const out = [];
  let pageToken;
  do {
    const page = await call('GET', `calendars/${encodeURIComponent(calendarId)}/events`, token, {
      params: { singleEvents: true, orderBy: 'startTime', maxResults: 250, pageToken, timeMin, timeMax,
                privateExtendedProperty: undefined },
    });
    for (const e of page.items ?? []) {
      const m = e.extendedProperties?.private?.obligations;
      if (m && m.startsWith(prefix)) out.push({ id: e.id, marker: m, summary: e.summary, start: e.start, end: e.end, status: e.status });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/* ------------------------------------------------ one-off diary entries */

/**
 * Putting something in his diary from a job, and saying so.
 *
 * Alex, 2026-09-14, after the evening brief reported that the ARKO showroom
 * visit was settled for Friday at 10am "and it is not in your diary. I could
 * not put it there — nothing running on a schedule here can create a calendar
 * entry": "how can we make the assistant make schedule changes, as long as it calls
 * it out in the briefs expressively."
 *
 * The permission was never the problem. CLAUDE.md has said since 2026-09-05
 * that calendar entries are bookkeeping — they reach nobody but him and he can
 * delete them — and this script is on the allow list. What was missing was the
 * verb: the command line could only LIST, and `insertEvent` is a function a job
 * cannot call inline. So the triage wrote "the remaining move is getting it
 * onto the calendar" in five runs in a row on the ARKO thread, and could not
 * make the move. The rule said yes and there was no door.
 *
 * Three things keep it honest now that the door exists:
 *   - every entry is the assistant's own (marked), so it can only ever remove
 *     what it made, and never touches one of his;
 *   - it refuses attendees, so it cannot mail anyone in his name — that is
 *     still the Outbox's job, behind his tap;
 *   - every change is a line in integrations/calendar-changes.jsonl, and the
 *     next brief leads with what it put in his diary and how to undo it. An
 *     entry he was not told about would be the assistant arranging his week
 *     behind his back, which is the opposite of what he asked for.
 */
export const CHANGES = 'integrations/calendar-changes.jsonl';

const slug = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const pad2 = (n) => String(n).padStart(2, '0');

/** Local wall-clock to an RFC 3339 string with this box's offset on that day. */
export function localDateTime(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${date}T${pad2(h)}:${pad2(m)}:00`);
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  return `${date}T${pad2(h)}:${pad2(m)}:00${sign}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
}

/**
 * What an entry request means, before anything is sent. Pure, so every
 * refusal is testable without a network.
 *
 * `start` is "YYYY-MM-DD HH:MM". An end comes from `end` (HH:MM) or `minutes`;
 * with neither it is an hour, because a meeting with no stated length is still
 * a meeting and a zero-length entry is invisible in a day view.
 */
export function planEntry({ title, start, end = null, minutes = null, location = '', note = '', source = '' } = {}) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error('an entry needs a title');
  const m = String(start ?? '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/);
  if (!m) throw new Error('start must be "YYYY-MM-DD HH:MM"');
  const [, date, hm] = m;
  const hhmm = hm.length === 4 ? '0' + hm : hm;
  let finish;
  if (end) {
    if (!/^\d{1,2}:\d{2}$/.test(end)) throw new Error('end must be HH:MM');
    finish = end.length === 4 ? '0' + end : end;
    if (finish <= hhmm) throw new Error('end must be after start');
  } else {
    const len = minutes == null ? 60 : Number(minutes);
    if (!Number.isFinite(len) || len <= 0 || len > 12 * 60) throw new Error('minutes must be between 1 and 720');
    const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + len;
    if (total >= 24 * 60) throw new Error('an entry that runs past midnight is not something to add unasked');
    finish = `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  }
  return {
    summary: t, date, from: hhmm, to: finish,
    start: localDateTime(date, hhmm), end: localDateTime(date, finish),
    location: String(location ?? ''), marker: `add:${date}:${slug(t)}`,
    description: [String(note ?? '').trim(), source ? `From ${source}.` : '',
                  'Added by the assistant; it will be named in your next brief.'].filter(Boolean).join('\n\n'),
  };
}

/** Append one change to the ledger the briefs read. */
async function record(vault, row) {
  const { appendFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await appendFile(join(vault, CHANGES), JSON.stringify(row) + '\n');
}

/** The ledger, oldest first. Unreadable lines are skipped, not fatal. */
export async function readChanges(vault) {
  let raw = '';
  try { raw = await readFile(join(vault, CHANGES), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * Put one entry in his diary, unless it is already there.
 *
 * Already there means either of two things: the assistant made it before (same
 * marker), or HE did — an event of his own at the same start whose title shares
 * a real word with this one. The second matters more. Adding a twin of an entry
 * he typed himself is exactly the duplicate calendar-dupes.mjs exists to clean
 * up, and it would be the assistant's mess.
 */
export async function addEntry(vault = OBLIGATIONS, request, { why = '', by = 'agent' } = {}) {
  if (!String(why).trim()) throw new Error('--why is required: an entry nobody can explain is not one to add unasked');
  const plan = planEntry(request);
  const dayMin = localDateTime(plan.date, '00:00'), dayMax = localDateTime(plan.date, '23:59');
  const mine = await findMarked(vault, plan.marker, { timeMin: dayMin, timeMax: dayMax });
  if (mine.length) return { added: false, why: 'already in the diary from an earlier run', id: mine[0].id, plan };
  const words = new Set(plan.summary.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  const same = (await listEvents(vault, { timeMin: dayMin, timeMax: dayMax })).find((e) => {
    const at = e.start?.dateTime ?? '';
    if (!at.startsWith(`${plan.date}T${plan.from}`)) return false;
    return String(e.summary ?? '').toLowerCase().split(/[^a-z0-9]+/).some((w) => words.has(w));
  });
  if (same) return { added: false, why: `he already has "${same.summary}" at that time`, id: same.id, plan };
  const made = await insertEvent(vault, {
    summary: plan.summary, start: plan.start, end: plan.end, location: plan.location,
    description: plan.description, marker: plan.marker,
    // A meeting he has to be at gets his normal reminders. Bookings went in
    // with none because the trip's own tickets nudge; nothing nudges a
    // showroom visit except this.
    reminders: 'default',
  });
  const row = { at: localStamp(), action: 'added', id: made.id, marker: plan.marker, title: plan.summary,
                when: `${plan.date} ${plan.from}–${plan.to}`, location: plan.location, why: String(why).trim(),
                source: request.source ?? null, by };
  await record(vault, row);
  return { added: true, ...row, htmlLink: made.htmlLink };
}

/** Take back an entry the assistant made. Refuses anything it did not make. */
export async function removeEntry(vault = OBLIGATIONS, marker, { why = '', by = 'agent' } = {}) {
  if (!String(marker ?? '').startsWith('add:')) throw new Error('only an entry this door added (marker add:…) can be removed here');
  const [, date] = marker.split(':');
  const found = await findMarked(vault, marker, { timeMin: localDateTime(date, '00:00'), timeMax: localDateTime(date, '23:59') });
  if (!found.length) return { removed: false, why: 'no such entry' };
  await deleteEvent(vault, found[0].id, { reason: why });
  const row = { at: localStamp(), action: 'removed', id: found[0].id, marker, title: found[0].summary,
                when: found[0].start?.dateTime ?? found[0].start?.date, why: String(why).trim(), by };
  await record(vault, row);
  return { removed: true, ...row };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null; };
  try {
    if (argv.includes('--add')) {
      const r = await addEntry(OBLIGATIONS, {
        title: flag('--title'), start: flag('--start'), end: flag('--end'), minutes: flag('--minutes'),
        location: flag('--location') ?? '', note: flag('--note') ?? '', source: flag('--source') ?? '',
      }, { why: flag('--why') ?? '', by: flag('--by') ?? 'agent' });
      console.log(r.added ? `added  ${r.when}  ${r.title}  [${r.marker}]` : `not added: ${r.why}`);
    } else if (argv.includes('--remove')) {
      const r = await removeEntry(OBLIGATIONS, flag('--remove'), { why: flag('--why') ?? '', by: flag('--by') ?? 'agent' });
      console.log(r.removed ? `removed  ${r.title}  [${r.marker}]` : `not removed: ${r.why}`);
    } else if (argv.includes('--list-marked')) {
      const rows = await findMarked(OBLIGATIONS, flag('--list-marked') ?? '');
      for (const r of rows) console.log(`${r.start?.dateTime ?? r.start?.date}  ${r.summary}  [${r.marker}]`);
      if (!rows.length) console.log('none');
    } else {
      console.log('calendar-write: --add --title T --start "YYYY-MM-DD HH:MM" [--minutes N | --end HH:MM] '
        + '[--location L] [--note N] [--source S] --why W  ·  --remove add:… --why W  ·  --list-marked <prefix>');
    }
  } catch (err) { console.error(`calendar-write: ${err.message}`); process.exit(1); }
}
