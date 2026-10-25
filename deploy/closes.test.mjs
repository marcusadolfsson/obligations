/** deploy/closes.mjs — what would close it, as data. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { satisfied, whenMet, validSpec, hasWords, KINDS } from './closes.mjs';
import { review, apply } from './review.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));
const NOW = new Date('2026-09-20T09:00:00');

console.log('\nspecs are checked, not trusted');
{
  check('an unknown kind is dropped', validSpec({ kind: 'vibes' }) === null);
  check('booking without words is dropped — "something booked for Pinecrest" is true on day one', validSpec({ kind: 'booking' }) === null);
  check('words are trimmed and empties dropped', JSON.stringify(validSpec({ kind: 'reply-from', words: [' leak ', ''] })) === '{"kind":"reply-from","words":["leak"]}');
  check('hasWords is whole-word, case-insensitive', hasWords('Re: the ELMWOOD leak', ['elmwood']) && !hasWords('leaky', ['leak']));
  check('six kinds', KINDS.length === 6);
}

console.log('\neach kind against what the context knows');
{
  const o = { id: 'x', who: 'dana@x.com', since: '2026-09-10 08:00', closes_when: [{ kind: 'reply-from' }] };
  const row = { at: '2026-09-17 10:00', channel: 'email', from: 'them', detail: 'Utility Bill — the city found the usage', thread: 't-util' };
  const known = { elsewhere: [row], sent: [], mineOnThread: [], paidOnFile: [], onCalendar: [], bookings: [], logged: null, from: async () => [], samePerson: (a, b) => a === b };
  const r1 = await satisfied({ kind: 'reply-from' }, o, known, { now: NOW });
  check('reply-from: a message from them elsewhere, since the debt began', !!r1 && /Utility Bill/.test(r1.evidence), JSON.stringify(r1));
  check('  words narrow it', (await satisfied({ kind: 'reply-from', words: ['leak'] }, o, known, { now: NOW })) === null);
  check('  no `since` means no answer — the match would be unbounded', (await satisfied({ kind: 'reply-from' }, { ...o, since: null }, known, { now: NOW })) === null);
  /* A JUDGED-ONLY ROW CARRIES A SUBJECT AND NOTHING ELSE. `elsewhere` grew on
     2026-09-22 to include every thread the mail job has filed away, so an
     answer that was archived could still be found. That is enough to ASK the
     triage; it is not enough to close on, and hours later it closed "Chase ONE
     on the Brokerly proposal" on a mail about a delivery robot. */
  const filed = { ...known, elsewhere: [{ at: '2026-09-21 23:55', channel: 'email', from: 'them', thread: 'tke',
                                          detail: 'TKE MAX Robot Integration', judged: true }] };
  check('a thread known only from the judged record does not satisfy a bare reply-from',
        (await satisfied({ kind: 'reply-from' }, o, filed, { now: NOW })) === null);
  check('  ...but it does when words tie it to this debt',
        !!(await satisfied({ kind: 'reply-from', words: ['robot'] }, o, filed, { now: NOW })));
  let asked = null;
  const known2 = { ...known, elsewhere: [], from: async (who) => { asked = who; return [{ at: '2026-09-18 09:00', channel: 'text', from: 'them', detail: 'device check done' }]; } };
  const r2 = await satisfied({ kind: 'reply-from', who: 'Theo' }, o, known2, { now: NOW });
  check('  a named third party is looked up on their own', asked === 'Theo' && !!r2 && /device check/.test(r2.evidence), JSON.stringify(r2));
  const r3 = await satisfied({ kind: 'sent-by-me' }, o, { ...known, sent: [{ id: 'ob1', kind: 'text', to: '+1', sentAt: '2026-09-15 07:29', text: 'Here are my notes' }] }, { now: NOW });
  check('sent-by-me: an Outbox send on the thread', !!r3 && /outbox\/ob1/.test(r3.evidence), JSON.stringify(r3));
  const r4 = await satisfied({ kind: 'sent-by-me' }, o, { ...known, mineOnThread: [{ at: '2026-09-16 10:00', channel: 'email', from: 'you', detail: 'Re: leak', thread: 't1' }] }, { now: NOW });
  check('  or sent mail in the extract on the thread', !!r4 && /you wrote by email/.test(r4.evidence), JSON.stringify(r4));
  const r5 = await satisfied({ kind: 'receipt' }, o, { ...known, paidOnFile: [{ date: '2026-09-16', title: 'Receipt for your payment', sender: 'Lawson Law' }] }, { now: NOW });
  check('receipt: a receipt on file', !!r5 && /Receipt for your payment/.test(r5.evidence));
  const cal = [{ summary: 'N200BB inspection', startsOn: '2026-09-18' }, { summary: 'N200BB inspection', startsOn: '2026-09-25' }];
  const r6 = await satisfied({ kind: 'event' }, o, { ...known, onCalendar: cal }, { now: NOW });
  check('event: only one that has STARTED counts', !!r6 && r6.at === '2026-09-18', JSON.stringify(r6));
  check('  a future one does not', (await satisfied({ kind: 'event' }, o, { ...known, onCalendar: [cal[1]] }, { now: NOW })) === null);
  const r7 = await satisfied({ kind: 'booking', words: ['Summit Lodge'] }, o, { ...known, bookings: [{ date: '2026-09-22', title: 'Summit Lodge Pinecrest', trip: { name: 'Pinecrest' } }] }, { now: NOW });
  check('booking: a matching line under the trip', !!r7 && /Summit Lodge/.test(r7.evidence));
  const r8 = await satisfied({ kind: 'logbook' }, o, { ...known, logged: { at: '2026-09-15 10:00', who: 'agent:mail', outcome: 'paid' } }, { now: NOW });
  check('logbook: a line after the debt began', !!r8 && /agent:mail/.test(r8.evidence));

  const m1 = await whenMet(o, known, { now: NOW });
  check('whenMet: a spec met', m1?.kind === 'reply-from');
  const m2 = await whenMet({ ...o, closes_when: null, closes: 'she confirms a date' }, known, { now: NOW });
  check('  prose alone is never read — a regex over English is a guess', m2 === null, JSON.stringify(m2));
  const m3 = await whenMet({ ...o, closes_when: [{ kind: 'receipt' }, { kind: 'reply-from' }] }, known, { now: NOW });
  check('  a list is any-of: the second entry closes it', m3?.kind === 'reply-from');
  check('  nothing to test is null', (await whenMet({ ...o, closes_when: null, closes: 'he decides' }, known, { now: NOW })) === null);
}

console.log('\nan explicit closes_when closes');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-closes-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'contacts.json'), JSON.stringify({ index: { 'dana@x.com': 'Dana', '5552000002': 'Dana' } }));
  await writeFile(join(vault, 'integrations', 'calls.json'), JSON.stringify({ calls: [] }));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [] }));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [
    { thread_id: 't-util', subject: 'Utility Bill — the city found the usage', participants: ['dana@x.com'], messages: [{ at: '2026-09-17 10:00', from_me: false, draft: false, from: 'dana@x.com' }] } ] }));
  const conclusion = (extra) => ({ open: true, tier: 'action', title: 'Chase Dana on the Elmwood leak', what: 'He asked; no answer.', owed_by: 'them', who: '+15552000002', since: '2026-09-10 08:00', ...extra });
  const state = (extra) => ({ threads: [{ chat_id: 'any;-;+15552000002', watermark: '2026-09-10 08:00', reviewed: '2026-09-10 08:05', conclusion: conclusion(extra) }] });

  /* Explicit AND tied to this debt — the review closes it. `words` is what
     ties it: a bare reply-from is satisfied by them writing about anything,
     which since 2026-09-22 is a question for the triage rather than a close
     (see the bare case below). */
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(state({ closes: 'she answers on the leak', closes_when: [{ kind: 'reply-from', words: ['usage'] }] })));
  const r1 = await review(vault, { now: NOW });
  const f1 = r1.findings.find((f) => f.check === 'closes-met');
  check('an explicit closes_when met is a [closes-met] finding marked auto, ranked first', f1?.auto === true && r1.findings[0]?.check === 'closes-met', JSON.stringify(r1.findings.map((f) => [f.check, f.auto])));
  check('  the finding names the threads it is about', Array.isArray(f1?.threads) && f1.threads.includes('any;-;+15552000002'), JSON.stringify(f1?.threads));
  const dry = await apply(vault, { now: NOW, write: false });
  check('  --dry names it and closes nothing', dry.closed.length === 1 && dry.closed[0].dry && (await review(vault, { now: NOW })).findings.some((f) => f.check === 'closes-met'));
  const a1 = await apply(vault, { now: NOW });
  check('  apply closes it, agent:review, the evidence as the outcome', a1.closed.length === 1 && /Utility Bill/.test(a1.closed[0].outcome), JSON.stringify(a1));
  const { listOpen } = await import('./agent-service/obligations.mjs');
  check('  ...and it is off the list', !(await listOpen(vault)).length);
  const { readObligationState } = await import('./agent-service/obligation-state.mjs');
  const st = await readObligationState(vault);
  check('  ...with the obligation\'s own record saying agent:review', Object.values(st.closed)[0]?.by === 'agent:review', JSON.stringify(st));

  /* A BARE reply-from ASKS, IT DOES NOT CLOSE. Alex, 2026-09-22: "Why did
     KWW6 close. That was a task unrelated to Brokerly." It closed on Lena
     writing to him about a delivery robot, because reply-from is by definition
     about a conversation that is NOT this one — so with no words it is
     satisfied by the person existing. */
  await writeFile(join(vault, 'integrations', 'obligation-state.json'), JSON.stringify({ closed: {} }));
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(state({ closes: 'she says anything', closes_when: [{ kind: 'reply-from' }] })));
  const rb = await review(vault, { now: NOW });
  const fb = rb.findings.find((f) => f.check === 'closes-met');
  check('a bare reply-from is still a finding', !!fb, JSON.stringify(rb.findings.map((f) => f.check)));
  check('  but not one the pass may close by itself', fb?.auto === false, JSON.stringify(fb?.auto));
  check('  it tells the triage to read what they said and rewrite the test', /bare reply-from/.test(fb?.why ?? ''), fb?.why);
  const ab = await apply(vault, { now: NOW });
  check('  and apply closes nothing on it', ab.closed.length === 0, JSON.stringify(ab.closed));
  check('  so the obligation is still open', (await listOpen(vault)).length === 1);

  /* EVIDENCE OLDER THAN A REOPEN DOES NOT CLOSE IT AGAIN. Alex, 2026-10-02:
     "why does that keep closing?" — the Nate quote, closed fifteen times
     on one email of 09-26 and reopened twelve. The utility-bill reply above is
     2026-09-17 10:00; a reopen after it means that reply did not settle it. */
  {
    const { appendFile } = await import('node:fs/promises');
    const { forPrompt } = await import('./review.mjs');
    await writeFile(join(vault, 'integrations', 'obligation-state.json'), JSON.stringify({ closed: {} }));
    await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(state({ closes: 'she answers on the leak', closes_when: [{ kind: 'reply-from', words: ['usage'] }] })));
    const id = (await listOpen(vault))[0]?.id;
    const changes = join(vault, 'integrations', 'obligation-changes.jsonl');
    await writeFile(changes, JSON.stringify({ at: '2026-09-18 09:00', action: 'reopened', id, by: 'agent:assistant', why: 'that reply was about the bill, not the leak' }) + '\n');
    const rs = await review(vault, { now: NOW });
    const fs = rs.findings.find((f) => f.id === id && f.check.startsWith('closes-met'));
    check('evidence from before the last reopen is a [closes-met-stale] finding', fs?.check === 'closes-met-stale', JSON.stringify(rs.findings.map((f) => [f.check, f.auto])));
    check('  that the pass may NOT close by itself', fs?.auto === false);
    check('  naming the reopen and the old evidence', /reopened on 2026-09-18 09:00/.test(fs?.claim ?? '') && /2026-09-17 10:00/.test(fs?.claim ?? ''), fs?.claim);
    check('  and telling the triage to rewrite the stale closes_when', /rewrite closes_when/.test(fs?.why ?? ''), fs?.why);
    check('  it reaches the triage\'s prompt for that thread', forPrompt(rs.findings, new Set(['any;-;+15552000002'])).some((f) => f.check === 'closes-met-stale'));
    const as = await apply(vault, { now: NOW });
    check('  apply closes nothing on it — the loop that ran fifteen times stops', as.closed.length === 0, JSON.stringify(as.closed));
    check('  so the reopen holds', (await listOpen(vault)).length === 1);

    // A reopen BEFORE the evidence is no bar: the evidence came after it.
    await writeFile(changes, JSON.stringify({ at: '2026-09-16 08:00', action: 'reopened', id, by: 'Alex', why: 'still waiting' }) + '\n');
    const rn = await review(vault, { now: NOW });
    const fn = rn.findings.find((f) => f.id === id && f.check.startsWith('closes-met'));
    check('evidence newer than the last reopen still closes as before', fn?.check === 'closes-met' && fn?.auto === true,
          JSON.stringify(rn.findings.map((f) => [f.check, f.auto])));
    // Only the LAST reopen counts: an older one followed by a newer one bars it.
    await appendFile(changes, JSON.stringify({ at: '2026-09-19 12:00', action: 'reopened', id, by: 'Alex', why: 'no' }) + '\n');
    const rl = await review(vault, { now: NOW });
    check('  the latest reopen is the one that counts', rl.findings.find((f) => f.id === id && f.check.startsWith('closes-met'))?.check === 'closes-met-stale',
          JSON.stringify(rl.findings.filter((f) => f.id === id).map((f) => [f.check, f.auto])));
    await writeFile(changes, '');
  }

  // Prose alone: nothing.
  await writeFile(join(vault, 'integrations', 'obligation-state.json'), JSON.stringify({ closed: {} }));
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(state({ closes: 'she confirms the leak is sorted' })));
  const r2 = await review(vault, { now: NOW });
  check('a prose closes sentence alone is not a finding', !r2.findings.some((f) => f.check === 'closes-met'), JSON.stringify(r2.findings.map((f) => f.check)));
  const a2 = await apply(vault, { now: NOW });
  check('  and apply closes nothing on it', a2.closed.length === 0 && (await listOpen(vault)).length === 1, JSON.stringify(a2));

  // Not met: nothing.
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [] }));
  const r3 = await review(vault, { now: NOW });
  check('with no reply anywhere there is no finding', !r3.findings.some((f) => f.check === 'closes-met'));

  // The cap.
  // `words`, so these are closes rather than questions — the cap is about how
  // many a run may close, not about which kinds close.
  const many = { threads: Array.from({ length: 7 }, (_, i) => ({ chat_id: `c${i}`, watermark: '2026-09-10 08:00', reviewed: '2026-09-10 08:05', conclusion: conclusion({ title: `Chase Dana ${i}`, closes_when: [{ kind: 'reply-from', words: ['usage'] }] }) })) };
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [
    { thread_id: 't-util', subject: 'Utility Bill — the city found the usage', participants: ['dana@x.com'], messages: [{ at: '2026-09-17 10:00', from_me: false, draft: false, from: 'dana@x.com' }] } ] }));
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify(many));
  const a3 = await apply(vault, { now: NOW, write: false });
  check('a run closes at most five and counts the rest', a3.closed.length === 5 && a3.held === 2, JSON.stringify({ closed: a3.closed.length, held: a3.held }));
  await rm(vault, { recursive: true, force: true });
}

console.log('\ndoubt expires');
{
  /* Review item 3, 2026-09-20. An item opened on doubt (`confidence: low`)
   * that nothing confirms in fourteen quiet days closes as never confirmed.
   * Quiet means: no newer look at the thread, no update to the conclusion,
   * nothing from them on any channel. */
  const { DOUBT_DAYS } = await import('./review.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-doubt-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'contacts.json'), JSON.stringify({ index: { 'dana@x.com': 'Dana' } }));
  await writeFile(join(vault, 'integrations', 'calls.json'), JSON.stringify({ calls: [] }));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [] }));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [] }));
  const thread = (extra, reviewed = '2026-09-01 08:05') => ({ thread_id: 't-d', account: 'a', watermark: '2026-09-01 08:00', reviewed,
    conclusion: { open: true, tier: 'action', title: 'Send Dana the dock photos', what: 'She may have asked for photos.', owed_by: 'me', who: 'dana@x.com', since: '2026-09-01 08:00', ...extra } });
  const put = (t) => writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [t] }));
  await put(thread({ confidence: 'low' }));
  const r1 = await review(vault, { now: NOW });
  const f = r1.findings.find((x) => x.check === 'doubt-expired');
  check(`a low-confidence item quiet for ${DOUBT_DAYS}+ days is a [doubt-expired] finding, auto`, f?.auto === true && /never|nothing has confirmed/.test(f.claim), JSON.stringify(r1.findings.map((x) => x.check)));
  check('  with an outcome that says so', /opened on doubt/.test(f?.outcome ?? ''), f?.outcome);
  await put(thread({}));
  check('an item not marked low is left alone', !(await review(vault, { now: NOW })).findings.some((x) => x.check === 'doubt-expired'));
  await put(thread({ confidence: 'low' }, '2026-09-15 08:05'));
  check('a low one the triage looked at again five days ago is not quiet', !(await review(vault, { now: NOW })).findings.some((x) => x.check === 'doubt-expired'));
  await put(thread({ confidence: 'low', what: 'She may have asked for photos. UPDATE 2026-09-12: still unclear.' }));
  check('an update to the conclusion eight days ago is not quiet either', !(await review(vault, { now: NOW })).findings.some((x) => x.check === 'doubt-expired'));
  await put(thread({ confidence: 'low' }));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [
    { thread_id: 't-other', subject: 'Dock', participants: ['dana@x.com'], messages: [{ at: '2026-09-14 10:00', from_me: false, draft: false, from: 'dana@x.com' }] } ] }));
  check('a word from them six days ago is not quiet', !(await review(vault, { now: NOW })).findings.some((x) => x.check === 'doubt-expired'));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [] }));
  const a = await apply(vault, { now: NOW });
  check('apply closes it as never confirmed, agent:review', a.closed.length === 1 && a.closed[0].check === 'doubt-expired' && /opened on doubt/.test(a.closed[0].outcome), JSON.stringify(a));
  const { listOpen } = await import('./agent-service/obligations.mjs');
  check('  ...and it is off the list', !(await listOpen(vault)).length);
  await rm(vault, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
