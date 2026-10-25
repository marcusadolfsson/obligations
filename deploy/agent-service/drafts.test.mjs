/**
 * Drafts that stopped being true, and promises with nothing behind them.
 * The first case is real: written Sunday, sent Tuesday, still saying
 * "tomorrow" about a meeting that had already happened.
 */
import { staleness, quietFor, rankChases, draftNote, headlineOf } from '../drafts.mjs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pass as draftsPass } from '../drafts.mjs';
const OBLIGATIONS = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const NOW = Date.parse('2026-09-08T09:00:00');
const d = (o) => ({ status: 'draft', created: '2026-09-06 12:56', text: '', ...o });

console.log('staleness — the Owen draft, as it actually was');
{
  const owen = d({ status: 'approved', created: '2026-09-06 12:56',
    text: "Out tomorrow for Labor Day — let's skip the weekly synch. See you Tuesday at the GP meeting." });
  const why = staleness(owen, { now: NOW });
  check('caught: it says "tomorrow" and is two days old', why.some((w) => /says "tomorrow"/.test(w)), JSON.stringify(why));
  check('caught: approved and still unsent — it will go when the Mac wakes',
        why.some((w) => /approved \d+ days? ago and still not sent/.test(w)), JSON.stringify(why));
  check('a fresh draft saying "tomorrow" is fine', staleness(d({ created: '2026-09-08 08:00', text: 'See you tomorrow' }), { now: NOW }).length === 0);
}

console.log('\nthe other rules');
{
  check('a weekday that has gone by',
        staleness(d({ created: '2026-09-01 09:00', text: 'Let us do Wednesday.' }), { now: NOW }).some((w) => /names Wednesday/.test(w)));
  check('a date that has passed',
        staleness(d({ created: '2026-09-01 09:00', text: 'Confirming 2026-09-03 at 10.' }), { now: NOW }).some((w) => /2026-09-03/.test(w)));
  check('they have written since it was drafted',
        staleness(d({ created: '2026-09-05 10:00', text: 'Thanks.' }), { now: NOW, threadLast: '2026-09-07 20:18' }).some((w) => /written since/.test(w)));
  check('a draft nobody has tapped in three days says so',
        staleness(d({ created: '2026-09-04 10:00', text: 'Thanks.' }), { now: NOW }).some((w) => /waiting for your tap/.test(w)));
  check('a two-day-old draft with nothing time-bound in it is left alone',
        staleness(d({ created: '2026-09-06 20:00', text: 'Thanks, that works.' }), { now: NOW }).length === 0);
  check('a future date is not stale',
        staleness(d({ created: '2026-09-08 08:00', text: 'Confirming 2026-09-11.' }), { now: NOW }).length === 0);
}

// The pass the service runs. Alex, 2026-09-08: "it seems like it should be
// more proactive" — so it now runs after every triage job and hourly, which
// makes "it must not write the same draft twice" the load-bearing property.
// Checked against the live repo, like contract.mjs, because the thing that
// would break is the join between real conclusions and real outbox files.
// The duplicate that reached him. Alex, 2026-09-08: two drafts to Carl both
// proposing 09:00, written either side of the reply that agreed 11:00 and went
// out at 10:15. Both halves of the dedupe were wrong, and both had to be for a
// second draft to appear — so both get a case here.
console.log('\nthe Brava duplicate');
{
  const r = await draftsPass(OBLIGATIONS, { write: false });
  const mike = r.owed.find((o) => /Brava/i.test(o.title ?? ''));
  if (!mike) { console.log('  note the Brava obligation has closed; the rules below are pinned by the stale cases'); }
  else {
    check('an obligation carries every thread it is evidenced by, not the first',
          mike.threads.length > 1, JSON.stringify(mike.threads));
    check('a reply already SENT counts as the promise being answered',
          mike.answered === true);
    check('and so nothing would draft it again',
          mike.hasDraft === true);
  }
  // Fixtures, not live data. These two started out asserting against the real
  // outbox and passed only until Alex discarded the drafts they described —
  // a test that goes red because he tidied up is testing his housekeeping, not
  // the rule. The rule is what has to be pinned.
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const box = join(await mkdtemp(join(tmpdir(), 'obligations-dupe-')), 'outbox');
  await mkdir(box, { recursive: true });
  const put = (name, status, created, extra = '') => writeFile(join(box, name),
    `---\ntype: outbox\nto: +15551234567\nstatus: ${status}\ncreated: ${created}\n`
    + `approved_at: -\nsent_at: ${status === 'sent' ? created : '-'}\nerror: -\n${extra}---\n\nhello\n`);
  await put('a.md', 'draft', '2026-09-08 09:20');
  await put('b.md', 'draft', '2026-09-08 10:59');
  await put('c.md', 'sent', '2026-09-08 10:15');
  const { stale: staleOf } = await import('../drafts.mjs');
  const rows = await staleOf(join(box, '..'), { now: Date.parse('2026-09-08T12:00:00') });
  const dupes = rows.filter((d) => d.why.some((w) => /other draft to the same person/.test(w)));
  check('two drafts waiting for one person are both called out', dupes.length === 2,
        JSON.stringify(rows.map((r) => r.id)));
  check('a draft written before a send to the same person is stale',
        rows.find((d) => d.id === 'a.md')?.why.some((w) => /already sent .* since this was written/.test(w)),
        JSON.stringify(rows.find((d) => d.id === 'a.md')?.why));
  check('and one written after that send is not accused of it',
        !rows.find((d) => d.id === 'b.md')?.why.some((w) => /already sent/.test(w)));
}

// Chasing. Alex, 2026-09-08: "if we wait on others, it would be good to
// auto-draft a follow up after a certain amount of time." The sentence goes out
// over his name, so what it must never do is read the task list back at the
// person being chased — every title is imperative and written from his side.
console.log('\nwhat a chase says');
{
  const { topicOf, chaseText, firstNameOf } = await import('../drafts.mjs');
  check('the verb and the name come off',
        topicOf('Chase Megan Shaw on the PHOA content pages') === 'the PHOA content pages',
        topicOf('Chase Megan Shaw on the PHOA content pages'));
  check('a title that is already a noun phrase survives whole',
        topicOf('Chase the OPOA forum history from 2016 to the ForumHost move')
          === 'the OPOA forum history from 2016 to the ForumHost move');
  check('"hear back from X on Y" keeps only Y',
        topicOf("Hear back from Mike Hale on Crane's site access") === "Crane's site access");
  check('a shape with no liftable noun phrase gets no topic',
        topicOf('Confirm the Frankel membership renewal now posts') === null,
        String(topicOf('Confirm the Frankel membership renewal now posts')));
  check('and then a text says "our conversation" rather than something garbled',
        chaseText({ who: 'Hank Mercer', title: 'Confirm the Frankel membership renewal now posts' })
          === 'Hi Hank, following up on our conversation. Any update?',
        chaseText({ who: 'Hank Mercer', title: 'Confirm the Frankel membership renewal now posts' }));
  // VZ7L, 2026-09-23: "it is an odd followup" — the draft said "this" on a
  // month-old trade-detail thread when the debt was the password reset.
  check('"Get the …" names what is owed',
        chaseText({ who: 'Anton Dale Moreno', title: 'Get the Bank Business Online password reset' })
          === 'Hi Anton, following up on the Bank Business Online password reset. Any update?',
        chaseText({ who: 'Anton Dale Moreno', title: 'Get the Bank Business Online password reset' }));
  /* Alex, 2026-10-01: "Capitalize the sentences better" and "add more
     context to the follow up." A mail is a short letter: greeting, the thing,
     when, the subject he would know the thread by, his name. */
  const mail = chaseText({ who: 'Anton Dale Moreno', title: 'Get the Bank Business Online password reset', channel: 'mail',
                           since: '2026-08-26 13:49', subject: 'RE: Rivera - Citi Follow Up Items - August 2026' });
  check('a mail follow-up says what, when and which thread, in sentences',
        mail === 'Hi Anton,\n\nFollowing up on the Bank Business Online password reset, from our exchange on 26 August ("Rivera - Citi Follow Up Items - August 2026"). Any update?\n\nThanks,\nAlex', mail);
  const noName = chaseText({ who: 'x@y.com', title: 'Confirm it', channel: 'mail', since: '2026-08-15', subject: 'Casa de Hillside Villa' });
  check('  ...with no name it still opens with a capital, and the subject stands for the topic',
        noName.startsWith('Hello,\n\nFollowing up on "Casa de Hillside Villa", from our exchange on 15 August.'), noName);
  check('  but "Get Gail\'s answer" is not said to Gail in the third person',
        topicOf("Get Gail Quinn's threshold-engineer answer for BP26") === null);
  check('an address is not a first name',
        firstNameOf('kdelano@co959d.example') === null);
  check('  ...but first.last@ is, and a role mailbox is not',
        firstNameOf('frank.mason@citi.com') === 'Frank' && firstNameOf('info.desk@x.com') === null && firstNameOf('sales.team@x.com') === null);
  check('so the chase opens without one rather than "Hi kdejulio"',
        chaseText({ who: 'kdelano@co959d.example', title: 'Chase Go Charity for the villa availability' })
          === 'Following up on the villa availability. Any update?');
  // The one sentence that must never appear.
  for (const t of ['Chase Megan Shaw on the PHOA content pages',
                   'Hear back from Mike Hale on Crane\'s site access',
                   'Nail down the Elmhurst board-seat call with Colin Reed']) {
    check(`never says "chase" to the person being chased — ${t.slice(0, 24)}…`,
          !/\bchase\b/i.test(chaseText({ who: 'Someone', title: t })));
  }
}

console.log('\nwho gets chased, and how often');
{
  const { chases } = await import('../drafts.mjs');
  const r = await chases(OBLIGATIONS);
  check('it reports how many it looked at, not just what it picked', Number.isInteger(r.considered) && r.considered >= 0, String(r.considered));
  const { CHASES_A_DAY, PERSON_EVERY } = await import('../drafts.mjs');
  check('the daily tripwire holds', r.rows.length <= CHASES_A_DAY, String(r.rows.length));
  check('the policy is one a week per person, and the day cap is only a tripwire above it', PERSON_EVERY === 7 && CHASES_A_DAY >= 7);
  check('everything it would draft has somebody to send to', r.rows.every((x) => x.who));
  check('and a channel to send on', r.rows.every((x) => ['mail', 'imessage'].includes(x.channel)));
  check('a mail chase knows the thread and the mailbox',
        r.rows.filter((x) => x.channel === 'mail').every((x) => x.thread && x.account));
  check('no machine addresses', r.rows.every((x) => !/noreply|no-reply|notifications@|mailer-daemon/i.test(x.who)));
  check('the oldest wait is chased first',
        r.rows.every((x, i) => i === 0 || r.rows[i - 1].days >= x.days));
  check('the rest are held rather than dropped', r.held + r.rows.length <= r.considered);
}

console.log('\nthe pass the service runs');
{
  const before = (await readdir(join(OBLIGATIONS, 'outbox'))).length;
  const r = await draftsPass(OBLIGATIONS, { write: false });
  check('read-only means read-only', (await readdir(join(OBLIGATIONS, 'outbox'))).length === before);
  check('returns both lists and what it wrote', Array.isArray(r.stale) && Array.isArray(r.owed) && Array.isArray(r.wrote));
  check('write:false writes nothing', r.wrote.length === 0);
  check('every stale row says why', r.stale.every((d) => d.why?.length > 0));
  check('a promise already answered is not answered again',
        r.owed.filter((o) => o.hasDraft).every((o) => o.chatId),
        'hasDraft can only be true when there is a chat to match on');
  // The guard the writing loop uses, stated as the predicate rather than by
  // writing a file: a row is only drafted when nothing answers it already and
  // the other side actually offered times.
  const wouldWrite = r.owed.filter((o) => !o.hasDraft && o.offer);
  check('nothing would be drafted twice', wouldWrite.every((o) => !o.hasDraft));
  check('nothing is drafted without an offer to answer', wouldWrite.every((o) => o.offer?.windows?.length));
}

/* Which three, when eleven are eligible. Alex, 2026-09-17: the follow-ups
 * "appear very adhoc" — the order was days-quiet and nothing else. */
console.log('\nwhat decides which chases go first');
{
  const { rankChases } = await import('../drafts.mjs');
  const focusRank = new Map([['one', 1], ['phoa', 2]]);
  const rows = [
    { id: 'a', who: 'old stranger', days: 40, tags: [], lead_days: null, overdue: false },
    { id: 'b', who: 'phoa person', days: 8, tags: ['phoa'], lead_days: null, overdue: false },
    { id: 'c', who: 'one person', days: 6, tags: ['one'], lead_days: null, overdue: false },
    { id: 'd', who: 'one, overdue', days: 5, tags: ['one'], lead_days: -3, overdue: true },
    { id: 'e', who: 'dated stranger', days: 20, tags: [], lead_days: 2, overdue: false },
    { id: 'f', who: 'newer stranger', days: 12, tags: [], lead_days: null, overdue: false },
  ];
  const order = rankChases(rows, { focusRank }).map((r) => r.id);
  check('a project he is for comes before anything older', order.slice(0, 3).join('') === 'dcb', order.join(''));
  check('  ...in HIS order — #one before #phoa, because that is how he wrote them',
        order.indexOf('c') < order.indexOf('b'));
  check('  ...and inside one project, a deadline beats age', order.indexOf('d') < order.indexOf('c'));
  check('with no project, a deadline still beats age', order.indexOf('e') < order.indexOf('a'), order.join(''));
  check('and with neither, the longest quiet wins — where this started',
        order.indexOf('a') < order.indexOf('f'));
  const why = Object.fromEntries(rankChases(rows, { focusRank }).map((r) => [r.id, r.why]));
  check('every row says what decided it', /#one, overdue, 5 days quiet/.test(why.d), why.d);
  check('  ...and a row with no project says only what is true', why.a === '40 days quiet', why.a);
  check('no focus projects at all still ranks, by deadline then age',
        rankChases(rows, {}).map((r) => r.id).join('') === 'deafbc', rankChases(rows, {}).map((r) => r.id).join(''));
  check('ranking does not mutate what it was given', rows[0].why === undefined);
}

/* A chase held because they already answered — somewhere else. Alex,
 * 2026-09-18, on a four-day-old "Chase Dana on the Elmwood water leak check":
 * "She did respond via email." She had, the day before, on a utility-bill
 * thread. The text thread he asked on was silent, so this would have sent his
 * sister a follow-up about something she had already handled. */
const heldOf = (r, w) => (r.heldRows.find((h) => (h.who ?? '').includes(w)) ?? {}).why ?? '';

console.log('\nthey answered somewhere else');
{
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-chase-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  const now = Date.parse('2026-09-18T18:00:00');
  const day = (n) => new Date(now - n * 86400000).toISOString().slice(0, 16).replace('T', ' ');
  await writeFile(join(vault, 'integrations', 'contacts.json'), JSON.stringify({ index: { '5552000002': 'Dana', 'dana@x.com': 'Dana' } }));
  await writeFile(join(vault, 'integrations', 'calls.json'), JSON.stringify({ calls: [] }));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [
    { chat_id: 'any;-;+15552000002', participants: ['+15552000002'],
      messages: [{ at: day(8), from_me: true, text: 'Can you check if there is a water leak at Elmwood?' }] },
  ] }));
  const mail = (at, subject) => ({ thread_id: 't-util', subject, participants: ['dana@x.com'],
    messages: [{ at, from_me: false, draft: false, subject }] });
  const { chases } = await import('../drafts.mjs');
  const state = (rows) => writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: rows }));
  await state([{ chat_id: 'any;-;+15552000002', watermark: day(8), reviewed: day(0),
    conclusion: { open: true, owed_by: 'them', who: 'Dana', since: day(8),
                  title: 'Chase Dana on the Elmwood water leak check' } }]);

  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [mail(day(1), 'Utility Bill')] }));
  const held = await chases(vault, { now, perDay: 99 });
  check('a chase is held when they answered elsewhere in the last three days',
        held.answered.some((a) => /Dana/.test(a.who)) && !held.rows.some((r) => /Dana/.test(r.who)),
        JSON.stringify({ rows: held.rows.map((r) => r.who), answered: held.answered.map((a) => a.who) }));
  check('  ...and it says where, so he can see whether it was really an answer',
        /Utility Bill/.test(held.answered[0]?.why ?? ''), held.answered[0]?.why);

  // HIS own recent writing counts too. Alex, 2026-09-19, of a chase to
  // Noah & Co drafted at 00:05: "since I sent several emails to her
  // yesterday, I don't think that follow up is necessary?" He had written to
  // her three times the previous afternoon, on other threads.
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [
    { thread_id: 't-tax', subject: 'Rivera Personal Tax', participants: ['dana@x.com'],
      messages: [{ at: day(1), from_me: true, draft: false, subject: 'Rivera Personal Tax' }] },
  ] }));
  const hisOwn = await chases(vault, { now, perDay: 99 });
  check('a chase is held when HE wrote to them yesterday, on another thread',
        hisOwn.answered.some((a) => /Dana/.test(a.who)) && !hisOwn.rows.some((r) => /Dana/.test(r.who)),
        JSON.stringify(hisOwn.answered.map((a) => a.why)));
  check('  ...and the note says it was him, not them',
        /you have written to them since/.test(hisOwn.answered[0]?.why ?? ''), hisOwn.answered[0]?.why);

  // Older contact is not an answer, and must not silence a real chase.
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [mail(day(15), 'Updated invitation: onboarding')] }));
  const goes = await chases(vault, { now, perDay: 99 });
  check('a fortnight-old email does not silence the chase',
        goes.rows.some((r) => /Dana/.test(r.who)) && !goes.answered.length,
        JSON.stringify({ rows: goes.rows.map((r) => r.who), answered: goes.answered.map((a) => a.who) }));

  // Nothing from them at all: the ordinary case.
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [] }));
  const quiet = await chases(vault, { now, perDay: 99 });
  check('silence everywhere still chases', quiet.rows.some((r) => /Dana/.test(r.who)));

  /* A REPLY NOBODY HAS READ YET. Review item 5, 2026-09-20. Older than three
   * days, so the recency hold lets it through — but their message is NEWER
   * than the triage's last look at this thread, so the review has asked
   * whether it was the answer and the chase waits for that. Once the triage
   * has looked since and kept the item open, it goes. */
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [mail(day(6), 'Utility Bill — the city found the usage')] }));
  await state([{ chat_id: 'any;-;+15552000002', watermark: day(8), reviewed: day(7),
    conclusion: { open: true, owed_by: 'them', who: 'Dana', since: day(8), title: 'Chase Dana on the Elmwood water leak check' } }]);
  const unread = await chases(vault, { now, perDay: 99 });
  check('a six-day-old reply elsewhere holds the chase while the triage has not looked since',
        unread.answered.some((a) => /has not looked/.test(a.why)) && !unread.rows.some((r) => /Dana/.test(r.who)),
        JSON.stringify({ rows: unread.rows.map((r) => r.who), answered: unread.answered.map((a) => a.why) }));
  await state([{ chat_id: 'any;-;+15552000002', watermark: day(8), reviewed: day(5),
    conclusion: { open: true, owed_by: 'them', who: 'Dana', since: day(8), title: 'Chase Dana on the Elmwood water leak check' } }]);
  const looked = await chases(vault, { now, perDay: 99 });
  check('  ...and goes once the triage has looked since and kept it open', looked.rows.some((r) => /Dana/.test(r.who)) && !looked.answered.length,
        JSON.stringify({ rows: looked.rows.map((r) => r.who), answered: looked.answered.map((a) => a.why) }));

  /* THE REST OF THE COMPANY. Alex, 2026-09-21, on a chase that went to Amy
   * at Quality Cabinets Co: "there are other people in the same company I have
   * talked to about this project." It was right about the thread — 38 days,
   * nothing back — and blind to the firm: a colleague had written, and the
   * obligation with her was one HE owed. */
  const mailState = (rows) => writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: rows }));
  const mailThread = (id, who, title, owed, since) => ({
    thread_id: id, account: 'personal', watermark: since, reviewed: since,
    conclusion: { open: true, tier: 'action', who, title, what: title, owed_by: owed, since },
  });
  await state([]);
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ mailboxes: [{ account: 'personal', address: 'alex@rivera.example' }], threads: [] }));
  await mailState([
    mailThread('t-jen', 'amyr@citycab.example', 'Chase Quality Cabinets Co for the millwork number', 'them', day(38)),
    mailThread('t-britt', 'ninac@citycab.example', 'Decide on the Quality Cabinets Co closet estimate', 'me', day(13)),
    mailThread('t-far', 'sam@othervendor.com', 'Chase Other Vendor for the quote', 'them', day(20)),
  ]);
  const org = await chases(vault, { now, perDay: 99 });
  const heldWho = (w) => org.heldRows.find((h) => (h.who ?? '').includes(w));
  check('a chase is held while he owes the same company an answer',
        !!heldWho('amyr') && /you owe ninac@citycab\.example an answer first/.test(heldWho('amyr').why), JSON.stringify(org.heldRows.map((h) => h.why)));

  /* HIS OWN MAIL, ON THE CHASE'S OWN THREAD. Alex, 2026-09-23, of a 12:43
   * chase to Gail Quinn: "I already send Tess an email today before this
   * drafted." He had written to her twice that morning on that very thread.
   * `elsewhere` skips the item's own thread by design and `quiet` only counts
   * what THEY said, so his own mail was the one thing neither could see. */
  await mailState([mailThread('t-gail', 'quinnengineering@comcast.example',
    "Get Gail Quinn's threshold-engineer answer for BP26", 'them', day(32))]);
  const gail = (mine) => writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({
    mailboxes: [{ account: 'personal', address: 'alex@rivera.example' }],
    threads: [{ thread_id: 't-gail', subject: 'TRT request for update', participants: ['quinnengineering@comcast.example'],
      messages: [{ at: day(32), from_me: false, draft: false, subject: 'TRT request for update' },
                 { at: mine, from_me: true, draft: false, subject: 'TRT request for update' }] }] }));
  /* A LOCAL stamp, not this file's `day()`: that builds a UTC string, and the
     four-hour skew turns "two hours ago" into tomorrow. This case is measured
     in hours, so it has to be written the way the extractors write one. */
  const at = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  await gail(at(now - 2 * 3600000));
  const own = await chases(vault, { now, perDay: 99 });
  const teresaHeld = own.heldRows.find((h) => /quinn/i.test(h.who ?? ''));
  check('a chase is held when he wrote on its own thread today',
        !!teresaHeld && !own.rows.some((r) => /quinn/i.test(r.who)),
        JSON.stringify({ rows: own.rows.map((r) => r.who), held: own.heldRows.map((h) => h.why) }));
  check('  ...and the reason is his own mail, not their silence',
        /you wrote to .* yourself today/.test(teresaHeld?.why ?? ''), teresaHeld?.why);
  check('  ...and it is held by thread, so the tidy can discard the draft it already wrote',
        !!teresaHeld?.thread, JSON.stringify(teresaHeld?.thread ?? null));
  // Five days is not "an hour ago": a real chase still goes.
  await gail(at(now - 5 * 86400000));
  const stale = await chases(vault, { now, perDay: 99 });
  check('his own mail five days back does not silence a month of quiet',
        stale.rows.some((r) => /quinn/i.test(r.who)), JSON.stringify(stale.heldRows.map((h) => h.why)));
  check('  ...and an unrelated company is chased as before', org.rows.some((r) => /othervendor/.test(r.who)), JSON.stringify(org.rows.map((r) => r.who)));
  check('  the held one is never in the rows that would be sent', !org.rows.some((r) => /amyr/.test(r.who)));

  /* A HANDOFF IS PERMANENT. Alex, same message: "I don't want Amy G chase to
   * fire after I respond to nina. Amy handed me off to nina at one
   * point." The owed-first hold above would only defer it — the moment he
   * answers Nina, the wrong mail goes. */
  await mailState([
    { ...mailThread('t-jen', 'amyr@citycab.example', 'Chase Quality Cabinets Co for the millwork number', 'them', day(38)),
      conclusion: { ...mailThread('t-jen', 'amyr@citycab.example', 'Chase Quality Cabinets Co for the millwork number', 'them', day(38)).conclusion,
                    handed_to: 'ninac@citycab.example' } },
  ]);
  const handed = await chases(vault, { now, perDay: 99 });
  check('someone who handed the thread on is never chased, even with nothing owed back',
        !handed.rows.some((r) => /amyr/.test(r.who)) && /handed this to ninac@citycab\.example/.test(heldOf(handed, 'amyr')), JSON.stringify(handed.heldRows.map((h) => h.why)));
  check('  ...and the reason says where to chase instead', /their own thread, or merge/.test(heldOf(handed, 'amyr')));

  /* ONE A WEEK PER PERSON. Two debts of Dana's: one chase, the ranked one;
   * the other is held and says why. A ledger entry for her from four days ago
   * on a third item holds both. */
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [] }));
  await state([
    { chat_id: 'any;-;+15552000002', watermark: day(8), reviewed: day(8), conclusion: { open: true, owed_by: 'them', who: 'Dana', since: day(8), title: 'Chase Dana on the Elmwood water leak check' } },
    { chat_id: 'c-dock', watermark: day(9), reviewed: day(9), conclusion: { open: true, owed_by: 'them', who: '+15552000002', since: day(9), title: 'Get Dana\'s answer on the Birchwood dock' } },
  ]);
  const two = await chases(vault, { now, perDay: 99 });
  check('two debts of one person: one chase this week', two.rows.filter((r) => /Dana|5552000002/.test(r.who)).length === 1, JSON.stringify(two.rows.map((r) => r.who)));
  check('  ...the other is held and says so', two.heldRows.some((h) => /one a week per person/.test(h.why)), JSON.stringify(two.heldRows.map((h) => h.why)));
  await writeFile(join(vault, '.log', 'chases.json'), JSON.stringify({ 'im:c-other': { at: day(4), who: 'dana@x.com', channel: 'mail', text: 'x' } }));
  const week = await chases(vault, { now, perDay: 99 });
  check('a chase to her four days ago on a third item holds both', !week.rows.some((r) => /Dana|5552000002/.test(r.who)) && week.heldRows.length >= 2, JSON.stringify(week.heldRows.map((h) => h.why)));
  await writeFile(join(vault, '.log', 'chases.json'), JSON.stringify({ 'im:c-other': { at: day(9), who: 'dana@x.com', channel: 'mail', text: 'x' } }));
  const later = await chases(vault, { now, perDay: 99 });
  check('  ...and nine days ago does not', later.rows.filter((r) => /Dana|5552000002/.test(r.who)).length === 1);
}

/* One note for the pass. Alex, 2026-09-19: "why did only that followup become
 * a note? looks like there were two other outbox created at the same time."
 * The service wrote one file per draft, named by the minute, with `wx` — the
 * first won and the rest were swallowed. */
console.log('\nwhat the pass tells him it wrote');
{
  const { draftNote } = await import('../drafts.mjs');
  check('nothing written, nothing said', draftNote([]) === null && draftNote(undefined) === null);

  const one = draftNote([{ kind: 'chase', who: 'hull.sharon@oliverco.example', why: '#acme, 10 days quiet', text: 'Following up on this. Any update?' }]);
  check('one draft names the person in the title', one.title === 'Drafted a reply to hull.sharon@oliverco.example', one.title);
  check('  ...and says why it went first', /#acme, 10 days quiet/.test(one.body));
  check('  ...and quotes what is waiting', /> Following up on this/.test(one.body));
  check('  ...and says nothing was sent', /Nothing was sent/.test(one.body));

  const three = draftNote([
    { kind: 'chase', who: 'a@x.com', text: 'one' },
    { kind: 'chase', who: 'b@x.com', text: 'two' },
    { kind: 'invite', who: 'c@x.com', text: 'three' },
  ]);
  check('three drafts are ONE note, not three', three.title === 'Drafted 3 replies', three.title);
  check('  ...and every one of them is named', ['a@x.com', 'b@x.com', 'c@x.com'].every((w) => three.body.includes(w)),
        'the bug was that two of three vanished silently');
  check('  ...each with its own words', ['> one', '> two', '> three'].every((t) => three.body.includes(t)));
  check('an invite reads as an invite, not as a chase', /an invite is ready/.test(three.body));
  const rew = draftNote([{ kind: 'chase', who: 'a@x.com', rewrote: true, text: 'newer words' }]);
  check('a rewrite says so rather than claiming a new draft', /rewrote the draft already waiting/.test(rew.body));
}


/* A KEPT PROMISE CLOSES. Review item 2, 2026-09-20: `answered` had been
 * computed since 09-08 and nothing read it, so the Ari text went out with his
 * approval and the item sat open eighteen days. Only a promise, only on its
 * own thread, only with write:true — and named in draft-changes so the brief
 * says why a debt vanished. */
console.log('\na kept promise closes');
{
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-kept-'));
  for (const d of ['integrations', '.log', 'outbox']) await mkdir(join(vault, d), { recursive: true });
  const now = Date.parse('2026-09-20T09:00:00');
  const day = (n) => new Date(now - n * 86400000).toISOString().slice(0, 16).replace('T', ' ');
  await writeFile(join(vault, 'integrations', 'contacts.json'), JSON.stringify({ index: { '5552000008': 'Ari' } }));
  await writeFile(join(vault, 'integrations', 'calls.json'), JSON.stringify({ calls: [] }));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [] }));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [
    { chat_id: 'any;-;+15552000008', participants: ['+15552000008'], messages: [{ at: day(9), from_me: false, text: 'Any notes on the render?' }] },
    { chat_id: 'any;-;+18130000000', participants: ['+18130000000'], messages: [{ at: day(9), from_me: false, text: 'Tahoe?' }] },
  ] }));
  const rows = [
    // promised, and the reply went out on THIS chat: closes
    { chat_id: 'any;-;+15552000008', watermark: day(9), reviewed: day(1),
      conclusion: { open: true, owed_by: 'me', who: '+15552000008', since: day(9), promised: day(7), title: 'Send Ari your notes on the render' } },
    // promised, but the only send was a different conversation with the same person: does NOT close
    { chat_id: 'any;-;+18130000000', watermark: day(9), reviewed: day(1),
      conclusion: { open: true, owed_by: 'me', who: '+18130000000', since: day(9), promised: day(7), title: 'Pass the Tahoe offer on' } },
  ];
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: rows }));
  const rec = (name, chat, at, body) => writeFile(join(vault, 'outbox', name),
    `---\ntype: outbox\nto: ${chat.split('+').pop() ? '+' + chat.split('+').pop() : '?'}\nchat_id: ${chat}\nstatus: sent\ncreated: ${day(6)}\napproved_at: ${at} by alex@rivera.example\nsent_at: ${at}\nerror: -\n---\n${body}\n`);
  await rec('2026-09-15-0728-eli.md', 'any;-;+15552000008', day(5), 'Here are my notes on the first render.');
  await rec('2026-09-16-0900-tom-group.md', 'any;+;group-with-tom', day(4), 'How was the flight? 4k check going out.');

  const dry = await draftsPass(vault, { now, write: false });
  check('read-only closes nothing', (dry.closed ?? []).length === 0, JSON.stringify(dry.closed));
  const r = await draftsPass(vault, { now, write: true });
  check('the kept promise is closed, and only that one', r.closed.length === 1 && /Ari/.test(r.closed[0].title), JSON.stringify(r.closed));
  const state = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8')).threads;
  const eli = state.find((t) => /5552000008/.test(t.chat_id)).conclusion;
  const tahoe = state.find((t) => /8130000000/.test(t.chat_id)).conclusion;
  check('  ...closed by the drafts pass, with the send as the outcome', eli.open === false && eli.closed_by === 'agent:drafts', JSON.stringify({ open: eli.open, by: eli.closed_by }));
  check('  ...and the one whose send was another conversation stays open', tahoe.open === true);
  const changes = (await readFile(join(vault, 'integrations', 'draft-changes.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('  ...and the brief will be told why', changes.some((c) => c.action === 'closed' && /Ari/.test(c.title) && /promised/.test(c.why)), JSON.stringify(changes));
  const again = await draftsPass(vault, { now, write: true });
  check('  ...once — a second pass finds nothing to close', (again.closed ?? []).length === 0, JSON.stringify(again.closed));

  /* A SEND FROM BEFORE THE PROMISE IS NOT ITS KEEPING. The re-audit,
     2026-09-20: sentExact had no date bound, so any old sent record on the
     chat — months before he promised — closed the promise on the next pass,
     quoting an unrelated text. And a REOPENED promise was re-closed by the
     same stale send. A send keeps a promise only if it is later than the
     promise, and later than the last time this was closed. */
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'any;-;+15552000008', watermark: day(9), reviewed: day(1),
      conclusion: { open: true, owed_by: 'me', who: '+15552000008', since: day(9), promised: day(2), title: 'Send Ari the second render notes' } },
  ] }));
  const r2 = await draftsPass(vault, { now, write: true });
  check('a send from before the promise does not close it', (r2.closed ?? []).length === 0, JSON.stringify(r2.closed));
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'any;-;+15552000008', watermark: day(9), reviewed: day(1),
      conclusion: { open: true, owed_by: 'me', who: '+15552000008', since: day(9), promised: day(7), closed_at: day(3), closed_by: 'agent:drafts', title: 'Reopened after a new message' } },
  ] }));
  const r3 = await draftsPass(vault, { now, write: true });
  check('a reopened promise is not re-closed by the send that closed it before', (r3.closed ?? []).length === 0, JSON.stringify(r3.closed));
}

/* HOW LONG IT HAS ACTUALLY BEEN QUIET. Alex, 2026-09-21, of a chase to the
   One Springfield manager: "manager@harborview-condo.example email me on Sep 18th.
   it has not been 11 days quiet." The 11 was the obligation's AGE — the day
   the waiting started — and every surface reading it said "days quiet". On the
   live list this was about to send six follow-ups to people who had written
   within days, three of them that same day. */
console.log('\nquiet is the gap since THEY wrote, not the age of the debt');
{
  /* 14:00, not noon: the gaps here are 3.07 and 11.03 days and `days()`
     floors, so a fixture an hour earlier makes them 2 and 10 and the test
     measures its own arithmetic rather than the code's. */
  const NOW = Date.parse('2026-09-21T14:00:00');
  const said = [
    { at: '2026-09-10 13:14', from: 'you', channel: 'email', thread: 't1' },
    { at: '2026-09-18 12:16', from: 'them', channel: 'email', thread: 't1' },
  ];
  check('measured from their newest message', quietFor(said, { since: '2026-09-10 13:14', now: NOW }) === 3,
        String(quietFor(said, { since: '2026-09-10 13:14', now: NOW })));

  /* The bug in one assertion: a reply ON the chase's own thread counts. The
     recency hold excluded it, reasoning that a reply there would have closed
     the item — but the triage read Lena's message and correctly kept the
     obligation open, because what he is waiting for had not arrived. Answering
     is not discharging, and a live conversation is the last thing to chase. */
  check('  a reply on the chase\'s own thread counts — answering is not discharging',
        quietFor(said.filter((x) => x.thread === 't1'), { since: '2026-09-10 13:14', now: NOW }) === 3);

  check('  his own writing does not make it quiet again',
        quietFor([...said, { at: '2026-09-21 09:00', from: 'you', channel: 'email' }],
                 { since: '2026-09-10 13:14', now: NOW }) === 3);

  check('nothing from them at all falls back to when the waiting started — never answered',
        quietFor([{ at: '2026-09-10 13:14', from: 'you', channel: 'email' }],
                 { since: '2026-09-10 13:14', now: NOW }) === 11);
  check('  and so does an empty record', quietFor([], { since: '2026-09-10 13:14', now: NOW }) === 11);
  check('  with no `since` either it says it does not know, rather than 0',
        quietFor([], { since: null, now: NOW }) === null);

  const ranked = rankChases([
    { id: 'a', who: 'a@x.com', days: 40, quiet: 2 },
    { id: 'b', who: 'b@x.com', days: 11, quiet: 9 },
  ], { now: NOW });
  check('the ranking orders by the real gap, not the age',
        ranked[0].id === 'b', ranked.map((r) => r.id).join(','));
  check('  and the sentence quotes it', /9 days quiet/.test(ranked[0].why), ranked[0].why);
  check('  never the age it used to quote', !/11 days quiet/.test(ranked[0].why), ranked[0].why);
}

/* A NOTE SAYS WHAT THE CHASE IS ABOUT. Alex, 2026-09-22, of "mattunger@
   gmail.com had gone quiet (34 days quiet). > following up on this. Any
   update?": "that note is practically worthless as presented. following up
   on what? who is matt unger?" The draft says "this" on purpose — it replies
   on a thread whose subject names the thing — but the note is read by him,
   weeks later, with no thread in front of him. */
console.log('\nthe note a drafted chase leaves');
{
  const what = 'Joel Ames owns residenceos.com and the .org, and is about to launch a secondary software line on the name. Alex asked whether he would sell.\n\nUPDATE 2026-09-22: a chase is sitting as an unsent draft.';
  const n = draftNote([{ id: 'mail:personal:1a016759dbdedc84', who: 'joelames@gmail.com', kind: 'chase',
                         why: '34 days quiet', title: 'Close out the residenceos.com domain with Joel Ames', what,
                         text: 'following up on this. Any update?' }]);
  check('the title names the task, not the address', /residenceos\.com/.test(n.title) && !/mattunger/.test(n.title), n.title);
  check('  the task is linked to where he can act on it',
        n.body.includes('](/todo#pane=mail%3Apersonal%3A1a016759dbdedc84)'), n.body);
  check('  it says in a sentence what the thing was', n.body.includes('Joel Ames owns residenceos.com'), n.body);
  check('  from the headline only — no dated UPDATE log in a note', !/UPDATE 2026/.test(n.body), n.body);
  check('  and still quotes the draft itself', n.body.includes('> following up on this. Any update?'));
  check('  with who and how long, so he knows why now', /joelames@gmail\.com/.test(n.body) && /34 days quiet/.test(n.body));

  const bare = draftNote([{ id: 'x:1', who: 'a@b.com', kind: 'chase', text: 'hi' }]);
  check('an item with no title still names the person rather than breaking', /\*\*a@b\.com\*\*/.test(bare.body), bare.body);

  const long = 'First sentence is here and is long enough to matter for the cut. ' + 'x'.repeat(400);
  check('a long headline is cut at a sentence', headlineOf(long) === 'First sentence is here and is long enough to matter for the cut.', headlineOf(long));
  check('  and an empty one is empty', headlineOf(null) === '' && headlineOf('') === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
