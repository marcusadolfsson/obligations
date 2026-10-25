/**
 * Awareness and memory, appended to the brief once (filed-section.mjs).
 *
 * The case it was written for: Simon Kerr forwarding the plugco/DataCo deck
 * on 2026-10-07, judged `memory`, and no brief saying a word about it.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pendingFiled, renderFiled, filedIntoBrief, personOf, HEADING, FILED_CAP } from './filed-section.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const vault = await mkdtemp(join(tmpdir(), 'filed-'));
await mkdir(join(vault, 'integrations'), { recursive: true });
await mkdir(join(vault, 'messages'), { recursive: true });
const thread = (id, tier, reviewed, extra = {}) => ({
  account: 'work', thread_id: id, reviewed,
  conclusion: { tier, who: 'simon.kerr@plugco.example', title: `title ${id}`, what: `What ${id} was. A second sentence.`, ...extra },
});
await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
  thread('1a117be2d2ef820f', 'memory', '2026-10-07 15:32', { title: 'plugco/DataCo partnership presentation — filed' }),
  thread('aaaa0001', 'awareness', '2026-10-07 16:00', { who: 'alerts@coe94a.example', title: 'Leak sensor at 3407' }),
  thread('aaaa0002', 'digest', '2026-10-07 16:10'),                  // the mail digest's, not this section's
  thread('aaaa0003', 'memory', '2026-10-01 09:00'),                  // before the start line
  thread('aaaa0004', 'action', '2026-10-07 17:00'),                  // a to-do, not this
] }));
await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
  { chat_id: 'any;-;+1727', reviewed: '2026-10-07 18:00', conclusion: { tier: 'awareness', who: 'SMS Sensorly', title: 'Water at 3407', what: 'Sensor tripped.' } },
] }));

console.log('What it picks:');
{
  const rows = await pendingFiled(vault);
  const ids = rows.map((r) => r.id);
  check('the plugco forward, judged memory, is in it', ids.includes('work:1a117be2d2ef820f'), ids.join(','));
  check('awareness, mail and text, is in it', ids.includes('work:aaaa0001') && ids.some((i) => i.startsWith('text:')));
  check('digest-tier mail is not — the mail digest carries that', !ids.includes('work:aaaa0002'));
  check('a to-do is not', !ids.includes('work:aaaa0004'));
  check('nothing from before the start line floods in', !ids.includes('work:aaaa0003'));
  check('awareness comes before memory', rows[0].tier === 'awareness' && rows.at(-1).tier === 'memory');
}

console.log('\nHow a line reads:');
{
  check('an address becomes a name', personOf('simon.kerr@plugco.example') === 'Simon Kerr (plugco)');
  check('a name stays a name', personOf('SMS Sensorly') === 'SMS Sensorly');
  const { text } = renderFiled(await pendingFiled(vault));
  check('the subject in bold, the thing itself the link',
        text.includes('- **Simon Kerr (plugco)** — [plugco/DataCo partnership presentation — filed](/mail#pane=work%3A1a117be2d2ef820f): What 1a117be2d2ef820f was.'), text);
  check('a text says so and has no mail link', /\*\*SMS Sensorly\*\* \(text\) — Water at 3407: Sensor tripped\./.test(text), text);
  const many = Array.from({ length: FILED_CAP + 4 }, (_, i) => ({ id: `x:${i}`, tier: 'memory', at: '2026-10-07 20:00', who: 'w', title: 't', what: 'w', link: null }));
  const r = renderFiled(many);
  check(`at most ${FILED_CAP}, and the rest counted for the next brief`, r.shown.length === FILED_CAP && /…and 4 more/.test(r.text));
}

console.log('\nInto the brief:');
{
  const file = '2026-10-07-1800-brief.md';
  const body = '---\ntype: message\nkind: brief\nat: 2026-10-07 18:00\ntitle: t\nread: false\ndelivered: none\n---\n\nThe brief.\n\n'
    + `${HEADING}\n- a list the model wrote itself\n\n## Mail digest\n<!-- mail-digest -->\n\n## Worth opening\n- x\n`;
  await writeFile(join(vault, 'messages', file), body);
  const r = await filedIntoBrief(vault, file, { now: new Date('2026-10-07T22:50:00Z') });
  const after = await readFile(join(vault, 'messages', file), 'utf8');
  check('attached, all three', r.attached && r.count === 3, JSON.stringify(r));
  check('above the mail digest', after.indexOf(HEADING) < after.indexOf('## Mail digest') && after.indexOf(HEADING) > after.indexOf('The brief.'));
  check('the one the model wrote itself is gone — one heading, ours', after.split(HEADING).length === 2 && !after.includes('a list the model wrote itself'));
  const again = await filedIntoBrief(vault, file);
  check('the same brief is never given it twice', !again.attached);
  const next = '2026-10-08-0700-brief.md';
  await writeFile(join(vault, 'messages', next), '---\nkind: brief\n---\n\nMorning.\n');
  const n = await filedIntoBrief(vault, next);
  check('the next brief does not repeat what this one carried', !n.attached && n.count === 0, JSON.stringify(n));
  const { checkFile } = await import('../contract.mjs');
  const c = await checkFile(vault, 'filedReported');
  check('the ledger passes its contract', c.ok && c.records === 3, JSON.stringify(c));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
