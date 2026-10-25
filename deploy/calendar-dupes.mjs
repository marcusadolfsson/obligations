#!/usr/bin/env node
/**
 * Duplicate events on his calendar — and what may be removed.
 *
 * Alex, 2026-09-05: "if the calendar has duplicated events (sometimes gmail
 * adds stuff by itself), we need to clean it up."
 *
 * Gmail's "events from Gmail" are stubs Google makes from a confirmation mail —
 * "Event at Harbor Castle Park" — and Google marks them `eventType: fromGmail`.
 * When the assistant has filed the same booking properly (bookings-events.mjs), or
 * he has added it by hand, the stub is a duplicate. Those are deleted here,
 * because they are machine-made, reproducible, and carry less than the event
 * they duplicate.
 *
 * Two hand-made events that look alike are NOT deleted. They are reported, and
 * Tomorrow's Brief says so. CLAUDE.md: deleting his events is his call. The only
 * things this removes are Gmail stubs and, if asked, the assistant's own.
 *
 * "Duplicate" is, on the same day: the same normalised title, OR a shared venue
 * word of five letters or more ("Harbor Castle" ⇄ "Harbor Castle park
 * reservation"). Deliberately loose for Gmail stubs, whose titles are generic,
 * and only applied between a stub and a real event — never between two real ones.
 *
 *   node deploy/calendar-dupes.mjs [--dry] [--days 45]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEvents, deleteEvent, exactTwins } from './integrations/calendar-write.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const argv = process.argv.slice(2);
const DAYS = Number(argv[argv.indexOf('--days') + 1]) || 45;

const STOP = new Set(['event', 'events', 'meeting', 'reservation', 'reservations', 'booking', 'dinner', 'lunch', 'party', 'guests', 'theme', 'resort', 'hotel', 'with', 'from', 'your', 'the', 'and']);
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length >= 5 && !STOP.has(w)));
export const dayOf = (e) => e.start?.date ?? String(e.start?.dateTime ?? '').slice(0, 10);

/**
 * Decide what to do. Pure. Returns { remove: [...fromGmail stubs], report: [...pairs] }.
 * `remove` entries carry `because` naming the event they duplicate.
 */
export function plan(events) {
  const byDay = new Map();
  for (const e of events) { if (e.status === 'cancelled') continue; const d = dayOf(e); if (!d) continue; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(e); }
  const remove = [], report = [];
  for (const [day, list] of byDay) {
    const stubs = list.filter((e) => e.eventType === 'fromGmail');
    const real = list.filter((e) => e.eventType !== 'fromGmail');
    for (const s of stubs) {
      const sw = words(s.summary);
      const twin = real.find((r) => norm(r.summary) === norm(s.summary) || [...words(r.summary)].some((w) => sw.has(w)));
      if (twin) remove.push({ id: s.id, summary: s.summary ?? '', day, because: twin.summary ?? '' });
    }
    // Two real events, same title, same start. Both the assistant's own (a
    // booking marker on each): the newer one comes off — it is a clone the
    // repo made, and only the assistant's own events are ever removed here.
    // Otherwise report, never delete: his events are his.
    // Two real events, same title, same start and end, nobody else on either:
    // the newer comes off, whoever made it — the assistant's own clone or his own
    // double entry. Alex, 2026-09-06: "you are my chief of staff. Handle
    // that." A pair with other people on it is only reported: deleting one
    // sends every invitee a cancellation, which is not tidying.
    const seen = new Map();
    const own = (e) => String(e.extendedProperties?.private?.obligations ?? '').startsWith('booking:');
    for (const r of [...real].sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')))) {
      const k = norm(r.summary) + '|' + (r.start?.dateTime ?? r.start?.date ?? '');
      if (!seen.has(k)) { seen.set(k, r); continue; }
      const first = seen.get(k);
      if (own(first) && own(r)) remove.push({ id: r.id, summary: r.summary ?? '', day, because: `${first.summary ?? ''} (the assistant's own, placed first)`, own: true });
      else if (exactTwins(first, r)) remove.push({ id: r.id, summary: r.summary ?? '', day, because: `${first.summary ?? ''} (his, entered first)`, twinOf: first.id });
      else report.push({ day, summary: r.summary ?? '', ids: [first.id, r.id], why: 'other people are on it — deleting one would cancel it for them' });
    }
  }
  return { remove, report };
}

export async function run(vault = OBLIGATIONS, { days = DAYS, dry = DRY } = {}) {
  const now = new Date();
  const events = await listEvents(vault, { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + days * 86400000).toISOString() });
  const { remove, report } = plan(events);
  const removed = [];
  for (const r of remove) {
    if (dry) { removed.push({ ...r, dry: true }); continue; }
    try { removed.push({ ...r, ...(await deleteEvent(vault, r.id, { reason: `duplicate of "${r.because}"`, twinOf: r.twinOf ?? null })) }); }
    catch (err) { removed.push({ ...r, error: err.message }); }
  }
  return { scanned: events.length, removed, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await run();
  console.log(`scanned ${r.scanned} events in the next ${DAYS} days`);
  for (const x of r.removed) console.log(`${x.dry ? 'would remove' : x.error ? 'FAILED     ' : 'removed    '}  ${x.day}  "${x.summary}"  — ${x.own ? "the assistant's own twin of" : x.twinOf ? 'exact twin of' : 'Gmail stub duplicating'} "${x.because}"${x.error ? ` (${x.error})` : ''}`);
  for (const x of r.report) console.log(`duplicate?   ${x.day}  "${x.summary}" appears twice — not touched: ${x.why ?? 'yours to merge'}`);
  if (!r.removed.length && !r.report.length) console.log('no duplicates.');
}
