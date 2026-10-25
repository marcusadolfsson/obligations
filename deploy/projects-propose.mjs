#!/usr/bin/env node
/**
 * Projects the system should already have a file for.
 *
 * Alex, 2026-09-05, from the chief-of-staff audit: "Five vendors and dozens of
 * threads on one scope should make the system suggest
 * projects/one-2201-renovation.md, not wait for compaction." The renovation was
 * the largest live thread in the repo and had no projects/ file; projects/ had
 * five files, and it was not one of them.
 *
 * A project is a cluster of open obligations that share a tag or a sender
 * domain, with no projects/ file that mentions the tag or domain. This proposes
 * — it does not create. Naming a project is a judgement about what he is doing,
 * and the evening job makes it with the journal in front of it; this only says
 * where the clusters are.
 *
 *   node deploy/projects-propose.mjs
 *   node deploy/projects-propose.mjs --json
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOpen } from './agent-service/obligations.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_CLUSTER = 4;

/* Domains that are a service, not a counterparty — a cluster of Chase alerts is
 * not a project. Extend as they turn up; a false proposal costs one line in a
 * brief, so the list is short rather than clever. */
const NOISE_DOMAINS = /(^|\.)(gmail|google|apple|amazon|chase|citi|paypal|stripe|docusign|linkedin|substack|beehiiv|mailchimp|sendgrid|ccsend|hubspot|salesforce|intuit|quickbooks|zoom|calendly)\./i;

export async function projectFiles(vault) {
  try {
    const names = (await readdir(join(vault, 'projects'))).filter((n) => n.endsWith('.md') && !n.startsWith('_'));
    const out = [];
    for (const n of names) {
      const text = (await readFile(join(vault, 'projects', n), 'utf8')).toLowerCase();
      out.push({ slug: n.slice(0, -3), text });
    }
    return out;
  } catch { return []; }
}

const domainOf = (who) => { const m = String(who ?? '').toLowerCase().match(/@([a-z0-9.-]+)$/); return m ? m[1] : null; };

/** Pure: clusters from open obligations and the project files. Exported for tests. */
export function proposeFrom(open, projects, { min = MIN_CLUSTER } = {}) {
  const covered = (key) => projects.some((p) => p.slug.includes(key) || p.text.includes(key));
  const clusters = new Map();
  const add = (kind, key, o) => {
    const k = `${kind}:${key}`;
    if (!clusters.has(k)) clusters.set(k, { kind, key, items: [], who: new Set() });
    const c = clusters.get(k);
    c.items.push({ id: o.id, title: o.title, owed_by: o.owed_by, days: o.days ?? 0 });
    if (o.who) c.who.add(String(o.who).toLowerCase());
  };
  for (const o of open) {
    for (const t of o.tags ?? []) if (t !== 'decision') add('tag', t.toLowerCase(), o);
    const d = domainOf(o.who);
    if (d && !NOISE_DOMAINS.test(d)) add('domain', d, o);
  }
  return [...clusters.values()]
    .filter((c) => c.items.length >= min && !covered(c.key))
    .map((c) => ({ kind: c.kind, key: c.key, size: c.items.length, people: [...c.who].sort(),
                   items: c.items.sort((a, b) => b.days - a.days).slice(0, 8),
                   suggestedFile: `projects/${c.key.replace(/[^a-z0-9]+/g, '-')}.md` }))
    .sort((a, b) => b.size - a.size);
}

export async function propose(vault = OBLIGATIONS) {
  let open;
  try { open = await listOpen(vault); }
  catch (err) { return { proposals: [], error: String(err?.message ?? err) }; }
  const projects = await projectFiles(vault);
  return { proposals: proposeFrom(open, projects), existing: projects.map((p) => p.slug), error: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await propose();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  if (out.error) { console.log(`could not read obligations: ${out.error}`); process.exit(0); }
  console.log(`${out.existing.length} project files: ${out.existing.join(', ')}\n`);
  if (!out.proposals.length) console.log('no uncovered cluster of ' + MIN_CLUSTER + '+ open obligations.');
  for (const p of out.proposals) {
    console.log(`PROPOSE ${p.suggestedFile}  — ${p.size} open obligations share ${p.kind} "${p.key}"`);
    if (p.people.length) console.log(`  people: ${p.people.slice(0, 6).join(', ')}${p.people.length > 6 ? ' …' : ''}`);
    for (const it of p.items.slice(0, 5)) console.log(`  · ${it.title} (${it.owed_by === 'me' ? 'you' : 'them'}, ${it.days}d)`);
    console.log();
  }
}
