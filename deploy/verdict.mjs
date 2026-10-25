#!/usr/bin/env node
/**
 * Record one of Alex's judgement calls, so the next run makes the same one.
 *
 * Alex, 2026-09-05, re-audit: "It doesn't learn your judgement. When you
 * correct a verdict in chat — 'that's not a task', 'these are separate people' —
 * it becomes a rule edit if I'm here, or nothing." Today's Kyle Porter fix is
 * the pattern: a real correction, encoded as a code change and a test, which
 * does not scale.
 *
 * rules/verdicts.md is the answer: one line per call, in his words or close to
 * them, with the reason. Every job and both triage skills read it before they
 * judge anything, and a verdict outranks the prose in rules/*.md where the two
 * disagree — the prose is what we thought the rule was; the verdict is what he
 * actually decided about a real case.
 *
 * Append-only, like the journal and the logbook. A verdict that turns out wrong
 * gets a later verdict that says so; the first is not edited. That is what makes
 * "why did the assistant start doing X on the 5th?" answerable.
 *
 *   node deploy/verdict.mjs <scope> "<the call>" "<why>"
 *   node deploy/verdict.mjs --list [scope[,scope]]
 *
 * scope is one of: mail · message · people · decision · calendar · brief · ui
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRepoLock } from './agent-service/lock.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fileOf = (vault) => join(vault, 'rules', 'verdicts.md');   // per call: a module constant ignored `obligations` and the tests appended to the live file
export const SCOPES = ['mail', 'message', 'people', 'decision', 'calendar', 'brief', 'ui', 'general'];

const HEADER = `# Verdicts

Alex's judgement calls on real cases, one per line, newest last. **Read this
before judging anything.** Where a line here disagrees with the prose in another
rules file, the line wins — the prose is what we thought the rule was; the
verdict is what he decided about a case in front of him.

Append-only. A wrong verdict gets a later line that says so; nothing here is
edited. Written by \`deploy/verdict.mjs\`, in the same turn he says it.

Format: \`- YYYY-MM-DD | scope | the call | why\`

`;

/** Parse the file. Exported for the tests and for anything that wants them typed. */
export function parseVerdicts(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*\|\s*([a-z]+)\s*\|\s*([^|]+?)\s*(?:\|\s*(.*\S))?\s*$/);
    if (m) out.push({ date: m[1], scope: m[2], call: m[3], why: m[4] ?? '' });
  }
  return out;
}

export async function record(vault, scope, call, why = '') {
  scope = String(scope ?? '').toLowerCase().trim();
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  if (!String(call ?? '').trim()) throw new Error('the call is required');
  const clean = (s) => String(s).replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim();   // pipes are the separator
  const date = new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const line = `- ${stamp} | ${scope} | ${clean(call)}${why ? ` | ${clean(why)}` : ''}`;
  await withRepoLock(vault, async () => {
    let text;
    try { text = await readFile(fileOf(vault), 'utf8'); } catch { text = HEADER; }
    await writeFile(fileOf(vault), text.trimEnd() + '\n' + line + '\n');
  });
  return { line };
}

export async function verdicts(vault = OBLIGATIONS, scope = null) {
  let text;
  try { text = await readFile(join(vault, 'rules', 'verdicts.md'), 'utf8'); } catch { return []; }
  const all = parseVerdicts(text);
  // One scope, a comma list, or an array: `--list mail,general` is what a
  // triage reads, so it never loads the brief's and the people page's calls.
  const want = Array.isArray(scope) ? scope : String(scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return want.length ? all.filter((v) => want.includes(v.scope)) : all;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  try {
    if (a[0] === '--list') {
      const vs = await verdicts(OBLIGATIONS, a[1] ?? null);
      for (const v of vs) console.log(`${v.date}  [${v.scope}]  ${v.call}${v.why ? `\n            — ${v.why}` : ''}`);
      if (!vs.length) console.log('no verdicts recorded');
    } else if (a.length >= 2) {
      console.log((await record(OBLIGATIONS, a[0], a[1], a[2] ?? '')).line);
    } else {
      console.error('usage: verdict.mjs <scope> "<call>" "<why>"   |   verdict.mjs --list [scope]');
      process.exit(2);
    }
  } catch (err) { console.error(`verdict: ${err.message}`); process.exit(1); }
}
