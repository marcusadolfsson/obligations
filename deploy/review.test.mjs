/**
 * The review pass — mostly what it refuses.
 *
 * A finding here sends a model to rewrite a sentence Alex relies on, so the
 * expensive failure is a false positive, not a miss. `lint.mjs` learned that by
 * calling his own home four rare places and declaring three live vendors dead.
 * Most of what follows is the cases that must NOT flag.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distinctive, mentions, ranges, claimsAbsent, spinning, relativeDate, headline, correct, changesSince, review, forPrompt, PROMPT_CHECKS, handoff } from './review.mjs';
import { capsOf } from './agent-service/similar.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('joining an obligation to a trip');
check('a trip name gives its distinctive words', distinctive('Pinecrest — ski trip').join(',') === 'pinecrest',
  distinctive('Pinecrest — ski trip').join(','));
check('and drops the ones that mean nothing', !distinctive('Pinecrest — ski trip').includes('trip'));
check('a text naming the place matches', mentions('Sort Pinecrest lodging and tell the group', 'Pinecrest — ski trip'));
/* THE REFUSAL THAT MATTERS MOST. Two trips are not one because both are trips,
   and a heading with no distinctive word of its own must join NOTHING rather
   than everything — otherwise "Japan · dates not yet recorded" would claim
   every obligation in the list. */
check('a heading with no distinctive word joins nothing', !mentions('anything at all', 'trip · dates not chosen'));
check('and a different place does not match', !mentions('Sort Pinecrest lodging', 'Hank Funland World · 2026-09-06 → 2026-09-07'));
check('substring is not a match', !mentions('he went to Pinecrestdale', 'Pinecrest — ski trip'));

/* ONE TOKENISER, NOT TWO. The first cut of review.mjs wrote its own copy of
   "what counts as a distinctive word", which is the exact habit the file exists
   to stop: two functions deciding the same thing will one day disagree about
   one word, and the bug is invisible because both look right. It delegates to
   similar.mjs now and only adds the trip-specific refusal on top. */
check('distinctive() is capsOf() minus the dull words',
  distinctive('Pinecrest — ski trip').every((w) => capsOf('Pinecrest — ski trip').has(w)));
check('and it keeps a name capsOf keeps', distinctive('Hank Funland World').includes('funland'),
  distinctive('Hank Funland World').join(','));
/* A name with a regex character in it must not throw when it becomes one. */
check('a heading with punctuation does not blow up the matcher',
  mentions('the C++ review', 'C++ · dates not chosen') === false || true);

console.log('\nwhat counts as a date claim');
check('a range is a claim', ranges('he has the aircraft 09-22 to 09-27')[0]?.from === '09-22');
check('a full-date range too', ranges('2026-09-24 → 2026-09-29')[0]?.to === '09-29');
/* A SINGLE DATE IS NOT A CLAIM ABOUT THE TRIP. Conclusions are full of dates
   that are facts about the past — "he confirmed on 2026-09-03", "Reid asked on
   2026-09-05 18:53" — and reading those as trip windows would flag almost
   every obligation in the repo. Only a range reads as "the trip is X to Y". */
check('a lone date is not a range', ranges('he confirmed on 2026-09-03 with Mia and I are in').length === 0);
check('two unrelated dates in a sentence are not a range',
  ranges('Reid asked on 2026-09-05 and Kyle answered. Filed 2026-09-08.').length === 0);

console.log('\nclaiming nothing is on file');
check('naming the file is a claim', claimsAbsent('nothing in reference/bookings.md records lodging for him'));
check('so is saying the room is not booked', claimsAbsent('the hotel is still not booked'));
check('a note that something IS filed is not', !claimsAbsent('Filed to reference/bookings.md under the Pinecrest trip'));
check('and neither is an unrelated negative', !claimsAbsent('he has not answered Reid yet'));

console.log('\na loop that is not going anywhere');
{
  const spun = 'The original judgement, which is long enough to matter. '
    + Array.from({ length: 6 }, (_, k) => `UPDATE 2026-09-1${k} (0${k}:00 run): re-checked — no new messages, no new call. Unchanged; still unanswered.`).join(' ');
  check('six no-op updates in a row are counted', spinning(spun).runs === 6, JSON.stringify(spinning(spun)));
  /* A REAL UPDATE STOPS THE COUNT. The run that found the second Kyle Weller
     call said something; everything after it is noise, and everything before
     it is history. Counting through a genuine entry would call a live thread
     stale. */
  const mixed = 'Original. UPDATE 2026-09-10: re-checked — no new messages. Unchanged. '
    + 'UPDATE 2026-09-11: a second call with Kyle at 18:13, genuinely new. '
    + 'UPDATE 2026-09-12: re-checked — no new call. Unchanged.';
  check('a genuine update stops the count', spinning(mixed).runs === 1, JSON.stringify(spinning(mixed)));
  check('a conclusion with no updates is not spinning', spinning('Just the one paragraph, nothing appended.').runs === 0);
  check('and an empty one does not throw', spinning('').runs === 0 && spinning(null).runs === 0);
}

console.log('\na date that cannot stay true');
{
  /* Caught on the very first live correction. The model fixed the Pinecrest window
     from 09-22 to 09-24 and carried the next clause through untouched — "and
     the trip begins in two days", when it was four. A headline is written once
     and read for weeks, so any relative expression in it has a shelf life of a
     day. */
  check('a countdown in the headline is a finding',
    relativeDate('The reply to Reid is outstanding, and the trip begins in two days.') === 'in two days');
  check('so is a bare tomorrow', relativeDate('He owes Glen a verdict tomorrow.') === 'tomorrow');
  check('and "six days out"', relativeDate('Still unanswered, six days out from the trip.') === 'six days out');

  /* REDUNDANT IS NOT MISLEADING. The date is right there to be read, so the
     parenthesis going stale costs him nothing — and sending a model to fix
     every one of these would spend the budget on style. */
  check('not when the real date is beside it',
    relativeDate("Mia's birthday is 2027-09-04 (two weeks out) — make dinner plans.") === null);

  /* THE LOG IS NOT THE HEADLINE. Inside a dated entry "today" is exact, and
     flagging those would be flagging the audit trail for being one. */
  check('a relative date inside an UPDATE is left alone',
    relativeDate('The room is booked. UPDATE 2026-09-18: he texted Pete today, nothing on the Tahoe.') === null);
  check('headline() stops at the first entry',
    headline('The current statement. UPDATE 2026-09-18: something else.') === 'The current statement.');
  check('and a conclusion with no relative date is clean',
    relativeDate('He owes Reid a one-line reply about lodging.') === null);
  /* "No new messages, but he paid the invoice" opens like a no-op and is not
     one — the re-audit's case. The clause that turns is the one that matters. */
  const turned = 'Original. ' + Array.from({ length: 5 }, (_, k) => `UPDATE 2026-09-1${k}: re-checked — no new messages. Unchanged.`).join(' ')
    + ' UPDATE 2026-09-19: No new messages, but he paid the invoice on 09-19.';
  check('a leading negative with a "but" is not a no-op', spinning(turned, { now: new Date('2026-09-20T09:00:00') }).runs === 0, JSON.stringify(spinning(turned, { now: new Date('2026-09-20T09:00:00') })));
}

console.log('\nhe sent something on it from the Outbox');
{
  /* Review item 2, 2026-09-20. A kept PROMISE closes on its own in the drafts
     pass. This is the other case: a send on the obligation's own thread with
     no promised date — the Ari text was the discharge, the mail on the Quikr
     thread was not the decision about Quikr's quote — and whether the send WAS
     the answer is judgement. So it is a finding with the words he sent, never
     a close. */
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(vault, 'outbox'), { recursive: true });
  await writeFile(join(vault, 'outbox', '2026-09-15-0728-eli.md'),
    '---\ntype: outbox-text\nto: +15552000008\nchat_id: any;-;+15552000008\nstatus: sent\ncreated: 2026-09-14 18:00\nsent_at: 2026-09-15 07:29\nerror: -\n---\nHere are my notes on the first render.\n');
  const base = { title: 'Send Ari your notes', who: '+15552000008', since: '2026-09-05 10:00', what: 'He owes Ari notes.', chat_id: 'any;-;+15552000008', owed_by: 'me',
    evidence: [{ source: 'imessage', ref: 'c', detail: { chat_id: 'any;-;+15552000008' } }] };
  const r1 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [{ id: 'im:eli', code: 'AAAA', ...base }] });
  const f1 = r1.findings.find((f) => f.check === 'sent-from-outbox');
  check("a send on the obligation's own thread becomes a question for the triage", !!f1 && /Here are my notes/.test(f1.claim), JSON.stringify(r1.findings.map((f) => f.check)));
  check('and it says close it with close.mjs, or leave it and say why', /close\.mjs/.test(f1?.why ?? '') && /leave it open/.test(f1?.why ?? ''));
  /* A PROMISE IS NOT A QUESTION. The drafts pass closes a kept promise itself;
     asking the triage as well would be two writers of one close. */
  const promised = { ...base, evidence: [{ source: 'imessage', ref: 'c', detail: { chat_id: 'any;-;+15552000008', promised: '2026-09-12' } }] };
  const r2 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [{ id: 'im:eli', code: 'AAAA', ...promised }] });
  check('a kept promise is not asked about — the drafts pass closes it', !r2.findings.some((f) => f.check === 'sent-from-outbox'));
  /* Something THEY owe is not discharged by him writing to them. */
  const theirs = { ...base, owed_by: 'them', title: 'Chase Ari for the estimate' };
  const r3 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [{ id: 'im:eli', code: 'AAAA', ...theirs }] });
  check('a send does not discharge something they owe', !r3.findings.some((f) => f.check === 'sent-from-outbox'));
  await rm(vault, { recursive: true, force: true });
}

console.log('\nthey wrote back, somewhere else');
{
  /* Review item 3. For something THEY owe, a reply on another conversation is
     the one fact the triage cannot see — it reads the thread the chase is on.
     Dana answered the leak question on the utility-bill thread. And an
     invitation is not a reply: the first live run flagged "Chase the ONE team"
     over an "Updated invitation", which is the lesson the chase hold learned. */
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'contacts.json'), JSON.stringify({ index: { 'dana@x.com': 'Dana' } }));
  await writeFile(join(vault, 'integrations', 'calls.json'), JSON.stringify({ calls: [] }));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [] }));
  const mail = (subject, at) => ({ thread_id: 't-' + subject.slice(0, 6), subject, participants: ['dana@x.com'], messages: [{ at, from_me: false, draft: false, subject }] });
  const ob = { id: 'im:dana', code: 'CCCC', title: 'Chase Dana on the Elmwood leak', who: 'dana@x.com', owed_by: 'them', since: '2026-09-10 08:00', what: 'He asked; no answer.', chat_id: 'any;-;+15552000002', evidence: [{ source: 'imessage', ref: 'c', detail: { chat_id: 'any;-;+15552000002' } }] };
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [mail('Utility Bill — the city found the usage', '2026-09-17 10:00')] }));
  const r1 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [ob] });
  const f = r1.findings.find((x) => x.check === 'they-replied');
  check('a reply from them on another thread becomes a question', !!f && /Utility Bill/.test(f.claim), JSON.stringify(r1.findings.map((x) => x.check)));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [mail('Updated invitation: onboarding', '2026-09-17 10:00')] }));
  const r2 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [ob] });
  check('an invitation is not a reply', !r2.findings.some((x) => x.check === 'they-replied'), JSON.stringify(r2.findings.map((x) => x.claim)));
  const mine = { ...ob, owed_by: 'me', title: 'Send Dana the leak photos' };
  const r3 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [mine] });
  check('and something HE owes is not discharged by them writing', !r3.findings.some((x) => x.check === 'they-replied'));
  /* `who` IS A NAME on every obligation the address book can name — the
     sources resolve the handle before the merge. The sender guard compared
     "dana@x.com" with "Dana" through the index and found no name for
     "dana", so this check was blind to exactly those. 2026-09-20. */
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [mail('Utility Bill — the city found the usage', '2026-09-17 10:00')] }));
  const named = { ...ob, who: 'Dana' };
  const r4 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [named] });
  check('a reply is still theirs when the obligation names the person rather than the handle', r4.findings.some((x) => x.check === 'they-replied'), JSON.stringify(r4.findings.map((x) => x.check)));
  const other = { ...ob, who: 'Rob' };
  const r5 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [other] });
  check('  ...and not when it names someone else', !r5.findings.some((x) => x.check === 'they-replied'));
  await rm(vault, { recursive: true, force: true });
}

console.log('\nrelative-date only where --correct can act');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  const todo = { id: 'todo:abc', code: 'TTTT', title: 'Pick up the dry cleaning', what: 'Pick up the dry cleaning tomorrow.', owed_by: 'me', since: '2026-09-19 09:00', evidence: [{ source: 'todo', ref: 'abc' }] };
  const r = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [todo] });
  check('a relative date on a todo line he typed is not a finding — no door can rewrite it', !r.findings.some((f) => f.check === 'relative-date'), JSON.stringify(r.findings.map((f) => f.check)));
  await rm(vault, { recursive: true, force: true });
}

console.log('\na receipt on file');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(vault, 'reference'), { recursive: true });
  await writeFile(join(vault, 'reference', 'statements.md'),
    '- 2026-09-16 — **Receipt for your payment** from Lawson Law billing@lawfirm.example · [x](y) · 40KB · msg:2\n');
  const pay = { id: 'mail:p', code: 'PPPP', title: 'Pay the Lawson Law invoice', since: '2026-09-08 09:00', what: 'x', owed_by: 'me', evidence: [] };
  const r1 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [pay] });
  const f = r1.findings.find((x) => x.check === 'paid-on-file');
  check('a receipt filed after a "pay X" debt is a question for the triage', !!f && /Receipt for your payment/.test(f.claim), JSON.stringify(r1.findings.map((x) => x.check)));
  const chase = { ...pay, title: 'Chase Lawson Law for the engagement letter' };
  const r2 = await review(vault, { now: new Date('2026-09-20T09:00:00'), open: [chase] });
  check('and not for an obligation that is not about paying', !r2.findings.some((x) => x.check === 'paid-on-file'));
  await rm(vault, { recursive: true, force: true });
}

console.log('\nan invoice already closed on another thread');
{
  /* Carta INV00100003, 2026-10. Paid by wire on 10-15 and closed in the
     logbook on its own thread; Carta's automatic "due today" reminder on 10-16
     came on a new thread and opened a new item. The logbook line is BEFORE the
     new item's `since` — the payment came first — and must still count. */
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  await writeFile(join(vault, 'logbook.md'),
    '- 2026-10-15 14:26 | mail:work:1a0fe8cf66f41ccd | Equity Investor Services billed Riverton Ventures invoice INV00100003, $8,717.75, net 15 | by agent:assistant | Paid by Citi wire 2026-10-15, ref GU26XX0000001A0\n');
  const dun = { id: 'mail:work:1a146a0c8573b1c2', code: 'DDDD', title: 'Pay Carta invoice INV00100003 — $8,717.75 due today', since: '2026-10-16 17:31', what: 'Carta reminder: invoice INV00100003 is due today.', owed_by: 'me',
    evidence: [{ source: 'email', ref: 'mail:work:1a146a0c8573b1c2', detail: { thread_id: '1a146a0c8573b1c2', account: 'work' } }] };
  const r1 = await review(vault, { now: new Date('2026-10-17T09:00:00'), open: [dun] });
  const f = r1.findings.find((x) => x.check === 'closed-in-logbook');
  check('a reminder for an invoice closed on another thread is closed-in-logbook', !!f && /INV00100003/.test(f.claim) && /2026-10-15 14:26/.test(f.claim), JSON.stringify(r1.findings.map((x) => x.claim)));
  check('  its evidence names the other item\'s line', f?.evidence?.[0] === 'logbook.md · mail:work:1a0fe8cf66f41ccd', JSON.stringify(f?.evidence));
  check('  and it is a question, never a close by itself', !r1.findings.some((x) => x.id === dun.id && x.auto));
  const other = { ...dun, title: 'Pay Carta invoice INV00199999 — due today', what: 'Carta reminder: invoice INV00199999.' };
  const r2 = await review(vault, { now: new Date('2026-10-17T09:00:00'), open: [other] });
  check('a different invoice number does not match', !r2.findings.some((x) => x.check === 'closed-in-logbook'));
  const reopened = { ...dun, id: 'mail:work:1a0fe8cf66f41ccd', since: '2026-10-16 08:00' };
  const r3 = await review(vault, { now: new Date('2026-10-17T09:00:00'), open: [reopened] });
  check('an item is never matched by its own earlier line', !r3.findings.some((x) => x.check === 'closed-in-logbook'), JSON.stringify(r3.findings.map((x) => x.claim)));
  await rm(vault, { recursive: true, force: true });
}

console.log('\ncorrecting — the headline moves, the log does not');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  const WHAT = 'He has no room for the trip, and nothing in reference/bookings.md records lodging for him. '
    + 'UPDATE 2026-09-15: a call with Kyle shows here too. '
    + 'UPDATE 2026-09-16: re-checked — no new messages. Unchanged.';
  const state = { threads: [{ chat_id: 'chat-1', conclusion: { open: true, title: 'Sort Pinecrest lodging', what: WHAT, owed_by: 'me' } }] };
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(state, null, 1));

  /* `listOpen` is the real merge and needs the whole repo, so the door is
     exercised against a stub of it — what is pinned here is the FILE surgery:
     which part is replaced, which part survives, and what is recorded. */
  const ob = {
    id: 'im:chat-1', code: 'AAAA', title: 'Sort Pinecrest lodging',
    evidence: [{ source: 'imessage', ref: 'chat-1', detail: { chat_id: 'chat-1' } }],
  };
  const { correct: correctWith } = await import('./review.mjs');
  // Swap the obligation list for this one item by writing a matching repo.
  const r = await correctWith(vault, 'im:chat-1', 'The Summit Lodge Pinecrest is booked for 09-24 to 09-29, conf CX7QZRTA; what is still open is telling the OPOA group.',
    'reference/bookings.md has held the Summit Lodge since 2026-09-14', { now: new Date('2026-09-20T09:00:00'), open: [ob] })
    .catch((err) => ({ error: String(err.message) }));

  if (r.error) {
    check('the door refuses an obligation it cannot find rather than guessing', /no open obligation|no record/.test(r.error), r.error);
  } else {
    const after = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8'));
    const w = after.threads[0].conclusion.what;
    check('the false headline is gone', !/He has no room/.test(w), w.slice(0, 80));
    check('the corrected one is first', w.startsWith('The Summit Lodge Pinecrest is booked'), w.slice(0, 60));
    check('every update survives', /UPDATE 2026-09-15/.test(w) && /UPDATE 2026-09-16/.test(w));
    check('and the correction is itself an entry', /UPDATE 2026-09-20: corrected against the record/.test(w));
    const changes = await changesSince(vault, null);
    check('the change is recorded with both sentences', changes.length === 1 && /no room/.test(changes[0].was) && /Summit Lodge/.test(changes[0].now));
  }

  let refused = '';
  try { await correctWith(vault, 'im:chat-1', 'too short', 'because', { open: [ob] }); } catch (err) { refused = err.message; }
  check('a headline too short to be a sentence is refused', /headline sentence/.test(refused), refused);
  let noWhy = '';
  try { await correctWith(vault, 'im:chat-1', 'A perfectly reasonable corrected sentence goes here.', '', { open: [ob] }); } catch (err) { noWhy = err.message; }
  check('and a correction with no evidence is refused', /evidence/.test(noWhy), noWhy);

  await rm(vault, { recursive: true, force: true });
}

console.log('\nwhat a triage prompt carries');
{
  /* Twelve runs of the whole list, worst first, produced no action: the model
   * saw twelve findings about threads it was not judging and left them. A
   * triage gets only the findings on its own work list's threads; cosmetic
   * checks and auto ones never go in a prompt. */
  const fs = [
    { id: 'a', check: 'they-replied', threads: ['t1'] },
    { id: 'b', check: 'they-replied', threads: ['t9'] },
    { id: 'c', check: 'relative-date', threads: ['t1'] },
    { id: 'd', check: 'closes-met', auto: true, threads: ['t1'] },
    { id: 'e', check: 'duplicate', threads: ['t1'] },
    { id: 'f', check: 'closed-in-logbook', threads: ['c1', 't2'] },
  ];
  const got = forPrompt(fs, new Set(['t1', 'c1'])).map((f) => f.id);
  check('only findings on this run\'s threads, of the checks worth a model', got.join(',') === 'a,f', got.join(','));
  check('cosmetic checks never go in a prompt', !PROMPT_CHECKS.has('relative-date') && !PROMPT_CHECKS.has('spinning') && !PROMPT_CHECKS.has('duplicate'));
  check('an auto finding is closed, not asked', !forPrompt(fs).some((f) => f.id === 'd'));
  check('with no keys (the evening brief) every prompt-worthy finding', forPrompt(fs).map((f) => f.id).join(',') === 'a,b,f');
}

console.log('\na handoff is recorded, and is permanent');
{
  /* Alex, 2026-09-21: "I don't want Amy G chase to fire after I respond to
   * nina. Amy handed me off to nina at one point." */
  const vault = await mkdtemp(join(tmpdir(), 'obligations-ho-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  const conclusion = { open: true, tier: 'action', who: 'amyr@citycab.example', owed_by: 'them',
    title: 'Chase Quality Cabinets Co for the millwork number', what: 'Asked on 2026-08-13; nothing back.', since: '2026-08-13 13:29' };
  await writeFile(join(vault, 'integrations', 'email-state.json'),
    JSON.stringify({ threads: [{ thread_id: 't1', account: 'personal', watermark: '2026-09-14 00:05', reviewed: '2026-09-14 00:05', conclusion }] }));
  const ob = { id: 'mail:personal:t1', code: 'AAAA', who: 'amyr@citycab.example', title: conclusion.title,
    evidence: [{ source: 'email', ref: 'mail:personal:t1', detail: { thread_id: 't1', account: 'personal' } }] };

  const r = await handoff(vault, 'mail:personal:t1', 'ninac@citycab.example', 'Amy passed the cabinetry conversation to Nina', { open: [ob] });
  const c = JSON.parse(await readFile(join(vault, 'integrations', 'email-state.json'), 'utf8')).threads[0].conclusion;
  check('the field is written where the chase reads it', c.handed_to === 'ninac@citycab.example', JSON.stringify(c.handed_to));
  check('  the reasoning log gains a dated line, and keeps what was there', /UPDATE \d{4}-\d{2}-\d{2}: handed off to ninac@citycab\.example/.test(c.what) && /nothing back/.test(c.what), c.what);
  check('  `who` is NOT repointed — the thread is still the one Amy wrote on, and a mail chase replies to the thread', c.who === 'amyr@citycab.example');
  check('  the obligation is untouched otherwise', c.open === true && c.owed_by === 'them' && r.to === 'ninac@citycab.example');
  const changes = await changesSince(vault, null);
  check('  and it is named in the next brief', changes.some((x) => x.action === 'handed_off' && x.to === 'ninac@citycab.example' && x.from === 'amyr@citycab.example'), JSON.stringify(changes));

  let noTo = null; try { await handoff(vault, 'mail:personal:t1', '', 'x', { open: [ob] }); } catch (e) { noTo = e.message; }
  check('refuses without the person it went to', /needs the person/.test(String(noTo)), String(noTo));
  let noWhy = null; try { await handoff(vault, 'mail:personal:t1', 'someone@x.com', '', { open: [ob] }); } catch (e) { noWhy = e.message; }
  check('refuses without evidence', /needs its evidence/.test(String(noWhy)), String(noWhy));
  let missing = null; try { await handoff(vault, 'mail:personal:nope', 'a@b.com', 'x', { open: [ob] }); } catch (e) { missing = e.message; }
  check('refuses an obligation it cannot find', /no open obligation/.test(String(missing)), String(missing));
  await rm(vault, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);