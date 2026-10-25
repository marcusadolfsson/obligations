/**
 * Mail as an obligation source.
 *
 * Two things carry most of the weight here.
 *
 * The **ref is a thread**, so a chase-up arriving in the same conversation does
 * not become a second open item. That is the failure the obligation model exists
 * to prevent, and keying by message id would walk straight back into it.
 *
 * And **close() does not archive**. It marks `archive_pending` and the next
 * triage pass does the archiving through the one rate-limited, audit-logged
 * door. The last test asserts this file contains no `fetch(` — if that fails,
 * read the header of sources/email.mjs before deleting it.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read, close, setDue, mailRef, SOURCE } from './sources/email.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const STATE = {
  updated: '2026-08-30 07:00',
  threads: [
    { thread_id: '18f3a1', account: 'gmail', watermark: '2026-08-28 23:07',
      conclusion: {
        open: true, what: 'owes Wendy the Marisol II flood declaration page',
        who: 'wendy-fuller@insureco.example', since: '2026-08-28 15:43',
        priority: 'normal', owed_by: 'them', closes: 'the dec page arrives',
        message_id: '<AM0P123@insureco.example>', subject: 'Re: Marisol II flood insurance',
      } },
    { thread_id: '18f3b2', account: 'gmail', watermark: '2026-08-28 18:09',
      conclusion: {
        open: true, what: 'sign the Air Insurance pilot experience form',
        who: 'support@coa25d.example', since: '2026-08-28 18:09',
        due: '2026-09-05', priority: 'high', owed_by: 'me',
      } },
    { thread_id: '18f3c3', account: 'phoa', watermark: '2026-08-20 09:00',
      conclusion: { open: false, what: 'settled', who: 'someone@example.com',
                    since: '2026-08-20 09:00', closed_by: 'alex@rivera.example' } },
  ],
};

const CONTACTS = { generated_at: '2026-08-30 13:36', people: 1, index: {
  'wendy-fuller@insureco.example': 'Wendy Fuller',
} };

async function make() {
  const dir = await mkdtemp(join(tmpdir(), 'mail-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify(STATE, null, 1));
  await writeFile(join(dir, 'integrations', 'contacts.json'), JSON.stringify(CONTACTS));
  return dir;
}

console.log('Reading');
{
  const dir = await make();
  const rows = await read(dir);

  check('the adapter names itself', SOURCE === 'email');
  check('every conclusion is returned, closed ones included', rows.length === 3, String(rows.length));

  const cindy = rows.find((r) => r.what.includes('Marisol'));
  check('the ref is mail:<account>:<threadId>', cindy.ref === 'mail:gmail:18f3a1', cindy.ref);
  check('  ...self-prefixed, so obligations.mjs needs no idFor change',
        cindy.ref.startsWith('mail:'));
  check('the account is in the ref, so two mailboxes cannot collide',
        rows.find((r) => r.what === 'settled').ref === 'mail:phoa:18f3c3');

  check('the address resolves to a name at read time', cindy.who === 'Wendy Fuller', cindy.who);
  check('  ...and an unknown address stays as it is',
        rows.find((r) => r.priority === 'high').who === 'support@coa25d.example');

  check('direction survives', cindy.owed_by === 'them');
  check('a deadline the triage read is carried',
        rows.find((r) => r.priority === 'high').due === '2026-09-05');
  check('what discharge looks like is carried', cindy.closes === 'the dec page arrives');
  check('the Message-ID is kept for cross-thread reply matching',
        cindy.detail.message_id === '<AM0P123@insureco.example>',
        'a reply from another client lands in a different Gmail thread');

  check('no state file means an empty list, not a throw',
        (await read(await mkdtemp(join(tmpdir(), 'empty-')))).length === 0);
}

console.log('\nThe ref is a thread, not a message');
{
  // A chase-up in the same conversation must not become a second open item —
  // that is the failure the obligation model exists to prevent.
  const dir = await make();
  const before = (await read(dir)).length;

  const st = JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8'));
  st.threads[0].watermark = '2026-08-31 09:00';          // she chased it up
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify(st, null, 1));

  const after = await read(dir);
  check('a new message in the thread adds no item', after.length === before);
  check('  ...and the ref is unchanged',
        after.some((r) => r.ref === 'mail:gmail:18f3a1'));
}

console.log('\nClosing');
{
  const dir = await make();
  const r = await close(dir, 'mail:gmail:18f3a1', 'alex@rivera.example', 'she sent it Monday');

  check('it reports closed', r.closed === true);
  check('  ...and that the archive is deferred', r.archivePending === true);

  const st = JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8'));
  const c = st.threads.find((t) => t.thread_id === '18f3a1').conclusion;
  check('open goes false', c.open === false);
  check('closed_by names the human — the differ reads this to know it is permanent',
        c.closed_by === 'alex@rivera.example');
  check('the watermark at close is recorded, so only newer mail reopens it',
        c.closed_watermark === '2026-08-28 23:07');
  check('the outcome is kept', c.outcome === 'she sent it Monday');
  check('archive_pending is set for the next triage pass', c.archive_pending === true);

  check('the entry is never deleted — the differ must keep seeing it',
        st.threads.length === STATE.threads.length);
  check('every other thread is byte-identical',
        JSON.stringify(st.threads[1]) === JSON.stringify(STATE.threads[1]));

  const again = await close(dir, 'mail:gmail:18f3a1', 'someone');
  check('closing twice is idempotent, not an error', again.alreadyClosed === true);
}
{
  const dir = await make();
  let threw = null;
  try { await close(dir, 'mail:gmail:nope', 'x'); } catch (e) { threw = e.message; }
  check('an unknown ref is refused rather than guessed at', threw !== null, String(threw));
}

console.log('\nIt does not talk to Gmail');
{
  // close() sets archive_pending instead of archiving inline. Doing it here
  // would mean a network call under the repo lock, and a second archiving path
  // that bypasses the deny list, the rate clamps and the audit log.
  const raw = await readFile(new URL('./sources/email.mjs', import.meta.url), 'utf8');
  // Comments stripped first: the file's own header explains that this test
  // exists, and a doc mentioning the call is not the call. Checking the raw
  // text failed on that sentence, which is a nice demonstration of why a
  // grep-shaped assertion needs to look at code rather than prose.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('no network call anywhere in the adapter', !code.includes('fetch('),
        'read the header of sources/email.mjs before deleting this test');
  check('no Gmail hostname either', !code.includes('googleapis.com'));
  check('  ...and the header still explains why', raw.includes('archive_pending'));
}

/* ONE THREAD, ONE RECORD — BOTH HALVES. Alex, 2026-09-21, of an Northwind
   task: "why can't I see the latest email thread." The state file held four
   records for that thread and 55 extra records across 41 threads, because the
   triage hand-writes this file and had appended where it should have updated.
   Two failures fell out of it: the thread was listed four times as its own
   evidence, and a close wrote to whichever copy came first. */
console.log('\nA thread the triage recorded more than once');
{
  const dir = await mkdtemp(join(tmpdir(), 'mail-dup-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  const dup = (reviewed, what, open = true) => ({
    thread_id: 'dupe1', account: 'gmail', watermark: '2026-09-01 08:00', reviewed,
    conclusion: { open, what, who: 'ar@northwind-aero.example', since: '2026-08-19 12:48' },
  });
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({
    // Deliberately out of order, and the stale copy first — which is the shape
    // that made close() write to a record nothing read.
    threads: [dup('2026-09-14 10:00', 'still waiting on Pablo'),
              dup('2026-09-21 12:55', 'Matthias replied with the reconciliation'),
              dup('2026-09-16 09:00', 'a chase went out')],
  }, null, 1));

  const items = await read(dir);
  check('one obligation, not one per copy', items.length === 1, String(items.length));
  check('  and it is the newest judgement of the three',
        items[0].what.startsWith('Matthias'), items[0].what);

  const r = await close(dir, mailRef('dupe1', 'gmail'), 'agent:test', 'he accepted the numbers');
  check('closing reaches every copy, not just the first', r.records === 3, JSON.stringify(r));
  const after = JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8'));
  check('  so no stale copy is left open to reopen it',
        after.threads.every((t) => t.conclusion.open === false),
        JSON.stringify(after.threads.map((t) => t.conclusion.open)));
  check('  and the obligation is gone from the open list',
        (await read(dir)).every((i) => !i.open));
}

/* SETTING A DATE HAS THE SAME HAZARD. Found 2026-09-21 while giving a dateless
   task a due date: setDue took the FIRST matching record and read() takes the
   newest, so on a duplicated thread the date would be written where nothing
   reads it and the old one would come straight back. */
console.log('\nSetting a due date on a thread recorded more than once');
{
  const dir = await mkdtemp(join(tmpdir(), 'mail-due-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  const rec = (reviewed, due) => ({
    thread_id: 'dupe2', account: 'gmail', watermark: '2026-09-01 08:00', reviewed,
    conclusion: { open: true, what: 'x', who: 'a@b.com', since: '2026-09-01 08:00', due },
  });
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({
    threads: [rec('2026-09-10 10:00', null), rec('2026-09-21 12:55', null)] }, null, 1));

  const r = await setDue(dir, mailRef('dupe2', 'gmail'), '2026-10-01');
  check('a thread with no date can be given one', r.due === '2026-10-01' && r.was === null, JSON.stringify(r));
  check('  and it lands on every copy', r.records === 2, JSON.stringify(r));
  check('  so the list shows the date that was set',
        (await read(dir))[0].due === '2026-10-01', JSON.stringify((await read(dir))[0].due));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
