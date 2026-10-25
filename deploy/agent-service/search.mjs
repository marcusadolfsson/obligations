/**
 * One search over everything the assistant holds.
 *
 * Alex, 2026-09-05: "545 people, 177 obligations, 872 judged threads, and the
 * only way to find anything is to know which tab it's under." So: one query,
 * across obligations, decisions, people, judged mail, and what the system said —
 * each hit typed and carrying the link to where it lives. "Crestline" should find
 * the vendor, their threads, the decision they are an option in, and the nudge
 * drafted to them.
 *
 * Substring over lower-cased fields, ranked by where the match lands (title
 * beats body) and by recency. No index: at this size a scan is milliseconds,
 * and an index is a second copy of the data that can disagree with the first.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listObligations } from './obligations.mjs';
import { peopleIndex } from './people.mjs';
import { listMessages } from './messages.mjs';

const norm = (s) => String(s ?? '').toLowerCase();

/** Score: 3 for a title hit, 2 for who/subject, 1 for body; 0 = no match. */
function score(q, { title, who, body }) {
  if (norm(title).includes(q)) return 3;
  if (norm(who).includes(q)) return 2;
  if (norm(body).includes(q)) return 1;
  return 0;
}

export async function search(vault, query, { limit = 40 } = {}) {
  const q = norm(query).trim();
  if (q.length < 2) return { query, hits: [], counts: {}, note: 'type two or more characters' };

  const hits = [];
  const push = (kind, s, h) => { if (s) hits.push({ kind, score: s, ...h }); };

  // Obligations and decisions — open first, closed still findable.
  let obligations = [];
  try { obligations = await listObligations(vault); } catch { /* reported below */ }
  for (const o of obligations) {
    const kind = (o.tags ?? []).includes('decision') ? 'decision' : 'obligation';
    // A decision's options, recommendation and blocker live in its evidence
    // detail, not in `what` — and "Crestline" has to find the decision Crestline is
    // an option in, or the search cannot answer the question it was built for.
    const dd = kind === 'decision' ? ((o.evidence ?? []).find((e) => e.source === 'decision')?.detail ?? {}) : {};
    const body = [o.what, ...(dd.options ?? []), dd.recommend, dd.blocked, ...(dd.notes ?? [])].filter(Boolean).join(' ');
    const s = score(q, { title: o.title, who: o.who, body });
    // The open bonus only applies to a real match. Adding it to a zero turned
    // every open obligation into a hit for every query — 177 results for
    // "zzqx" — which the suite caught on its first run.
    push(kind, s ? s + (o.open ? 0.5 : 0) : 0, {
      id: o.id, title: o.title, sub: o.who ? `${o.who}${o.open ? '' : ' · closed'}` : (o.open ? '' : 'closed'),
      at: o.since ?? '', href: '/todo#pane=' + encodeURIComponent(o.id),
    });
  }

  // People.
  let people = [];
  try { people = (await peopleIndex(vault)).people; } catch { /* reported below */ }
  for (const p of people) {
    const s = score(q, { title: p.name, who: p.handles.join(' ') + ' ' + p.org, body: p.how });
    push('person', s, {
      id: p.key, title: p.name, sub: [p.org, `${p.threads} threads`,
        p.owedByMe.length ? `you owe ${p.owedByMe.length}` : '', p.owedByThem.length ? `owed ${p.owedByThem.length}` : ''].filter(Boolean).join(' · '),
      at: p.last ?? '', href: '/people#pane=' + encodeURIComponent(p.key),
    });
  }

  // Judged mail.
  try {
    const state = JSON.parse(await readFile(join(vault, 'integrations', 'email-state.json'), 'utf8'));
    for (const t of state.threads ?? []) {
      const c = t.conclusion; if (!c) continue;
      const s = score(q, { title: c.title || c.subject, who: c.who + ' ' + c.subject, body: c.what });
      push('mail', s, {
        id: `${t.account}:${t.thread_id}`, title: c.title || c.subject || '(no subject)',
        sub: `${c.who ?? ''} · ${c.tier}`, at: c.since ?? t.watermark ?? '',
        href: '/mail#pane=' + encodeURIComponent(`${t.account}:${t.thread_id}`),
      });
    }
  } catch { /* no mail state is an empty section, and the counts say so */ }

  // What the system said.
  try {
    for (const m of await listMessages(join(vault, 'messages'))) {
      const s = score(q, { title: m.title, who: m.kind, body: m.body });
      push('said', s, { id: 'msg:' + m.id, title: m.title, sub: `${m.kind} · ${m.at}`, at: m.at,
                        href: '/briefs#pane=' + encodeURIComponent(m.id) });
    }
  } catch { /* same */ }

  hits.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  const counts = {};
  for (const h of hits) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  return { query, hits: hits.slice(0, limit), counts, total: hits.length,
           blind: [obligations.length ? null : 'obligations unreadable', people.length ? null : 'people unreadable'].filter(Boolean) };
}
