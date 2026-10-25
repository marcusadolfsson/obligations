/**
 * `reference/bookings.md` → events. Pure, and imported by everything.
 *
 * This lived inside `bookings-events.mjs` until 2026-09-15, when `conflicts.mjs`
 * needed the same parse to tell which trip a `booking:` marker came from — and
 * importing it deadlocked, because `bookings-events.mjs` imports `gym.mjs`,
 * which imports `conflicts.mjs`. The cycle hung the whole conflict check with
 * nothing but a top-level-await warning to say so.
 *
 * So the parser is its own module, with **no imports but node:crypto**. Two
 * callers, one parse. Two parsers over one format is the failure the contract
 * guard was written for: they disagreed about whether the kind lives in `type`
 * or `kind`, and no brief was pushed for as long as that lasted.
 *
 * A trip is `## Name · YYYY-MM-DD → YYYY-MM-DD`. A booking is a bullet that
 * starts with a date, then ` · `-separated facts:
 *   - 2026-09-06 → 2026-09-07 · Hotel name · conf …        (all-day, multi-day)
 *   - 2026-09-06 · Harbor Castle park reservation · conf …  (all-day)
 *   - 2026-09-06 18:40 · Garden Buffet dinner · conf …     (timed, 90 min default)
 *   - 2026-09-07 13:00–16:00 · Sitter · …                    (timed, explicit end)
 * Continuation lines (indented) belong to the bullet above. The title is the
 * first fact after the date; the rest becomes the description.
 */
import { createHash } from 'node:crypto';

const pad = (n) => String(n).padStart(2, '0');

/** HH:MM plus minutes, wrapping at midnight. Inlined from gym.mjs to stay import-free. */
export function plusMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}

export function parseBookings(text) {
  const out = [];
  let trip = null;
  const bullets = [];
  for (const raw of String(text ?? '').split('\n')) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const range = h[1].match(/(\d{4}-\d{2}-\d{2})\s*(?:→|->|—|-)\s*(\d{4}-\d{2}-\d{2})/);
      trip = { name: h[1].split('·')[0].trim(), from: range?.[1] ?? null, to: range?.[2] ?? null };
      continue;
    }
    if (!trip) continue;
    if (/^\s*-\s+/.test(raw)) bullets.push({ trip, lines: [raw.replace(/^\s*-\s+/, '')] });
    else if (/^\s{2,}\S/.test(raw) && bullets.length && bullets[bullets.length - 1].trip === trip) bullets[bullets.length - 1].lines.push(raw.trim());
  }
  for (const b of bullets) {
    const line = b.lines.join(' ').replace(/\s+/g, ' ').trim();
    if (/^~~/.test(line) || /~~\s*$/.test(line)) continue;                          // cancelled
    const m = line.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2})(?:\s*[–-]\s*(\d{2}:\d{2}))?)?(?:\s*(?:→|->)\s*(\d{4}-\d{2}-\d{2}))?\s*·\s*(.+)$/);
    if (!m) continue;
    const [, date, start, end, until, rest] = m;
    const facts = rest.split(/\s+·\s+/).map((s) => s.trim()).filter(Boolean);
    const title = facts[0].replace(/\*\*/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    const description = [...facts.slice(1), `from reference/bookings.md — ${b.trip.name}`].join('\n').replace(/\*\*/g, '');
    // The marker is the trip, the day and the title — not the whole line.
    // Hashing the line meant an edit to the description (a note that the
    // intake sheet was submitted) was a new booking, and the next run cloned
    // the event: the evening job of 2026-09-06 found two Little Sprouts
    // entries and could remove neither. Events placed under the old marker
    // are matched by day and title below, so nothing is placed twice.
    //
    // The trip name being IN the hash is also what lets conflicts.mjs map a
    // marker back to its heading — see bookingTrips() there.
    const marker = 'booking:' + createHash('sha1').update(`${b.trip.name}|${date}|${String(title).toLowerCase().replace(/\s+/g, ' ').trim()}`).digest('hex').slice(0, 12);
    if (start) out.push({ kind: 'timed', date, start, end: end ?? plusMinutes(start, 90), title, description, marker, trip: b.trip });
    else out.push({ kind: 'allday', date, until: until ?? date, title, description, marker, trip: b.trip });
  }
  return out;
}
