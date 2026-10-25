/**
 * The lint, against fixtures and against the live repo.
 *
 * Alex, 2026-09-10, from Karpathy's LLM-wiki gist. The rule it enforces has
 * been in CLAUDE.md since the beginning — when a person file and the journal
 * disagree, the journal is right — and nothing had ever checked it.
 *
 * What these tests are really about is FALSE POSITIVES. A lint runs weekly and
 * he either acts on it or learns to skim it, and the first draft earned exactly
 * that: it called his own home four rare places, reported a project that is in
 * every brief this week as cold, and declared three live cabinet vendors dead
 * because an unrelated thread of theirs had been closed. Every negative case
 * below is one of those.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stalePeople, deadOptions, coldProjects, brokenLinks, projectRegistry, lint, front } from '../lint.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

/** A repo with just enough in it to answer one question. */
async function fixture({ people = {}, journal = {}, projects = {}, decisions = null, now = null } = {}) {
  const vault = await mkdtemp(join(tmpdir(), 'lint-'));
  for (const d of ['people', 'journal', 'projects']) await mkdir(join(vault, d), { recursive: true });
  for (const [f, body] of Object.entries(people)) await writeFile(join(vault, 'people', f), body);
  for (const [f, body] of Object.entries(journal)) await writeFile(join(vault, 'journal', f), body);
  for (const [f, body] of Object.entries(projects)) await writeFile(join(vault, 'projects', f), body);
  if (decisions !== null) await writeFile(join(vault, 'decisions.md'), decisions);
  return vault;
}
const person = (name, last) => `---\ntype: person\nname: ${name}\nlast-contact: ${last}\n---\n\n# ${name}\n`;

console.log('frontmatter');
{
  const { meta } = front('---\ntype: person\nname: Ada\n---\n\nbody\n');
  check('parses the shape every file here uses', meta.name === 'Ada' && meta.type === 'person');
  check('a file with no frontmatter does not throw', front('just text').meta.name === undefined);
}

console.log('\npeople the journal has seen more recently than their own file');
{
  const vault = await fixture({
    people: { 'a.md': person('Joel Hartman', '2026-08-28'), 'b.md': person('Ada Lovelace', '2026-09-09') },
    journal: { '2026-09-09.md': 'Joel Hartman called about the Icon keys. Ada Lovelace too.' },
  });
  const out = await stalePeople(vault);
  check('the one that drifted is reported', out.length === 1, JSON.stringify(out.map((o) => o.who)));
  check('  ...and it is the right one', out[0]?.who === 'Joel Hartman');
  check('a file that is already current is not', !out.some((o) => o.who === 'Ada Lovelace'));
  check('it says what the file claims and what the journal shows',
        out[0]?.said === '2026-08-28' && out[0]?.should === '2026-09-09');
}
{
  // The file can be AHEAD of the journal — he saw them and no entry was
  // written yet — and that is not a defect this can judge.
  const vault = await fixture({
    people: { 'a.md': person('Ada', '2026-09-20') },
    journal: { '2026-09-09.md': 'Ada came by.' },
  });
  check('a file ahead of the journal is left alone', (await stalePeople(vault)).length === 0);
}
{
  const vault = await fixture({
    people: { 'a.md': person('Ada', '2026-09-01') },
    journal: { '2026-09-09.md': 'nothing about anyone in particular' },
  });
  check('someone the journal never mentions is not chased', (await stalePeople(vault)).length === 0);
}

console.log('\nprojects nothing points at');
{
  const proj = (name, status = 'active') => `---\ntype: project\nname: ${name}\nstatus: ${status}\n---\n`;
  const vault = await fixture({
    projects: { 'phoa-crm.md': proj('phoa-crm'), 'dead.md': proj('Rewiring the shed'), 'old.md': proj('Finished thing', 'done') },
    journal: { '2026-09-09.md': 'More PHOA registration work today.' },
  });
  const out = await coldProjects(vault);
  // The failure that mattered: the journal writes PHOA, the file is phoa-crm.
  check('a project named in the journal by part of its name is not cold',
        !out.some((o) => /phoa/i.test(o.who)), JSON.stringify(out.map((o) => o.who)));
  check('one nothing mentions is', out.some((o) => /shed/i.test(o.who)));
  check('one already marked done is left alone', !out.some((o) => /Finished/i.test(o.who)));
}

console.log('\noptions that are settled but still offered');
{
  const decisions = '## Cabinets  !due:2026-09-12  #one\n'
    + '- options: Crestline — $79,059 · MWC Millwork — $220,717 · WITHDRAWN: Someone Else — gone\n';
  const vault = await fixture({ decisions });
  const out = await deadOptions(vault);
  // With no obligations at all nothing can be settled, which is the point:
  // being closed is not enough, the OUTCOME has to say the option is out.
  check('nothing is called dead without an outcome saying so', out.length === 0, JSON.stringify(out));
  check('an option already marked WITHDRAWN is the fixed state, not a finding',
        !out.some((o) => /Someone Else/.test(o.said)));
}

console.log('\nreferences to files that are not there');
{
  const vault = await fixture({ decisions: 'see people/ada.md and people/ghost.md\n',
                                people: { 'ada.md': person('Ada', '2026-09-09') } });
  const out = await brokenLinks(vault);
  check('a path that does not resolve is reported', out.some((o) => /ghost/.test(o.who)), JSON.stringify(out));
  check('a path that does is not', !out.some((o) => /ada/.test(o.who)));
}

console.log('\nthe registry against itself');
{
  const vault = await mkdtemp(join(tmpdir(), 'lint-reg-'));
  await mkdir(join(vault, 'projects'), { recursive: true });
  await mkdir(join(vault, 'integrations'), { recursive: true });
  const put = (n, front_) => writeFile(join(vault, 'projects', `${n}.md`), `---\n${front_}\n---\n\n# ${n}\n\n**Goal:** x.\n`);
  // One tag on two files: whichever is read last wins, and nothing says so.
  await put('phoa-crm', 'type: project\nname: phoa-crm\nstatus: active\ntag: phoa');
  await put('phoa-events', 'type: project\nname: phoa-events\nstatus: active\ntag: phoa');
  // Leads the briefs, but nothing can join it.
  await put('vague', 'type: project\nname: vague\nstatus: active\nfocus: 2');
  // Leads the briefs with nothing open under it.
  await put('quiet', 'type: project\nname: quiet\nstatus: active\ntag: quiet\nfocus: 1');
  await writeFile(join(vault, 'todo.md'), '# Todo\n\n## Now\n\n- [ ] something #phoa !since:2026-09-01\n');

  const out = await projectRegistry(vault);
  check('two projects claiming one tag is reported', out.some((f) => /#phoa/.test(f.who) && /whichever file is read last/.test(f.why)),
        JSON.stringify(out));
  check('a focus project with no tag is reported', out.some((f) => /vague/.test(f.who) && /nothing can be joined/.test(f.why)));
  check('a focus project with nothing open is reported', out.some((f) => /quiet/.test(f.who) && /nothing moved/.test(f.why)));
  check('a project that is merely not a focus is not reported',
        !out.some((f) => /phoa-crm/.test(f.who) && /nothing moved/.test(f.why)));
  check('every finding still names a file and says why', out.every((f) => f.file && f.why));
}

/* Against the real repo. A lint that only works on fixtures is the failure
 * contract.mjs was written for. */
console.log('\nthe live repo');
{
  const r = await lint(OBLIGATIONS);
  const real = r.findings.filter((f) => f.kind !== 'BLIND');
  check('it runs over the real files without throwing', Array.isArray(r.findings));
  check('every finding names a file and says why',
        real.every((f) => f.file && f.why), JSON.stringify(real.filter((f) => !f.file || !f.why)));
  check('nothing it cannot read is reported silently',
        r.blind.every((b) => typeof b === 'string' && b.length));
  console.log(`  note ${real.length} thing(s) have drifted in the live repo`
    + (r.blind.length ? `, ${r.blind.length} not checked` : ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
