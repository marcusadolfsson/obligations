#!/usr/bin/env node
/**
 * The one way to write decisions.md.
 *
 * Alex, 2026-09-05, re-audit: "Decisions aren't detected, only recorded. The
 * cabinet decision exists because I wrote it. Five vendor threads arrived over
 * three weeks and the triage judged each as a debt; none of them said 'this is
 * one choice with five options.'"
 *
 * The triage now recognises a choice-in-progress (see the email-triage skill)
 * and records it through this door rather than by hand-editing markdown — so
 * every entry has the same shape, `sources/decisions.mjs` can always parse it,
 * and an option added from a second thread lands under the SAME heading instead
 * of starting a rival one.
 *
 *   node deploy/decide.mjs list
 *   node deploy/decide.mjs add --title "Cabinetry vendor" --option "MWC $220k" \
 *        --option "Summitline (install incl.)" --blocked "comparable totals" \
 *        --due 2026-09-12 --tag one [--recommend "..."]
 *   node deploy/decide.mjs option "Cabinetry vendor" "Quality Cabinets Co — proposal in"
 *   node deploy/decide.mjs due "Cabinetry vendor" 2026-09-18   # or `none` to defer
 *   node deploy/decide.mjs decide "Cabinetry vendor" --outcome "Summitline — firm number came in"
 *
 * `decide` is the close: the same `decided:` line close.mjs writes, so a decision
 * made in chat and one made by the job leave the same record.
 */
import { localStamp } from './agent-service/time.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDecisions, decisionId } from './agent-service/sources/decisions.mjs';
import { withRepoLock } from './agent-service/lock.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fileOf = (vault) => join(vault, 'decisions.md');   // per call — a module constant ignored the `obligations` argument and the tests wrote into the live file
const argv = process.argv.slice(2);
const flags = (name) => argv.flatMap((a, i) => (a === '--' + name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const flag = (name) => flags(name)[0] ?? null;

const HEADER = `# Decisions

Choices waiting on Alex. Not debts — nobody is owed these. Written through
\`deploy/decide.mjs\` so every entry parses; read by \`sources/decisions.mjs\` into the
task list tagged \`decision\`. A \`decided:\` line closes one; the section stays as
the record of why.
`;

async function load(vault) {
  try { return await readFile(fileOf(vault), 'utf8'); } catch { return HEADER; }
}

/** Find a heading by title or id; returns [start, end) line indexes or null. */
function locate(lines, ref) {
  const want = ref.startsWith('decision:') ? ref : decisionId(ref);
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!h) continue;
    const title = h[1].replace(/\s*!due:\d{4}-\d{2}-\d{2}\b/, '').replace(/(?:^|\s)#[^\s@#!]+/, '').trim();
    if (decisionId(title) === want) {
      let end = i + 1;
      while (end < lines.length && !/^##\s/.test(lines[end])) end++;
      return [i, end];
    }
  }
  return null;
}

export async function add(vault, { title, options = [], recommend = null, blocked = null, due = null, tag = null, note = null, supersede = false }) {
  if (!title?.trim()) throw new Error('--title is required');
  let result;
  await withRepoLock(vault, async () => {
    const text = await load(vault);
    const lines = text.split('\n');
    const where = locate(lines, title);
    if (where) {
      // Already a decision: merge options rather than start a rival heading.
      const [s, e] = where;
      const block = lines.slice(s, e);
      const optIdx = block.findIndex((l) => /^\s*[-*]\s+options\s*:/i.test(l));
      const existing = optIdx >= 0 ? block[optIdx].replace(/^\s*[-*]\s+options\s*:\s*/i, '').split(/\s+·\s+/).map((x) => x.trim()) : [];
      // `supersede` replaces the option list rather than adding to it.
      //
      // Alex, 2026-09-10. Options do not only accumulate, they go stale: MWC
      // withdrew, Nook declined, Studio expired. Merging a fresh comparison
      // into the old list left eleven options including a withdrawn vendor
      // still carrying the highest number, which is worse than either list
      // alone — he would have read it as a live bid. Use it when a comparison
      // supersedes what was there; the old list survives in git, which is
      // where superseded things belong.
      const merged = supersede ? options : [...existing, ...options.filter((o) => !existing.includes(o))];
      const optLine = `- options: ${merged.join(' · ')}`;
      if (optIdx >= 0) block[optIdx] = optLine; else block.splice(1, 0, optLine);
      if (recommend) { const i = block.findIndex((l) => /^\s*[-*]\s+recommend\s*:/i.test(l)); const l = `- recommend: ${recommend}`; if (i >= 0) block[i] = l; else block.splice(2, 0, l); }
      if (blocked) { const i = block.findIndex((l) => /^\s*[-*]\s+blocked\s*:/i.test(l)); const l = `- blocked: ${blocked}`; if (i >= 0) block[i] = l; else block.splice(2, 0, l); }
      lines.splice(s, e - s, ...block);
      result = { merged: true, title, options: merged.length };
    } else {
      const head = `## ${title.trim()}${due ? `  !due:${due}` : ''}${tag ? `  #${tag.replace(/^#/, '')}` : ''}`;
      const block = [head, `- options: ${options.join(' · ')}`];
      if (recommend) block.push(`- recommend: ${recommend}`);
      if (blocked) block.push(`- blocked: ${blocked}`);
      if (note) block.push(`- ${note}`);
      const out = text.trimEnd() + '\n\n' + block.join('\n') + '\n';
      await writeFile(fileOf(vault), out);
      result = { merged: false, title, options: options.length };
      return;
    }
    await writeFile(fileOf(vault), lines.join('\n'));
  });
  return result;
}

/**
 * Move a decision's `!due:`, or take it off. The heading's title is the id, so
 * it survives either way.
 *
 * `none` clears the date instead of setting one. Alex, 2026-09-12: "delay
 * cabinet decision indefinitely, we need to get permitting back on track." A
 * decision deferred with no new date is a real state — it is still a choice he
 * has to make, it simply has no deadline — and the alternative was inventing a
 * date nobody meant, which is how a list stops being believed.
 *
 * Takes the repo lock, like `add` and `decide`. It did not, and two writers on
 * one heading would have lost one of them.
 */
export async function setDue(vault, ref, due) {
  const raw = String(due ?? '').trim().toLowerCase();
  const clearing = raw === 'none' || raw === '' || raw === 'indefinite';
  const d = String(due ?? '').slice(0, 10);
  if (!clearing && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))) {
    throw new Error('due must be YYYY-MM-DD, or `none` to defer indefinitely');
  }
  let result;
  await withRepoLock(vault, async () => { result = await setDueLocked(vault, ref, due); });
  return result;
}

/**
 * The same move, for a caller that ALREADY holds the repo lock.
 *
 * Found 2026-09-14. On 09-12 the midday brief job added clearing a date here and
 * wrapped setDue in the repo lock "like add and decide" — right for a direct
 * `node deploy/decide.mjs due …`, and wrong for the Move due button, whose
 * path through obligations.mjs takes the lock first and then calls in. The lock
 * is not re-entrant, so the second acquire waited out its timeout and threw
 * "repo is busy; try again". Moving a decision's date from To Do has failed
 * since that commit, and the obligations suite said so in red for two days
 * without anyone running it.
 */
export async function setDueLocked(vault, ref, due) {
  const raw = String(due ?? '').trim().toLowerCase();
  const clearing = raw === 'none' || raw === '' || raw === 'indefinite';
  const d = String(due ?? '').slice(0, 10);
  if (!clearing && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))) {
    throw new Error('due must be YYYY-MM-DD, or `none` to defer indefinitely');
  }
  const lines = (await load(vault)).split('\n');
  const at = locate(lines, ref);
  if (!at) throw new Error('no decision with that id');
  const h = lines[at[0]];
  const was = (h.match(/!due:(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null;
  lines[at[0]] = clearing
    ? h.replace(/\s*!due:\d{4}-\d{2}-\d{2}/, '')
    : /!due:\d{4}-\d{2}-\d{2}/.test(h)
      ? h.replace(/!due:\d{4}-\d{2}-\d{2}/, `!due:${d}`)
      : h.replace(/(\s+#[^\s@#!]+)?\s*$/, (tag) => `  !due:${d}${tag ? tag : ''}`);
  await writeFile(fileOf(vault), lines.join('\n'));
  return { ref, was, due: clearing ? null : d };
}

export async function addOption(vault, ref, option) {
  return add(vault, { title: ref, options: [option] });
}

export async function decide(vault, ref, outcome) {
  if (!outcome?.trim()) throw new Error('--outcome is required: say what was chosen and why');
  let result;
  await withRepoLock(vault, async () => {
    const lines = (await load(vault)).split('\n');
    const where = locate(lines, ref);
    if (!where) { result = { decided: false, why: 'no such decision' }; return; }
    const [s, e] = where;
    if (lines.slice(s, e).some((l) => /^\s*[-*]\s+decided\s*:/i.test(l))) { result = { decided: false, why: 'already decided' }; return; }
    let at = e; while (at > s + 1 && !lines[at - 1].trim()) at--;
    // His day, not UTC's (2026-09-30: after 20:00 in the state this wrote tomorrow).
    lines.splice(at, 0, `- decided: ${localStamp().slice(0, 10)} ${outcome.trim()}`);
    await writeFile(fileOf(vault), lines.join('\n'));
    result = { decided: true };
  });
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = argv[0];
  try {
    if (cmd === 'list' || !cmd) {
      const ds = parseDecisions(await load(OBLIGATIONS)).filter((d) => !/^Title\b/.test(d.title));
      for (const d of ds) console.log(`${d.decided ? '✓' : '?'} ${d.title}${d.due ? `  (by ${d.due})` : ''}\n    ${d.options.length} options${d.recommend ? ` · → ${d.recommend}` : ''}${d.blocked ? ` · blocked: ${d.blocked}` : ''}${d.decided ? ` · decided ${d.decided}` : ''}`);
      if (!ds.length) console.log('no decisions recorded');
    } else if (cmd === 'add') {
      console.log(JSON.stringify(await add(OBLIGATIONS, { title: flag('title'), options: flags('option'), recommend: flag('recommend'), blocked: flag('blocked'), due: flag('due'), tag: flag('tag'), note: flag('note'), supersede: process.argv.includes('--supersede') })));
    } else if (cmd === 'option') {
      console.log(JSON.stringify(await addOption(OBLIGATIONS, argv[1], argv[2])));
    } else if (cmd === 'due') {
      console.log(JSON.stringify(await setDue(OBLIGATIONS, argv[1], argv[2])));
    } else if (cmd === 'decide') {
      console.log(JSON.stringify(await decide(OBLIGATIONS, argv[1], flag('outcome'))));
    } else {
      console.error('usage: decide.mjs list | add --title … --option … | option <title> <text> | due <title> <YYYY-MM-DD|none> | decide <title> --outcome …');
      process.exit(2);
    }
  } catch (err) { console.error(`decide: ${err.message}`); process.exit(1); }
}
