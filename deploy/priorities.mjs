#!/usr/bin/env node
/**
 * Movement on what matters — the priorities report the briefs lead with.
 *
 * Alex, 2026-09-05, from the chief-of-staff audit: "It has no idea what
 * matters to you. There is no priorities concept anywhere. tasks.mjs sorts by
 * days-waiting. Every brief answers 'what arrived' when a CoS would answer
 * 'what moved on what you care about.'"
 *
 * **The priorities ARE the projects, since 2026-09-16.** Alex: "maybe combine
 * priorities and projects?" There were two files keyed by the same tag —
 * priorities.md saying what he is for, projects/ describing the work — and every
 * priority he had was a body of work with a project file or a conspicuously
 * missing one (#one and #acme had neither). So a project file carries `focus: n`
 * when it is one of the few, and the number is the order. priorities.md is
 * retired to archive/; nothing reads it.
 *
 * This joins those projects to the merged obligation list by tag and answers,
 * per project, the four questions a chief of staff answers first: what closed,
 * what is new, what is due, what is undecided. Read-only. It ranks nothing and
 * closes nothing — the ranking is `focus:`, and that line is his.
 *
 * Also reports what is NOT on any priority. That number is the check on the
 * file: if most of what he owes belongs to no priority, either the file is stale
 * or the obligations are noise, and either way he should know.
 *
 *   node deploy/priorities.mjs             # since the last 24h
 *   node deploy/priorities.mjs --since 2026-09-04
 *   node deploy/priorities.mjs --json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { withRepoLock } from './agent-service/lock.mjs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listObligations } from './agent-service/obligations.mjs';
import { focusProjects, readProjects, setFocus } from './agent-service/projects.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const DAY = 86400000;

/** `## Title  #tag` headings, with the prose under each. Exported for tests. */
export function parsePriorities(text) {
  const out = [];
  let cur = null;
  let inComment = false, inFence = false;
  for (const raw of String(text ?? '').split('\n')) {
    // The template block at the top is inside a code fence and an HTML
    // comment; neither is a priority. The fence has to be tracked as a STATE:
    // the first version reset on the fence line and then read "## Title #tag"
    // inside it as a real priority, which reported "0 open; nothing moved" on a
    // heading that does not exist.
    if (raw.includes('<!--')) inComment = true;
    if (inComment) { if (raw.includes('-->')) inComment = false; continue; }
    if (/^```/.test(raw)) { inFence = !inFence; cur = null; continue; }
    if (inFence) continue;
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const tag = h[1].match(/(?:^|\s)#([^\s#]+)/);
      const title = h[1].replace(/(?:^|\s)#[^\s#]+/g, '').trim();
      // A heading with no tag cannot be joined to anything and is skipped
      // loudly rather than silently — see `untagged` in the report.
      cur = { title, tag: tag ? tag[1].toLowerCase() : null, note: [] };
      out.push(cur);
      continue;
    }
    if (cur && raw.trim() && !/^#/.test(raw)) cur.note.push(raw.trim());
  }
  return out.map((p) => ({ ...p, note: p.note.join(' ') }));
}

const closedAt = (o) => (o.evidence ?? []).map((e) => e.detail?.closed_at ?? e.closed_at ?? '')
  .filter(Boolean).sort().pop() ?? '';

export async function priorities(vault = OBLIGATIONS, { sinceMs = Date.now() - DAY } = {}) {
  const focus = await focusProjects(vault).catch(() => []);
  /* EVERY ACTIVE PROJECT, NOT ONLY THE RANKED. Alex, 2026-09-30: "I added a
     new project from the map page, but it doesnt show" on Projects. It was
     made — unranked, like anything added without a rank — and this listed
     only the ranked. The rest come back as `others`, with the same numbers;
     `priorities` stays the ranked few, which is what the briefs lead with. */
  const active = (await readProjects(vault).catch(() => [])).filter((p) => p.tag);
  const ranked = new Set(focus.map((p) => p.tag));
  const otherDefs = active.filter((p) => !ranked.has(p.tag))
    .map((p) => ({ title: p.title, tag: p.tag, note: p.note, file: p.file, focus: null, parent: p.parent ?? null }));
  const defs = focus.map((p) => ({ title: p.title, tag: p.tag, note: p.note, file: p.file, focus: p.focus, parent: p.parent ?? null }));
  const all = await listObligations(vault);
  const since = new Date(sinceMs).toISOString().slice(0, 16).replace('T', ' ');
  const soon = Date.now() + 7 * DAY;

  const reportOf = (p) => {
    if (!p.tag) return { ...p, untagged: true };
    const mine = all.filter((o) => (o.tags ?? []).map((t) => t.toLowerCase()).includes(p.tag));
    const open = mine.filter((o) => o.open);
    const line = (o) => ({ id: o.id, title: o.title, due: o.due ?? null, days: o.days ?? null,
                           owed_by: o.owed_by, overdue: !!o.overdue });
    return {
      ...p,
      open: open.length,
      closed: mine.filter((o) => !o.open && closedAt(o) >= since).map(line),
      fresh: open.filter((o) => (o.since ?? '') >= since).map(line),
      overdue: open.filter((o) => o.overdue).map(line),
      dueSoon: open.filter((o) => o.due && !o.overdue && Date.parse(String(o.due).replace(' ', 'T')) <= soon).map(line),
      undecided: open.filter((o) => (o.tags ?? []).includes('decision')).map(line),
      waitingOnThem: open.filter((o) => o.owed_by === 'them').length,
    };
  };
  const report = defs.map(reportOf);
  const others = otherDefs.map(reportOf).sort((a, b) => (b.open ?? 0) - (a.open ?? 0) || String(a.title).localeCompare(String(b.title)));

  const tagged = new Set(defs.map((p) => p.tag).filter(Boolean));
  const openAll = all.filter((o) => o.open);
  const unattached = openAll.filter((o) => !(o.tags ?? []).some((t) => tagged.has(t.toLowerCase())));

  return {
    since,
    // Every project, so the page can offer the ones that are not the focus yet.
    all: active.map((p) => ({ tag: p.tag, title: p.title, name: p.name, file: p.file, focus: p.focus ?? null, note: p.note })),
    priorities: report,
    others,
    // Absence gets a number. Most of what he owes belonging to no priority is a
    // fact about either the file or the list, and both are worth knowing.
    unattached: { count: unattached.length, of: openAll.length,
                  owedByMe: unattached.filter((o) => o.owed_by === 'me').length },
    // Against EVERY active project — what the Projects list's last row means.
    unprojected: (() => { const all2 = new Set(active.map((p) => p.tag)); const u = openAll.filter((o) => !(o.tags ?? []).some((t) => all2.has(t.toLowerCase())));
      return { count: u.length, of: openAll.length, owedByMe: u.filter((o) => o.owed_by === 'me').length }; })(),
    error: focus.length ? null : 'no project carries a `focus:` line — nothing to lead with',
  };
}

/**
 * His edit, from the priorities page.
 *
 * Alex, 2026-09-05: "The editor here needs to be form based. Don't rely on
 * the user to edit an .md file properly." That still holds — what changed on
 * 2026-09-16 is where it writes. The form now picks which projects are the
 * focus, in what order, with the one line each that says what on track looks
 * like, and `setFocus` writes exactly those two things into the project files.
 * Nothing else in a project file is touched: the rest is his prose or the
 * compaction's, and a form that rewrote the file could lose a decision log.
 */
export const MAX_FOCUS = 7;
export function validateFocus(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'no projects chosen — a brief has to lead with something';
  if (rows.length > MAX_FOCUS) return `${rows.length} is more than ${MAX_FOCUS} — a list of twelve priorities is a list with none`;
  const seen = new Set();
  for (const r of rows) {
    const tag = String(r?.tag ?? '').trim().toLowerCase().replace(/^#/, '');
    if (!tag) return 'a chosen project with no tag';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tag)) return `a tag is letters, digits and dashes: #${tag}`;
    if (seen.has(tag)) return `#${tag} is chosen twice`;
    seen.add(tag);
  }
  return null;
}

export async function savePriorities(vault, rows) {
  const why = validateFocus(rows);
  if (why) throw new Error(why);
  const r = await setFocus(vault, rows);
  return { priorities: r.focus.length, changed: r.changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = flag('since');
  const out = await priorities(OBLIGATIONS, s ? { sinceMs: Date.parse(s) } : {});
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  if (out.error) { console.log(out.error); process.exit(0); }
  console.log(`movement since ${out.since}\n`);
  for (const p of out.priorities) {
    if (p.untagged) { console.log(`## ${p.title}\n  ! no #tag on this heading — nothing can be joined to it\n`); continue; }
    const bits = [];
    if (p.closed.length) bits.push(`${p.closed.length} closed`);
    if (p.fresh.length) bits.push(`${p.fresh.length} new`);
    if (p.overdue.length) bits.push(`${p.overdue.length} overdue`);
    if (p.dueSoon.length) bits.push(`${p.dueSoon.length} due this week`);
    if (p.undecided.length) bits.push(`${p.undecided.length} undecided`);
    console.log(`## ${p.title}  #${p.tag}  — ${p.open} open` + (bits.length ? `; ${bits.join(', ')}` : '; nothing moved'));
    for (const o of p.closed) console.log(`   ✓ ${o.title}`);
    for (const o of p.fresh) console.log(`   + ${o.title}`);
    for (const o of p.overdue) console.log(`   ! ${o.title} — overdue`);
    for (const o of p.dueSoon) console.log(`   · ${o.title} — due ${String(o.due).slice(0, 10)}`);
    for (const o of p.undecided) console.log(`   ? ${o.title}`);
    console.log();
  }
  const u = out.unattached;
  console.log(`${u.count} of ${u.of} open obligations belong to no priority (${u.owedByMe} owed by you).`);
}
