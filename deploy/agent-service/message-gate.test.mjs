/**
 * The message gate: the same shape as mail, plus the one difference that
 * justified building it — someone he knows does not wait for a batch.
 */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messagesDue, knownWaiting, MESSAGES } from './message-gate.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const stamp = (min) => {
  const d = new Date(Date.now() - min * 60000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
};
const entry = (id, named) => ({ chat_id: id, reason: 'new messages', who: named ? 'Pete Rourke' : '+17275550000',
                                participants: named ? [{ handle: '+15552000003', name: 'Pete Rourke' }] : [{ handle: '+17275550000', name: null }] });
async function fixture(entries, { extractMin = 5 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'integrations', 'imessage-changed.json'),
    JSON.stringify({ generated_at: stamp(1), extract_generated_at: stamp(extractMin), needs_judgement: entries, counts: {} }));
  return dir;
}

console.log('the gate');
{
  const now = new Date();
  let dir = await fixture([]);
  check('nothing waiting says so', (await messagesDue(dir, now, {})).why === 'nothing waiting');
  await rm(dir, { recursive: true, force: true });

  dir = await fixture([entry('a', false)], { extractMin: 200 });
  const asleep = await messagesDue(dir, now, {});
  check('a stale extract is the Mac asleep, not quiet', !asleep.due && asleep.stale && /Mac last exported/.test(asleep.why), asleep.why);
  await rm(dir, { recursive: true, force: true });

  dir = await fixture([entry('a', false)]);
  const one = await messagesDue(dir, now, { messages: { at: stamp(45) } });
  check('one unnamed number holds for a batch', !one.due && /holding for a batch/.test(one.why), one.why);
  const three = await messagesDue(await fixture([entry('a', false), entry('b', false), entry('c', false)]), now, { messages: { at: stamp(45) } });
  check('three waiting is a run', three.due && three.waiting === 3);
  const known = await messagesDue(await fixture([entry('t', true)]), now, { messages: { at: stamp(25) } });
  check('someone he knows runs after 20 minutes, not 60', known.due && known.known === 1 && /someone he knows/.test(known.why), known.why);
  const tooSoon = await messagesDue(await fixture([entry('t', true)]), now, { messages: { at: stamp(5) } });
  // Not the exact minute: stamps truncate to the minute, so "5m ago" rounds to
  // 6 on a bad second. The rule is what matters, not the rounding.
  check('…but not within the 20', !tooSoon.due && /waiting 20m/.test(tooSoon.why), tooSoon.why);
  const old = await messagesDue(await fixture([entry('a', false)]), now, { messages: { at: stamp(75) } });
  check('one unnamed number still runs after an hour', old.due && /nothing judged for/.test(old.why), old.why);
  await rm(dir, { recursive: true, force: true });
  check('knownWaiting reads the names the differ resolved',
        knownWaiting({ needs_judgement: [entry('t', true), entry('u', false)] }).length === 1);
  check('the gaps are the mail model plus the known-person accelerator',
        MESSAGES.MIN_GAP_MIN === 30 && MESSAGES.BATCH_AT === 3 && MESSAGES.MAX_WAIT_MIN === 60 && MESSAGES.KNOWN_GAP_MIN === 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
