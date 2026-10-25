/** urgency.mjs — the second lane: does this need him now? */
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidates, promptFor, parseVerdicts, inQuietHours, classifyUrgency, pushAfterTriage, readLedger, saidSince, addBodies, firstWords, THIN_SNIPPET, URGENCY } from './urgency.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const contacts = { index: { '5552000002': 'Dana', 'dana@x.com': 'Dana', 'tom@x.com': 'Pete Rourke' } };
const texts = { needs_judgement: [
  { chat_id: 'c-dana', reason: 'new messages', participants: [{ handle: '+15552000002', name: 'Dana', relation: null }] },
  { chat_id: 'c-group', reason: 'new messages', participants: [{ handle: '+15552000002', name: 'Dana' }, { handle: '+1', name: 'Rob' }] },
  { chat_id: 'c-stranger', reason: 'not seen before', participants: [{ handle: '+19999999999', name: null }] },
  { chat_id: 'c-stale', reason: 'conclusion not revisited in 7+ days', participants: [{ handle: '+15552000002', name: 'Dana' }] },
  { chat_id: 'c-mine', reason: 'new messages', participants: [{ handle: '+15552000002', name: 'Dana' }] },
] };
const textExtract = { threads: [
  { chat_id: 'c-dana', is_group: false, participants: ['+15552000002'], messages: [{ at: '2026-09-20 10:00', from_me: true, text: 'Did the plumber come?' }, { at: '2026-09-20 10:30', from_me: false, text: 'Yes — but the dock light is still out, can you call the electrician today?' }] },
  { chat_id: 'c-group', is_group: true, participants: ['+15552000002', '+1'], messages: [{ at: '2026-09-20 10:30', from_me: false, text: 'lol' }] },
  { chat_id: 'c-stranger', is_group: false, participants: ['+19999999999'], messages: [{ at: '2026-09-20 10:30', from_me: false, text: 'Your car warranty' }] },
  { chat_id: 'c-stale', is_group: false, participants: ['+15552000002'], messages: [{ at: '2026-09-01 10:30', from_me: false, text: 'old' }] },
  { chat_id: 'c-mine', is_group: false, participants: ['+15552000002'], messages: [{ at: '2026-09-20 10:30', from_me: true, text: 'On it' }] },
] };
const mail = { needs_judgement: [
  { thread_id: 't-tom', account: 'personal', reason: 'not seen before', sender: 'tom@x.com', subject: 'Gym Thursday 920 & 930?', watermark: '2026-09-20 11:00' },
  { thread_id: 't-list', account: 'personal', reason: 'not seen before', sender: 'tom@x.com', subject: 'Newsletter', watermark: '2026-09-20 11:00' },
  { thread_id: 't-stranger', account: 'personal', reason: 'not seen before', sender: 'nobody@z.com', subject: 'Invoice', watermark: '2026-09-20 11:00' },
  { thread_id: 't-spoof', account: 'personal', reason: 'not seen before', sender: 'tom@x.com', subject: 'Wire now', watermark: '2026-09-20 11:00' },
] };
const mailExtract = { threads: [
  { thread_id: 't-tom', account: 'personal', subject: 'Gym Thursday 920 & 930?', never_replied: true, is_list: false, last_from_me: false, watermark: '2026-09-20 11:00', messages: [{ at: '2026-09-20 11:00', from: 'tom@x.com', from_me: false, dmarc_pass: true }] },
  { thread_id: 't-list', account: 'personal', subject: 'Newsletter', is_list: true, last_from_me: false, watermark: '2026-09-20 11:00', messages: [{ at: '2026-09-20 11:00', from: 'tom@x.com', from_me: false, list_id: 'x' }] },
  { thread_id: 't-stranger', account: 'personal', subject: 'Invoice', is_list: false, last_from_me: false, watermark: '2026-09-20 11:00', messages: [{ at: '2026-09-20 11:00', from: 'nobody@z.com', from_me: false }] },
  { thread_id: 't-spoof', account: 'personal', subject: 'Wire now', is_list: false, last_from_me: false, watermark: '2026-09-20 11:00', messages: [{ at: '2026-09-20 11:00', from: 'tom@x.com', from_me: false, dmarc_pass: false }] },
] };

console.log('who reaches the second lane');
{
  const c = candidates({ mail, texts, mailExtract, textExtract, contacts });
  const keys = c.map((x) => x.key).sort();
  check('a one-to-one text from a known person, and a mail from a known sender — nothing else', keys.join(',') === 'im:c-dana,mail:personal:t-tom', keys.join(','));
  check('  a group chat is not', !keys.includes('im:c-group'));
  check('  a stranger is not, on either channel', !keys.includes('im:c-stranger') && !keys.includes('mail:personal:t-stranger'));
  check('  a stale re-offer is not — only something new', !keys.includes('im:c-stale'));
  check('  his own last word is not a question to him', !keys.includes('im:c-mine'));
  check('  a list is not, and a DMARC failure is not', !keys.includes('mail:personal:t-list') && !keys.includes('mail:personal:t-spoof'));
  const dana = c.find((x) => x.key === 'im:c-dana');
  check('the classifier sees the last messages, named, clipped', /Dana: Yes — but the dock light/.test(dana.brief) && /Alex: Did the plumber/.test(dana.brief), dana.brief);
  const tom = c.find((x) => x.key.startsWith('mail:'));
  // The subject and the shape, plus their own first line where the extract has
  // one — see "what the classifier is shown about a mail" below. This fixture
  // predates snippets, so it is the shape alone.
  check('  and for mail the subject and the shape', /subject "Gym Thursday/.test(tom.brief) && /first mail from them/.test(tom.brief), tom.brief);
  check('a thread already asked about at this watermark is not asked again', candidates({ mail, texts, mailExtract, textExtract, contacts, ledger: { seen: { 'im:c-dana': { watermark: '2026-09-20 10:30' } } } }).every((x) => x.key !== 'im:c-dana'));
  check('  ...but a newer message on it is', candidates({ mail, texts, mailExtract, textExtract, contacts, ledger: { seen: { 'im:c-dana': { watermark: '2026-09-20 09:00' } } } }).some((x) => x.key === 'im:c-dana'));
  const p = promptFor(c, new Date('2026-09-20T11:05:00'));
  check('the prompt asks one question and wants JSON only', /WITHIN THE HOUR/.test(p) && /JSON only/.test(p) && /^1\. \[/m.test(p));
}

console.log('\nreading the answer');
{
  const c = candidates({ mail, texts, mailExtract, textExtract, contacts });
  const v = parseVerdicts('Sure! [{"n":1,"now":true,"why":"asks him to call the electrician today"},{"n":2,"now":false,"why":"gym time, can wait"}]', c);
  check('a JSON array inside chatter is read', v.get('im:c-dana')?.now === true && v.get('mail:personal:t-tom')?.now === false, JSON.stringify([...v]));
  check('garbage means later for everyone', [...parseVerdicts('I cannot help with that', c).values()].every((x) => x.now === false));
  check('a missing line means later', parseVerdicts('[{"n":1,"now":true,"why":"x"}]', c).get('mail:personal:t-tom')?.now === false);
  check('"now" has to be the boolean true, not a string', parseVerdicts('[{"n":1,"now":"true","why":"x"}]', c).get('im:c-dana')?.now === false);
  check('quiet hours are 21:00 to 07:00', inQuietHours(new Date('2026-09-20T21:00:00')) && inQuietHours(new Date('2026-09-21T06:59:00')) && !inQuietHours(new Date('2026-09-21T07:00:00')) && !inQuietHours(new Date('2026-09-20T13:00:00')));
}

console.log('\none pass, remembered');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-urg-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'contacts.json'), JSON.stringify(contacts));
  await writeFile(join(vault, 'integrations', 'imessage-changed.json'), JSON.stringify(texts));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify(textExtract));
  await writeFile(join(vault, 'integrations', 'gmail-changed.json'), JSON.stringify(mail));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify(mailExtract));
  let prompts = 0;
  const ask = async () => { prompts++; return { text: '[{"n":1,"now":true,"why":"asks him to call today"},{"n":2,"now":false,"why":"can wait"}]', costUSD: 0.0007, model: 'stub' }; };
  const now = new Date('2026-09-20T11:05:00');
  const r = await classifyUrgency(vault, { ask, now });
  check('one call for every candidate', prompts === 1 && r.asked === 2, JSON.stringify(r));
  check('  the urgent one comes back with who and why', r.now.length === 1 && r.now[0].key === 'im:c-dana' && /call today/.test(r.now[0].why), JSON.stringify(r.now));
  check('  the cost is reported', r.cost === 0.0007);
  const again = await classifyUrgency(vault, { ask, now: new Date('2026-09-20T11:06:00') });
  check('a minute later nothing is asked again', prompts === 1 && again.asked === 0 && again.now.length === 0, JSON.stringify(again));
  const led = await readLedger(vault);
  check('  the ledger says what was decided', led.seen['im:c-dana']?.now === true && led.seen['mail:personal:t-tom']?.now === false);
  const failing = async () => { throw new Error('model down'); };
  await writeFile(join(vault, '.log', 'urgency.json'), '{}');
  const f = await classifyUrgency(vault, { ask: failing, now });
  check('a failing classifier means later, and is remembered so it is not retried every minute', f.now.length === 0 && f.batch.length === 2 && /classifier failed/.test((await readLedger(vault)).seen['im:c-dana']?.why));

  console.log('\nthe push carries the triage\'s verdict');
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'c-dana', watermark: '2026-09-20 10:30', reviewed: '2026-09-20 11:07', conclusion: { open: true, tier: 'action', title: 'Call the electrician about the dock light', what: 'Dana reports the dock light is still out and asks him to call the electrician today.', who: 'Dana', since: '2026-09-20 10:30' } } ] }));
  await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: 't-tom', account: 'personal', watermark: '2026-09-20 11:00', reviewed: '2026-09-20 11:07', conclusion: { open: false, tier: 'awareness', title: 'Gym Thursday', what: 'x', who: 'Pete Rourke' } } ] }));
  const sent = [];
  const notify = async (m) => { sent.push(m); return { channel: 'ntfy', ok: true }; };
  await writeFile(join(vault, '.log', 'urgency.json'), '{}');
  const p1 = await pushAfterTriage(vault, { keys: ['im:c-dana', 'mail:personal:t-tom'], notify, now: new Date('2026-09-20T11:08:00') });
  /* THE PUSH SAYS WHAT THEY SAID. Alex, 2026-09-21, on the first live one:
   * "why didn't it also include the message, that would be helpful." It
   * carried the conclusion's HEADLINE — written days earlier — while Leo
   * had just texted "Let me check! Give me like 1 hr plz". */
  check('the push quotes what they actually said, not the stored headline',
        p1.pushed.length === 1 && /^Dana: /.test(sent[0].body) && /dock light is still out/.test(sent[0].body) && !/Dana reports/.test(sent[0].body), JSON.stringify(sent[0]));
  check('  ...with the title from the triage, at high priority', sent[0].title === 'Call the electrician about the dock light' && sent[0].priority === 'high');
  check('  an awareness verdict is held, and says so', p1.held.length === 1 && /awareness/.test(p1.held[0].why), JSON.stringify(p1.held));
  const notes = (await readdir(join(vault, 'messages'))).filter((n) => /-now/.test(n));
  const noteText = notes.length ? await readFile(join(vault, 'messages', notes[0]), 'utf8') : '';
  /* Its own kind, so the briefs tab tags it apart from a note — the list
     builds a chip per kind. Alex, 2026-09-21. */
  check('  a note records it, with how it was delivered, tagged as its own kind',
        notes.length === 1 && /delivered: ntfy/.test(noteText) && /^kind: urgent$/m.test(noteText) && !/kind: note/.test(noteText), noteText.slice(0, 160));
  check('  the note quotes them, names them, and keeps the triage\'s reading under it',
        /\*\*Dana\*\* said at 10:30:/.test(noteText) && /^> Yes — but the dock light/m.test(noteText) && /Dana reports the dock light/.test(noteText), noteText.slice(0, 220));
  check('  ...and the link reads as somewhere to go, not a percent-encoded path',
        /\[Open the task\]\(\/todo#pane=im%3Ac-dana\)/.test(noteText), noteText.slice(-120));
  const p2 = await pushAfterTriage(vault, { keys: ['im:c-dana'], notify, now: new Date('2026-09-20T11:09:00') });
  check('the same thread is not pushed twice in a day', p2.pushed.length === 0 && /already pushed/.test(p2.held[0]?.why));
  await writeFile(join(vault, '.log', 'urgency.json'), '{}');
  const p3 = await pushAfterTriage(vault, { keys: ['im:c-dana'], notify, now: new Date('2026-09-20T22:00:00') });
  check('quiet hours hold it for the morning brief', p3.pushed.length === 0 && /quiet hours/.test(p3.held[0]?.why), JSON.stringify(p3));
  const full = {}; for (let k = 0; k < URGENCY.PER_DAY; k++) full[`im:x${k}`] = '2026-09-20 09:00';
  await writeFile(join(vault, '.log', 'urgency.json'), JSON.stringify({ pushed: full }));
  const p4 = await pushAfterTriage(vault, { keys: ['im:c-dana'], notify, now: new Date('2026-09-20T12:00:00') });
  check(`the day's cap (${URGENCY.PER_DAY}) holds`, p4.pushed.length === 0 && /pushes today already/.test(p4.held[0]?.why));

  /* HE ANSWERED AFTER WHAT THE TRIAGE READ. Alex, 2026-09-25, of "Needs you
     now — Tell Leo yes to the call": "This alert doesn't make any sense."
     Leo asked for a call at 17:31, Alex said "Will call you in 5 min" at
     17:33, Leo said "Ok" at 17:34. The triage had judged up to 17:31; the
     old check passed because "Ok" is theirs and comes last. */
  await writeFile(join(vault, '.log', 'urgency.json'), '{}');
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'c-leo', watermark: '2026-09-23 17:31', reviewed: '2026-09-23 17:34', conclusion: { open: true, tier: 'action', owed_by: 'me',
      title: 'Tell Leo yes to the call or push to tomorrow', what: 'Leo asks for a call now or tomorrow.', who: 'Leo Banks' } } ] }));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [
    { chat_id: 'c-leo', participants: ['+15552000012'], messages: [
      { at: '2026-09-23 17:31', from_me: false, text: 'Hey do you have 15 or so min to hop on a call?' },
      { at: '2026-09-23 17:33', from_me: true, text: 'Will call you in 5 min' },
      { at: '2026-09-23 17:34', from_me: false, text: 'Ok' }] }] }));
  const p5 = await pushAfterTriage(vault, { keys: ['im:c-leo'], notify, now: new Date('2026-09-23T17:35:00') });
  check('a push is held when he wrote after the last message the triage read, even if they spoke last',
        p5.pushed.length === 0 && /after the last message the triage read/.test(p5.held[0]?.why ?? ''), JSON.stringify(p5));
  // And the verdict still goes when the triage did read his last word.
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
    { chat_id: 'c-leo', watermark: '2026-09-23 17:34', reviewed: '2026-09-23 17:35', conclusion: { open: true, tier: 'action', owed_by: 'me',
      title: 'Tell Leo yes to the call or push to tomorrow', what: 'x', who: 'Leo Banks' } } ] }));
  const p6 = await pushAfterTriage(vault, { keys: ['im:c-leo'], notify, now: new Date('2026-09-23T17:36:00') });
  check('  ...but not when the triage had already read his reply', !p6.held.some((h) => /after the last message the triage read/.test(h.why)), JSON.stringify(p6));
  await rm(vault, { recursive: true, force: true });
}

console.log('\nwhat they said since he last spoke');
{
  const t = { messages: [
    { at: '2026-09-21 08:00', from_me: false, text: 'old thing' },
    { at: '2026-09-21 08:45', from_me: true, text: 'Morning, did the code fix go live?' },
    { at: '2026-09-21 09:01', from_me: false, text: 'Let me check!' },
    { at: '2026-09-21 09:01', from_me: false, text: 'Give me like 1 hr plz' },
  ] };
  const said = saidSince(t);
  check('only what came after his own last word', said.length === 2 && said[0].text === 'Let me check!' && !said.some((m) => /old thing/.test(m.text)), JSON.stringify(said));
  check('  a burst arrives as a burst', said[1].text === 'Give me like 1 hr plz');
  check('  and each carries when it was said', said[0].at === '2026-09-21 09:01');
  check('nothing from them since he wrote is nothing to quote',
        saidSince({ messages: [{ at: '1', from_me: false, text: 'hi' }, { at: '2', from_me: true, text: 'ok' }] }).length === 0);
  check('a thread he has never written in still quotes them', saidSince({ messages: [{ at: '1', from_me: false, text: 'hello' }] }).length === 1);
  check('empty and missing threads are empty, not a crash', saidSince(null).length === 0 && saidSince({}).length === 0);
  check('at most the last three, so a push is not a transcript',
        saidSince({ messages: Array.from({ length: 6 }, (_, i) => ({ at: String(i), from_me: false, text: `m${i}` })) }).length === 3);
  check('whitespace is flattened — a push is one line', saidSince({ messages: [{ at: '1', from_me: false, text: ' a\n\n  b ' }] })[0].text === 'a b');
}

console.log('\nhe answered while the triage was running');
{
  /* Alex, 2026-09-21: "before pushing, let's verify there isn't new messages
   * in the thread. On the last one I already answered in iMessage before the
   * push came." The triage takes one to three minutes and the Mac pushes its
   * extract on change, so his reply is on disk by the time this runs. */
  const vault = await mkdtemp(join(tmpdir(), 'obligations-race-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  const conclusion = { open: true, tier: 'action', title: 'Call the electrician', what: 'She asked.', who: 'Dana', since: '2026-09-20 10:30' };
  await writeFile(join(vault, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [{ chat_id: 'c1', watermark: '2026-09-20 10:30', reviewed: '2026-09-20 11:07', conclusion }] }));
  await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [] }));
  const sent = [];
  const notify = async (m) => { sent.push(m); return { channel: 'ntfy', ok: true }; };
  const withThread = (msgs) => writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [{ chat_id: 'c1', messages: msgs }] }));

  await withThread([{ at: '2026-09-20 10:30', from_me: false, text: 'the dock light is still out' }]);
  const still = await pushAfterTriage(vault, { keys: ['im:c1'], notify, now: new Date('2026-09-20T11:08:00') });
  check('with their message still standing, it pushes', still.pushed.length === 1 && /dock light/.test(sent[0].body), JSON.stringify(still));

  await writeFile(join(vault, '.log', 'urgency.json'), '{}');
  await withThread([
    { at: '2026-09-20 10:30', from_me: false, text: 'the dock light is still out' },
    { at: '2026-09-20 11:07', from_me: true, text: 'On it — calling him now' },
  ]);
  const answered = await pushAfterTriage(vault, { keys: ['im:c1'], notify, now: new Date('2026-09-20T11:08:00') });
  check('once he has answered on the thread, nothing buzzes',
        answered.pushed.length === 0 && /answered on the thread|after the last message the triage read/.test(answered.held[0]?.why ?? ''), JSON.stringify(answered.held));
  check('  ...and no second notification was sent', sent.length === 1, String(sent.length));
  await rm(vault, { recursive: true, force: true });
}

/* WHO WROTE, AND WHERE THE SUMMARY STOPS. Alex, 2026-09-22, of a push headed
   "Needs you now — Chase Lena and Kyle on the TKE robot elevator quote",
   sent because Lena had just written to HIM: "why did that chase go out at
   15:22 when she emailed me at 15:07?" Nothing went out — but a task title is
   an imperative from his side, so the push read as a chase the assistant had sent.
   Its body also ended "He archived th…". */
console.log('\nwhat the push is headed, and where its summary stops');
{
  const { mkdtemp, mkdir, writeFile, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const vault = await mkdtemp(join(tmpdir(), 'urg-title-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  const what = 'Alex wrote Lena Ortiz and Kyle Porter asking them to reach out to TKE for the cost of '
    + '"TKE MAX Robot Integration" and "TKE MAX Elevator Calls for Application" — the first step in scoping a '
    + 'delivery robot for the building, at Neil Ashby\'s request. He archived the thread.';
  await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: 'tke', account: 'personal', watermark: '2026-09-22 15:07', reviewed: '2026-09-22 15:22',
      conclusion: { open: true, tier: 'action', who: 'Lena Ortiz', subject: 'TKE MAX Robot Integration',
                    title: 'Chase Lena and Kyle on the TKE robot elevator quote', what, since: '2026-09-22 15:07' } },
  ] }));
  let sent = null;
  const notify = async (m) => { sent = m; return { ok: true, channel: 'apns' }; };
  await pushAfterTriage(vault, { keys: ['mail:personal:tke'], notify, now: new Date('2026-09-22T15:22:00') });
  const file = (await readdir(join(vault, 'messages'))).find((f) => f.endsWith('-now.md'));
  const note = await readFile(join(vault, 'messages', file), 'utf8');
  const title = /^title: (.*)$/m.exec(note)?.[1] ?? '';
  check('the title names who wrote, not the task he owes', /^Needs you now — Lena Ortiz on /.test(title), title);
  check('  and never reads as a chase the assistant sent', !/Chase Lena/.test(title), title);
  check('  the push that buzzed says the same', /Lena Ortiz/.test(sent?.title ?? ''), sent?.title);
  check('the summary stops at a word, not inside one', !/\b\w+…/.test(note) || /\.…/.test(note), note.slice(200, 520));
  check('  and what it kept is a whole sentence or phrase', /He archived the thread\.|first step in scoping a delivery robot|…$/m.test(note), note.slice(200, 520));
}

/* SOMETHING THEY OWE CANNOT NEED HIM NOW, AND A MAIL CANDIDATE CARRIES WORDS.
   Alex, 2026-09-22: "there was nothing in Lenas message that needed me
   now." She had written "I emailed our account rep at TKE and will keep you
   posted" on a thread where he is waiting for TKE's price — and the classifier
   was shown only the subject and "3 messages so far". */
console.log('\nan update on something they owe');
{
  const { mkdtemp, mkdir, writeFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const vault = await mkdtemp(join(tmpdir(), 'urg-owed-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  const conclusion = (owed) => ({ open: true, tier: 'action', who: 'Lena Ortiz', subject: 'TKE MAX Robot Integration',
    title: 'Chase Lena and Kyle on the TKE robot elevator quote', what: 'Waiting on TKE\'s price.',
    owed_by: owed, since: '2026-09-22 15:07' });
  const write = async (owed) => writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: 'tke', account: 'personal', watermark: '2026-09-22 15:07', reviewed: '2026-09-22 15:22', conclusion: conclusion(owed) },
  ] }));
  const notify = async () => ({ ok: true, channel: 'apns' });

  await write('them');
  const theirs = await pushAfterTriage(vault, { keys: ['mail:personal:tke'], notify, now: new Date('2026-09-22T15:22:00') });
  check('a debt THEY owe does not buzz his phone', theirs.pushed.length === 0, JSON.stringify(theirs.pushed));
  check('  and the hold says why, rather than going quiet', /they owe this/.test(theirs.held[0]?.why ?? ''), JSON.stringify(theirs.held));
  check('  nothing was written to messages/ either', !(await readdir(join(vault, 'messages')).catch(() => [])).length);

  await write('me');
  const mine = await pushAfterTriage(vault, { keys: ['mail:personal:tke'], notify, now: new Date('2026-09-22T15:23:00') });
  check('something HE owes still does', mine.pushed.length === 1, JSON.stringify(mine.held));
}

console.log('\nwhat the classifier is shown about a mail');
{
  const need = { needs_judgement: [
    { thread_id: 'tke', account: 'personal', reason: 'not seen before', sender: 'lena@x.com', subject: 'TKE MAX Robot Integration', watermark: '2026-09-22 15:07' } ] };
  const extract = { threads: [
    { thread_id: 'tke', account: 'personal', subject: 'TKE MAX Robot Integration', is_list: false, last_from_me: false, watermark: '2026-09-22 15:07',
      messages: [{ at: '2026-09-22 15:07', from: 'lena@x.com', from_me: false, dmarc_pass: true,
                   snippet: 'Good afternoon, I emailed our account rep at TKE and will keep you posted. Great idea!' }] } ] };
  const book = { index: { 'lena@x.com': 'Lena Ortiz' } };
  const c = candidates({ mail: need, texts: { needs_judgement: [] }, mailExtract: extract, textExtract: { threads: [] }, contacts: book });
  const k = c.find((x) => x.key === 'mail:personal:tke');
  check('a mail candidate carries their words, not just the subject',
        /I emailed our account rep at TKE/.test(k?.brief ?? ''), k?.brief);
  check('  the prompt puts them in front of the model', /keep you posted/.test(promptFor(c)));
  /* An extract written before the snippet existed still works — it reads as
     it always did, subject and shape. */
  const older = { threads: [{ ...extract.threads[0], messages: [{ at: '2026-09-22 15:07', from: 'lena@x.com', from_me: false, dmarc_pass: true }] }] };
  const old = candidates({ mail: need, texts: { needs_judgement: [] }, mailExtract: older, textExtract: { threads: [] }, contacts: book });
  check('  an older extract with no snippet still makes a candidate',
        /subject "TKE MAX Robot Integration"/.test(old[0]?.brief ?? '') && !/They wrote/.test(old[0]?.brief ?? ''), old[0]?.brief);
}

/* THE WORDS, WHERE THE SNIPPET IS TOO THIN. Alex, 2026-09-22: "why can't we
   send the body to the classifier?" Nothing forbids it — the never-read-a-body
   rule belongs to the deterministic login-code lane — and the obstacle was only
   that nothing here HAS a body: the extract is metadata and the cache holds
   threads that already have a conclusion. So it fetches one, read-only, and
   only when the snippet cannot carry the question. */
console.log('\nfetching the words when the snippet is thin');
{
  const mk = (snippet) => ([{ key: 'mail:personal:t1', channel: 'mail', account: 'personal', thread_id: 't1',
                              snippet, brief: 'subject "Contract"' }]);
  const redact = (t) => String(t ?? '').replace(/\b\d{4,8}\b/g, (m) => '*'.repeat(m.length));
  let calls = 0;
  // The shape Gmail returns: a text/plain part, base64url. Long enough that
  // `readable()` keeps it rather than treating it as preheader padding.
  const message = 'Hi Alex,\n\nCan you approve the quote today? We need an answer before the contractor starts, '
    + 'and the code on the account is 445566 if you need it.\n\nOn Mon, someone wrote:\n> the old thread\n';
  const fetchThread = async () => { calls++; return { messages: [{ payload: { headers: [], mimeType: 'text/plain',
    body: { data: Buffer.from(message).toString('base64url') } } }] }; };

  const thin = mk('Hi Alex,');
  const r1 = await addBodies('/x', thin, { fetchThread, redact });
  check('a thin snippet is filled in from the message', /Can you approve the quote today/.test(thin[0].brief) || /Can you approve/.test(thin[0].brief), thin[0].brief);
  check('  it is counted, so "the snippet was enough" is a different fact', r1.fetched === 1 && r1.thin === 1, JSON.stringify(r1));
  check('  the quoted thread underneath is not sent', !/the old thread/.test(thin[0].brief), thin[0].brief);
  check('  anything code-shaped is redacted first', !/445566/.test(thin[0].brief), thin[0].brief);

  calls = 0;
  const fat = mk('I emailed our account rep at TKE and will keep you posted. Great idea! Nothing needed from you.');
  const r2 = await addBodies('/x', fat, { fetchThread, redact });
  check('a snippet that already answers the question costs no fetch', calls === 0 && r2.fetched === 0, JSON.stringify(r2));

  const broken = mk('Hi,');
  const r3 = await addBodies('/x', broken, { fetchThread: async () => { throw new Error('no token'); }, redact });
  check('a failed fetch leaves the snippet and says so', r3.failed === 1 && broken[0].brief === 'subject "Contract"', JSON.stringify(r3));

  check('the thin threshold is a named number', typeof THIN_SNIPPET === 'number' && THIN_SNIPPET > 0);
  check('firstWords stops at the quoted reply', firstWords('New words here.\nOn Mon someone wrote:\n> old') === 'New words here.');
  check('  and at a signature', firstWords('Thanks!\nSent from my iPhone') === 'Thanks!');
}

console.log(`\n${pass} passed, ${fail} failed`);