#!/usr/bin/env node
/**
 * Answer an invitation as Alex: accept, decline, or tentative.
 *
 * Alex, 2026-09-06: "If I ask the chat to decline can it do it?" It could
 * not: calendar-write.mjs refuses any event with attendees, because changing
 * one sends mail in his name. A decline is exactly that — the organizer gets a
 * notification — so it gets the same treatment as sending email: possible in
 * chat, where the permission prompt is the approval, and out of reach of a
 * scheduled job. This script is deliberately NOT on the allow list in
 * .claude/settings.json; mcp-fences pins that. Running it in chat raises the
 * approval card naming the event and the answer; a job cannot run it at all.
 *
 * It changes one thing: his own attendee entry's responseStatus. It refuses an
 * event he organizes (that is cancelling, a different act) and one he is not
 * invited to. `--quiet` withholds the notification (sendUpdates=none) when he
 * only wants his own calendar to reflect it.
 *
 *   node deploy/integrations/calendar-respond.mjs <account> <eventId> declined|accepted|tentative [--comment "…"] [--quiet]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken } from '../mcp/google-auth.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events/';
const ANSWERS = ['accepted', 'declined', 'tentative'];

/** The attendee list with his entry answered. Exported for the tests. */
export function withResponse(event, myEmail, status, comment = null) {
  if (!ANSWERS.includes(status)) throw new Error(`answer must be one of ${ANSWERS.join(', ')}`);
  const me = String(myEmail ?? '').toLowerCase();
  const attendees = event.attendees ?? [];
  const mine = attendees.find((a) => a.self || String(a.email ?? '').toLowerCase() === me);
  if (!mine) throw new Error('you are not on this invitation');
  if (event.organizer?.self || String(event.organizer?.email ?? '').toLowerCase() === me) throw new Error('you organize this event — that is a cancel, not a reply; do it in Calendar');
  return attendees.map((a) => (a === mine ? { ...a, responseStatus: status, ...(comment ? { comment: String(comment).slice(0, 300) } : {}) } : a));
}

export async function respond(vault, account, eventId, status, { comment = null, quiet = false } = {}) {
  const token = await accessToken(vault, fetch, account);
  const headers = { Authorization: `Bearer ${token}` };
  const get = await fetch(BASE + encodeURIComponent(eventId), { headers });
  if (!get.ok) throw new Error(`event not found (${get.status})`);
  const event = await get.json();
  const profile = await (await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', { headers })).json();
  const attendees = withResponse(event, profile.id ?? profile.summary, status, comment);
  const url = new URL(BASE + encodeURIComponent(eventId));
  url.searchParams.set('sendUpdates', quiet ? 'none' : 'all');
  const res = await fetch(url, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ attendees }) });
  if (!res.ok) throw new Error(`calendar PATCH failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const out = await res.json();
  return { id: out.id, summary: out.summary, start: out.start?.dateTime ?? out.start?.date ?? null, organizer: out.organizer?.email ?? null, status, notified: !quiet };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [account, eventId, status] = process.argv.slice(2);
  const argv = process.argv;
  const ci = argv.indexOf('--comment');
  try {
    if (!account || !eventId || !status) throw new Error('usage: calendar-respond.mjs <account> <eventId> declined|accepted|tentative [--comment "…"] [--quiet]');
    const r = await respond(OBLIGATIONS, account, eventId, status, { comment: ci > 0 ? argv[ci + 1] : null, quiet: argv.includes('--quiet') });
    console.log(`${r.status}: ${r.summary} (${r.start}) — organizer ${r.organizer}${r.notified ? ' notified' : ', not notified'}`);
  } catch (err) { console.error(`calendar-respond: ${err.message}`); process.exit(1); }
}
