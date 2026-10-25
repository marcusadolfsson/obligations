/**
 * The best-in-class UI layer, 2026-09-05: snooze and search.
 *
 * Snooze is the third state an obligation can be in — hidden until a time,
 * without being closed — and the risk is that "hidden" becomes "lost": a swipe
 * that made a debt disappear from every surface forever. So the tests pin that
 * it wakes, that it never touches the obligation, and that the file prunes.
 *
 * Search is one query over five kinds; the tests pin the ranking (a title hit
 * beats a body hit) and the typing (a decision is a decision, not an
 * obligation), because a search that returns the right thing under the wrong
 * label sends him to the wrong page.
 */
import { snoozed, snooze, unsnooze, tomorrowMorning } from './snooze.mjs';
import { search } from './search.mjs';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('snooze — later, not lost');
{
  const dir = await mkdtemp(join(tmpdir(), 'snooze-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });

  check('nothing snoozed is an empty map, not an error', (await snoozed(dir)).size === 0);
  const r = await snooze(dir, 'mail:a:1', '2999-01-01 07:00');
  check('a snooze records the id and the wake time', r.id === 'mail:a:1' && r.until === '2999-01-01 07:00');
  check('...and it is hidden', (await snoozed(dir)).has('mail:a:1'));

  await snooze(dir, 'mail:a:2', '2000-01-01 07:00');
  check('a snooze already in the past is not hidden', !(await snoozed(dir)).has('mail:a:2'),
        'it woke — "later" came and went');
  const raw = JSON.parse(await readFile(join(dir, 'integrations', 'obligation-state.json'), 'utf8'));
  check('...and the record pruned it', !('mail:a:2' in raw.snoozed), JSON.stringify(raw.snoozed));

  await unsnooze(dir, 'mail:a:1');
  check('a snooze can be taken back', !(await snoozed(dir)).has('mail:a:1'));

  let refused = false;
  try { await snooze(dir, '../../etc/passwd'); } catch { refused = true; }
  check('a traversal id is refused', refused);
  refused = false;
  try { await snooze(dir, 'mail:a:3', 'tomorrow-ish'); } catch { refused = true; }
  check('a non-stamp wake time is refused', refused);

  const t = tomorrowMorning(new Date('2026-09-05T22:15:00'));
  check('the default is tomorrow at 07:00, the morning brief\'s hour', t === '2026-09-06 07:00', t);
  const late = tomorrowMorning(new Date('2026-12-31T23:59:00'));
  check('...across a year boundary', late === '2027-01-01 07:00', late);
}

console.log('\nsearch — one query, five kinds');
{
  const dir = await mkdtemp(join(tmpdir(), 'search-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await mkdir(join(dir, 'messages'), { recursive: true });
  await mkdir(join(dir, 'people'), { recursive: true });
  await writeFile(join(dir, 'todo.md'), '## Now\n- [ ] Chase Crestline for a firm number @nadia\n- [ ] Pay the Gogo invoice\n');
  await writeFile(join(dir, 'decisions.md'), '## Cabinetry vendor  #one\n- options: MWC · Crestline · Summitline\n');
  await writeFile(join(dir, 'people', 'nadia-volkov.md'), '---\ntype: person\nname: Nadia Volkov\norg: Crestline\n---\n\n# Nadia Volkov\n\n**How I know them:** Crestline cabinets. nadia@crestline.example\n');
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: 'abc', account: 'a', watermark: '2026-09-01 10:00',
      conclusion: { tier: 'action', title: 'Crestline quote', subject: 'Your quote', who: 'nadia@crestline.example', what: 'a cabinet quote', since: '2026-09-01 10:00' } },
    { thread_id: 'def', account: 'a', watermark: '2026-09-02 10:00',
      conclusion: { tier: 'digest', title: 'Bloomberg briefing', subject: 'Daily', who: 'noreply@news.bloomberg.com', what: 'markets; mentions a crestline of nothing', since: '2026-09-02 10:00' } },
  ] }));
  await writeFile(join(dir, 'messages', '2026-09-04-1810-note.md'), '---\ntype: message\nkind: note\nat: 2026-09-04 18:10\ntitle: Crestline has chased twice\nread: false\ndelivered: none\n---\n\nbody\n');

  const r = await search(dir, 'crestline');
  const kinds = new Set(r.hits.map((h) => h.kind));
  check('finds the person', kinds.has('person'), JSON.stringify(r.counts));
  check('finds the obligation', kinds.has('obligation'));
  check('finds the decision, typed as a decision', kinds.has('decision'),
        'a choice with Crestline as an option is not a debt to Crestline');
  check('finds the judged thread', kinds.has('mail'));
  check('finds what the system said', kinds.has('said'));
  check('every hit links somewhere', r.hits.every((h) => typeof h.href === 'string' && h.href.startsWith('/')));

  // Ranking: the thread TITLED Crestline outranks the one that merely mentions it.
  const mail = r.hits.filter((h) => h.kind === 'mail');
  check('a title hit outranks a body hit', mail[0]?.title === 'Crestline quote', mail.map((h) => h.title).join(' > '));

  check('one character is refused with a reason, not an empty result',
        (await search(dir, 'm')).note?.includes('two'));
  check('a miss is an empty list with counts, not an error',
        (await search(dir, 'zzqx')).hits.length === 0 && (await search(dir, 'zzqx')).error === undefined);
  check('case does not matter', (await search(dir, 'CRESTLINE')).hits.length === r.hits.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
