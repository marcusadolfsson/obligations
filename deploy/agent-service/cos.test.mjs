/**
 * The chief-of-staff layer, second pass (2026-09-05): scheduling replies, the
 * post-meeting debrief, decisions written through one door, and verdicts.
 *
 * Availability is the one that writes to a stranger (as a drafted reply), so it
 * gets the most negatives: never a slot in the past, never on a weekend, never
 * inside a trip, never over his own meeting. The debrief must not fire for a
 * dentist appointment or before the meeting has actually ended. decide.mjs must
 * merge an option under an existing heading rather than start a rival one.
 */
import { freeGaps, chop, say } from '../availability.mjs';
import { endedEvents, composeDebrief } from '../debrief.mjs';
import { add as decideAdd, decide } from '../decide.mjs';
import { parseDecisions } from './sources/decisions.mjs';
import { parseVerdicts, record as recordVerdict, verdicts } from '../verdict.mjs';
import { replyHeaders, rawMessage, isMachine, bodyHtml } from '../integrations/mail-draft.mjs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The repo root, wherever this runs: the container mounts it at /obligations, the host
// has it at ~/obligations, and a hardcoded host path failed only in the container.
const REPO = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('availability — where he is actually free');
{
  // Mon 2026-09-07 08:00 local. Working window 09:00–17:00.
  const now = new Date('2026-09-07T08:00:00').getTime();
  const events = [
    { summary: 'Standup', startsAt: '2026-09-07 10:00', endsAt: '2026-09-07 10:30', mine: true },
    { summary: 'Lunch', startsAt: '2026-09-07 12:00', endsAt: '2026-09-07 13:00', mine: true },
    { summary: 'Mom works', allDay: true, startsOn: '2026-09-08', mine: false, calendar: 'Mia' },
    { summary: 'Travel day', allDay: true, startsOn: '2026-09-09', mine: true },
  ];
  const gaps = freeGaps({ now, days: 4, events, trs: [{ name: 'Pinecrest', from: '2026-09-10', to: '2026-09-11' }] });
  const mon = gaps.filter((g) => g.date === '2026-09-07').map((g) => `${g.start}-${g.end}`);
  check('Monday is free around the meetings', mon.join(',') === '09:00-10:00,10:30-12:00,13:00-17:00', mon.join(','));
  check('someone else\'s all-day entry does not block him', gaps.some((g) => g.date === '2026-09-08'));
  check('his own travel day blocks the whole day', !gaps.some((g) => g.date === '2026-09-09'));
  check('a trip blocks the day', !gaps.some((g) => g.date === '2026-09-10'));
  check('the window counts working days, so it reaches past the blocked ones',
        gaps.some((g) => g.date === '2026-09-14') === false && gaps.length >= 3, JSON.stringify(gaps.map((g) => g.date)));

  const late = freeGaps({ now: new Date('2026-09-07T15:30:00').getTime(), days: 1, events: [] });
  check('never offers the past', late.length === 1 && late[0].start === '15:30', JSON.stringify(late));
  const weekend = freeGaps({ now: new Date('2026-09-05T09:00:00').getTime(), days: 1, events: [] });   // Saturday
  check('never a weekend', weekend.every((g) => !['2026-09-05', '2026-09-06'].includes(g.date)), JSON.stringify(weekend.map((g) => g.date)));

  const slots = chop(gaps, { len: 30, count: 3 });
  check('three slots', slots.length === 3);
  check('...spread across days, not three on one morning', new Set(slots.map((s) => s.date)).size >= 2, JSON.stringify(slots));
  check('a slot reads like a sentence', /^\w{3} \d{1,2} \w{3} \d{2}:\d{2}–\d{2}:\d{2}$/.test(say(slots[0])), say(slots[0]));
  check('a gap shorter than the slot yields nothing',
        chop(freeGaps({ now, days: 1, events: [{ summary: 'x', startsAt: '2026-09-07 09:00', endsAt: '2026-09-07 16:45', mine: true }] }), { len: 30 }).length === 0);
}

console.log('\ndebrief — after the meeting, not before, not for the dentist');
{
  const cal = { today: [
    { id: 'm', summary: 'PHOA', startsAt: '2026-09-05 14:00', endsAt: '2026-09-05 15:00', mine: true,
      attendees: [{ email: 'me@x', self: true }, { email: 'hank@phoa.example', self: false }] },
    { id: 'd', summary: 'Dentist', startsAt: '2026-09-05 14:00', endsAt: '2026-09-05 15:00', mine: true, attendees: [{ email: 'me@x', self: true }] },
    { id: 'c', summary: 'Mia thing', startsAt: '2026-09-05 14:00', endsAt: '2026-09-05 15:00', mine: false, attendees: [{ email: 'a@x', self: false }] },
  ] };
  const at = (t) => new Date(`2026-09-05T${t}:00`).getTime();
  check('not before it ends', !endedEvents(cal, at('14:50')).length);
  check('not the minute it ends', !endedEvents(cal, at('15:05')).length);
  check('twenty minutes after, yes', endedEvents(cal, at('15:25')).map((e) => e.id).join() === 'm');
  check('a meeting with nobody else is not debriefed', !endedEvents(cal, at('15:25')).some((e) => e.id === 'd'));
  check('someone else\'s meeting is not', !endedEvents(cal, at('15:25')).some((e) => e.id === 'c'));
  check('and not three hours later', !endedEvents(cal, at('18:30')).length, 'the memory has faded; the evening brief covers it');

  const people = [{ key: 'hank-mercer', name: 'Hank Mercer', handles: ['hank@phoa.example'],
                    owedByMe: [{ title: 'the Industry Day spec', days: 3 }], owedByThem: [] }];
  const d = composeDebrief(cal.today[0], people);
  check('the title names the meeting and the person', /PHOA.*Hank Mercer/.test(d.title), d.title);
  check('it reminds him what he owed going in', d.body.includes('the Industry Day spec'));
  check('it asks one question', d.body.includes('What was agreed'));
  check('the chat link pre-fills the answer', d.body.includes('/chat?say=') && d.prefill.startsWith('Debrief PHOA'));
}

console.log('\ndecide.mjs — one door for decisions.md');
{
  const dir = await mkdtemp(join(tmpdir(), 'decide-'));
  await mkdir(join(dir, '.log'), { recursive: true });
  // decide.mjs writes to <OBLIGATIONS>/decisions.md — point it at the temp dir via the exported fns.
  const r1 = await decideAdd(dir, { title: 'Cabinetry vendor', options: ['MWC $220k', 'ARKO'], blocked: 'totals', due: '2026-09-12', tag: 'one' });
  check('a new decision is written', r1.merged === false && r1.options === 2, JSON.stringify(r1));
  let text = await readFile(join(dir, 'decisions.md'), 'utf8');
  check('...with the header, a heading, due and tag', text.startsWith('# Decisions') && text.includes('## Cabinetry vendor  !due:2026-09-12  #one'), text);
  const r2 = await decideAdd(dir, { title: 'cabinetry VENDOR', options: ['Summitline (install)', 'ARKO'] });
  check('the same title merges, case-insensitively', r2.merged === true, JSON.stringify(r2));
  text = await readFile(join(dir, 'decisions.md'), 'utf8');
  const d = parseDecisions(text).find((x) => x.title === 'Cabinetry vendor');
  check('...adding only the new option', d?.options.length === 3 && d.options.includes('Summitline (install)'), JSON.stringify(d?.options));
  check('...and not a second heading', (text.match(/^## /gm) ?? []).length === 1);
  const r3 = await decide(dir, 'Cabinetry vendor', 'Summitline — firm number in');
  check('decide writes the close line', r3.decided === true);
  check('...idempotently', (await decide(dir, 'Cabinetry vendor', 'again')).decided === false);
  check('a missing decision is said, not invented', (await decide(dir, 'Nope', 'x')).why === 'no such decision');
}

console.log('\nverdicts — his calls, kept');
{
  const dir = await mkdtemp(join(tmpdir(), 'verd-'));
  await mkdir(join(dir, 'rules'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });
  const r = await recordVerdict(dir, 'people', 'kyle@saunaco.example is not Kyle Porter', 'a first name is not identity');
  check('a verdict is one line', /^- \d{4}-\d{2}-\d{2} \| people \| kyle@saunaco\.example is not Kyle Porter \| a first name is not identity$/.test(r.line), r.line);
  const text = await readFile(join(dir, 'rules', 'verdicts.md'), 'utf8');
  check('a new file gets the header', text.startsWith('# Verdicts'));
  const vs = parseVerdicts(text);
  check('...and parses back', vs.length === 1 && vs[0].scope === 'people' && vs[0].why === 'a first name is not identity');
  await recordVerdict(dir, 'mail', 'a | pipe in the call', 'and | in the why');
  const again = await verdicts(dir);
  check('a pipe in the text does not break the line', again.length === 2 && again[1].call === 'a / pipe in the call', JSON.stringify(again[1]));
  let refused = false; try { await recordVerdict(dir, 'nonsense', 'x'); } catch { refused = true; }
  check('an unknown scope is refused', refused);
  check('the live file parses', Array.isArray(await verdicts(REPO)));
  await recordVerdict(dir, 'mail', 'a receipt is digest', 'nothing is owed');
  await recordVerdict(dir, 'brief', 'never a relative date', 'read for weeks');
  check('--list takes a comma list of scopes', (await verdicts(dir, 'mail,general')).every((v) => v.scope === 'mail') && (await verdicts(dir, 'mail,brief')).length === (await verdicts(dir)).length - (await verdicts(dir, 'people')).length);
  check('  ...and an array', (await verdicts(dir, ['brief'])).length === 1);
}

console.log('\nmail-draft — a reply that lands in the thread');
{
  const msg = (from, subject, id, extra = {}) => ({ payload: { headers: [
    { name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: id },
    ...Object.entries(extra).map(([name, value]) => ({ name, value })) ] } });
  const thread = [msg('Alex <alex@rivera.example>', 'Sunrise Nannies Inquiry', '<a@x>'),
                  msg('Hope Lane <info@sunrise-nannies.example>', 'Sunrise Nannies Inquiry', '<b@y>', { References: '<a@x>' })];
  const h = replyHeaders(thread, 'alex@rivera.example');
  check('replies to the last message that was not his', h.to === 'Hope Lane <info@sunrise-nannies.example>', h.to);
  check('Re: is added once', h.subject === 'Re: Sunrise Nannies Inquiry' && replyHeaders([msg('x', 'Re: Hi', '<c>')], 'me').subject === 'Re: Hi');
  // The last non-Alex message can be a machine's — a Superhuman reminder
  // bounce was, and the evening job's nudge went to reminder@superhuman.com.
  const bounced = [msg('Miss Riley <riley@example.com>', 'Sitter', '<r1>'), msg('reminder@superhuman.com', 'Reminder: Sitter', '<sh>')];
  check('a machine sender is skipped for the last human one', replyHeaders(bounced, 'me').to === 'Miss Riley <riley@example.com>');
  check('...and --to overrides whoever the thread suggests', replyHeaders(bounced, 'me', { to: 'other@example.com' }).to === 'other@example.com');
  // A NAME is not an address, and Gmail says so with "Invalid To header (400)".
  // The chases pass `who` off the obligation, which the triage writes as a name
  // whenever the address book can name the person — so every follow-up to
  // somebody it could name failed, hourly, and the pass swallowed the error.
  // Alex, 2026-09-17: the drafts "appear very adhoc" — they were exactly the
  // people the address book could not name.
  check('a name passed as --to is not a recipient; the thread decides',
        replyHeaders(bounced, 'me', { to: 'Hank Mercer' }).to === 'Miss Riley <riley@example.com>',
        replyHeaders(bounced, 'me', { to: 'Hank Mercer' }).to);
  check('...but a name WITH an address is kept as written',
        replyHeaders(bounced, 'me', { to: 'Hank Mercer <wmercer@mac.com>' }).to === 'Hank Mercer <wmercer@mac.com>');
  check('isMachine knows the shapes', isMachine('reminder@superhuman.com') && isMachine('no-reply@x.com') && isMachine('MAILER-DAEMON@g.com') && !isMachine('riley@example.com'));
  check('a helpdesk queue is a machine; a person at the same company is not', isMachine('support@co9704.zohodesk.example') && !isMachine('mben.chen@co9704.example'));
  check('In-Reply-To is their Message-ID', h.inReplyTo === '<b@y>');
  check('References chains theirs', h.references === '<a@x> <b@y>');
  check('Reply-To wins over From when present',
        replyHeaders([msg('A <a@x>', 'S', '<i>', { 'Reply-To': 'B <b@y>' })], 'me').to === 'B <b@y>');
  const raw = Buffer.from(rawMessage({ from: 'me@x', to: 'you@y', subject: 'Re: S', inReplyTo: '<i>', references: '<i>', body: 'Hi\n\nBye' }), 'base64url').toString('utf8');
  check('the raw message is RFC 2822 with CRLF and a blank line before the body', /^From: me@x\r\nTo: you@y\r\nSubject: Re: S\r\nIn-Reply-To: <i>\r\n/.test(raw) && raw.includes('\r\n\r\nHi\r\n\r\nBye'), JSON.stringify(raw));
  check('a missing In-Reply-To leaves no empty header', !rawMessage({ from: 'a', to: 'b', subject: 's', body: 'x' }).includes(Buffer.from('In-Reply-To').toString('base64url').slice(0, 8)));
  // Gmail's composer flattened a plain-text draft into one paragraph; the
  // draft now carries an HTML twin shaped like the composer's own output.
  check('the draft is multipart/alternative with plain and html parts', /multipart\/alternative/.test(raw) && /text\/plain/.test(raw) && /text\/html/.test(raw));
  const withFile = Buffer.from(rawMessage({ from: 'me@x', to: 'you@y', subject: 'S', body: 'see attached', attachments: [{ filename: 'cert.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 fake') }] }), 'base64url').toString('utf8');
  check('a file wraps the text in multipart/mixed, base64, named', /multipart\/mixed/.test(withFile) && /multipart\/alternative/.test(withFile) && /Content-Disposition: attachment; filename="cert.pdf"/.test(withFile) && withFile.includes(Buffer.from('%PDF-1.4 fake').toString('base64')));
  check('paragraphs become divs, blank lines between them, and markup is escaped',
        bodyHtml('Abe,\n\nline one\nline two\n\n<b>&') === '<div>Abe,</div><div><br></div><div>line one<br>line two</div><div><br></div><div>&lt;b&gt;&amp;</div>', bodyHtml('Abe,\n\nline one\nline two\n\n<b>&'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
