/**
 * The gate that decides whether an unattended agent runs against Alex's mail.
 *
 * Two failures matter more than the rest, and they are opposites:
 *
 * A gate that is too eager burns real money to learn nothing — the mail job
 * reads ~71KB of instruction before it sees a message, so an empty run is not
 * a cheap run.
 *
 * A gate that is too shy strands mail. Worse, a gate that treats "the extract
 * stopped refreshing" as "no mail waiting" goes quiet at exactly the moment
 * something is wrong, and everything downstream — including a brief that no
 * longer reads mail itself — inherits that silence and reports a calm morning.
 * That is why staleness returns its own reason rather than folding into "no".
 */
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailDue, MAIL } from './mail-gate.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };

const NOW = new Date('2026-09-02T18:00:00');
const stamp = (minsAgo) => {
  const d = new Date(NOW.getTime() - minsAgo * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function ask({ listAge = 5, waiting = 0, lastRun = null, noList = false,
                     stampSkewHours = 0, behind = 0, toArchive = 0,
                     archiveLeft = null }) {
  const dir = await mkdtemp(join(tmpdir(), 'mailgate-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  if (!noList) {
    const path = join(dir, 'integrations', 'gmail-changed.json');
    await writeFile(path, JSON.stringify({
      // Deliberately skewable: the gate must not believe this field.
      extract_generated_at: stamp(listAge + stampSkewHours * 60),
      needs_judgement: Array.from({ length: waiting }, (_, i) => ({ thread_id: `t${i}` })),
      needs_archive: Array.from({ length: toArchive }, (_, i) => ({ thread_id: `a${i}` })),
      counts: { not_shown: behind },
    }));
    // Age is mtime, so the fixture sets mtime and NOW is the fixed clock above.
    const when = new Date(NOW.getTime() - listAge * 60000);
    await utimes(path, when, when);
  }
  const runs = lastRun == null ? {} : { mail: { at: stamp(lastRun), ok: true,
    ...(archiveLeft == null ? {} : { archive_left: archiveLeft, archive_only: true }) } };
  return mailDue(dir, NOW, runs);
}

// A backlog is not arrivals, and waiting an hour between runs on work already
// in hand was three quarters of every cycle spent idle.
// "Draining" is threads left over from this batch, NOT the batch being large.
// The first version thresholded on the work list length, which is capped at
// MAX_JUDGEMENT — so lowering the batch from 160 to 80 silently made the fast
// path unreachable. These pin the signal to the thing that actually means
// "another run is already owed".
const drainCases = [
  ['one thread left over is a backlog',   { waiting: 80, behind: 1, lastRun: MAIL.DRAIN_GAP_MIN + 1 }, true],
  ['...but not before the short gap',     { waiting: 80, behind: 1, lastRun: MAIL.DRAIN_GAP_MIN - 1 }, false],
  ['a full batch with none behind waits', { waiting: 80, behind: 0, lastRun: MAIL.DRAIN_GAP_MIN + 1 }, false],
  ['...for the full hour',                { waiting: 80, behind: 0, lastRun: MAIL.MIN_GAP_MIN + 1 }, true],
  ['a small queue with none behind waits', { waiting: 5, behind: 0, lastRun: MAIL.DRAIN_GAP_MIN + 1 }, false],
];

const cases = [
  ['no work list is not "no mail"',        { noList: true },                    false],
  ['nothing waiting holds',                { waiting: 0 },                      false],
  ['a batch fires',                        { waiting: MAIL.BATCH_AT },          true],
  ['...but not twice within the gap',      { waiting: 9, lastRun: 20 },         false],
  ['...and does once past it',             { waiting: 9, lastRun: 61 },         true],
  // The rescue is an hour now, not three: on Sonnet a run costs about a fifth
  // of what it did, so waiting to amortise the floor buys nothing (2026-09-07).
  ['one stray mail waits for company',     { waiting: 1, lastRun: 45 },         false],
  ['...but is never stranded',             { waiting: 1, lastRun: 61 },         true],
  ['just under the rescue still holds',    { waiting: 2, lastRun: 59 },         false],
];

for (const [name, opts, want] of [...cases, ...drainCases]) {
  const got = await ask(opts);
  if (got.due === want) ok(`${name} (${got.why})`);
  else bad(name, `due=${got.due}, wanted ${want} — ${got.why}`);
}

// The one that must never collapse into "quiet": a work list nobody is
// refreshing is a broken pipeline, and it has to be distinguishable from an
// empty inbox by everything downstream.
const stale = await ask({ listAge: 180, waiting: 9 });
if (stale.due === false && stale.stale === true) {
  ok('a stale work list refuses AND says it is stale');
} else {
  bad('a stale work list refuses AND says it is stale', JSON.stringify(stale));
}
const quiet = await ask({ waiting: 0 });
if (!quiet.stale) ok('...while a genuinely quiet mailbox is not marked stale');
else bad('...while a genuinely quiet mailbox is not marked stale');

// The stamp inside the work list is local wall-clock text with no offset, so a
// reader in another timezone misreads it by the offset -- four hours, in the
// case that found this. Age comes from mtime, which is absolute, and these two
// assert the stamp cannot move the answer in either direction.
const skewedOld = await ask({ listAge: 5, waiting: 9, stampSkewHours: 6 });
if (skewedOld.due === true) ok('a six-hour-stale stamp on a fresh file still fires');
else bad('a six-hour-stale stamp on a fresh file still fires', skewedOld.why);

const skewedNew = await ask({ listAge: 300, waiting: 9, stampSkewHours: -6 });
if (skewedNew.due === false && skewedNew.stale === true) {
  ok('...and a future-dated stamp cannot make a dead pipeline look alive');
} else {
  bad('...and a future-dated stamp cannot make a dead pipeline look alive',
      JSON.stringify(skewedNew));
}

// The cadence must be legible from the outside: "held for 12 more minutes on a
// backlog" and "held for 50 more on a quiet mailbox" are different situations
// and the reason has to say which.
const held = await ask({ waiting: 80, behind: 40, lastRun: 1 });
if (held.draining === true && /draining/.test(held.why)) {
  ok('a refusal while draining says so');
} else {
  bad('a refusal while draining says so', JSON.stringify(held));
}

// Archiving is work the gate could not see. A thread judged "digest" whose
// archive call never happened has a conclusion, so it is never new, never
// stale, and never aged out — needs_judgement stays empty and the job never
// fires again. 18 threads sat in the inbox that way, filed as far as the assistant
// was concerned and present as far as Alex was.
const sweep = await ask({ waiting: 0, toArchive: 18, lastRun: MAIL.MIN_GAP_MIN + 1 });
if (sweep.due === true) ok(`archiving alone fires a run (${sweep.why})`);
else bad('archiving alone fires a run', JSON.stringify(sweep));

const quietNow = await ask({ waiting: 0, toArchive: 0 });
if (quietNow.due === false && quietNow.why === 'nothing waiting') {
  ok('...and nothing to archive is still nothing to do');
} else {
  bad('...and nothing to archive is still nothing to do', JSON.stringify(quietNow));
}

const tooSoon = await ask({ waiting: 0, toArchive: 18, lastRun: 5 });
if (tooSoon.due === false && /to archive/.test(tooSoon.why)) {
  ok('...but a burst of closes is one sweep, not one run each');
} else {
  bad('...but a burst of closes is one sweep, not one run each', JSON.stringify(tooSoon));
}

// A sweep that archived nothing will archive nothing again. work's MCP server was
// disabled in settings.local.json, so three runs spent ~$12 between them
// reaching the same answer and re-arming. The gate asked "is there work" and
// never "did the last attempt move it".
const stuck = await ask({ waiting: 0, toArchive: 46, archiveLeft: 46,
                          lastRun: MAIL.MIN_GAP_MIN + 1 });
if (stuck.due === false && stuck.stuck === true) {
  ok(`a sweep that made no progress does not retry (${stuck.why})`);
} else {
  bad('a sweep that made no progress does not retry', JSON.stringify(stuck));
}

const progressed = await ask({ waiting: 0, toArchive: 12, archiveLeft: 46,
                               lastRun: MAIL.MIN_GAP_MIN + 1 });
if (progressed.due === true) ok('...but one that cleared some of them carries on');
else bad('...but one that cleared some of them carries on', JSON.stringify(progressed));

// A "no" that cannot say why is one nobody can debug at 07:00.
const reasons = await Promise.all([
  ask({ noList: true }), ask({ waiting: 0 }), ask({ waiting: 9, lastRun: 20 }),
  ask({ listAge: 180, waiting: 9 }), ask({ waiting: 1, lastRun: 61 }),
]);
if (reasons.every((r) => typeof r.why === 'string' && r.why.length > 8)) {
  ok('every refusal carries a readable reason');
} else {
  bad('every refusal carries a readable reason', JSON.stringify(reasons.map((r) => r.why)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
