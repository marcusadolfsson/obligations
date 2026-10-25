/**
 * The contracts, checked against the LIVE files.
 *
 * Not against fixtures. A fixture is a story about the data; these are the data.
 * The bug this exists for passed its own test for weeks because the fixture
 * wrote `type: brief` — a shape nothing has ever produced — so the test agreed
 * with the code and both were wrong about the file on disk.
 *
 * Advisory fields are reported and never failed: a field being rolled out should
 * be visible as a migration in progress, not a red build.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, checkValue, frontmatter } from '../contract.mjs';

/* The repo root. OBLIGATIONS wins where it is set — the container sets it — but the
   fallback is derived from this file's own location rather than the container's
   mount point. It used to default to the literal '/obligations', so running this on
   the host died with a raw ENOENT stack for a path that exists nowhere on that
   machine. A guard people cannot run outside the container is a guard people
   stop running. This file sits at <repo>/deploy/agent-service/, so ../.. is the
   root in both places. */
const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };

/** Check many records against one spec; report the first few failures only. */
function checkAll(label, records, spec, { advisory = {}, requiredAny = [] } = {}) {
  const errs = [], soft = new Map();
  for (const [id, rec] of records) {
    for (const [field, s] of Object.entries(spec)) {
      const e = checkValue(s, rec?.[field]);
      if (e) errs.push(`${id}: ${field} ${e}`);
    }
    for (const group of requiredAny) {
      if (!group.some((f) => rec?.[f])) errs.push(`${id}: none of ${group.join('/')} present`);
    }
    for (const [field, s] of Object.entries(advisory)) {
      if (checkValue(s, rec?.[field])) soft.set(field, (soft.get(field) ?? 0) + 1);
    }
  }
  if (!records.length) { ok(`${label}: nothing on disk to check`); return; }
  if (errs.length) bad(`${label} (${records.length} records)`, errs.slice(0, 3).join(' · '));
  else ok(`${label}: ${records.length} records match the contract`);
  for (const [field, n] of soft) {
    console.log(`  note ${label}: ${n}/${records.length} missing advisory \`${field}\` — `
      + (advisory[field].why ?? 'rolling out'));
  }
}

const load = async (rel) => JSON.parse(await readFile(join(OBLIGATIONS, rel), 'utf8'));

console.log('Live artifacts against deploy/contract.mjs');

/* ---------------------------------------------------------------- messages */
{
  const c = CONTRACTS.message;
  const recs = [];
  try {
    for (const name of (await readdir(join(OBLIGATIONS, 'messages'))).filter((n) => n.endsWith('.md'))) {
      const fm = frontmatter(await readFile(join(OBLIGATIONS, 'messages', name), 'utf8'));
      if (fm) recs.push([name, fm]);
      else bad(`messages/${name}: no frontmatter block`);
    }
  } catch { /* directory absent */ }
  checkAll('message frontmatter', recs, c.required);
}

/* ------------------------------------------------------------- conclusions */
{
  const c = CONTRACTS.conclusion;
  let threads = [];
  try { threads = (await load(c.file)).threads ?? []; } catch { /* absent */ }
  checkAll('email-state threads',
           threads.map((t) => [t.thread_id ?? '(no id)', t]), c.required,
           { advisory: c.advisory });
  const withConc = threads.filter((t) => t.conclusion);
  checkAll('  their conclusions',
           withConc.map((t) => [t.thread_id, t.conclusion]), c.nested.conclusion.required,
           { advisory: c.nested.conclusion.advisory,
             requiredAny: c.nested.conclusion.requiredAny });
}

/* ----------------------------------------------------------- extract threads */
{
  const c = CONTRACTS.extractThread;
  let threads = [];
  try { threads = (await load(c.file)).threads ?? []; } catch { /* absent */ }
  checkAll('extract threads', threads.map((t) => [t.thread_id ?? '(no id)', t]), c.required);
}

/* -------------------------------------------------------------- job records */
{
  const c = CONTRACTS.jobRun;
  let runs = {};
  try { runs = await load(c.file); } catch { /* absent */ }
  checkAll('job runs', Object.entries(runs), c.required);
}

/* ------------------------ the specific drift that cost every push ---------- */
{
  // Two parsers read this format. Assert they agree about which field carries
  // brief/note/failure, because when they disagreed nothing was delivered.
  const py = await readFile(join(OBLIGATIONS, 'deploy', 'reminder-dispatch.py'), 'utf8');
  const js = await readFile(join(OBLIGATIONS, 'deploy', 'agent-service', 'messages.mjs'), 'utf8');
  const pyReadsKind = /fields\.get\(["']kind["']\)/.test(py);
  const jsReadsKind = /kind/.test(js);
  if (pyReadsKind && jsReadsKind) ok('both frontmatter parsers read `kind`, not `type`');
  else bad('a frontmatter parser reads the wrong field',
           `dispatch=${pyReadsKind ? 'kind' : 'NOT kind'} messages.mjs=${jsReadsKind ? 'kind' : 'NOT kind'}`);
}

// Every JSON contract through the walker the CLI uses, so a contract added for
// the CLI cannot quietly go unchecked by the suite — and so the two never grow
// separate ideas of what the same spec means.
console.log('\nEvery JSON contract, through checkFile()');
{
  const { checkFile, CONTRACTS } = await import('../contract.mjs');
  for (const [name, spec] of Object.entries(CONTRACTS)) {
    if (spec.kind !== 'json') continue;
    try {
      const r = await checkFile(OBLIGATIONS, name);
      if (r.absent) ok(`${name}: ${spec.file} absent — optional, nothing on disk yet`);
      else if (r.ok) ok(`${name}: ${r.records} live record(s) in ${spec.file}`);
      else bad(`${name} (${r.records} records)`, r.errors.slice(0, 3).join(' · '));
    } catch (err) {
      // A fresh checkout has no runtime files yet; the host that runs the service does.
      if (err?.code === 'ENOENT') ok(`${name}: ${spec.file} not on disk yet (fresh checkout)`);
      else bad(`${name} could not be checked`, String(err.message));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
