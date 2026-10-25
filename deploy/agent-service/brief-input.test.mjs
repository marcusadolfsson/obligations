/**
 * brief-input.mjs: the one document a brief starts from. Two properties
 * matter — a source that cannot be read is named rather than silently absent,
 * and the document stays small enough to be the prompt rather than a dump.
 */
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefInput, keptSince } from '../brief-input.mjs';
import { nowLine } from './time.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const heads = (md) => [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

console.log('an empty obligations: every source blind, nothing invented');
{
  const dir = await mkdtemp(join(tmpdir(), 'obligations-'));
  const out = await briefInput(dir, 'morning');
  check('still produces a document', out.markdown.startsWith('# Brief input — morning') && out.bytes > 200);
  check('names what it could not read', out.blind.length >= 6 && out.blind.some((b) => /calendar\.json/.test(b)) && out.blind.some((b) => /now\.md/.test(b)), out.blind.join(' | '));
  check('the blind section carries them', /## blind[\s\S]*calendar\.json/.test(out.markdown));
  check('no obligation section is faked', !/## obligations/.test(out.markdown) || /0 open/.test(out.markdown));
  let err = null; try { await briefInput(dir, 'weekly'); } catch (e) { err = e; }
  check('an unknown slot is refused', /slot must be/.test(err?.message ?? ''));
  await rm(dir, { recursive: true, force: true });
}

console.log('\nthe verdicts a brief carries are the ones it acts on');
{
  const dir = await mkdtemp(join(tmpdir(), 'obligations-v-'));
  await mkdir(join(dir, 'rules'), { recursive: true });
  await writeFile(join(dir, 'rules', 'verdicts.md'), '# Verdicts\n\n- 2026-09-01 | mail | a receipt is digest | nothing is owed\n- 2026-09-02 | brief | never a relative date | read for weeks\n- 2026-09-03 | message | a thanks closes nothing | x\n- 2026-09-04 | people | chris@x is not Kyle Porter | a first name is not identity\n');
  const out = await briefInput(dir, 'morning');
  const sec = out.markdown.slice(out.markdown.indexOf('## verdicts'), out.markdown.indexOf('## ', out.markdown.indexOf('## verdicts') + 5));
  check('brief and people verdicts are in, newest first', /never a relative date/.test(sec) && /Kyle Porter/.test(sec) && sec.indexOf('Kyle Porter') < sec.indexOf('relative date'), sec);
  check('  ...mail and message verdicts are not — the triages carry their own', !/receipt is digest/.test(sec) && !/thanks closes nothing/.test(sec), sec);
  check('  ...and the section is not the file verbatim', !/^# Verdicts/m.test(sec));
  await rm(dir, { recursive: true, force: true });
}

console.log('\nthe live repo: the skeleton a brief walks');
{
  const m = await briefInput(REPO, 'morning');
  const h = heads(m.markdown);
  const want = ['pipeline health', 'verdicts', 'priorities', 'obligations', 'calendar today', 'conflicts', 'messages', 'mail pipeline', 'reminders.md', 'now.md', 'blind'];
  // A section may be absent only when its source is named under blind — a fresh
  // checkout has no extracts yet, and saying so is the contract.
  const blind = m.markdown.slice(m.markdown.indexOf('## blind'));
  const SOURCE = { 'calendar today': 'calendar.json', messages: 'imessage.json', 'mail pipeline': 'gmail-changed.json', priorities: 'priorities:' };
  const missing = want.filter((w) => !h.some((x) => x.startsWith(w)) && !(SOURCE[w] && blind.includes(SOURCE[w])));
  check('morning has every section a brief needs', !missing.length, 'missing: ' + missing.join(', '));
  /* The section is `filed mail to report` since 2026-09-21 and covers only
     awareness and memory: the digest proper is written by its own model and
     appended to the finished brief, so asking the brief model to narrate those
     threads as well would put two accounts of the same mail in one message. */
  /* One brief a day since 2026-10-24: the morning carries what Tomorrow's
     Brief used to — closes, follow-through, proposals, decisions, tomorrow. */
  check('morning carries filed mail and the sections the evening brief used to',
        h.some((x) => x.startsWith('filed mail'))
        && ['closed since the last brief', 'follow-through', 'project proposals', 'decisions.md'].every((w) => h.some((x) => x.startsWith(w)))
        // Tomorrow's calendar rides today's: no calendar file, neither section.
        && h.some((x) => x.startsWith('calendar today')) === h.some((x) => x.startsWith('calendar tomorrow')), h.join(' | '));
  check('  and no longer asks the brief to narrate the digest itself',
        !h.some((x) => x.startsWith('digest')), h.join(' | '));
  check('under 60KB, not truncated', m.bytes < 60 * 1024 && !/\[truncated/.test(m.markdown), `${m.bytes} bytes`);
  check('verbatim files do not add top-level sections', !h.includes('Active') && !h.includes('Stalled'), h.join(' | '));
  check('obligations are one line each with the id as the handle', /^- `[a-z]+:[^`]+`/m.test(m.markdown));
  const e = await briefInput(REPO, 'evening');
  const eh = heads(e.markdown);
  check('evening, which writes no brief, gets closed today for the journal and none of the brief sections',
        eh.some((x) => x.startsWith('closed today'))
        && !eh.some((x) => /^(filed mail|follow-through|project proposals|calendar tomorrow|decisions\.md)/.test(x)), eh.join(' | '));
  let refused = false; try { await briefInput(REPO, 'midday'); } catch { refused = true; }
  check('midday is no longer a slot', refused);
  // Attendee lines appear exactly when a meeting today has someone else in it.
  let cal = {}; try { cal = JSON.parse(await readFile(join(REPO, 'integrations/calendar.json'), 'utf8')); } catch {}
  const others = (cal.today ?? []).some((e) => (e.attendees ?? []).some((a) => !a.self && a.email));
  const todaySec = m.markdown.slice(m.markdown.indexOf('## calendar today'), m.markdown.indexOf('## ', m.markdown.indexOf('## calendar today') + 5));
  check(others ? 'attendees are joined from people/ under today\'s meetings' : 'no attendee lines when nobody else is in today\'s meetings',
        others === /^  - .+ — /m.test(todaySec), todaySec.slice(0, 300));
}

console.log('\nwiring: the runner hands it over, the jobs know');
{
  const server = await readFile(join(REPO, 'deploy/agent-service/server.mjs'), 'utf8');
  check('one brief slot, and the evening still gets its input', /BRIEF_SLOTS = \['morning'\]/.test(server) && /INPUT_SLOTS = \['morning', 'evening'\]/.test(server) && /INPUT_SLOTS\.includes\(name\)[\s\S]{0,80}briefInput\(OBLIGATIONS, name\)/.test(server));
  check('...and falls back loudly when the assembler fails', /brief_input_failed/.test(server) && /NOT AVAILABLE/.test(server));
  for (const j of ['morning', 'evening']) {
    const p = await readFile(join(REPO, 'jobs', `${j}.md`), 'utf8');
    check(`jobs/${j}.md tells the model its input is below`, /Your input is assembled below/.test(p));
  }
  const src = await readFile(join(REPO, 'deploy/brief-input.mjs'), 'utf8');
  check('the assembler writes nothing: no writeFile, no spawn, no close call',
        !/\bwriteFile\(|\bappendFile\(|closeObligation\(|appendClose\(|\bspawn\(|\bexecFile\(|\bexec\(/.test(src) && !/from 'node:child_process'/.test(src));
}

console.log('\nthe wall clock every prompt opens with');
{
  const d = new Date('2026-09-07T17:10:00');
  const line = nowLine(d);
  check('names the day and the exact minute', /^\[Now: Monday 2026-09-07 17:10/.test(line), line);
  check('spells out today, tomorrow and yesterday — the arithmetic that went wrong',
        /Today is 2026-09-07; tomorrow is 2026-09-08; yesterday was 2026-09-06/.test(line), line);
  check('tells the model not to infer a date from a file', /never a date you infer/.test(line));
  const server = await readFile(join(REPO, 'deploy/agent-service/server.mjs'), 'utf8');
  /* The property is that the clock is the FIRST thing in a job's prompt, not
     that `nowLine()` sits within N characters of the function name — a window
     that shrinks every time a line is added at the top of runJob, which is
     what it did when the model switch went in on 2026-09-21. Asserting the
     assignment itself says what is actually meant and cannot drift. */
  check('every job prompt opens with it',
        /let prompt = `\$\{nowLine\(\)\}/.test(server), 'runJob must build its prompt starting with nowLine()');
  check('every chat turn opens with it', /text = `\$\{nowLine\(\)\}/.test(server));
  const nye = nowLine(new Date('2026-12-31T23:59:00'));
  check('a date that rolls over is still right', /Today is 2026-12-31; tomorrow is 2027-01-01/.test(nye), nye);
}

/* Fitting the budget by trimming, never by cutting the tail. Found 2026-09-14:
 * with 231 open obligations the morning input reached 62KB and the byte slice
 * had been firing — cutting a sentence in half and dropping now.md, today's
 * journal and the blind section, so the brief could not know anything was
 * missing. The live repo is over budget, so this exercises the real path. */
console.log('\nover budget, nothing important falls off the end');
{
  for (const slot of ['morning', 'evening']) {
    const r = await briefInput(REPO, slot);
    check(`${slot}: fits without the last-resort slice`, !/truncated at \d+KB/.test(r.markdown), `${r.bytes} bytes`);
    check(`${slot}: the blind section is still the last thing in it`,
          /## blind[^\n]*\n[\s\S]*$/.test(r.markdown) && !/\n## (?!blind)[^\n]*\n[\s\S]*$/.test(r.markdown.slice(r.markdown.lastIndexOf('## blind'))));
    check(`${slot}: anything cut is admitted in the blind section`,
          r.cuts.every((c) => r.markdown.slice(r.markdown.lastIndexOf('## blind')).includes(c.split(':')[0])),
          JSON.stringify(r.cuts));
  }
}

/* "Did iMessages stop working?" — Alex, 2026-09-23, of a morning brief that
 * said he had never come back to Owen Frydén with a place. He had, by text
 * at 19:43, and the obligation closed at 20:35. iMessage was fine: the promise
 * section is yesterday's journal read verbatim, a snapshot written at 18:00,
 * and nothing between it and the brief asked whether he had since kept it. */
console.log('\nhe said he would — what happened after he said it');
{
  const dir = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'integrations/contacts.json'), JSON.stringify({
    index: { '7275550111': 'Owen Frydén', '7275550222': 'Neil Brandt' } }));
  await writeFile(join(dir, 'integrations/imessage.json'), JSON.stringify({ threads: [
    { chat_id: '+17275550111', participants: ['+17275550111'], messages: [
      { at: '2026-09-22 11:31', from_me: true, text: 'Jag återkommer med plats' },
      { at: '2026-09-22 19:43', from_me: true, text: 'Sucré Table on W Kendall' }] },
    { chat_id: '+17275550222', participants: ['+17275550222'], messages: [
      { at: '2026-09-22 16:24', from_me: true, text: 'I will send you info' }] }] }));
  await writeFile(join(dir, 'logbook.md'),
    '- 2026-09-22 20:35 | msg:owen | Suggest a meeting spot for Owen in Eastshore | by agent:assistant | he picked Sucré Table\n'
    + '- 2026-09-22 16:18 | mail:kevin | Send Neil the Instagram inbox app info | by agent:assistant | sent\n');

  const block = ['- "Jag återkommer med plats" — to Owen Frydén, 11:31, before the 10:00.',
                 '- "I will send you info" — to Neil Brandt, 16:24, on the app.',
                 '- Tidy the hangar paperwork.'].join('\n');
  const out = (await keptSince(dir, block, '2026-09-22')).split('\n');

  check('a promise he kept carries what he did about it',
        /SINCE HE SAID IT[\s\S]*Owen Frydén by text at 19:43/.test(out[1]), out[1]);
  check('  and the close that followed it', /closed 2026-09-22 20:35/.test(out[1]), out[1]);
  /* The promise itself was sent in that minute and an older close is about
     something else — either one cited back at him is a line that looks like
     evidence and is not. */
  const notes = out.filter((l) => /SINCE HE SAID IT/.test(l));
  check('the promise message is not evidence of itself, and an older close is not either',
        notes.length === 1, notes.join(' | '));
  check('a line with no promise in it is untouched', out[out.length - 1] === '- Tidy the hangar paperwork.');
  check('nothing is dropped', out.length === 4, String(out.length));
  await rm(dir, { recursive: true, force: true });
}

/* Alex, 2026-10-17: "No way that has been 51 days." The item opened on
   08-26; Carl last wrote on 10-14 and Alex answered him that morning. The
   waiting line printed the item's age. */
console.log('\na wait is the gap since they last wrote, not the age of the item');
{
  const { withWait, obLine } = await import('../brief-input.mjs');
  const now = new Date('2026-10-17T07:00:00');
  const mike = { id: 'mail:personal:t', title: 'Get the interior quote', owed_by: 'them', who: 'mvoss@cod896.example',
                 since: '2026-08-26 19:06', days: 51, evidence: [{ source: 'email' }] };
  const said = [{ at: '2026-10-12 12:57', from: 'them', thread: 't' }, { at: '2026-10-14 09:54', from: 'them', thread: 't' },
                { at: '2026-10-14 10:41', from: 'you', thread: 't' }];
  const [m] = await withWait([mike], async () => ({ inTouch: { seen: true, all: said } }), now);
  check('measured from their newest message on the thread', m.waited === 2, String(m.waited));
  check('  and the line says so', /waiting 2d, never chased/.test(obLine(m, { waiting: {} })), obLine(m, { waiting: {} }));
  const [blindRow] = await withWait([mike], async () => ({ inTouch: { seen: false, all: [] } }), now);
  check('nobody could look: the age stands, rather than a guess', blindRow.waited === 51, String(blindRow.waited));
  const [never] = await withWait([mike], async () => ({ inTouch: { seen: true, all: [] } }), now);
  check('nothing from them at all: waiting since it started', never.waited === 51, String(never.waited));
}

/* Alex, 2026-10-18: the morning brief put "Sales tax" under Due today —
   the diary's "Sales Tax Due" and now.md's "Mon 10-19" line — above a digest
   of the state portal's payment and return-filed notices. He had closed the
   obligation on 10-15; neither the diary nor now.md is an obligation, and
   nothing set the close beside them. */
console.log('\na diary entry or a dated now.md line about something already closed');
{
  const { closedMatch, datedLinesChecked } = await import('../brief-input.mjs');
  const filed = { id: 'mail:personal:1a1119e87532bb48', open: false, title: 'File the September the state sales and use tax return',
                  due: '2026-10-19', closed_at: '2026-10-15 15:35', closed_by: 'alex@rivera.example', outcome: 'the September return is filed' };
  const ups = { id: 'mail:a:ups', open: false, title: 'Pay the UPS invoice', due: '2026-10-12', closed_at: '2026-10-11 09:00', closed_by: 'alex@rivera.example' };
  check('the diary entry finds the close', closedMatch('Sales Tax Due', '2026-10-18', [filed, ups])?.id === filed.id);
  check('  but next month\'s entry does not find this month\'s close', closedMatch('Sales Tax Due', '2026-11-18', [filed]) === null);
  check('one shared word is not a match', closedMatch('the state trip', '2026-10-18', [filed]) === null);
  check('an obligation with no due date is never matched', closedMatch('Sales Tax Due', '2026-10-18', [{ ...filed, due: null }]) === null);
  const md = ['## This week\'s deadlines', '',
              '- **Mon 10-12** — Gym 09:00. Theo\'s interview 13:30.',
              '  The UPS invoice is due.',
              '- **Mon 10-19** — The September the state sales and use tax return.',
              '- **Thu 10-22** — Clara\'s cataract surgery.',
              '- Untouched line about sales tax return the state.'].join('\n');
  const out = datedLinesChecked(md, '2026-10-18', [filed, ups]).split('\n');
  const notes = out.filter((l) => /ALREADY DONE/.test(l));
  check('each dated line gets its close', notes.length === 2, notes.join(' | '));
  check('  after the whole bullet, continuation line included', /ALREADY DONE: "Pay the UPS invoice"/.test(out[4]), out[4]);
  check('  and the note carries the outcome and the link', /the September return is filed.*\/todo#pane=mail%3Apersonal%3A1a1119e87532bb48/.test(out[6]), out[6]);
  check('nothing is dropped', out.length === md.split('\n').length + 2, String(out.length));
  /* An indented "- … — …" under a meeting is an attendee line; the note must
     not read as one (the live-data test caught it, 2026-10-18). */
  check('the note is not shaped like an attendee line', notes.every((l) => !/^  - .+ — /.test(l)), notes.join(' | '));
  const long = { ...filed, outcome: 'Owen has the link — he asked on the text thread at 09:30 and Alex sent the Teams link at 09:31; Owen joined the 09:30 call on audio at 09:57, so nothing is left to send' };
  const cut = datedLinesChecked('- **Mon 10-19** — The September the state sales and use tax return.', '2026-10-18', [long]);
  check('a long outcome is cut at a word, and says so', cut.includes('…') && !/, so \(/.test(cut), cut);
  check('an undated line is left alone', out[out.length - 1] === '- Untouched line about sales tax return the state.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
