/**
 * Projects as the registry: what a tag is, what belongs to one, and adding a
 * task by hand.
 *
 * Alex, 2026-09-16: "can we add some more manual ways to create To Dos,
 * grouped by Tags/Projects. And then when data comes in we try to assign to
 * those tags/Projects as needed."
 *
 * Nearly every case here is a FALSE POSITIVE case, which is where the lint's
 * first draft went wrong: it called his own home four rare places by being
 * clever. A missing tag shows up in the unassigned count on the page; a wrong
 * one quietly files a debt under a project he will not look in.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjects, assignTag, createProject, archiveProject, updateProject } from './projects.mjs';
import { addTask, read as readTodo } from './sources/todo.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const project = (vault, name, front, body = 'prose') =>
  writeFile(join(vault, 'projects', `${name}.md`), `---\n${front}\n---\n\n# ${name}\n\n${body}\n`);

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'obligations-proj-'));
  await mkdir(join(vault, 'projects'), { recursive: true });
  await project(vault, '_template', 'type: project\nname:\nstatus: active | paused | done\ntag:');
  await project(vault, 'phoa-crm', ['type: project', 'name: phoa-crm', 'status: active', 'tag: phoa',
    'match-people: community@phoa.example, @co4c04.example, +15552000004, Hank Mercer',
    'match-words: PHOA, Industry Day'].join('\n'));
  await project(vault, 'one-reno', ['type: project', 'name: one-reno', 'status: active', 'tag: one',
    'match-people: henry@pike.example', 'match-words: ONE Springfield, 2201/2202'].join('\n'));
  await project(vault, 'old-thing', 'type: project\nname: old-thing\nstatus: done\ntag: old\nmatch-words: anything');
  await project(vault, 'untagged', 'type: project\nname: untagged\nstatus: active');
  return vault;
}

console.log('reading the registry');
const vault = await fixture();
const projects = await readProjects(vault);
{
  const tags = projects.map((p) => p.tag);
  check('every active project with a tag is listed', tags.includes('phoa') && tags.includes('one'), tags.join(','));
  check('the template is not a project', !projects.some((p) => p.slug === '_template'));
  check('a finished project stops collecting', !tags.includes('old'));
  check('a project with no tag is still listed, so it can be grouped by hand once tagged',
        projects.some((p) => p.slug === 'untagged' && p.tag === null));
  check('match rules are read as lists', projects.find((p) => p.tag === 'phoa').people.length === 4
        && projects.find((p) => p.tag === 'phoa').words.length === 2);
}

console.log('\nwhat a project claims');
{
  const at = (o) => assignTag(o, projects);
  check('an address on the people list', at({ who: 'community@phoa.example', title: 'Answer Ruth' })?.tag === 'phoa');
  check('a whole domain, written @example.org', at({ who: 'lynch@co4c04.example', title: 'Fix the blog post' })?.tag === 'phoa');
  check('a phone number, on its last ten digits', at({ who: '+1 (555) 200-0004', title: 'Call him back' })?.tag === 'phoa');
  check('a name, which is how the triage usually writes who', at({ who: 'Hank Mercer', title: 'Send the reply' })?.tag === 'phoa');
  check('a name inside a group string still files it', at({ who: 'Hank Mercer and Ruth Ellis (PHOA)', title: 'x' })?.tag === 'phoa');
  check('a word in the title', at({ who: 'nobody@example.com', title: 'Book the Industry Day tent' })?.tag === 'phoa');
  check('the reason is carried, so the page never shows a tag from nowhere',
        /Industry Day/.test(at({ who: 'nobody@example.com', title: 'Book the Industry Day tent' })?.why ?? ''));

  check('an address is stronger than a word: the person wins', at({ who: 'henry@pike.example', title: 'Send the PHOA plans' })?.tag === 'one');
  check('two projects claiming it by word assigns neither',
        at({ who: 'nobody@example.com', title: 'PHOA meeting at ONE Springfield' }) === null);
  check('nothing matching assigns nothing', at({ who: 'dawn@coc426.example', title: 'Treat the Angelnet positions' }) === null);
  check('a word must be whole: "one" does not match "money"',
        at({ who: 'nobody@example.com', title: 'Chase the money for the hangar' }) === null);
  check('a project with no match rules claims nothing',
        at({ who: 'untagged@example.com', title: 'untagged' }) === null);
  check('no projects at all is not an error', assignTag({ who: 'a@b.c', title: 'x' }, []) === null);
  check('an item with no person and no title is left alone', assignTag({}, projects) === null);
}

console.log('\nadding a task by hand');
{
  const box = await mkdtemp(join(tmpdir(), 'obligations-todo-'));
  await writeFile(join(box, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] an older task !since:2026-09-01\n\n## Next\n\n');
  const r = await addTask(box, { text: 'Call the roofer', tag: 'one', due: '2026-09-20', section: 'Now' });
  const raw = await readFile(join(box, 'todo.md'), 'utf8');
  check('the line is written in the file\'s own grammar',
        /^- \[ \] Call the roofer #one !due:2026-09-20 !since:\d{4}-\d{2}-\d{2}$/m.test(raw.split('\n').find((l) => /roofer/.test(l)) ?? ''),
        raw.split('\n').find((l) => /roofer/.test(l)));
  check('it lands under the section asked for, newest first',
        raw.indexOf('Call the roofer') > raw.indexOf('## Now') && raw.indexOf('Call the roofer') < raw.indexOf('an older task'));
  check('nothing else in the file is touched', /- \[ \] an older task !since:2026-09-01/.test(raw));
  check('it comes back with the id the page can open', /^todo:[0-9a-f]{12}$/.test(r.id), r.id);

  const rows = await readTodo(box);
  const made = rows.find((x) => x.ref === r.ref);
  check('the source reads back what was written', made?.what === 'Call the roofer' && made.due === '2026-09-20' && made.project === 'one',
        JSON.stringify(made));

  await addTask(box, { text: 'Wait on the survey #one !waiting', section: 'Next' });
  const raw2 = await readFile(join(box, 'todo.md'), 'utf8');
  check('a line that already carries its own tags is not given a second copy',
        (raw2.match(/Wait on the survey[^\n]*/) ?? [''])[0].match(/#one/g).length === 1,
        (raw2.match(/Wait on the survey[^\n]*/) ?? [''])[0]);
  check('a missing section is created rather than the task landing anywhere',
        (await addTask(box, { text: 'Some day', section: 'Someday' })).section === 'Someday'
        && /## Someday/.test(await readFile(join(box, 'todo.md'), 'utf8')));

  const refuses = async (label, args) => {
    try { await addTask(box, args); check(`refuses ${label}`, false, 'accepted'); }
    catch (e) { check(`refuses ${label}`, true, e.message); }
  };
  await refuses('a task with no words', { text: '   ' });
  await refuses('a due date that is not a date', { text: 'x', due: 'Friday' });
  await refuses('a section that is not one of his', { text: 'x', section: 'Inbox' });
}

console.log('\nstarting a project by hand');
{
  const dir = await fixture();
  const r = await createProject(dir, { name: 'Hangar lease', goal: 'Signed and hangared by December.',
    onTrack: 'Two quotes in, one site visit booked.', people: ['@codbe4.example', 'Reid Coyle'],
    words: ['KXYZ', 'hangar lease'], focus: true });
  check('the file is named after the project', r.file === 'projects/hangar-lease.md', r.file);
  check('the tag comes from the name when none is given', r.tag === 'hangar-lease', r.tag);
  const text = await readFile(join(dir, r.file), 'utf8');
  check('it is the template the other projects use',
        /^---\ntype: project\nname: hangar-lease\nstatus: active\nstarted: \d{4}-\d{2}-\d{2}\ntag: hangar-lease\n/.test(text), text.slice(0, 200));
  check('his sentences land where the report reads them',
        /\*\*Goal:\*\* Signed and hangared by December\./.test(text) && /\*\*On track:\*\* Two quotes in/.test(text));
  check('the match rules are written as the registry reads them',
        /match-people: @codbe4\.example, Reid Coyle/.test(text) && /match-words: KXYZ, hangar lease/.test(text));
  check('asking for it to lead the briefs puts it last in the order, not first',
        r.focus === 1 && /^focus: 1$/m.test(text), String(r.focus));
  const back = await readProjects(dir);
  check('the registry picks it up at once', back.some((p) => p.tag === 'hangar-lease' && p.words.length === 2));
  check('and it can claim new work immediately',
        assignTag({ who: 'someone@codbe4.example', title: 'x' }, back)?.tag === 'hangar-lease');

  const refuses = async (label, args) => {
    try { await createProject(dir, args); check(`refuses ${label}`, false, 'accepted'); }
    catch (e) { check(`refuses ${label}`, true, e.message); }
  };
  await refuses('a project with no name', { name: '  ' });
  await refuses('a name that is only punctuation', { name: '???' });
  // One tag on two files is the failure the lint reports; this stops it being
  // made in the first place.
  await refuses('a tag another project already carries', { name: 'PHOA events', tag: 'phoa' });
  await refuses('a file that already exists', { name: 'Hangar lease', tag: 'hangar2' });
  const made = await createProject(dir, { name: 'Quiet thing', tag: 'quiet' });
  check('a project that does not lead gets no focus line', made.focus === null
        && !/^focus:/m.test(await readFile(join(dir, made.file), 'utf8')));
}

/* ARCHIVING A PRIORITY, AND EDITING ONE. Alex, 2026-09-21: "how do I archive
 * a priority? ... you should be able to edit an existing priority." Both were
 * file edits — `status: done` has always been honoured by readProjects and was
 * reachable only by opening the file, which is the gap the add form closed for
 * creating one. */
console.log('\narchiving a priority, and bringing it back');
{
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'proj-arch-'));
  await mkdir(join(dir, 'projects'), { recursive: true });
  const file = join(dir, 'projects', 'hangar.md');
  await writeFile(file, ['---', 'type: project', 'name: hangar', 'status: active', 'tag: hangar',
    'focus: 2', 'match-people: a@b.com', 'match-words: hangar', '---', '', '# Hangar lease', '',
    '**Goal:** Signed by December.', '', '**On track:** Waiting on the draft.', '',
    '## Decisions', '', '2026-09-01 — chose Cypress — closer.', ''].join('\n'));

  const r = await archiveProject(dir, 'hangar');
  const text = await readFile(file, 'utf8');
  check('archiving marks the file done', r.status === 'done' && /^status: done$/m.test(text), r.status);
  check('  ...and drops focus — an archived project must not lead a brief', !/^focus:/m.test(text));
  check('  ...but the file stays, decision log and all', /chose Cypress/.test(text) && /# Hangar lease/.test(text));
  check('  it is gone from the live list', (await readProjects(dir)).length === 0);
  check('  and findable when asked for', (await readProjects(dir, { includeDone: true })).length === 1);
  check('archiving twice is a no-op, not an error', (await archiveProject(dir, 'hangar')).changed === false);
  const back = await archiveProject(dir, 'hangar', { restore: true });
  check('bringing it back makes it active again', back.status === 'active' && (await readProjects(dir)).length === 1);
  check('  ...and does NOT put it back in the order — that is his pick', !/^focus:/m.test(await readFile(file, 'utf8')));
  let bad1 = null; try { await archiveProject(dir, 'nope'); } catch (e) { bad1 = e.message; }
  check('a tag no project carries is refused by name', /no project carries #nope/.test(String(bad1)), String(bad1));
}

console.log('\nediting one in place');
{
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'proj-edit-'));
  await mkdir(join(dir, 'projects'), { recursive: true });
  const file = join(dir, 'projects', 'hangar.md');
  const original = ['---', 'type: project', 'name: hangar', 'status: active', 'tag: hangar',
    'focus: 2', 'match-people: a@b.com', 'match-words: hangar', '---', '', '# Hangar lease', '',
    '**Goal:** Signed by December.', '', '**On track:** Waiting on the draft.', '',
    '## Decisions', '', '2026-09-01 — chose Cypress — closer.', ''].join('\n');
  await writeFile(file, original);

  const r = await updateProject(dir, 'hangar', { name: 'Hangar lease at Cypress', goal: 'Signed and hangared by December.', words: 'hangar, cypress' });
  const text = await readFile(file, 'utf8');
  check('the heading is rewritten', /^# Hangar lease at Cypress$/m.test(text), (text.match(/^# .*/m) ?? [])[0]);
  check('  the goal sentence too', /\*\*Goal:\*\* Signed and hangared by December\./.test(text));
  check('  and the match rules', /^match-words: hangar, cypress$/m.test(text));
  check('what was not sent is untouched', /\*\*On track:\*\* Waiting on the draft\./.test(text) && /^focus: 2$/m.test(text) && /chose Cypress/.test(text));
  check('  and it reports what it changed', JSON.stringify(r.changed) === '["name","match-words","Goal"]', JSON.stringify(r.changed));
  const same = await updateProject(dir, 'hangar', { name: 'Hangar lease at Cypress' });
  check('an edit that changes nothing writes nothing', same.changed.length === 0, JSON.stringify(same.changed));

  const p = (await readProjects(dir))[0];
  check('goal and on-track come back apart, for the form', p.goal === 'Signed and hangared by December.' && p.onTrack === 'Waiting on the draft.', JSON.stringify([p.goal, p.onTrack]));

  /* THE TAG IS NOT EDITABLE. Obligations join on it and nothing rewrites the
     ones already carrying the old one, so a rename would orphan every task
     attached to the project — silently, which is the failure mode this repo
     keeps meeting. */
  let refused = null;
  try { await updateProject(dir, 'hangar', { tag: 'hangar-lease' }); } catch (e) { refused = e.message; }
  check('renaming the tag is refused, and says why', /cannot be changed here/.test(String(refused)), String(refused));
  check('  ...and sending the SAME tag is fine — the form posts it', (await updateProject(dir, 'hangar', { tag: 'hangar', goal: 'Signed by December.' })).changed.includes('Goal'));

  // A project with no On track line yet gets one rather than losing the edit.
  await writeFile(join(dir, 'projects', 'bare.md'), ['---', 'type: project', 'tag: bare', '---', '', '# Bare', ''].join('\n'));
  await updateProject(dir, 'bare', { onTrack: 'Just started.' });
  check('a sentence the file did not have is added under the heading', /\*\*On track:\*\* Just started\./.test(await readFile(join(dir, 'projects', 'bare.md'), 'utf8')));
}

/* SUB-PROJECTS. Alex, 2026-09-30: "projects can also have sub projects, and
 * those sub projects can have tasks." */
console.log('\nsub-projects');
{
  const dir = await mkdtemp(join(tmpdir(), 'obligations-sub-'));
  await mkdir(join(dir, 'projects'), { recursive: true });
  await createProject(dir, { name: 'ONE renovation', tag: 'one', words: ['ONE Springfield'] });
  const k = await createProject(dir, { name: 'Kitchen', parent: 'one', words: ['cabinetry'] });
  const all = await readProjects(dir);
  check('a sub-project is a project file that names its parent', k.parent === 'one' && all.find((p) => p.tag === 'kitchen')?.parent === 'one',
        JSON.stringify(all.map((p) => [p.tag, p.parent])));
  check('  ...and a top-level project has none', all.find((p) => p.tag === 'one')?.parent === null);
  let err = null; try { await createProject(dir, { name: 'Hinges', parent: 'kitchen' }); } catch (e) { err = e.message; }
  check('one level deep: a sub-project cannot have its own', /one level deep/.test(err ?? ''), err);
  err = null; try { await createProject(dir, { name: 'Orphan', parent: 'nope' }); } catch (e) { err = e.message; }
  check('a parent that does not exist is refused', /no active project #nope/.test(err ?? ''), err);
  const both = assignTag({ title: 'ONE Springfield cabinetry bid' }, all);
  check('a match on a sub-project and its parent is the sub-project, not a tie', both?.tag === 'kitchen', JSON.stringify(both));
  check('  ...and a match on the parent alone is the parent', assignTag({ title: 'ONE Springfield permit' }, all)?.tag === 'one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
