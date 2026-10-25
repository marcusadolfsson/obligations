/**
 * Awareness and memory, in front of him once.
 *
 * Alex, 2026-10-07, after the evening brief said nothing about Simon Kerr
 * forwarding the plugco/DataCo partnership deck: "we need a section on Memory and
 * Awareness items, otherwise I never see them." He was right about the
 * plumbing. The mail digest covers the `digest` and `reading` tiers only;
 * `awareness` and `memory` were handed to the brief model in its input, and no
 * brief's instructions gave them a section, so a partner's forward judged
 * `memory` (no ask, filed to Drive) went to the record and nowhere else.
 *
 * So the service appends them, the way it appends the mail digest: after the
 * brief is written, one line per thread with its link, every awareness and
 * memory thread no brief has carried yet, and a ledger of which brief carried
 * each one so it is shown exactly once. Not written by the brief model — it
 * reads the previous brief, and anything it can read it can copy (the digest
 * heading, 2026-09-29) — and not a judgement: the triage already judged each.
 *
 * Starts at FILED_FROM, so switching it on brings this afternoon's mail, not
 * three weeks of receipts.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { localStamp } from './time.mjs';
import { ignoredSenders, isIgnored, addressOf } from './reading.mjs';

export const FILED_TIERS = ['awareness', 'memory'];
export const FILED_FROM = '2026-10-07 12:30';
/** A day's worth with room; the rest wait for the next brief, counted. */
export const FILED_CAP = 30;
export const HEADING = '## Awareness and memory';
export const MARK = '<!-- awareness and memory: attached by the service -->';
const LEDGER = ['.log', 'filed-reported.json'];

const stampOf = (t) => String(t.reviewed || t.watermark || '').slice(0, 16).replace('T', ' ');

/** "simon.kerr@plugco.example" → "Simon Kerr (plugco)"; any other address → its domain; a name as written. */
export function personOf(who) {
  const s = String(who ?? '').trim();
  const m = /^([a-z]+)[._]([a-z]+)@([a-z0-9-]+)\./i.exec(s);
  const cap = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
  if (m) return `${cap(m[1])} ${cap(m[2])} (${m[3].toLowerCase()})`;
  const at = /@([a-z0-9.-]+)$/i.exec(s);
  if (at) return at[1].toLowerCase().split('.').slice(-2).join('.');
  return s || 'someone';
}

/* A clip on a word, not a sentence: "Springfield" is not the end of one. */
const clip = (s, n = 150) => {
  const t = String(s ?? '').split(/\n+UPDATE\b/)[0].replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n).replace(/\s+\S*$/, '');
  return cut.replace(/[,;:—-]+$/, '') + '…';
};
const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

export async function readLedger(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, ...LEDGER), 'utf8'));
    return { reported: d?.reported ?? {}, briefs: d?.briefs ?? {} };
  } catch { return { reported: {}, briefs: {} }; }
}

/** Every awareness and memory thread, mail and text, judged since FILED_FROM and carried by no brief. */
export async function pendingFiled(vault, { from = FILED_FROM } = {}) {
  const read = async (...p) => { try { return JSON.parse(await readFile(join(vault, ...p), 'utf8')); } catch { return null; } };
  const [mail, texts, ledger] = await Promise.all([read('integrations', 'email-state.json'), read('integrations', 'imessage-state.json'), readLedger(vault)]);
  const ignored = await ignoredSenders(vault).catch(() => new Set());
  // One row per thread — the record can hold a thread twice; the newest judgement wins.
  const byId = new Map();
  for (const t of mail?.threads ?? []) {
    const c = t.conclusion;
    if (!c || !FILED_TIERS.includes(c.tier) || stampOf(t) < from) continue;
    const id = `${t.account || 'personal'}:${t.thread_id}`;
    if (ledger.reported[id] || (ignored.size && isIgnored(addressOf(c.who), ignored))) continue;
    if (byId.has(id) && byId.get(id).at >= stampOf(t)) continue;
    byId.set(id, { id, tier: c.tier, at: stampOf(t), who: personOf(c.who), title: c.title || c.subject || null,
                   what: clip(c.what), link: /^[0-9a-f]{4,32}$/.test(String(t.thread_id)) ? `/mail#pane=${encodeURIComponent(id)}` : null });
  }
  /* A text thread is re-read whenever anything new lands on it, so its time
     says nothing about whether its conclusion is new. Keyed on what the
     conclusion says: shown once, and again only when it changes. */
  for (const t of texts?.threads ?? []) {
    const c = t.conclusion;
    if (!c || !FILED_TIERS.includes(c.tier) || stampOf(t) < from) continue;
    const id = `text:${t.chat_id}:${hash(c.what)}`;
    if (ledger.reported[id]) continue;
    byId.set(id, { id, tier: c.tier, at: stampOf(t), who: c.who || 'a text', title: c.title || null, what: clip(c.what), link: null, text: true });
  }
  const rows = [...byId.values()];
  // Awareness first (it carries a date that arrives without him), each oldest first.
  return rows.sort((a, b) => (a.tier === b.tier ? a.at.localeCompare(b.at) : a.tier === 'awareness' ? -1 : 1));
}

/** The section, as markdown: one line each, the subject in bold, the thing itself the link. */
export function renderFiled(rows, { cap = FILED_CAP } = {}) {
  const shown = rows.slice(0, cap);
  const more = rows.length - shown.length;
  const line = (r) => {
    const head = r.title ? (r.link ? `[${r.title}](${r.link})` : r.title) : null;
    return `- **${r.who}**${r.text ? ' (text)' : ''} — ${head ? `${head}: ${r.what}` : r.what}`;
  };
  const block = (tier, label) => {
    const xs = shown.filter((r) => r.tier === tier);
    return xs.length ? [`**${label} · ${xs.length}**`, ...xs.map(line)].join('\n') : null;
  };
  const parts = [block('awareness', 'Awareness'), block('memory', 'Memory — filed')].filter(Boolean);
  if (more) parts.push(`…and ${more} more, in the next brief.`);
  return { text: parts.join('\n\n'), shown, more };
}

/**
 * Append the section to brief `into` (a messages/ file name), above the mail
 * digest when that is already on, and record what it carried. A brief that
 * already has it, or nothing pending, is left alone.
 */
export async function filedIntoBrief(vault, into, { now = new Date() } = {}) {
  const ledger = await readLedger(vault);
  if (ledger.briefs[into]) return { attached: false, why: `${into} already carries it (${ledger.briefs[into]})` };
  const rows = await pendingFiled(vault);
  if (!rows.length) return { attached: false, why: 'nothing new in awareness or memory', count: 0 };
  const { text, shown, more } = renderFiled(rows);
  const path = join(vault, 'messages', into);
  let brief = await readFile(path, 'utf8');
  // A copy the brief model wrote itself — heading, marker, lines — comes off first.
  const own = brief.search(new RegExp(`^${HEADING}\\s*$`, 'm'));
  if (own >= 0) {
    const next = brief.slice(own + HEADING.length).search(/^## /m);
    brief = brief.slice(0, own) + (next >= 0 ? brief.slice(own + HEADING.length + next) : '');
  }
  brief = brief.split('\n').filter((l) => l.trim() !== MARK).join('\n');
  const section = `${HEADING}\n${MARK}\n\n${text}\n`;
  const digestAt = brief.search(/^## Mail digest\s*$/m);
  brief = digestAt >= 0
    ? `${brief.slice(0, digestAt).replace(/\s*$/, '')}\n\n${section}\n${brief.slice(digestAt)}`
    : `${brief.replace(/\s*$/, '')}\n\n${section}`;
  await writeFile(path, brief.replace(/\s*$/, '') + '\n');
  const at = localStamp(now);
  for (const r of shown) ledger.reported[r.id] = at;
  ledger.briefs[into] = at;
  await mkdir(dirname(join(vault, ...LEDGER)), { recursive: true });
  await writeFile(join(vault, ...LEDGER), JSON.stringify(ledger, null, 1) + '\n');
  return { attached: true, count: shown.length, more, ids: shown.map((r) => r.id) };
}
