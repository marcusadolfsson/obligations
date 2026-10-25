/**
 * One answer, not one schedule.
 *
 * `context.mjs` exists because four passes each assembled their own slice of
 * "what does the rest of the assistant know about this obligation" and none could
 * see the others'. What is pinned here is mostly the ways that de-duplication
 * can go wrong: two copies of a rule that look identical and are not, and a
 * source that could not be read being mistaken for a source that said no.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContext, distinctive, mentions, RECENT_DAYS, daysForTest } from './context.mjs';
import { REPLY_RECENT, days as draftsDays } from './drafts.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('the number that decides whether an email goes out');
/* THE WHOLE POINT OF THE FILE, IN ONE ASSERTION. "Recently in touch" had three
 * implementations. If these two ever drift, the chase gate and everything else
 * disagree about whether somebody replied — and the chase gate is the one that
 * sends mail over his name. */
check('the chase gate and the shared context use the same recency',
  REPLY_RECENT === RECENT_DAYS, `chase ${REPLY_RECENT} vs context ${RECENT_DAYS}`);
/* And the same arithmetic — pinned, not described. The re-audit found the two
   `days()` helpers differ on an unparseable stamp (0 vs NaN); every comparison
   falls the same way today, and this is what keeps that true. */
{
  const t = Date.parse('2026-09-20T09:00:00');
  const same = ['2026-09-17 10:00', '2026-09-16 09:00', '2026-09-20 08:00', '', null, 'garbage']
    .every((v) => (draftsDays(v, t) <= RECENT_DAYS) === (daysForTest(v, t) <= RECENT_DAYS));
  check('and agree on every stamp shape about what is "recent"', same);
}

console.log('\njoining an obligation to a trip');
check('a trip name gives its distinctive words', distinctive('Pinecrest — ski trip').join(',') === 'pinecrest',
  distinctive('Pinecrest — ski trip').join(','));
check('a heading with no distinctive word joins nothing', !mentions('anything at all', 'trip · dates not chosen'));
check('a different place does not match', !mentions('Sort Pinecrest lodging', 'Hank Funland World · 2026-09-06 → 2026-09-07'));
check('substring is not a match', !mentions('he went to Pinecrestdale', 'Pinecrest — ski trip'));
/* A name with a regex character must not throw when it becomes a pattern. */
let threw = null;
try { mentions('the C++ review', 'C++ Rewrite · dates not chosen'); } catch (err) { threw = err.message; }
check('a name with regex characters does not throw', threw === null, String(threw));

console.log('\nwhat it knows, and what it admits it cannot see');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(vault, 'reference'), { recursive: true });
  await writeFile(join(vault, 'reference', 'bookings.md'),
    '## Pinecrest — ski trip · 2026-09-24 → 2026-09-29\n'
    + '- 2026-09-24 → 2026-09-29 · Summit Lodge Pinecrest, 2 adults · conf CX7QZRTA · check-in 4:00 PM\n');

  const ob = { id: 'im:1', title: 'Sort Pinecrest lodging', what: 'nothing on file', who: 'reid@co91eb.example', since: '2026-09-05 18:53' };
  const ctx = await loadContext(vault, { now: Date.parse('2026-09-20T09:00:00'), open: [ob] });
  const k = await ctx.about(ob);

  check('it finds the trip the obligation names', k.trip?.name === 'Pinecrest — ski trip', JSON.stringify(k.trip));
  check('and the bookings filed under it', k.bookings.length === 1 && /Summit Lodge/.test(k.bookings[0].title), JSON.stringify(k.bookings.map((b) => b.title)));

  /* A SILENCE IS NOT AN ABSENCE. There is no contacts book in this repo, so
   * nobody could look — and `seen: false` is how a caller tells that apart from
   * "they have not written". Reading the empty list as an absence is exactly
   * how a chase gets sent to somebody who already replied. */
  check('no contacts book means seen:false, not "nobody wrote"',
    k.inTouch.seen === false && k.inTouch.recent.length === 0, JSON.stringify(k.inTouch.seen));
  check('and the missing source is named rather than swallowed',
    ctx.blind.some((b) => /contact/i.test(b)), JSON.stringify(ctx.blind));

  /* The caller's own list is used as given — the drafts pass has already merged
     it and merging twice in one tick is the cost this argument removes. */
  check('an obligation list passed in is not re-merged', ctx.obligations.length === 1);

  const none = await ctx.about({ id: 'im:2', title: 'Something else entirely', what: '' });

  /* WHAT HE SENT ON IT. Exact join only, after `since`. Review item 2: the
     Outbox had sent the Ari text on 09-15 and nothing could join it back. */
  await mkdir(join(vault, 'outbox'), { recursive: true });
  const rec = (name, fm, body) => writeFile(join(vault, 'outbox', name), `---\n${fm}\n---\n${body}\n`);
  await rec('2026-09-15-0728-eli.md', 'type: outbox-text\nto: +15552000008\nchat_id: any;-;+15552000008\nstatus: sent\ncreated: 2026-09-14 18:00\napproved_at: 2026-09-15 07:28\nsent_at: 2026-09-15 07:29\nerror: -', 'Here are my notes on the first render.');
  await rec('2026-09-01-0900-eli-old.md', 'type: outbox-text\nto: +15552000008\nchat_id: any;-;+15552000008\nstatus: sent\ncreated: 2026-09-01 09:00\nsent_at: 2026-09-01 09:00\nerror: -', 'An older text, before the debt.');
  await rec('2026-09-15-0726-quikr.md', 'type: outbox-mail\nto: ops@coaaa0.example\nsubject: Re: MMEL\naccount: personal\ndraft_id: r1\nmessage_id: m1\nthread_id: abc123\nstatus: sent\ncreated: 2026-09-15 07:26\nsent_at: 2026-09-15 07:26\nerror: -', 'Thanks, noted.');
  const ctx2 = await loadContext(vault, { now: Date.parse('2026-09-20T09:00:00'), open: [] });
  const eliOb = { id: 'im:eli', title: 'Send Ari your notes', who: '+15552000008', since: '2026-09-05 10:00', chat_id: 'any;-;+15552000008', evidence: [{ source: 'imessage', detail: { chat_id: 'any;-;+15552000008' } }] };
  const k2 = await ctx2.about(eliOb);
  check('a text sent on the obligation\'s own chat, after it began, is found', k2.sent.length === 1 && k2.sent[0].id === '2026-09-15-0728-eli.md', JSON.stringify(k2.sent.map((d) => d.id)));
  check('and one sent before the debt existed is not', !k2.sent.some((d) => /old/.test(d.id)));
  const mailOb = { id: 'mail:personal:abc123', title: 'Decide on the quote', who: 'ops@coaaa0.example', since: '2026-09-10 08:00', evidence: [{ source: 'email', detail: { thread_id: 'abc123', account: 'personal' } }] };
  const k3 = await ctx2.about(mailOb);
  check('a mail sent on the obligation\'s own thread is found by thread id', k3.sent.length === 1 && k3.sent[0].kind === 'mail', JSON.stringify(k3.sent.map((d) => d.id)));
  /* HANDLE IS NOT A JOIN. The same person, a different conversation: a text
     to Pete about a $4k check must not read as the answer to the Tahoe item. */
  const other = { id: 'im:eli2', title: 'Something else with Ari', who: '+15552000008', since: '2026-09-05 10:00', chat_id: 'any;+;group-with-eli', evidence: [{ source: 'imessage', detail: { chat_id: 'any;+;group-with-eli' } }] };
  const k4 = await ctx2.about(other);
  check('the same person on a different conversation is not a match', k4.sent.length === 0, JSON.stringify(k4.sent.map((d) => d.id)));

  /* THE THREE SOURCES THE CLOSE-PATH AUDIT NAMED. Review item 3, 2026-09-20. */
  await mkdir(join(vault, 'integrations'), { recursive: true });
  // Chronological, as an append-only file is; readCloses is last-entry-wins.
  await writeFile(join(vault, 'logbook.md'), '- 2026-09-01 08:00 | im:eli | old close | by alex | before the debt\n- 2026-09-14 23:40 | im:eli | Send Ari your notes | by agent:assistant | he sent them\n');
  await writeFile(join(vault, 'integrations', 'calendar.json'), JSON.stringify({ today: [], upcoming: [
    { summary: 'N200BB 60-month inspection at Cypress', startsOn: '2026-09-26', startsAt: '09:00' },
    { summary: 'Wire transfer training', startsOn: '2026-09-26' },
    { summary: 'N200BB inspection — before the debt', startsOn: '2026-09-01' },
  ] }));
  const ctx3 = await loadContext(vault, { now: Date.parse('2026-09-20T09:00:00'), open: [] });
  const k5 = await ctx3.about(eliOb);
  check('a logbook line for this id, dated after the debt began, is found', k5.logged?.who === 'agent:assistant' && /sent them/.test(k5.logged.outcome), JSON.stringify(k5.logged));
  const sched = { id: 'mail:x', title: 'Schedule the N200BB 60-month inspection', since: '2026-09-10 08:00', evidence: [] };
  const k6 = await ctx3.about(sched);
  check('a calendar event sharing two distinctive words, after the debt began, is found', k6.onCalendar.length === 1 && /Cypress/.test(k6.onCalendar[0].summary), JSON.stringify(k6.onCalendar.map((e) => e.summary)));
  /* A RECEIPT ON FILE. The invoice itself is filed when the debt is created,
     so only a LATER line that says paid counts. */
  await writeFile(join(vault, 'reference', 'statements.md'),
    '- 2026-09-08 — **Invoice 4471** from Lawson Law billing@lawfirm.example · [x](y) · 40KB · msg:1\n'
    + '- 2026-09-16 — **Receipt for your payment** from Lawson Law billing@lawfirm.example · [x](y) · 40KB · msg:2\n'
    + '- 2026-09-17 — **Receipt** from Pat Morgan for Mayor thankyou@co9d92.example · [x](y) · 40KB · msg:3\n');
  const ctx4 = await loadContext(vault, { now: Date.parse('2026-09-20T09:00:00'), open: [] });
  const pay = { id: 'mail:p', title: 'Pay the Lawson Law invoice', since: '2026-09-08 09:00', evidence: [] };
  const k8 = await ctx4.about(pay);
  check('a later receipt from the vendor is found', k8.paidOnFile.length === 1 && /Receipt for your payment/.test(k8.paidOnFile[0].title), JSON.stringify(k8.paidOnFile));
  check('  ...the invoice itself is not a receipt', !k8.paidOnFile.some((x) => /Invoice/.test(x.title)));
  check('  ...and a receipt from somebody else is not', !k8.paidOnFile.some((x) => /Morgan/.test(x.sender)));
  const wire = { id: 'mail:y', title: 'Confirm the Citi wire landed', since: '2026-09-10 08:00', evidence: [] };
  const k7 = await ctx3.about(wire);
  check('one shared generic word is not a calendar match', k7.onCalendar.length === 0, JSON.stringify(k7.onCalendar.map((e) => e.summary)));
  /* The re-audit's precision fixes. */
  const wireOb = { id: 'mail:w', title: 'Wire the Pinecrest closing funds', since: '2026-09-08 09:00', evidence: [] };
  await writeFile(join(vault, 'reference', 'statements.md'), '- 2026-09-16 — **Wire transfer receipt** from Chase alerts@chase.com · [x](y) · 40KB · msg:9\n');
  const ctx5 = await loadContext(vault, { now: Date.parse('2026-09-20T09:00:00'), open: [] });
  const k9 = await ctx5.about(wireOb);
  check('the leading verb is not a vendor: "Wire the…" does not match a Chase wire receipt', k9.paidOnFile.length === 0, JSON.stringify(k9.paidOnFile));
  const noWho = { id: 'apple:1', title: 'Call Ruth', since: '2026-09-10 10:00', evidence: [] };
  const k10 = await ctx5.about(noWho);
  check('an obligation with no who is seen:false, not "nobody wrote"', k10.inTouch.seen === false);
  const noSince = { id: 'apple:2', title: 'Send Ari your notes', who: '+15552000008', evidence: [{ id: 'im:eli' }] };
  const k11 = await ctx5.about(noSince);
  check('a logbook match needs a since to compare against', k11.logged === null);
  const heldOb = { id: 'mail:h', title: 'Confirm the Cypress inspection slot', since: '2026-09-10 08:00', evidence: [] };
  await writeFile(join(vault, 'integrations', 'calendar.json'), JSON.stringify({ today: [], upcoming: [{ summary: 'Cypress inspection slot (hold)', startsOn: '2026-09-26', obligations: 'hold:abc' }] }));
  const ctx6 = await loadContext(vault, { now: Date.parse('2026-09-20T09:00:00'), open: [] });
  const k12 = await ctx6.about(heldOb);
  check('a hold the assistant made is not evidence he confirmed it', k12.onCalendar.length === 0, JSON.stringify(k12.onCalendar));
  await rm(vault, { recursive: true, force: true });
  check('an obligation that names no trip gets none', none.trip === null && none.bookings.length === 0);
  check('and no twin when there is only one item', none.twin === null);
}

console.log('\na repo with nothing in it');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  const ctx = await loadContext(vault, { open: [] });
  check('an empty repo loads rather than throwing', Array.isArray(ctx.trips) && Array.isArray(ctx.bookings));
  const k = await ctx.about({ id: 'x' });
  check('and answering about nothing is safe', k.trip === null && k.twin === null && k.inTouch.recent.length === 0);
  await rm(vault, { recursive: true, force: true });
}

console.log('\nwho a handle is WITH, as an organisation');
{
  const { orgOf, NOISE_ORGS } = await import('./context.mjs');
  check('two addresses at one firm are one counterparty', orgOf('amyr@citycab.example') === 'citycab' && orgOf('ninac@citycab.example') === 'citycab');
  check('  and the differ\'s own example still holds', orgOf('eecreportinghours@northwind-aero.example') === orgOf('accounts.receivable@northwind-aero.example.br'));
  check('a consumer domain is nobody', orgOf('someone@gmail.com') === '' && orgOf('x@icloud.com') === '');
  check('his own domain is not a counterparty', orgOf('dana@rivera.example', new Set(['rivera.example'])) === '');
  check('a bare name gives nothing — it has no domain to join on', orgOf('Nina Cole') === '' && orgOf('') === '' && orgOf(null) === '');
  check('`Name <addr>` is read', orgOf('Amy G <amyr@citycab.example>') === 'citycab');

  /* ONE RULE, TWO LANGUAGES. The mail differ answers the same question in
     Python for the work list; this answers it in JS for the chase. They must
     not drift — a company that is a counterparty on one side and noise on the
     other is exactly the disagreement that produces a wrong chase. */
  const { readFile } = await import('node:fs/promises');
  const py = await readFile(new URL('./integrations/email-diff.py', import.meta.url), 'utf8');
  const block = /NOISE_ORGS = \{([\s\S]*?)\}/.exec(py);
  const pyOrgs = new Set([...(block?.[1] ?? '').matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  const missing = [...pyOrgs].filter((x) => !NOISE_ORGS.has(x));
  const extra = [...NOISE_ORGS].filter((x) => !pyOrgs.has(x));
  check('NOISE_ORGS is the same set in both differs', pyOrgs.size > 20 && !missing.length && !extra.length,
        `missing ${missing.join(',')} | extra ${extra.join(',')}`);
}

/* AN ANSWER THE MAIL JOB FILED IS STILL AN ANSWER. Alex, 2026-09-22, of a
   to-do chasing Wendy Fuller for a flood declaration page: "she did follow
   up." She had, on a NEW thread, which the mail job judged as a receipt and
   archived — and archiving took it out of the live extract, the only mail this
   check read. The state file keeps who each judged thread was with. */
console.log('\na reply the mail job already filed away');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-filed-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'contacts.json'),
    JSON.stringify({ index: { 'wendy-fuller@insureco.example': 'Wendy Fuller' } }));
  // No live extract at all: the answer is in the judged record only.
  const rec = (id, who, watermark, extra = {}) => ({ thread_id: id, account: 'personal', watermark, reviewed: watermark,
    conclusion: { who, tier: 'digest', open: false, subject: `s-${id}`, since: watermark, ...extra } });
  await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    rec('own0001', 'wendy-fuller@insureco.example', '2026-08-28 19:07', { tier: 'action', open: true, owed_by: 'them' }),
    rec('dec0002', 'wendy-fuller@insureco.example', '2026-08-31 14:11', { subject: 'Loan #5552000016 - Flood Policy FLD00001' }),
    rec('old0003', 'wendy-fuller@insureco.example', '2026-08-01 09:00'),           // before the debt began
    rec('oth0004', 'someone@else.com', '2026-09-01 09:00'),                     // a different person
    rec('inv0005', 'wendy-fuller@insureco.example', '2026-09-02 09:00', { subject: 'Invitation: renewal call' }),
  ] }));
  const ob = { id: 'mail:personal:own0001', title: 'Chase Wendy Fuller on the Marisol flood dec page',
               who: 'wendy-fuller@insureco.example', owed_by: 'them', since: '2026-08-28 19:07',
               evidence: [{ source: 'email', ref: 'mail:personal:own0001', detail: { thread_id: 'own0001', account: 'personal' } }] };
  const ctx = await loadContext(vault, { now: Date.parse('2026-09-21T09:00:00'), open: [ob] });
  const k = await ctx.about(ob);
  const threads = k.elsewhere.map((x) => x.thread);
  check('her answer on a new, archived thread is found', threads.includes('dec0002'), JSON.stringify(k.elsewhere));
  check('  and it says what it was', k.elsewhere.some((x) => /FLD00001/.test(x.detail)));
  check('  the obligation\'s own thread is not "elsewhere"', !threads.includes('own0001'));
  check('  nothing from before the debt began', !threads.includes('old0003'));
  check('  nobody else\'s mail', !threads.includes('oth0004'));
  check('  and a machine-made invitation says nothing about the debt', !threads.includes('inv0005'));
  await rm(vault, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);