/**
 * Drafts that stop being needed, and drafts that should have been one.
 *
 * Alex, 2026-09-15: "If there is new information, rewrite a pending unsent
 * message rather then adding new ones", then "Auto discard drafts if I dealt
 * with the issue", then of the morning brief: "I did sent them yesterday" and
 * "I did call right away".
 *
 * All fixtures. The live outbox changes every time he taps, and a test that
 * goes red because he tidied up is testing his housekeeping, not the rule.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlesFor, contactSince } from './contact.mjs';
import { putText, tidy } from '../drafts.mjs';
import { isObligationsDraft } from '../integrations/mail-draft.mjs';
import { listOutbox } from './outbox.mjs';
import { draftChangeLines, inTouchLines } from '../brief-input.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const JAMES = '+17275550101';
const JAMES_MAIL = 'henry@pike.example';
const HANK = '+18135550102';

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'obligations-tidy-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, 'outbox'), { recursive: true });
  await writeFile(join(vault, 'integrations', 'contacts.json'), JSON.stringify({ index: {
    '7275550101': 'Henry Pike', [JAMES_MAIL]: 'Henry Pike', '8135550102': 'Hank Mercer',
  } }));
  await writeFile(join(vault, 'integrations', 'imessage.json'), JSON.stringify({ threads: [
    { chat_id: `any;-;${HANK}`, participants: [HANK], messages: [
      { at: '2026-09-14 16:00', from_me: true, text: 'on the same thread' },
    ] },
    { chat_id: 'any;+;group1', is_group: true, participants: [JAMES, HANK], messages: [
      { at: '2026-09-14 17:00', from_me: true, text: 'into a group' },
    ] },
  ] }));
  await writeFile(join(vault, 'integrations', 'gmail.json'), JSON.stringify({ threads: [
    { thread_id: 't-plans', subject: 'ONE Springfield updated drawings', participants: [`Henry Pike <${JAMES_MAIL}>`], messages: [
      { at: '2026-09-14 14:04', from_me: true, draft: false },
      { at: '2026-09-14 15:30', from_me: true, draft: true },
    ] },
  ] }));
  await writeFile(join(vault, 'integrations', 'calls.json'), JSON.stringify({ calls: [
    { at: '2026-09-14 14:32', key: '8135550102', connected: true, direction: 'out', duration_s: 300 },
    { at: '2026-09-14 18:00', key: '7275550101', connected: false, direction: 'out', duration_s: 0 },
  ] }));
  return vault;
}

const text = (vault, name, { to, chat = '-', created, status = 'draft', body = 'hello', edited = null }) =>
  writeFile(join(vault, 'outbox', name),
    `---\ntype: outbox\nto: ${to}\nchat_id: ${chat}\nstatus: ${status}\n${edited ? `edited_at: ${edited}\n` : ''}`
    + `created: ${created}\napproved_at: -\nsent_at: -\nerror: -\n---\n\n${body}\n`);

console.log('who counts as the same person');
{
  const book = { index: { '7275550101': 'Henry Pike', [JAMES_MAIL]: 'Henry Pike' } };
  const h = handlesFor(book, JAMES);
  check('a number reaches every handle that person has', h.has(JAMES_MAIL) && h.has('7275550101'), [...h].join(','));
  check('a name resolves through the address book', handlesFor(book, 'Henry Pike (ONE Springfield)').has(JAMES_MAIL));
  check('a group resolves to nobody — contact with one is not the group dealt with',
        handlesFor(book, 'Hank Mercer and Ruth Ellis (PHOA)').size === 0);
}

console.log('\nwhat counts as being in touch');
{
  const vault = await fixture();
  const j = await contactSince(vault, JAMES, '2026-09-14 12:00');
  check('an email answers a text: the channel he used is not the one it started on',
        j.some((r) => r.channel === 'email' && r.at === '2026-09-14 14:04'), JSON.stringify(j));
  check('an unsent Gmail draft is not contact — it would be a draft proving itself',
        !j.some((r) => r.at === '2026-09-14 15:30'));
  check('a text into a group is not a reply to one member of it', !j.some((r) => r.channel === 'text'));
  check('a missed call is an attempt, not contact', !j.some((r) => r.channel === 'call'));
  const w = await contactSince(vault, HANK, '2026-09-14 14:32');
  check('a call in the same minute she said "now is good" counts ("I did call right away")',
        w.some((r) => r.channel === 'call'), JSON.stringify(w));
}

console.log('\none waiting text per person, rewritten rather than added');
{
  const vault = await fixture();
  await text(vault, 'old.md', { to: JAMES, chat: `any;-;${JAMES}`, created: '2026-09-14 09:00', body: 'first words' });
  const r = await putText(vault, { to: JAMES, chatId: `any;-;${JAMES}`, text: 'newer words', slug: 'james', now: Date.parse('2026-09-15T10:00:00') });
  const box = await listOutbox(join(vault, 'outbox'));
  check('new information rewrites the waiting draft', r.rewrote === true && r.file === 'old.md', JSON.stringify(r));
  check('  ...and adds no second file', box.length === 1, box.map((d) => d.id).join(','));
  check('  ...and the words are the new ones', box[0].text === 'newer words');
  check('  ...and the file says the assistant rewrote it', /by agent:drafts/.test(box[0].editedAt ?? ''));
  check('the old words come back to the caller, so the change can be reported', r.was === 'first words');

  // A draft to the email address counts for the number: one person.
  const r2 = await putText(vault, { to: JAMES_MAIL, text: 'by the other handle', slug: 'james2', now: Date.parse('2026-09-15T11:00:00') });
  check('a different handle for the same person still rewrites', r2.rewrote === true, JSON.stringify(r2));

  await text(vault, 'his.md', { to: HANK, chat: `any;-;${HANK}`, created: '2026-09-14 09:00', body: 'his own sentence',
                                edited: '2026-09-14 10:00 by alex@rivera.example' });
  const r3 = await putText(vault, { to: HANK, chatId: `any;-;${HANK}`, text: 'machine words', slug: 'hank', now: Date.parse('2026-09-15T10:00:00') });
  const his = (await listOutbox(join(vault, 'outbox'))).filter((d) => d.to === HANK);
  check('a draft he edited is never overwritten', his.length === 1 && his[0].text === 'his own sentence', JSON.stringify(his));
  check('  ...and no rival is written beside it; the caller is told it was held', r3.held === true);

  const r4 = await putText(vault, { to: '+19995550000', text: 'someone new', slug: 'new', now: Date.parse('2026-09-15T12:00:00') });
  check('nobody waiting means a new draft', !r4.rewrote && /2026-09-15-1200-new\.md/.test(r4.file), JSON.stringify(r4));
  const raw = await readFile(join(vault, 'outbox', r4.file), 'utf8');
  check('  ...written as a draft, never approved', /^status: draft$/m.test(raw) && !/approved_at: 2/.test(raw));
}

console.log('\nthe door a job writes a text through');
{
  const { execFileSync } = await import('node:child_process');
  const vault = await fixture();
  const cli = (...args) => execFileSync('node', [new URL('../drafts.mjs', import.meta.url).pathname, '--text', ...args],
    { env: { ...process.env, OBLIGATIONS: vault }, encoding: 'utf8' });
  const first = cli(HANK, '--chat', `any;-;${HANK}`, 'first', 'words');
  const second = cli(HANK, '--chat', `any;-;${HANK}`, 'second words');
  const box = await listOutbox(join(vault, 'outbox'));
  check('a job writing twice to one person leaves one draft', box.length === 1 && box[0].text === 'second words', JSON.stringify(box.map((d) => d.text)));
  check('  ...and says it rewrote, and what it said before', /^wrote outbox\//.test(first) && /rewrote .* it said: first words/.test(second), second);
}

console.log('\ndiscarding what he has dealt with');
{
  const vault = await fixture();
  // Hank: he texted on the SAME thread after this draft — dealt with.
  await text(vault, 'hank.md', { to: HANK, chat: `any;-;${HANK}`, created: '2026-09-14 15:00' });
  // Henry: a text draft; he dealt with it by EMAIL. Nothing closed. Reported only.
  await text(vault, 'james.md', { to: JAMES, chat: `any;-;${JAMES}`, created: '2026-09-14 12:00' });
  // Approved: his decision, never touched.
  await text(vault, 'approved.md', { to: HANK, chat: `any;-;${HANK}`, created: '2026-09-14 15:00', status: 'approved' });

  const dry = await tidy(vault, { write: false, mail: false });
  check('a reply on the same thread since removes the draft',
        dry.removed.some((r) => r.id === 'hank.md' && /same thread/.test(r.why)), JSON.stringify(dry.removed));
  check('contact on another channel alone is a question, not a removal',
        dry.reported.some((r) => r.id === 'james.md' && /still needed/.test(r.why)) && !dry.removed.some((r) => r.id === 'james.md'),
        JSON.stringify(dry));
  check('an approved draft is never judged', ![...dry.removed, ...dry.reported].some((r) => r.id === 'approved.md'));
  check('a dry run changes nothing', (await listOutbox(join(vault, 'outbox'))).find((d) => d.id === 'hank.md').status === 'draft');

  const wet = await tidy(vault, { write: true, mail: false });
  const hank = (await listOutbox(join(vault, 'outbox'))).find((d) => d.id === 'hank.md');
  check('with write, the text is marked discarded — the file stays, so it can be undone', hank?.status === 'discarded');
  const ledger = (await readFile(join(vault, 'integrations', 'draft-changes.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  check('every removal is recorded with its full words and why, for the next brief',
        ledger.length === wet.removed.length && ledger.every((l) => l.text && l.why && l.at));
}

console.log('\nfolding duplicates');
{
  const vault = await fixture();
  await text(vault, 'a.md', { to: '+19995550000', created: '2026-09-15 08:00' });
  await text(vault, 'b.md', { to: '+19995550000', created: '2026-09-15 09:00' });
  await text(vault, 'c.md', { to: '+19995550001', created: '2026-09-15 07:00', edited: '2026-09-15 07:30 by alex@rivera.example' });
  await text(vault, 'd.md', { to: '+19995550001', created: '2026-09-15 09:00' });
  const r = await tidy(vault, { write: false, mail: false });
  check('two waiting for one person keeps the newest', r.removed.some((x) => x.id === 'a.md') && !r.removed.some((x) => x.id === 'b.md'),
        JSON.stringify(r.removed.map((x) => x.id)));
  check('an older one he edited is reported, not discarded',
        r.reported.some((x) => x.id === 'c.md' && /you edited/.test(x.why)) && !r.removed.some((x) => x.id === 'c.md'));
}

console.log('\nwhich Gmail drafts are the assistant\'s to delete');
{
  const msg = (ct) => ({ payload: { headers: [{ name: 'Content-Type', value: ct }] } });
  check('one the assistant wrote is', isObligationsDraft(msg('multipart/alternative; boundary="obligations-alt-1a2b"')));
  check('one with attachments the assistant wrote is', isObligationsDraft(msg('multipart/mixed; boundary=obligations-mix-9f')));
  check('once he edits it Gmail rewrites the boundary, and it is his', !isObligationsDraft(msg('multipart/alternative; boundary="000000000000abc"')));
  check('a plain draft is his', !isObligationsDraft(msg('text/plain; charset=UTF-8')) && !isObligationsDraft({}));
}

console.log('\nwhat the next brief is told');
{
  const rows = [
    { at: '2026-09-14 11:00', action: 'discarded', kind: 'text', to: 'Old', text: 'announced already', why: 'x' },
    { at: '2026-09-15 08:10', action: 'discarded', kind: 'text', to: 'Henry Pike', text: 'I will have the new plan set before we sit down Tuesday',
      why: 'what it was about is done' },
    { at: '2026-09-15 09:00', action: 'rewrote', kind: 'mail', to: 'Miles', text: 'Thursday works', was: 'Wednesday works', why: 'newer words' },
  ];
  const out = draftChangeLines(rows, '2026-09-15 07:00');
  check('every change since the last brief, and nothing before it', out.length === 2 && !out.some((l) => /Old/.test(l)), JSON.stringify(out));
  check('a discard says whose, the words, and why', /threw away the text to \*\*Henry Pike\*\*/.test(out[0]) && /plan set/.test(out[0]) && /done/.test(out[0]));
  check('a rewrite says what it says now', /rewrote the email to \*\*Miles\*\* — now "Thursday works"/.test(out[1]));

  const o = { id: 'im:x', who: 'Ruth Ellis', title: 'Call Ruth about the flier', since: '2026-09-14 14:30' };
  const lines = inTouchLines([
    { o, rows: [{ at: '2026-09-14 14:25', channel: 'text', detail: 'Can I call you?' }, { at: '2026-09-14 14:32', channel: 'call', detail: 'you called, 8 min' },
                { at: '2026-09-14 14:40', channel: 'text', detail: 'thanks' }] },
    { o: { ...o, id: 'im:y' }, rows: [] },
  ]);
  check('an item with contact is listed with the newest contact', lines.length === 1 && /call 09-14 14:32/.test(lines[0]) && /and 1 more/.test(lines[0]), JSON.stringify(lines));
  check('an item with no contact is not listed at all', !lines.some((l) => /im:y/.test(l)));
}

/* A FOLLOW-UP THE PASS WOULD NO LONGER WRITE. Alex, 2026-09-21, on the
 * Outbox: "there are several drafts that don't seem relevant." Five of the
 * eight Gmail drafts were chases to people the holds added that day would
 * refuse — someone who had handed the thread on, or a firm he owes. */
console.log('\nwithdrawing a chase that would not be written now');
{
  const { noLongerWritten } = await import('../drafts.mjs');
  const held = [
    { thread: 't-jen', why: 'amyr@citycab.example handed this to ninac@citycab.example' },
    { thread: 't-citi', why: 'you owe a colleague an answer first' },
    { thread: 't-nowhy' },
  ];
  const obligationsDraft = { id: 'd1', obligations: true, threadId: 't-jen', to: 'amyr@citycab.example' };
  check('a chase on a held thread is withdrawn, with the hold as the reason',
        /handed this to ninac/.test(noLongerWritten(obligationsDraft, held) ?? ''), String(noLongerWritten(obligationsDraft, held)));
  check('  ...and so is one held for owing the company', /owe a colleague/.test(noLongerWritten({ ...obligationsDraft, threadId: 't-citi' }, held) ?? ''));
  check('his own draft on the same thread is never touched',
        noLongerWritten({ ...obligationsDraft, obligations: false }, held) === null);
  check('a thread nothing is holding is left alone',
        noLongerWritten({ ...obligationsDraft, threadId: 't-other' }, held) === null);
  check('a draft with no thread cannot be matched, so it stays',
        noLongerWritten({ ...obligationsDraft, threadId: null }, held) === null);
  check('a held row with no reason withdraws nothing — the reason IS the record',
        noLongerWritten({ ...obligationsDraft, threadId: 't-nowhy' }, held) === null);
  check('no holds at all means nothing is withdrawn',
        noLongerWritten(obligationsDraft, []) === null && noLongerWritten(obligationsDraft) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);