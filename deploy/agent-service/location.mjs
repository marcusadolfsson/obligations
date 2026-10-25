/**
 * Where Alex is, and where he has been — from the app, on his phone.
 *
 * Alex, 2026-09-06: "since we now have an iOS app, I am thinking we should
 * send a location every so often from it. it would be helpful for the assistant
 * to understand where Alex is and where he has been. eventually we can also
 * sync photos for journal context."
 *
 * The app posts a point when iOS reports a significant change or a visit, and
 * names the place from on-device reverse geocoding when it can, so no
 * coordinate of his ever goes to a third party from here. This keeps the
 * points (a rolling window), answers "where is he now, since when", and folds
 * a day into stays — places he was for twenty minutes or more — which is what
 * a journal line or a brief wants. Arithmetic only.
 *
 * integrations/location.json is gitignored: it is derived, personal, and
 * rewritten many times a day.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { localStamp } from './time.mjs';

const FILE = (vault) => join(vault, 'integrations', 'location.json');
const KEEP = 4000;                 // points kept — a couple of months at significant-change rates
const STAY_M = 250;                // within this of the first point of a stay counts as the same stay
const STAY_MIN = 20;               // a stay is at least this long

export async function readPoints(vault) {
  try { const d = JSON.parse(await readFile(FILE(vault), 'utf8')); return Array.isArray(d.points) ? d.points : []; } catch { return []; }
}
async function save(vault, points) {
  await mkdir(dirname(FILE(vault)), { recursive: true });
  await writeFile(FILE(vault), JSON.stringify({ updated: localStamp(), updated_ms: Date.now(), points }, null, 0) + '\n');
}

/** Metres between two points; good enough for "same place". */
export function distanceM(a, b) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Validate and shape one point the app sent. Exported for the tests. */
export function shapePoint(p, { now = Date.now() } = {}) {
  const lat = Number(p?.lat), lon = Number(p?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('lat and lon are required');
  let ms = p?.at_ms != null ? Number(p.at_ms) : p?.at ? Date.parse(String(p.at)) : now;
  if (!Number.isFinite(ms) || ms > now + 5 * 60000 || ms < now - 365 * 86400000) throw new Error('at is not a usable time');
  const acc = p?.accuracy_m != null ? Number(p.accuracy_m) : null;
  return {
    lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
    accuracy_m: Number.isFinite(acc) ? Math.round(acc) : null,
    at: localStamp(new Date(ms)), at_ms: ms,
    place: p?.place ? String(p.place).slice(0, 120) : null,            // on-device reverse geocode, if any
    source: ['significant', 'visit', 'manual', 'launch'].includes(p?.source) ? p.source : 'significant',
    platform: p?.platform ? String(p.platform).slice(0, 12) : null,
  };
}

/** Record one point. Dedupes an exact repeat within a minute. */
export async function recordPoint(vault, raw, who) {
  if (!who) throw new Error('a location needs the signed-in identity');
  const pt = shapePoint(raw);
  const points = await readPoints(vault);
  const last = points[points.length - 1];
  if (last && Math.abs(last.at_ms - pt.at_ms) < 60000 && distanceM(last, pt) < 15) return { recorded: false, count: points.length };
  points.push(pt);
  points.sort((a, b) => a.at_ms - b.at_ms);
  const kept = points.slice(-KEEP);
  await save(vault, kept);
  return { recorded: true, count: kept.length, at: pt.at };
}

/** Consecutive points within STAY_M of a stay's anchor become one stay. Exported for the tests. */
export function stays(points, { minMinutes = STAY_MIN } = {}) {
  const out = [];
  let cur = null;
  for (const p of points) {
    if (cur && distanceM(cur.anchor, p) <= STAY_M) { cur.to_ms = p.at_ms; cur.to = p.at; cur.n++; if (!cur.place && p.place) cur.place = p.place; continue; }
    if (cur) out.push(cur);
    cur = { anchor: { lat: p.lat, lon: p.lon }, lat: p.lat, lon: p.lon, place: p.place ?? null, from: p.at, from_ms: p.at_ms, to: p.at, to_ms: p.at_ms, n: 1 };
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, minutes: Math.round((s.to_ms - s.from_ms) / 60000) })).filter((s) => s.minutes >= minMinutes);
}

/** Where he is now: the last point, and since when he has been within STAY_M of it. */
export async function whereNow(vault, { now = Date.now() } = {}) {
  const points = await readPoints(vault);
  const last = points[points.length - 1];
  if (!last) return null;
  let since = last;
  for (let i = points.length - 2; i >= 0; i--) { if (distanceM(points[i], last) <= STAY_M) since = points[i]; else break; }
  return { lat: last.lat, lon: last.lon, place: last.place ?? since.place ?? null, at: last.at, at_ms: last.at_ms,
           since: since.at, since_ms: since.at_ms, age_min: Math.round((now - last.at_ms) / 60000), accuracy_m: last.accuracy_m };
}

/**
 * Places he does not usually go, and when he was at them.
 *
 * Alex, 2026-09-10, on being told he had not run the Icon keys down when he
 * had: "maybe not a conclusion but a proactive prompt." Being somewhere proves
 * nothing on its own — standing at an airport is not handing over a set of
 * keys — so this never closes anything. It supplies the one fact a brief
 * cannot otherwise have: he made a promise, and then he went somewhere he does
 * not normally go.
 *
 * "Usual" is counted, not configured. Home and the office generate most of the
 * stays in any history, so anywhere in the top `usual` by number of visits is
 * dropped. Nothing has to be told where he lives, and it keeps working when he
 * moves.
 *
 * Places with no name are dropped too: "27.763, -82.630" in a brief is a
 * coordinate he has to go and look up, which is worse than silence.
 */
export async function unusualStays(vault, { since = 0, now = Date.now(), usual = 3, near = 250, dwellMin = 8 } = {}) {
  const points = await readPoints(vault);
  if (!points.length) return [];

  // Cluster by POSITION, never by the name. On-device reverse geocoding gives
  // one building four labels — his own home appears in this history as "100
  // Oak St N", "42 Elm St", "Harborwalk Garage" and "111 Main Ave" —
  // so counting names ranks home as four rare places instead of one constant
  // one, and every evening at home reads as somewhere he never goes.
  const clusters = [];
  for (const p of points) {
    const hit = clusters.find((c) => distanceM(c, p) <= near);
    if (hit) { hit.n++; hit.names.add(p.place ?? ''); continue; }
    clusters.push({ lat: p.lat, lon: p.lon, n: 1, names: new Set([p.place ?? '']) });
  }
  const common = clusters.slice().sort((a, b) => b.n - a.n).slice(0, usual);
  const isCommon = (p) => common.some((c) => distanceM(c, p) <= near);

  // Somewhere he STOPPED, not somewhere he drove past.
  //
  // Significant-change points arrive every few minutes while moving, so a
  // single trip lays down a trail of addresses he never got out of the car at.
  // What separates the two is the gap AFTER the point: on 2026-09-09 the drive
  // laid down four addresses five minutes apart, and the errand — Alfred
  // Field Airport — is the one with ten minutes of silence behind it.
  //
  // iOS `visit` points are kept whatever the gap, because the phone has
  // already decided he dwelled there. They are not enough on their own: the
  // airport stop that prompted all this came through as `significant`, so a
  // rule built only on visits would have missed the one case it is for.
  const from = typeof since === 'string' ? Date.parse(since.replace(' ', 'T')) : since;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p.place || isCommon(p)) continue;
    const next = points[i + 1];
    const gapMin = next ? Math.round((next.at_ms - p.at_ms) / 60000) : Infinity;
    if (p.source !== 'visit' && gapMin < dwellMin) continue;      // driving past
    if (p.at_ms < from || p.at_ms > now) continue;
    // Merge consecutive stops at the same place. A day at FUNLAND is one visit,
    // not the nine separate ones its significant-change points describe.
    const last = out[out.length - 1];
    // By name as well as by distance: a theme park is one place he went, and
    // its points are spread over a mile, so distance alone reported FUNLAND four
    // times in an afternoon.
    if (last && (last.place === p.place || distanceM(last, p) <= near)) {
      last.to = p.at;
      last.to_ms = Number.isFinite(gapMin) ? p.at_ms + gapMin * 60000 : p.at_ms;
      continue;
    }
    out.push({ lat: p.lat, lon: p.lon, place: p.place, from: p.at, from_ms: p.at_ms,
               to: p.at, to_ms: Number.isFinite(gapMin) ? p.at_ms + gapMin * 60000 : p.at_ms,
               source: p.source ?? 'significant' });
  }
  return out.map((v) => ({ place: v.place, from: v.from, to: v.to,
                           minutes: Math.round((v.to_ms - v.from_ms) / 60000), source: v.source }));
}

/** The day, as stays. */
export async function dayStays(vault, day = localStamp().slice(0, 10)) {
  const points = (await readPoints(vault)).filter((p) => String(p.at).slice(0, 10) === day);
  return { day, points: points.length, stays: stays(points) };
}
