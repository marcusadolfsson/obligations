#!/usr/bin/env node
/**
 * Does the derived layer still agree with the sources it came from?
 *
 * Alex, 2026-09-10, reading Karpathy's LLM-wiki gist and asking what this
 * repo could take from it. Almost everything in it is already here — raw
 * sources the agent never edits, a derived layer it owns, a schema in
 * CLAUDE.md — with one exception. The gist has a **lint**, and this repo has
 * four guards none of which look at the derived layer at all. `contract.mjs`
 * checks shapes. `brief-audit.mjs` checks a written brief against the record.
 * `conflicts.mjs` reads obligations across sources. Nothing has ever asked
 * whether `people/`, `projects/`, `decisions.md` and `now.md` still agree with
 * the journal — although CLAUDE.md states the rule outright: when a person
 * file and the journal disagree, the journal is right and the file needs
 * fixing. The rule existed with no mechanism.
 *
 * The case that proved it, the same day: the cabinetry decision said only one
 * vendor had a total on record, when six did and that one had withdrawn weeks
 * before. Nothing was broken. A derived file had drifted and no surface could
 * tell.
 *
 * Everything here is arithmetic — a date against a date, a name against a
 * list, a path against the filesystem. Contradictions in prose stay with the
 * Sunday compaction, where judgement already lives. It is READ-ONLY: it
 * reports and changes nothing, because deciding that a person file is wrong is
 * not the same as knowing what it should say.
 *
 *   node deploy/lint.mjs           what has drifted
 *   node deploy/lint.mjs --json
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listObligations } from './agent-service/obligations.mjs';
import { localStamp } from './agent-service/time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const ms = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };
const days = (a, b) => Math.round((b - a) / DAY);

/** Frontmatter, the same shape every file here uses. */
export function front(text) {
  const m = String(text ?? '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text ?? '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

const read = async (vault, rel) => { try { return await readFile(join(vault, rel), 'utf8'); } catch { return null; } };
const listMd = async (vault, dir) => {
  try { return (await readdir(join(vault, dir))).filter((f) => f.endsWith('.md') && !f.startsWith('_')); }
  catch { return []; }
};

/**
 * A person the journal has seen more recently than their own file says.
 *
 * The journal is authoritative by CLAUDE.md's first write rule, so this is the
 * one direction that is always a defect: the file cannot be ahead of the
 * source it derives from, and if it is behind, the last-contact date in it is
 * a fact that has quietly expired.
 *
 * Matching is on the person's NAME in the journal text, which is coarse on
 * purpose — a false positive costs him a glance, and the alternative is a
 * name-resolution layer that would itself need a lint.
 */
export async function stalePeople(vault = OBLIGATIONS, { now = Date.now(), slack = 2 } = {}) {
  const journals = (await listMd(vault, 'journal')).sort();
  // Every journal day read once, not once per person: 21 people against 15
  // days was 315 reads of the same files for an answer that needs 15.
  const byDay = new Map();
  for (const f of journals) byDay.set(f.slice(0, 10), ((await read(vault, join('journal', f))) ?? '').toLowerCase());
  const out = [];
  for (const f of await listMd(vault, 'people')) {
    const { meta } = front((await read(vault, join('people', f))) ?? '');
    const name = (meta.name ?? '').trim();
    if (!name) continue;
    let newest = null;
    for (const [day, body] of byDay) if (body.includes(name.toLowerCase())) newest = day;
    if (!newest) continue;
    const last = (meta['last-contact'] ?? '').trim();
    // No date at all is worth saying once: the file has been written but never
    // dated, so nothing downstream can tell how cold the relationship is.
    if (!last) { out.push({ kind: 'PERSON', file: `people/${f}`, who: name, said: 'no last-contact', should: newest, why: 'the journal mentions them and the file carries no date at all' }); continue; }
    if (ms(newest) > ms(last) + slack * DAY) {
      out.push({ kind: 'PERSON', file: `people/${f}`, who: name, said: last, should: newest,
                 why: `the journal has them on ${newest}, ${days(ms(last), ms(newest))} days after the file's own date` });
    }
  }
  return out;
}

/**
 * A decision still offering an option that is settled.
 *
 * The cabinetry case: MWC's estimate was the headline number in `decisions.md`
 * for a week after its thread had been closed as withdrawn. A live decision
 * carrying a dead option is worse than an out-of-date list, because he reads
 * it as a bid he could still take.
 */
/** The words a close uses when an option is out, not merely dealt with. */
const SETTLED = /\b(withdrew|withdrawn|declined|dropped|out of the (comparison|running)|no longer (in|a)|not proceeding|cannot match|chose|chosen)\b/i;

export async function deadOptions(vault = OBLIGATIONS) {
  const text = (await read(vault, 'decisions.md')) ?? '';
  const closed = (await listObligations(vault)).filter((o) => !o.open);
  const out = [];
  let heading = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*(?:!due:|#|$)/);
    if (h) { heading = h[1].trim(); continue; }
    if (!heading || !/^- options:/i.test(line)) continue;
    for (const opt of line.replace(/^- options:\s*/i, '').split('·')) {
      const name = opt.trim().split(/[—\-–(]/)[0].trim();
      if (name.length < 4) continue;
      // Already marked as settled in the text itself is the fixed state, not a defect.
      if (/^(WITHDRAWN|DECLINED|NO QUOTE|CHOSEN)/i.test(opt.trim())) continue;
      // A vendor having SOME closed thread proves nothing — they have many, and
      // the first version flagged Crestline, Quality and ARKO as dead because a
      // Zoom-link thread and an old quote had been closed. What settles an
      // option is the outcome saying so, in the words a close actually uses.
      const hit = closed.find((o) => {
        const hay = `${o.title} ${o.what ?? ''}`.toLowerCase();
        if (!hay.includes(name.toLowerCase())) return false;
        return SETTLED.test(String(o.outcome ?? ''));
      });
      if (hit) {
        out.push({ kind: 'OPTION', file: 'decisions.md', who: heading, said: name,
                   should: 'marked settled, or removed',
                   why: `"${name}" is still offered as an option, and its obligation closed: ${String(hit.outcome ?? '').slice(0, 90) || hit.title}` });
      }
    }
  }
  return out;
}

/**
 * A project file nothing points at any more.
 *
 * `projects-propose.mjs` does the opposite — clusters of obligations with no
 * project file. This is the other direction, and neither alone tells him the
 * page is dead: a project with no open obligation, no journal mention and no
 * calendar entry for a month is either finished and unmarked, or abandoned.
 */
export async function coldProjects(vault = OBLIGATIONS, { now = Date.now(), quiet = 30 } = {}) {
  const open = (await listObligations(vault)).filter((o) => o.open);
  const journals = (await listMd(vault, 'journal')).sort().slice(-quiet);
  const recent = (await Promise.all(journals.map((f) => read(vault, join('journal', f)))))
    .filter(Boolean).join('\n').toLowerCase();
  const out = [];
  for (const f of await listMd(vault, 'projects')) {
    const { meta } = front((await read(vault, join('projects', f))) ?? '');
    if ((meta.status ?? '').trim() === 'done') continue;
    const name = (meta.name ?? f.replace(/\.md$/, '')).trim();
    const slug = f.replace(/\.md$/, '');
    // Match on the parts, not the whole string. The journal writes "PHOA";
    // the file is `phoa-crm.md` with `name: phoa-crm`. Requiring the whole
    // name reported a project that is in every brief this week as cold, which
    // is the failure mode that matters here — a lint nobody trusts is worse
    // than no lint, because it trains him to skim the list.
    const words = [...new Set(`${name} ${slug}`.toLowerCase().split(/[\s\-_]+/))]
      .filter((w) => w.length >= 4);
    if (!words.length) continue;
    const mentions = (hay) => words.some((w) => hay.includes(w));
    if (open.some((o) => mentions(`${o.title} ${o.what ?? ''} ${(o.tags ?? []).join(' ')}`.toLowerCase()))) continue;
    if (mentions(recent)) continue;
    out.push({ kind: 'PROJECT', file: `projects/${f}`, who: name, said: meta.status ?? 'active',
               should: 'done, paused, or archived',
               why: `no open obligation names it and the last ${journals.length} journal days do not mention it` });
  }
  return out;
}

/**
 * The registry against itself. Since 2026-09-16 a project file carries the tag
 * everything joins on and the `focus:` line that makes it a priority, so the
 * ways it can quietly stop working are worth checking every week:
 *
 *   - two projects claiming one tag — whichever is read last wins, silently;
 *   - a focus project with no tag, which leads a brief that can hold nothing;
 *   - a focus project with nothing open, which reports "nothing moved" forever.
 *
 * The last one is not always wrong — a quiet week is a quiet week — so it says
 * what it saw rather than what to do.
 */
export async function projectRegistry(vault = OBLIGATIONS) {
  const { readProjects } = await import('./agent-service/projects.mjs');
  const projects = await readProjects(vault);
  const open = (await listObligations(vault)).filter((o) => o.open);
  const out = [];
  const byTag = new Map();
  for (const p of projects) {
    if (!p.tag) {
      if (p.focus) {
        out.push({ kind: 'PROJECT', file: p.file, who: p.name, said: `focus: ${p.focus}`, should: 'a tag: line as well',
                   why: 'it leads the briefs but nothing can be joined to it' });
      }
      continue;
    }
    if (!byTag.has(p.tag)) byTag.set(p.tag, []);
    byTag.get(p.tag).push(p);
  }
  for (const [tag, ps] of byTag) {
    if (ps.length > 1) {
      out.push({ kind: 'PROJECT', file: ps.map((p) => p.file).join(', '), who: `#${tag}`,
                 said: `${ps.length} projects carry it`, should: 'one project per tag',
                 why: 'work filed under this tag lands in whichever file is read last' });
    }
    const p = ps[0];
    if (p.focus && !open.some((o) => (o.tags ?? []).includes(tag))) {
      out.push({ kind: 'PROJECT', file: p.file, who: p.name, said: `focus: ${p.focus}`,
                 should: 'something open, or not a focus this week',
                 why: `nothing open carries #${tag}, so every brief leads with "nothing moved" on it` });
    }
  }
  return out;
}

/** A file the derived layer points at that is not there any more. */
export async function brokenLinks(vault = OBLIGATIONS) {
  const out = [];
  const targets = [['now.md', null], ['decisions.md', null], ['todo.md', null]];
  for (const d of ['people', 'projects']) for (const f of await listMd(vault, d)) targets.push([join(d, f), d]);
  for (const [rel] of targets) {
    const text = await read(vault, rel);
    if (text === null) continue;
    for (const m of text.matchAll(/(?:^|[\s(`])((?:people|projects|journal|reference|rules|deploy)\/[\w./-]+\.(?:md|mjs|json|py))/g)) {
      const path = m[1].replace(/[.,)]+$/, '');
      if ((await read(vault, path)) === null) {
        out.push({ kind: 'LINK', file: rel, who: path, said: path, should: 'a file that exists',
                   why: 'referenced here and not on disk' });
      }
    }
  }
  return out;
}

export async function lint(vault = OBLIGATIONS, opts = {}) {
  const groups = await Promise.all([
    stalePeople(vault, opts).catch((e) => [{ kind: 'BLIND', why: `people: ${e.message}` }]),
    deadOptions(vault).catch((e) => [{ kind: 'BLIND', why: `decisions: ${e.message}` }]),
    coldProjects(vault, opts).catch((e) => [{ kind: 'BLIND', why: `projects: ${e.message}` }]),
    brokenLinks(vault).catch((e) => [{ kind: 'BLIND', why: `links: ${e.message}` }]),
    projectRegistry(vault).catch((e) => [{ kind: 'BLIND', why: `registry: ${e.message}` }]),
  ]);
  const findings = groups.flat();
  return { at: localStamp(), findings, blind: findings.filter((f) => f.kind === 'BLIND').map((f) => f.why) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await lint(OBLIGATIONS);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  const real = r.findings.filter((f) => f.kind !== 'BLIND');
  if (!real.length) console.log('the derived files agree with the journal and the obligation list');
  for (const f of real) {
    console.log(`${f.kind.padEnd(8)} ${f.file}${f.who ? '  ' + f.who : ''}`);
    console.log(`         ${f.why}`);
    if (f.should) console.log(`         says: ${f.said} · should be: ${f.should}`);
  }
  // A checker that cannot see half of what it checks must say so rather than
  // reporting the half it can.
  for (const b of r.blind) console.log(`BLIND    ${b}`);
  console.log(`\n${real.length} thing(s) drifted${r.blind.length ? `, ${r.blind.length} not checked` : ''}`);
}
