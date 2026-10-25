/**
 * The chief-of-staff layer, 2026-09-05.
 *
 * Six small modules, each arithmetic over sources that already existed. What
 * these tests pin is the parsing (three new file formats) and the negatives:
 * a nudge proposed to nobody, a project proposed for Chase alerts, a prep note
 * for a dentist appointment — each is a way the layer becomes noise, and noise
 * is how a chief of staff gets ignored.
 */
import { parseDecisions, decisionId, close as decideClose, read as readDecisions } from './sources/decisions.mjs';
import { validateFocus, savePriorities } from '../priorities.mjs';
import { focusProjects, readProjects, setFocus } from './projects.mjs';
import { staleFrom } from '../stale.mjs';
import { proposeFrom } from '../projects-propose.mjs';
import { dueEvents, composePrep } from '../prep.mjs';
import { handle, peopleIndex } from './people.mjs';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('decisions.md');
{
  const text = `# Decisions\n\n\`\`\`\n## Template  !due:2000-01-01  #x\n\`\`\`\n\n`
    + `## Cabinetry vendor  !due:2026-09-12  #one\n`
    + `- options: MWC $220k · ARKO · Summitline (install)\n`
    + `- recommend: Summitline — only bid with install\n`
    + `- blocked: comparable totals\n`
    + `- a free note\n\n`
    + `## Already made\n- decided: 2026-09-01 went with A\n`;
  const ds = parseDecisions(text);
  // The fence is not tracked by parseDecisions — it takes every ## heading —
  // so the template heading IS parsed here. read() is what filters; this only
  // pins that the real one comes out right.
  const d = ds.find((x) => x.title === 'Cabinetry vendor');
  check('title, due and #project come off the heading', d && d.due === '2026-09-12' && d.project === 'one', JSON.stringify(d));
  check('options split on the middle dot', d?.options.length === 3, JSON.stringify(d?.options));
  check('recommend and blocked are read', d?.recommend?.startsWith('Summitline') && d?.blocked === 'comparable totals');
  check('a free bullet is kept as a note', d?.notes.includes('a free note'));
  const made = ds.find((x) => x.title === 'Already made');
  check('a decided: line is read', made?.decided === '2026-09-01 went with A');
  check('the id is stable across case and whitespace',
        decisionId('Cabinetry vendor') === decisionId('  cabinetry VENDOR '));

  const dir = await mkdtemp(join(tmpdir(), 'dec-'));
  await writeFile(join(dir, 'decisions.md'), text);
  const open = await readDecisions(dir);
  check('read() returns only undecided ones', open.length === 2 && !open.some((o) => o.what === 'Already made'),
        open.map((o) => o.what).join(', '));
  const real = open.find((o) => o.what === 'Cabinetry vendor');
  check('a decision is owed by him and tagged decision', real?.owed_by === 'me' && real?.tags.includes('decision'));
  check('a decision has no counterparty', real?.who === null, 'it is owed to nobody — that is the point');

  const r = await decideClose(dir, real.ref, 'agent', 'Summitline — firm number came in');
  check('close() writes a decided: line', r.closed === true);
  const after = await readFile(join(dir, 'decisions.md'), 'utf8');
  check('...under the right heading, and the section stays',
        /## Cabinetry vendor[\s\S]*?- decided: \d{4}-\d{2}-\d{2} Summitline/.test(after) && after.includes('- options:'),
        after);
  check('...and it is idempotent', (await decideClose(dir, real.ref, 'agent', 'again')).alreadyClosed === true);
  check('...and read() no longer lists it', !(await readDecisions(dir)).some((o) => o.ref === real.ref));
}

console.log('\nthe focus projects — what the briefs lead with');
{
  // Alex, 2026-09-16: "maybe combine priorities and projects?" priorities.md
  // and projects/ were two files keyed by the same tag, and every priority he
  // had was a body of work. A project carries `focus: n` when it is one of the
  // few; the number is the order the briefs read them in.
  const dir = await mkdtemp(join(tmpdir(), 'pri-'));
  await mkdir(join(dir, 'projects'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });
  const write = (name, body) => writeFile(join(dir, 'projects', `${name}.md`), body);
  await write('one', '---\ntype: project\nname: one\nstatus: active\ntag: one\nfocus: 2\n---\n\n'
    + '# ONE renovation\n\n**Goal:** install dated.\n\n**On track:** Cabinetry chosen.\n\n## Status\n\nprose\n');
  await write('phoa', '---\ntype: project\nname: phoa\nstatus: active\ntag: phoa\nfocus: 1\n---\n\n'
    + '# PHOA\n\n**Goal:** the CRM the board trusts.\n\n## Status\n\nprose\n');
  await write('locks', '---\ntype: project\nname: locks\nstatus: active\ntag: locks\n---\n\n# Locks\n\n**Goal:** stock traceable.\n');

  const f = await focusProjects(dir);
  check('only the ones with a focus line lead', f.map((p) => p.tag).join(',') === 'phoa,one', f.map((p) => p.tag).join(','));
  check('the number is the order, not the filename', f[0].tag === 'phoa');
  check('his on-track sentence is what the report shows', f[1].note === 'Cabinetry chosen.', f[1].note);
  check('a project with no on-track line falls back to its goal', f[0].note === 'the CRM the board trusts.', f[0].note);
  check('a project with no focus still exists to be grouped by',
        (await readProjects(dir)).some((p) => p.tag === 'locks' && p.focus === null));

  // The form: which projects, in what order, and the one line each.
  await setFocus(dir, [{ tag: 'locks', note: 'waiting list filling' }, { tag: 'one', note: 'install dated' }]);
  const after = await focusProjects(dir);
  check('choosing a project makes it the focus, in the order sent',
        after.map((p) => p.tag).join(',') === 'locks,one', after.map((p) => p.tag).join(','));
  check('one no longer chosen stops being a priority', !after.some((p) => p.tag === 'phoa'));
  check('his sentence is written where it belongs', after.find((p) => p.tag === 'locks').note === 'waiting list filling');
  const locks = await readFile(join(dir, 'projects', 'locks.md'), 'utf8');
  check('...under the goal, which is left as it was', /\*\*Goal:\*\* stock traceable\.[\s\S]*\*\*On track:\*\* waiting list filling/.test(locks), locks);
  const one = await readFile(join(dir, 'projects', 'one.md'), 'utf8');
  check('nothing else in the file is rewritten — a decision log cannot be lost this way',
        /## Status\n\nprose/.test(one) && /\*\*Goal:\*\* install dated\./.test(one));

  const refuses = async (label, rows) => {
    try { await setFocus(dir, rows); check(`refuses ${label}`, false, 'accepted'); }
    catch (e) { check(`refuses ${label}`, true, e.message); }
  };
  await refuses('a tag no project file carries', [{ tag: 'nope' }]);
  check('an empty list is refused before anything is written', validateFocus([]) !== null);
  check('more than seven is refused', /seven|more than/.test(validateFocus(Array.from({ length: 9 }, (_, i) => ({ tag: `t${i}` }))) ?? ''));
  check('a tag chosen twice is refused', /twice/.test(validateFocus([{ tag: 'a' }, { tag: 'a' }]) ?? ''));
}

console.log('\nstale.mjs — who to nudge');
{
  const mail = (o) => ({ evidence: [{ source: 'email', detail: { thread_id: 't1' } }], ...o });
  const text = (o) => ({ evidence: [{ source: 'imessage' }], chat_id: 'c1', ...o });
  const todo = (o) => ({ evidence: [{ source: 'todo' }], ...o });
  const out = staleFrom([
    mail({ id: 'a', title: 'quiet vendor', owed_by: 'them', who: 'v@x.com', days: 9 }),
    mail({ id: 'b', title: 'fresh vendor', owed_by: 'them', who: 'w@x.com', days: 2 }),
    text({ id: 'c', title: 'reply owed', owed_by: 'me', who: '+15551234567', days: 3, lead_days: 1, overdue: false }),
    mail({ id: 'd', title: 'overdue reply', owed_by: 'me', who: 'z@x.com', days: 10, lead_days: -2, overdue: true }),
    mail({ id: 'e', title: 'not soon', owed_by: 'me', who: 'y@x.com', days: 1, lead_days: 9, overdue: false }),
    todo({ id: 'f', title: 'my own todo', owed_by: 'them', who: 'someone', days: 30 }),
    mail({ id: 'g', title: 'no counterparty', owed_by: 'them', who: null, days: 30 }),
  ]);
  check('a quiet wait is a nudge candidate', out.them.some((r) => r.id === 'a'));
  check('a recent wait is not', !out.them.some((r) => r.id === 'b'));
  check('the channel comes from the evidence', out.them.find((r) => r.id === 'a')?.channel === 'mail');
  check('the mail thread rides along so the nudge is a reply', out.them.find((r) => r.id === 'a')?.thread === 't1');
  check('an imminent debt with someone to tell is a holding-reply candidate', out.you.some((r) => r.id === 'c'));
  check('...by text when the evidence is a text', out.you.find((r) => r.id === 'c')?.channel === 'imessage');
  check('an overdue debt is one too, and sorts first', out.you[0]?.id === 'd');
  check('a debt due next week is not', !out.you.some((r) => r.id === 'e'));
  check('a todo has nobody to nudge', !out.them.some((r) => r.id === 'f'), 'no channel, no candidate');
  check('no counterparty, no candidate', !out.them.some((r) => r.id === 'g'));
}

console.log('\nprojects-propose.mjs');
{
  const o = (id, who, tags = []) => ({ id, title: id, who, tags, owed_by: 'me', days: 1 });
  const open = [
    o('1', 'a@carta.example'), o('2', 'b@carta.example'), o('3', 'c@carta.example'), o('4', 'd@carta.example'),
    o('5', 'x@chase.com'), o('6', 'y@chase.com'), o('7', 'z@chase.com'), o('8', 'w@chase.com'),
    o('9', 'p@phoa.example', ['phoa']), o('10', 'q@phoa.example', ['phoa']), o('11', 'r@phoa.example', ['phoa']), o('12', null, ['phoa']),
    o('13', 's@small.com'), o('14', 't@small.com'),
  ];
  const props = proposeFrom(open, [{ slug: 'phoa-crm', text: 'the phoa crm' }]);
  check('a four-strong domain cluster is proposed', props.some((p) => p.key === 'carta.example'));
  check('...with a suggested file name', props.find((p) => p.key === 'carta.example')?.suggestedFile === 'projects/carta-example.md');
  check('a bank is not a project', !props.some((p) => p.key === 'chase.com'), 'a cluster of alerts is noise');
  check('a cluster already covered by a projects/ file is not proposed', !props.some((p) => p.key === 'phoa'));
  check('a cluster below the minimum is not proposed', !props.some((p) => p.key === 'small.com'));
  check('the decision tag never becomes a project', !props.some((p) => p.key === 'decision'));
}

console.log('\nprep.mjs');
{
  const now = Date.parse('2026-09-05T13:15:00');
  const cal = { today: [
    { id: 'soon', summary: 'PHOA', startsAt: '2026-09-05 14:00', attendees: [{ email: 'me@x', self: true }, { email: 'hank@phoa.example', self: false }] },
    { id: 'alone', summary: 'Dentist', startsAt: '2026-09-05 14:10', attendees: [{ email: 'me@x', self: true }] },
    { id: 'allday', summary: 'Anniversary', allDay: true, startsOn: '2026-09-05', attendees: [{ email: 'c@x', self: false }] },
    { id: 'later', summary: 'Later', startsAt: '2026-09-05 16:00', attendees: [{ email: 'a@x', self: false }] },
    { id: 'past', summary: 'Past', startsAt: '2026-09-05 12:00', attendees: [{ email: 'a@x', self: false }] },
  ] };
  const due = dueEvents(cal, now).map((e) => e.id);
  check('a meeting with someone else inside the hour is due', due.includes('soon'));
  check('a meeting with nobody else is not', !due.includes('alone'), 'a prep note about a room with nobody in it is a reminder');
  check('an all-day entry is not', !due.includes('allday'));
  check('a meeting in three hours is not yet', !due.includes('later'));
  check('a meeting that started is not', !due.includes('past'));

  const people = [{ key: 'hank-mercer', name: 'Hank Mercer', org: 'PHOA', how: 'Runs the board.',
                    handles: ['hank@phoa.example'], last: '2026-09-03 14:14', lastSubject: 'the hold', threads: 3,
                    owedByMe: [{ title: 'the spec', days: 4, due: null, overdue: false }],
                    owedByThem: [], file: 'people/hank-mercer.md' }];
  const note = composePrep(cal.today[0], people);
  check('the title names the person and what you owe', /Hank Mercer.*you owe 1/.test(note.title), note.title);
  check('the body says how you know them', note.body.includes('Runs the board.'));
  check('the body lists the debt', note.body.includes('the spec'));
  check('the body links the file', note.body.includes('people/hank-mercer.md'));
  const stranger = composePrep({ ...cal.today[0], attendees: [{ email: 'new@x.com', self: false }] }, people);
  check('a stranger is said to be one, not invented', stranger.body.includes('no history with them here') && /1 new/.test(stranger.title));
}

console.log('\npeople.mjs');
{
  check('handles fold case', handle(' hank@phoa.example ') === 'hank@phoa.example');
  check('a phone keeps its plus', handle('+15552000004') === '+15552000004');
  check('nothing is nothing', handle(null) === '');
}

console.log('\npeople.mjs — who an address belongs to');
{
  // Alex, 2026-09-05: kyle@saunaco.example had been merged into Kyle Porter
  // because "chris" matched exactly one file. These are separate people.
  const dir = await mkdtemp(join(tmpdir(), 'ppl-'));
  await mkdir(join(dir, 'people'), { recursive: true });
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'people', 'kyle-porter.md'),
    '---\ntype: person\nname: Kyle Porter\norg:\n---\n\n# Kyle Porter\n\n**How I know them:** +15552000005. The locks business.\n');
  await writeFile(join(dir, 'people', 'hank-mercer.md'),
    '---\ntype: person\nname: Hank Mercer\norg: PHOA\n---\n\n# Hank\n\n**How I know them:** +15552000004.\n');
  await writeFile(join(dir, 'integrations', 'contacts.json'), JSON.stringify([
    { name: 'Kyle Porter', handles: [{ kind: 'phone', key: '5552000005', raw: '+1 (555) 200-0005' }, { kind: 'email', key: 'admin@harborview-condo.example', raw: 'admin@harborview-condo.example' }] },
  ]));
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: 'a', account: 'x', watermark: '2026-09-01 10:00', conclusion: { tier: 'digest', who: 'kyle@saunaco.example', title: 'Sauna', since: '2026-09-01 10:00' } },
    { thread_id: 'b', account: 'x', watermark: '2026-09-02 10:00', conclusion: { tier: 'digest', who: 'admin@harborview-condo.example', title: 'ONE', since: '2026-09-02 10:00' } },
    { thread_id: 'c', account: 'x', watermark: '2026-09-03 10:00', conclusion: { tier: 'digest', who: 'hank@phoa.example', title: 'Board', since: '2026-09-03 10:00' } },
    { thread_id: 'd', account: 'x', watermark: '2026-09-03 11:00', conclusion: { tier: 'digest', who: 'hank@co4e6a.example', title: 'Other', since: '2026-09-03 11:00' } },
  ] }));
  const { people, hidden } = await peopleIndex(dir);
  const chris = people.find((p) => p.key === 'kyle-porter');
  /* Not merged is the point. Since 2026-09-22 a company address with no name
     on its mail is an organisation and left off the page — so it is either
     its own row or among the hidden, and in neither case Kyle Porter's. */
  check('a bare first name does not merge two people', !chris?.handles.includes('kyle@saunaco.example')
        && (people.some((p) => p.handles.includes('kyle@saunaco.example')) || hidden.some((h) => h.key === 'kyle@saunaco.example')),
        'kyle@saunaco.example is not Kyle Porter');
  check('Contacts links an address whose name has a file',
        chris?.handles.includes('admin@harborview-condo.example'), JSON.stringify(chris?.handles));
  check('...and the file inherits the contact\'s phone', chris?.handles.includes('+15552000005'));
  const hank = people.find((p) => p.key === 'hank-mercer');
  check('first name + org domain still links', hank?.handles.includes('hank@phoa.example'), JSON.stringify(hank?.handles));
  check('first name on a foreign domain does not', !hank?.handles.includes('hank@co4e6a.example'));
  // A machine address is not a person, even with an obligation attached.
  // Alex, 2026-09-06: "Why does people have so many emails not related to
  // people?" — noreply@github.com, noreply@amazon.com sat under "you owe 1".
  {
    const st = JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8'));
    st.threads.push({ thread_id: 'mach1', account: 'personal', reviewed: '2026-09-06 07:00',
      conclusion: { tier: 'action', who: 'noreply@github.com', title: 'SSH key added', what: 'x', open: true, owed_by: 'me', since: '2026-09-06 07:00' } });
    await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify(st));
    const again = await peopleIndex(dir);
    check('a noreply sender is not listed as a person', !again.people.some((p) => p.handles.includes('noreply@github.com')));
    check('...and is counted as hidden', again.counts.machinesHidden >= 1, String(again.counts.machinesHidden));
  }

  /* PEOPLE ONLY, YOURS FIRST. Alex, 2026-09-22: "Lets make it people only
     to begin with, it has a lot of organizations in there. … those [in the
     contact book] should be more high value people than non-contact book
     people." A role mailbox leaves the list and is counted; a contact he only
     ever texts is one of his; a named person at a company is one of the
     others; and a debt written against a NAME joins the person's own row
     rather than making a second, lower-cased one. */
  {
    const st = JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8'));
    st.threads.push(
      { thread_id: 'role1', account: 'personal', reviewed: '2026-09-07 07:00',
        conclusion: { tier: 'digest', who: 'accounts.receivable@northwind-aero.example.br', title: 'Payment', since: '2026-09-07 07:00' } },
      { thread_id: 'hum1', account: 'personal', reviewed: '2026-09-07 08:00',
        conclusion: { tier: 'digest', who: 'hull.sharon@oliverco.example', title: 'Returns', since: '2026-09-07 08:00' } });
    await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify(st));
    await writeFile(join(dir, 'integrations', 'sender-names.json'), JSON.stringify({ names: { 'hull.sharon@oliverco.example': 'Sharon Hart' } }));
    await writeFile(join(dir, 'integrations', 'contacts.json'), JSON.stringify([
      { name: 'Kyle Porter', handles: [{ kind: 'phone', key: '5552000005', raw: '+1 (555) 200-0005' }, { kind: 'email', key: 'admin@harborview-condo.example', raw: 'admin@harborview-condo.example' }] },
      { name: 'Pete Rourke', handles: [{ kind: 'phone', key: '8135550142', raw: '+1 (813) 555-0142' }] },
    ]));
    await writeFile(join(dir, 'integrations', 'imessage-state.json'), JSON.stringify({ threads: [
      { chat_id: 'c1', participants: ['+18135550142'], watermark: '2026-09-21 18:00', reviewed: '2026-09-21 18:05',
        conclusion: { open: true, owed_by: 'them', who: 'Pete Rourke', title: 'Gym times for Thursday', since: '2026-09-21 18:00' } },
    ] }));
    const r = await peopleIndex(dir);
    check('a role mailbox is left off the page', !r.people.some((p) => p.handles.includes('accounts.receivable@northwind-aero.example.br')));
    check('  and counted, so a shorter page is not mistaken for a broken one', r.counts.orgsHidden >= 1, String(r.counts.orgsHidden));
    const tom = r.people.find((p) => p.name === 'Pete Rourke');
    check('a contact he only texts is one of his people', tom?.circle === 'yours' && tom.texts === 1, JSON.stringify(tom));
    check('  and the page knows the last word was a text', tom?.lastChannel === 'text');
    check('a debt written against his NAME joins his row', tom?.owedByThem.length === 1, JSON.stringify(tom?.owedByThem));
    check('  and makes no second, lower-cased row', !r.people.some((p) => p !== tom && String(p.name).toLowerCase() === 'tom rourke'));
    const shannon = r.people.find((p) => p.handles.includes('hull.sharon@oliverco.example'));
    check('a named person at a company, not in his contacts, is one of the others', shannon?.circle === 'others', JSON.stringify(shannon?.circle));
    check('people/ files and contacts come before everyone else',
          r.people.findIndex((p) => p.circle === 'others') > r.people.findLastIndex((p) => p.circle === 'yours'));
  }

}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
