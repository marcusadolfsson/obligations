/**
 * web/taskmap.mjs — the To Do list as circles (2026-09-30). The layout is the
 * part that can be wrong without anyone seeing it in a test page: circles
 * that overlap, or a size that does not follow the count.
 */
import { radii, pack } from './web/taskmap.mjs';

let pass = 0, fail = 0;
const check = (m, c, d) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}${d ? ` -> ${d}` : ''}`); } };

// The live shape on the day it was built.
const live = [['__none', 148], ['one', 19], ['phoa', 16], ['acme', 16], ['invoice', 13], ['n100aa', 2], ['decision', 2], ['locks', 1]]
  .map(([key, n]) => ({ key, n }));
const r = radii(live);
check('area follows the count: 148 is about 2.8 times the radius of 19',
      Math.abs(r[0].r / r[1].r - Math.sqrt(148 / 19)) < 0.01, `${r[0].r} / ${r[1].r}`);
check('a one-task project still has room for its name', r.find((c) => c.key === 'locks').r >= 34);
const laid = pack(r);
check('every circle is placed', laid.length === live.length && laid.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y)));
let clash = null;
for (let i = 0; i < laid.length; i++) for (let j = i + 1; j < laid.length; j++) {
  const a = laid[i], b = laid[j];
  if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) clash = `${a.key} / ${b.key}`;
}
check('no two circles overlap', !clash, clash);
check('the biggest sits at the centre', laid[0].key === '__none' && laid[0].x === 0 && laid[0].y === 0);
check('one circle alone is fine', pack(radii([{ key: 'x', n: 3 }])).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
