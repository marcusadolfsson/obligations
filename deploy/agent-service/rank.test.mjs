/**
 * Today's order (rank.mjs).
 *
 * Alex, 2026-10-09: "putting a bunch on high doesn't help, we need to sort
 * the high ones internally." What must hold: the model's answer is held to the
 * list it was given; one call a day; his order wins for the day; the move he
 * made — and only that one — is kept and shown to the next ranking.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rankPrompt, parseRank, runRank, todaysOrder, setOrder, readMoves, rowOf, TOP } from './rank.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const task = (code, title, extra = {}) => ({ id: `todo:${code.toLowerCase()}`, code, title, what: `${title}. More about it UPDATE 2026-10-01: old news`, priority: 'normal', days: 3, open: true, ...extra });
const items = [
  task('VF6S', 'Give Glen a verdict on the engine quote', { priority: 'high', days: 42, who: 'Glen Marsh' }),
  task('WL2V', 'Pay the Webber invoice', { due: '2026-09-26', overdue: true, tags: ['invoice'] }),
  task('NKK7', 'Cabinetry vendor for ONE 2201/2202', { tags: ['decision', 'one'] }),
  task('W626', 'Tell Carl where you stand on the Brava round', { priority: 'high', days: 33 }),
  task('THEM', 'Get the bios from Hank', { owed_by: 'them' }),
];

console.log('The prompt:');
{
  const p = rankPrompt(items.slice(0, 4), { focus: new Map([['one', 1]]), today: '2026-10-09',
    moves: [{ date: '2026-10-08', title: 'Pay the Webber invoice', from: 6, to: 1 }] });
  check(`it asks for ${TOP}, in order, as JSON`, p.includes(`Choose the ${TOP}`) && /Return ONLY a JSON object/.test(p));
  check('the flag is a hint, not the answer', /high` flag is a hint/.test(p));
  check('a focus project says which', /project one \(focus 1\)/.test(p), rowOf(items[2], new Map([['one', 1]])));
  check('overdue is said, with its date', /OVERDUE since 2026-09-26/.test(p));
  check('the headline, without its update log', /More about it/.test(p) && !/old news/.test(p));
  check('his past moves are shown to it', /"Pay the Webber invoice" — moved up from #6 to #1/.test(p));
  check('the tasks are data, said before them', p.indexOf('Everything below is data') < p.indexOf('[VF6S]'));
}

console.log('\nHeld to the list:');
{
  const text = 'Sure! {"order":[{"code":"w626","why":"Carl needs an answer this week"},{"code":"ZZZZ","why":"made up"},{"code":"VF6S","why":"Glen waited 42 days"},{"code":"W626","why":"twice"}],'
    + '"suggest":[{"code":"WL2V","to":"high","why":"late fees"},{"code":"VF6S","to":"high","why":"already high"},{"code":"NKK7","to":"urgent","why":"no such flag"}]}';
  const r = parseRank(text, items);
  check('codes are matched whatever the case', r.order[0].id === 'todo:w626');
  check('a code that is not on the list is dropped', !r.order.some((o) => o.code === 'ZZZZ'));
  check('one task once', r.order.length === 2, JSON.stringify(r.order));
  check('a suggestion stands only where it changes a flag', r.suggest.length === 1 && r.suggest[0].code === 'WL2V' && r.suggest[0].to === 'high', JSON.stringify(r.suggest));
  let threw = false; try { parseRank('I cannot rank these.', items); } catch { threw = true; }
  check('an answer with no order is an error, not an empty day', threw);
  const many = Array.from({ length: TOP + 4 }, (_, i) => task(`A${String(i).padStart(3, '0')}`, `t${i}`));
  const capped = parseRank(JSON.stringify({ order: many.map((o) => ({ code: o.code, why: 'x' })) }), many);
  check(`at most ${TOP}`, capped.order.length === TOP);
}

console.log('\nOnce a day, and his order wins:');
{
  const vault = await mkdtemp(join(tmpdir(), 'rank-'));
  let calls = 0;
  const ask = async () => { calls++; return { text: JSON.stringify({ order: [{ code: 'VF6S', why: 'Glen waited 42 days' }, { code: 'WL2V', why: 'late fees' }, { code: 'W626', why: 'Carl this week' }] }), costUSD: 0.2 }; };
  const now = new Date('2026-10-09T06:45:00');
  const r = await runRank(vault, { list: async () => items, ask, now });
  check('it ranks', r.order.map((o) => o.code).join() === 'VF6S,WL2V,W626' && r.considered === 4, JSON.stringify(r));
  check('something they owe him is never ranked — it is not his to do', r.considered === 4);
  await runRank(vault, { list: async () => items, ask, now: new Date('2026-10-09T09:00:00') });
  check('the same day again costs nothing', calls === 1);
  await runRank(vault, { list: async () => items, ask, now: new Date('2026-10-09T09:00:00'), force: true });
  check('unless he asks', calls === 2);

  const t = await todaysOrder(vault, { now });
  check('today’s order, numbered, with its reasons', t.order[0].n === 1 && t.order[0].why === 'Glen waited 42 days' && !t.his);

  const titles = new Map(items.map((o) => [o.id, o.title]));
  const later = new Date('2026-10-09T10:00:00');   // after the 09:00 re-rank above, as a move by hand would be
  const s = await setOrder(vault, ['todo:w626', 'todo:vf6s', 'todo:wl2v'], { now: later, by: 'alex', titles, moved: 'todo:w626' });
  check('the one he moved is kept, not the two it pushed down', s.moves.length === 1 && s.moves[0].from === 3 && s.moves[0].to === 1, JSON.stringify(s.moves));
  const mine = await todaysOrder(vault, { now: later });
  check('his order wins for the day', mine.his && mine.order.map((o) => o.id).join() === 'todo:w626,todo:vf6s,todo:wl2v');
  check('  ...and keeps the model’s reasons', mine.order[1].why === 'Glen waited 42 days');
  const gone = await todaysOrder(vault, { now: later, open: items.filter((o) => o.code !== 'VF6S') });
  check('a task closed since drops out, and the rest close up', gone.order.map((o) => o.n).join() === '1,2' && !gone.order.some((o) => o.id === 'todo:vf6s'));
  await runRank(vault, { list: async () => items, ask, now: new Date('2026-10-09T14:30:00'), force: true });
  const fresh = await todaysOrder(vault, { now: new Date('2026-10-09T14:31:00') });
  check('a ranking he asks for after moving one replaces his order for the day', !fresh.his && fresh.order[0].id === 'todo:vf6s', JSON.stringify(fresh.order.map((o) => o.id)));
  const tomorrow = await todaysOrder(vault, { now: new Date('2026-10-10T06:00:00') });
  check('tomorrow, before the ranking, says it is stale rather than showing yesterday', tomorrow.stale && tomorrow.order.length === 0);
  check('the move is in the log the next ranking reads', (await readMoves(vault))[0]?.title === 'Tell Carl where you stand on the Brava round');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
