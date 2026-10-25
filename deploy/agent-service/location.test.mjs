/**
 * Location: a point is validated and kept, a day folds into stays, and
 * "where is he now" says since when.
 */
import { localStamp } from './time.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shapePoint, distanceM, stays, recordPoint, whereNow, dayStays, readPoints } from './location.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const T0 = Date.parse('2026-09-06T09:00:00');
const at = (min) => T0 + min * 60000;
const HOME = { lat: 27.77, lon: -82.64 }, HANGAR = { lat: 27.91, lon: -82.69 };

console.log('shapePoint');
{
  const p = shapePoint({ lat: '27.7712345', lon: -82.64, accuracy_m: 12.6, at_ms: at(0), place: 'Springfield', source: 'visit', platform: 'ios' }, { now: at(1) });
  check('rounds to five decimals, keeps place and source', p.lat === 27.77123 && p.accuracy_m === 13 && p.place === 'Springfield' && p.source === 'visit');
  check('a stamp and its epoch sibling', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(p.at) && p.at_ms === at(0));
  let err = null; try { shapePoint({ lat: 91, lon: 0 }); } catch (e) { err = e; }
  check('a bad coordinate is refused', /lat and lon/.test(err?.message ?? ''));
  err = null; try { shapePoint({ lat: 1, lon: 1, at_ms: at(60) }, { now: at(0) }); } catch (e) { err = e; }
  check('a time an hour in the future is refused', /usable time/.test(err?.message ?? ''));
  check('an unknown source falls back to significant', shapePoint({ lat: 1, lon: 1, source: 'x' }).source === 'significant');
}

console.log('\ndistance and stays');
{
  check('home to hangar is about 16 km', Math.abs(distanceM(HOME, HANGAR) - 16300) < 1500, String(distanceM(HOME, HANGAR)));
  const pts = [
    { ...HOME, at: '2026-09-06 09:00', at_ms: at(0), place: 'Home' },
    { lat: 27.7705, lon: -82.6402, at: '2026-09-06 09:30', at_ms: at(30), place: null },
    { ...HANGAR, at: '2026-09-06 10:10', at_ms: at(70), place: 'City Airport' },
    { ...HANGAR, at: '2026-09-06 10:50', at_ms: at(110), place: null },
    { lat: 27.95, lon: -82.45, at: '2026-09-06 11:30', at_ms: at(150), place: 'Riverton' },      // a five-minute stop: not a stay
    { lat: 27.95, lon: -82.45, at: '2026-09-06 11:35', at_ms: at(155), place: null },
    { ...HOME, at: '2026-09-06 12:30', at_ms: at(210), place: 'Home' },
    { ...HOME, at: '2026-09-06 14:00', at_ms: at(300), place: null },
  ];
  const s = stays(pts);
  check('three stays: home, the hangar, home again — the five-minute stop drops', s.length === 3 && s.map((x) => x.place).join('|') === 'Home|City Airport|Home', JSON.stringify(s.map((x) => [x.place, x.minutes])));
  check('a stay knows how long', s[1].minutes === 40 && s[0].minutes === 30);
}

console.log('\nrecordPoint / whereNow / dayStays');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  let err = null; try { await recordPoint(vault, { lat: 1, lon: 1 }, null); } catch (e) { err = e; }
  check('no identity, no record', /signed-in identity/.test(err?.message ?? ''));
  /* A fixed midday, never the wall clock: points fifty and twenty minutes
     back straddle midnight in the first hour of a day, and then no one day
     holds both. Failed twice at 00:10 on 2026-09-25. */
  // Yesterday's, so it is always in the past — recordPoint refuses the future.
  const now = new Date(`${localStamp(new Date(Date.now() - 86400000)).slice(0, 10)}T13:00:00`).getTime();
  await recordPoint(vault, { ...HOME, at_ms: now - 50 * 60000, place: 'Home' }, 'm@x');
  await recordPoint(vault, { lat: 27.7702, lon: -82.6401, at_ms: now - 20 * 60000 }, 'm@x');
  const dup = await recordPoint(vault, { lat: 27.7702, lon: -82.6401, at_ms: now - 20 * 60000 + 5000 }, 'm@x');
  check('an exact repeat within a minute is not recorded', dup.recorded === false && (await readPoints(vault)).length === 2);
  const w = await whereNow(vault, { now });
  check('where now: the last point, since the first point within reach, place carried', w.place === 'Home' && w.age_min === 20 && w.since_ms === now - 50 * 60000, JSON.stringify(w));
  const d = await dayStays(vault, localStamp(new Date(now)).slice(0, 10));
  check('the day folds into one 30-minute stay so far', d.stays.length === 1 && d.stays[0].minutes === 30, JSON.stringify(d));
  await rm(vault, { recursive: true, force: true });
}

/* Where he does not usually go, and stopped. Alex, 2026-09-10, after the
 * brief told him he had not run the Icon keys down when he had — his phone put
 * him at the airport ninety minutes after he said he would: "maybe not a
 * conclusion but a proactive prompt." */
console.log('\nplaces he does not usually go');
{
  const { unusualStays } = await import('./location.mjs');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const vault = await mkdtemp(join(tmpdir(), 'loc-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  const P = [];
  const at = (t) => `2026-09-09 ${t}`;
  const ms = (t) => Date.parse(`2026-09-09T${t}:00`);
  // Home, four different reverse-geocoded names for one building — this is
  // what defeated counting by name: his own home looked like four rare places.
  for (const [t, name] of [['00:46', 'Harborwalk Garage'], ['07:28', '42 Elm St'],
                           ['08:33', '111 Main Ave'], ['08:51', 'Harborwalk Garage'],
                           ['15:04', '7 Oak St N'], ['15:09', '7 Oak St N']])
    P.push({ at: at(t), at_ms: ms(t), lat: 27.7720, lon: -82.6342, place: name, source: 'significant' });
  // A drive: four addresses five minutes apart, none of them a destination.
  for (const [t, name, lat] of [['08:35', 'Third St N', 27.776], ['08:40', '35th Ave NE', 27.803],
                                ['08:45', '88 Oak St N', 27.793], ['08:50', 'Oak St N', 27.777]])
    P.push({ at: at(t), at_ms: ms(t), lat, lon: -82.634, place: name, source: 'significant' });
  // The errand: ten minutes of silence behind it.
  P.push({ at: at('14:54'), at_ms: ms('14:54'), lat: 27.763, lon: -82.630, place: 'City Airport Airport', source: 'significant' });
  P.sort((a, b) => a.at_ms - b.at_ms);
  await writeFile(join(vault, 'integrations', 'location.json'), JSON.stringify({ points: P }));

  const out = await unusualStays(vault, { since: '2026-09-09 00:00', now: ms('23:00') });
  check('the errand is the only thing reported', out.length === 1, JSON.stringify(out));
  check('  ...and it is the airport', out[0]?.place === 'City Airport Airport', out[0]?.place);
  check('home is not unusual, under any of its four names',
        !out.some((v) => /Harborwalk|Central|First (St|Ave)/.test(v.place)));
  check('driving past is not stopping', !out.some((v) => /35th Ave|2222/.test(v.place)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
