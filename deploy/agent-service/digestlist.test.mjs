/**
 * digestlist.mjs — what /mail actually shows.
 *
 * Written 2026-09-21 because the function had no test at all, and the thing it
 * was missing was the one Alex noticed: ignoring a sender did nothing to the
 * mail already judged.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestList, bucketOf, markDigestArchived, readArchived, DIGEST_TIERS, DIGESTED_FROM } from './digestlist.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const thread = (id, who, tier = 'digest', extra = {}) => ({
  thread_id: id, account: 'personal', watermark: '2026-09-20 10:00', reviewed: '2026-09-20 10:05',
  conclusion: { tier, who, title: `t-${id}`, subject: `s-${id}`, what: 'x', since: '2026-09-20 10:00', ...extra },
});

async function obligationsWith(threads, ignored = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'obligations-dl-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({ threads }));
  // The real file wraps the keys in `senders`, beside a `$comment` block.
  await writeFile(join(dir, 'integrations', 'ignored-senders.json'), JSON.stringify({ senders: ignored }));
  return dir;
}

console.log('the list itself');
{
  const dir = await obligationsWith([
    thread('a', 'dana@x.com'),
    thread('b', 'news@letter.com', 'reading'),
    thread('c', 'someone@y.com', 'action'),        // not a digest tier
  ]);
  const r = await digestList(dir, { days: 0, limit: 0 });
  check('only the tiers the digest is made of', r.items.length === 2 && r.items.every((i) => DIGEST_TIERS.includes(i.tier)), JSON.stringify(r.items.map((i) => i.tier)));
  check('  a long read sorts above a receipt', r.items[0].tier === 'reading');
  check('  grouped by sender', r.groups.length === 2 && r.counts.senders === 2);
  check('  and nothing is ignored when the list is empty', r.counts.ignored === 0);
  await rm(dir, { recursive: true, force: true });
}

/* IGNORING A SENDER REACHES THE MAIL ALREADY JUDGED. Alex, 2026-09-21: "if I
 * ignore an email @reply-sg.angellist.example it should hide it from the unread
 * list." 19 angellist threads judged before he pressed the button stayed unread
 * for ever, because this list read only the tier and the window. */
console.log('\na sender he has silenced');
{
  const threads = [
    thread('a', 'dana@x.com'),
    thread('spam1', 'reply-abc@reply-sg.angellist.example'),
    thread('spam2', 'reply-def@reply-sg.angellist.example'),
    thread('exact', 'noreply@vendor.com'),
    thread('other', 'someone@vendor.com'),
  ];
  const r = await digestList(await obligationsWith(threads, {
    '@reply-sg.angellist.example': { at: '2026-09-21 09:00' },
    'noreply@vendor.com': { at: '2026-09-21 09:00' },
  }), { days: 0, limit: 0 });
  const who = r.items.map((i) => i.who);
  check('a whole ignored domain is gone, however many threads it had', !who.some((w) => /angellist/.test(w)), JSON.stringify(who));
  check('  an ignored exact address is gone', !who.includes('noreply@vendor.com'));
  check('  another address at the same domain is NOT — an address is not a domain', who.includes('someone@vendor.com'), JSON.stringify(who));
  check('  and the mail he actually wants is untouched', who.includes('dana@x.com'));
  check('the number that went is on the record, not a silent shortening', r.counts.ignored === 3, JSON.stringify(r.counts));
  check('  they are out of the unread count too — that was the complaint', r.counts.unread === 2, JSON.stringify(r.counts));
  check('  and out of the sender groups, so the rollup does not list them', r.groups.every((g) => !/angellist/.test(g.who)));
}

console.log('\nthe shapes that must not break it');
{
  const dir = await obligationsWith([thread('a', 'Dana Jonas <dana@x.com>'), thread('b', null), thread('c', '')],
    { 'dana@x.com': { at: '2026-09-21 09:00' } });
  const r = await digestList(dir, { days: 0, limit: 0 });
  check('`Name <addr>` is matched on the address inside it', r.counts.ignored === 1 && !r.items.some((i) => /dana/i.test(i.who ?? '')), JSON.stringify(r.items.map((i) => i.who)));
  check('  a thread with no sender at all is kept, not dropped', r.items.length === 2);
  await rm(dir, { recursive: true, force: true });

  const none = await digestList(await obligationsWith([thread('a', 'dana@x.com')]), { days: 0, limit: 0 });
  check('no ignore file means nothing is hidden', none.items.length === 1 && none.counts.ignored === 0);

  const missing = await digestList(join(tmpdir(), 'obligations-does-not-exist'), { days: 0, limit: 0 });
  check('an unreadable state file says why rather than pretending the inbox is clear', missing.reason && missing.items.length === 0, JSON.stringify(missing.counts));
}

/* CURRENT, NEVER, ARCHIVED — the one rule the whole page turns on. Alex,
   2026-09-21: "digest emails that have yet been included in an 'Archived
   Digest' is labeled 'Current Digest'. You can still track read/unread
   status, but they will always be in the current digest until that Digest is
   archived." Plus the question he raised himself: "I don't know how to deal
   with really old imported email that was never featured in a Digest." */
console.log('\nwhich bucket a judged thread is in');
{
  const FROM = '2026-09-21 18:00';
  const row = (id, reviewed) => ({ id, reviewed });
  check('judged after the line and not yet reported: current',
        bucketOf(row('a:1', '2026-09-22 09:00'), {}, FROM) === 'current');
  check('judged before the line: never digested, and it stays that way',
        bucketOf(row('a:2', '2026-09-20 09:00'), {}, FROM) === 'never');
  check('  the line itself counts as after it',
        bucketOf(row('a:3', FROM), {}, FROM) === 'current');
  check('reported by an archived digest: archived, whenever it was judged',
        bucketOf(row('a:4', '2026-09-30 09:00'), { 'a:4': '2026-10-01 18:00' }, FROM) === 'archived');
  check('  and being archived beats being old — a report is a report',
        bucketOf(row('a:5', '2020-01-01 09:00'), { 'a:5': '2026-10-01 18:00' }, FROM) === 'archived');

  /* READ STATE DECIDES NOTHING. It used to be the whole membership rule, which
     is why the digest count and the Archive button's count disagreed. */
  check('a read thread is still current — only archiving moves it',
        bucketOf({ ...row('a:6', '2026-09-22 09:00'), read: true }, {}, FROM) === 'current');

  /* A thread with no `reviewed` at all cannot be proven to be after the line,
     so it is treated as old. Failing the other way would pour unknowable
     threads into a digest he is then asked to read. */
  check('no judgement stamp at all reads as never, not as current',
        bucketOf(row('a:7', ''), {}, FROM) === 'never');
  check('the shipped line is a real stamp', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(DIGESTED_FROM), DIGESTED_FROM);
}

console.log('\nthe list counts its two buckets');
{
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'obligations-bk-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  const th = (id, reviewed) => ({
    thread_id: id, account: 'personal', watermark: '2026-09-22 10:00', reviewed,
    conclusion: { tier: 'digest', who: `${id}@x.com`, title: `t-${id}`, subject: `s-${id}`, what: 'x', since: '2026-09-22 10:00' },
  });
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({
    threads: [th('new1', '2026-09-22 09:00'), th('new2', '2026-09-22 09:30'), th('old1', '2026-09-01 09:00')] }));

  let r = await digestList(dir, { limit: 0, from: '2026-09-21 18:00' });
  check('two current, one never', r.counts.current === 2 && r.counts.never === 1, JSON.stringify(r.counts));
  check('  and every row says which it is', r.items.every((i) => ['current', 'never'].includes(i.bucket)));

  /* Archiving one moves it, and the ledger is what moved it. */
  const n = await markDigestArchived(dir, ['personal:new1'], { now: new Date('2026-09-22T18:00:00') });
  check('the ledger records it once', n.changed === 1);
  check('  and recording it twice changes nothing',
        (await markDigestArchived(dir, ['personal:new1'])).changed === 0);
  check('  the stamp is readable back', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test((await readArchived(dir))['personal:new1']));

  r = await digestList(dir, { limit: 0, from: '2026-09-21 18:00' });
  check('after archiving, one current and the archived one is in neither bucket',
        r.counts.current === 1 && r.counts.never === 1, JSON.stringify(r.counts));
  check('  it is still listed, so the history does not vanish', r.items.length === 3);

  /* A junk id must not reach the ledger: the key is the join between this file
     and the state file, and a malformed one would be a row nothing matches. */
  check('a malformed id is refused', (await markDigestArchived(dir, ['not an id', ''])).changed === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
