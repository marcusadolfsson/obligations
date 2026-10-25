#!/usr/bin/env node
/**
 * Everything a brief needs, assembled once, handed to the model in one piece.
 *
 * Alex, 2026-09-06: "When we create the brief, how do we deliver the source
 * content to the LLM. As one blob of text in one go?" It was not — the job got
 * ~64KB of instructions and fetched every fact itself, fifteen to thirty tool
 * calls a run, and a fact it did not fetch did not exist (his brother, "the
 * 702 number"). Now the reading is code and the judgement is the model: this
 * runs every script a brief would run, joins what needs joining (each
 * attendee's one line from people/, each thread's participants by name), and
 * writes one markdown document the job receives in its prompt. The model keeps
 * its tools for a follow-up grep it genuinely needs — "and then it can make
 * follow-up fetches if needed" — but it starts with the whole picture.
 *
 * Read-only. Nothing here advances a cursor, marks, closes or writes to the
 * repo; the job still does those, and says so. Every source that cannot be
 * read is named under `## blind` — a silence must never be indistinguishable
 * from a success.
 *
 *   node deploy/brief-input.mjs morning|evening [--json]
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listObligations, sortObligations } from './agent-service/obligations.mjs';
import { personFor } from './agent-service/people.mjs';
import { whereNow, dayStays } from './agent-service/location.mjs';
import { conditions } from './agent-service/conditions.mjs';
import { localStamp } from './agent-service/time.mjs';
import { health } from './pipeline-health.mjs';
import { priorities } from './priorities.mjs';
import { conflicts } from './conflicts.mjs';
import { closedSince } from './closed.mjs';
import { contactSince } from './agent-service/contact.mjs';
import { distinctive } from './context.mjs';
import { words as wordsOf } from './agent-service/similar.mjs';
import { stale } from './stale.mjs';
import { propose } from './projects-propose.mjs';
import { changesSince } from './review.mjs';
import { reasonFor, upcoming, dueAt } from './digest-window.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* One brief a day since 2026-10-24 — the morning. The evening run writes no
   brief, but its journal is written from this document and assembling it is
   what records the day's trust line. */
const SLOTS = ['morning', 'evening'];
/* The verdict scopes a brief acts on. Mail and message verdicts are the
   triages' — each reads its own with `verdict.mjs --list` — and quoting the
   whole file here was 12KB of a 60KB budget, growing with every "Not a task".
   Newest first, capped; the count of the rest is stated. 2026-09-20. */
const BRIEF_VERDICT_SCOPES = ['brief', 'decision', 'calendar', 'people', 'general'];
const VERDICT_CAP = 40;
const CAP = { today: 40, upcoming: 20, waitingYou: 20, waitingThem: 20, digest: 40, threads: 14, msgsPerThread: 12 };
const MAX_BYTES = 60 * 1024;

const day = (d) => localStamp(d).slice(0, 10);

/**
 * Yesterday's promises, each with what happened AFTERWARDS.
 *
 * Alex, 2026-09-23, of a morning brief that opened "you told him at 11:31
 * yesterday you'd come back with a place, and you haven't": he had, at 19:43 —
 * after the 18:00 journal was written. The journal is append-only and right
 * about what he SAID; reading it as the current state is how a brief asserts
 * something the record already disproves. The obligation had even been closed
 * at 20:35 by the message triage, two hours before the brief ran.
 *
 * So each line gets the two things that would settle it: anything he sent that
 * person after he said it, and any obligation closed since whose title shares
 * a distinctive word with the line. The brief still decides — it can no longer
 * say "and you haven't" without having been shown the evidence.
 */
export async function keptSince(vault, block, yesterday, { closed = null } = {}) {
  let rows = closed;
  if (!rows) { try { rows = (await closedSince(vault, yesterday)).rows ?? []; } catch { rows = []; } }
  const out = [];
  for (const line of String(block ?? '').split('\n')) {
    out.push(line);
    // The journal's own shape for a promise: `— to NAME, HH:MM, …`
    const m = line.match(/\u2014\s*to\s+([^,]+?),\s*(\d{2}:\d{2})/);
    if (!m) continue;
    const who = m[1].trim(), since = `${yesterday} ${m[2]}`;
    const notes = [];
    try {
      /* STRICTLY AFTER. contactSince counts the same minute, which is right
         for "I called right away" and wrong here: the promise itself was sent
         in that minute, so the line would cite itself as evidence. */
      const mine = (await contactSince(vault, who, since, { direction: 'mine' }))
        .filter((x) => String(x.at ?? '') > since);
      const last = mine[mine.length - 1];
      if (last) notes.push(`you wrote to ${who} by ${last.channel} at ${String(last.at).slice(11, 16)}${last.detail ? ` ("${String(last.detail).replace(/\s+/g, ' ').slice(0, 80)}")` : ''}`);
    } catch { /* no address book: the line stands on its own */ }
    /* Stem against stem, never a stem inside a word boundary: distinctive()
       normalises the way similar.mjs does — "Owen" is held as "andrea" —
       so `\bandrea\b` matches nothing a person is actually called. */
    const want = distinctive(who);
    // And closed AFTER he said it: an older close is about something else.
    const hit = rows.filter((r) => `${r.date} ${r.time}` >= since)
      .find((r) => { const had = wordsOf(`${r.title ?? ''} ${r.who ?? ''}`); return want.some((w) => had.has(w)); });
    if (hit) notes.push(`"${hit.title}" closed ${hit.date} ${hit.time}${hit.by ? ` by ${hit.by}` : ''}`);
    if (notes.length) out.push(`  - SINCE HE SAID IT: ${notes.join('; ')} — check this before saying it is still outstanding.`);
  }
  return out.join('\n');
}
/**
 * A diary entry or a dated hand-kept line about something already discharged.
 *
 * Alex, 2026-10-18, of a morning brief that put "Sales tax" under Due today
 * — the calendar's "Sales Tax Due", and now.md's "Mon 10-19 — The September
 * the state sales and use tax return" — above a digest showing the state
 * portal's payment confirmations and return-filed notices for both entities.
 * He had closed the obligation himself on 10-15. Nothing told the brief: a
 * calendar entry and a line in now.md are not obligations, so nothing ever
 * closes them, and the brief read both as the current state.
 *
 * So each one is checked against the obligations already closed: one due
 * within a week of the entry's date whose title shares most of the entry's
 * distinctive words. Timid on purpose — two shared words at least, and the
 * date window keeps last month's close off this month's entry. The brief
 * still decides; it can no longer call it due without having been shown the
 * close.
 */
const GENERIC = new Set(['due', 'today', 'tomorrow', 'deadline', 'reminder']);
const WINDOW_DAYS = 7;
export function closedMatch(text, date, closedObs) {
  const want = new Set([...wordsOf(text)].filter((w) => !GENERIC.has(w)));
  const at = Date.parse(`${String(date ?? '').slice(0, 10)}T12:00:00`);
  if (want.size < 2 || Number.isNaN(at)) return null;
  let best = null;
  for (const o of closedObs ?? []) {
    const due = Date.parse(`${String(o.due ?? '').slice(0, 10)}T12:00:00`);
    if (Number.isNaN(due) || Math.abs(due - at) > WINDOW_DAYS * 86400000) continue;
    const had = new Set([...wordsOf(o.title)].filter((w) => !GENERIC.has(w)));
    const shared = [...want].filter((w) => had.has(w)).length;
    const score = shared / Math.min(want.size, had.size || 1);
    if (shared >= 2 && score >= 0.6 && (!best || score > best.score)) best = { o, score };
  }
  return best?.o ?? null;
}
/* Not a bullet: under a calendar event, an indented "- … — …" is an attendee
   line, to the reader and to the test that checks for them. */
const clip = (t, n) => { const s = esc(t); if (s.length <= n) return s; const c = s.slice(0, n); return c.slice(0, Math.max(c.lastIndexOf(' '), n / 2)).replace(/[,;:\s]+$/, '') + '…'; };
const doneLine = (o, indent = '  ') => `\n${indent}ALREADY DONE: "${esc(o.title)}"${o.due ? ` (due ${String(o.due).slice(0, 10)})` : ''} was closed ${o.closed_at}${o.closed_by ? ` by ${o.closed_by}` : ''}${o.outcome ? `: ${clip(o.outcome, 160)}` : ''}${o.id ? ` (link: /todo#pane=${encodeURIComponent(o.id)})` : ''}. That part is done: do not report it as due.`;
function doneNote(text, date, closedObs) {
  const o = closedMatch(text, date, closedObs);
  return o ? doneLine(o) : '';
}
/** now.md's dated bullets (`- **Mon 10-19** — …`), each with its
 *  continuation lines, checked the same way. Nothing else in the file is
 *  touched, and nothing is dropped. */
export function datedLinesChecked(md, today, closedObs) {
  const lines = String(md ?? '').split('\n');
  const out = [];
  const year = Number(String(today).slice(0, 4));
  const month = Number(String(today).slice(5, 7));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \*\*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{2})-(\d{2})\*\*/);
    if (!m) { out.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
    const block = lines.slice(i, j);
    out.push(...block);
    // The year the line means: a December line read in January is last year's.
    const mm = Number(m[1]);
    const y = mm - month > 6 ? year - 1 : month - mm > 6 ? year + 1 : year;
    const o = closedMatch(block.join(' '), `${y}-${m[1]}-${m[2]}`, closedObs);
    if (o) out.push(doneLine(o).slice(1));
    i = j - 1;
  }
  return out.join('\n');
}
const esc = (s) => String(s ?? '').replace(/\r?\n/g, ' ').trim();
const parseMs = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };

async function text(vault, rel, blind, label = rel) {
  try { return await readFile(join(vault, rel), 'utf8'); }
  catch (err) { blind.push(`${label}: ${err.code === 'ENOENT' ? 'missing' : err.message}`); return null; }
}
async function jsonFile(vault, rel, blind, label = rel) {
  const raw = await text(vault, rel, blind, label);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (err) { blind.push(`${label}: unreadable JSON (${err.message})`); return null; }
}
async function guarded(label, blind, fn) {
  try { return await fn(); } catch (err) { blind.push(`${label}: ${err?.message ?? err}`); return null; }
}

/* ------------------------------------------------------------ obligations */

const mine = (o) => (o.owed_by ?? 'me') !== 'them';
const isToday = (o) => mine(o) && (o.due ? o.lead_days <= 0 : o.priority === 'high');
const age = (o) => {
  if (o.due) {
    const d = o.lead_days;
    if (d == null) return o.due;
    if (d < 0) return `${o.due} (${-d}d overdue)`;
    if (d === 0) return `${o.due} (today)`;
    return `${o.due} (in ${d}d)`;
  }
  return o.days == null ? '' : `${o.days}d`;
};
const sources = (o) => { const n = new Map(); for (const e of o.evidence ?? []) n.set(e.source, (n.get(e.source) ?? 0) + 1); return [...n].map(([s, c]) => (c === 1 ? s : `${s}×${c}`)).join('+'); };
// One line each. The first version carried `what`, `closes when` and the
// thread link for every one of 185 obligations — 74KB, most of it about
// things the brief will not mention. The id is the handle for a follow-up
// (`node deploy/tasks.mjs --json`, or the thread page); `what` rides only on
// the today bucket, where the brief has to say something about each.
/** The page a thread lives on, if this obligation came from one. */
const threadLink = (o) => {
  const e = (o.evidence ?? []).find((x) => x.detail?.link);
  if (e) return e.detail.link;
  const m = (o.evidence ?? []).find((x) => x.source === 'email' && x.detail?.thread_id);
  if (m) return `/thread/${m.detail.account ?? 'personal'}/${m.detail.thread_id}`;
  return o.chat_id ? `/thread/${o.chat_id}` : null;
};

/**
 * How long he has ACTUALLY been waiting on each of these — the gap since they
 * last wrote, on any channel, this thread included — as `waited`.
 *
 * Alex, 2026-10-17, of "Carl Voss at Ellison — the windowline and
 * headliner material, 51 days, never chased": "No way that has been 51 days."
 * It had been under three (10-14 09:54 to 10-17 07:00). The 51 was the obligation's AGE (`days` is
 * daysSince(since), and since was the first quote on 08-26); the ball had
 * changed hands about ten times on that thread since, the last on 10-14. The
 * chases were fixed for exactly this on 2026-09-21 (quietFor in drafts.mjs);
 * the brief's waiting line kept reading the age. One measure for both, so the
 * brief and the chase cannot disagree about the same silence.
 *
 * `about` is context.mjs's; an item it cannot see keeps its age, which is the
 * honest reading of "they have never answered".
 */
export async function withWait(rows, about, now) {
  const { quietFor } = await import('./drafts.mjs');
  const out = [];
  for (const o of rows) {
    const known = o.since ? await about(o).catch(() => null) : null;
    const waited = known?.inTouch?.seen ? quietFor(known.inTouch.all, { since: o.since, now: now.getTime() }) : null;
    out.push({ ...o, waited: waited ?? o.days ?? 0 });
  }
  return out;
}

export function obLine(o, { what = false, waiting = null } = {}) {
  // For something THEY owe: how long he has been waiting, and when it was last
  // chased — the two numbers that say whether a wait is a wait or a loss.
  // `waited` when withWait has measured it; the age is only a stand-in.
  const wait = waiting ? `waiting ${o.waited ?? o.days ?? 0}d${waiting[o.id]?.at ? `, chased ${String(waiting[o.id].at).slice(0, 10)}` : ', never chased'}` : null;
  // The bare "73d" age is the wait itself on this bucket; say it once.
  const bits = [`- \`${o.id}\``, (o.due || !waiting) && age(o) ? age(o) : null, wait, o.priority && o.priority !== 'normal' ? `[${o.priority}]` : null,
    o.who ? `${o.who} —` : null, esc(o.title).slice(0, 110), `(${sources(o)})`, o.tags?.length ? o.tags.map((t) => '#' + t).join(' ') : null].filter(Boolean);
  let s = bits.join(' ');
  // The link rides only where `what` does — the buckets the brief actually
  // writes about. Alex, 2026-09-16, of an invoice the brief described in
  // full: "i need a link to the message in the brief." Carrying one for all
  // 233 obligations is what made the first version of this document 74KB.
  //
  // **The to-do first, the thread second.** Alex, 2026-09-17: "the brief
  // needs to link to the to-do if there is one, to the mail thread if not
  // to-do related." Everything on this line IS an obligation, and the page that
  // holds it is where he can close it, move its date or draft the follow-up —
  // the thread is only where the words are. So the to-do is the link, and the
  // thread rides beside it for when he wants to read rather than act.
  if (what) {
    s += `\n  link: /todo#pane=${encodeURIComponent(o.id)}`;
    const t = threadLink(o);
    if (t) s += `  (thread: ${t})`;
  }
  if (what && o.what && o.what !== o.title) s += `\n  what: ${esc(o.what).slice(0, 160)}`;
  return s;
}
function capList(rows, cap) { return rows.length > cap ? { rows: rows.slice(0, cap), more: rows.length - cap } : { rows, more: 0 }; }

/* -------------------------------------------------------------- calendar */

async function attendeeLine(vault, a, cache) {
  const key = String(a.email ?? '').toLowerCase();
  if (!key || a.self) return null;
  if (!cache.has(key)) cache.set(key, await personFor(vault, key).catch(() => null));
  const p = cache.get(key);
  const name = a.name || p?.name || key;
  if (!p || (!p.file && !p.threads)) return `  - ${name} — not known to the assistant`;
  const bits = [];
  if (p.role) bits.push(p.role); if (p.org) bits.push(p.org);
  if (p.how) bits.push(esc(p.how).slice(0, 120));
  if (p.last) bits.push(`last: ${p.last}${p.lastSubject ? ' — ' + esc(p.lastSubject).slice(0, 60) : ''}`);
  if (p.owedByMe?.length) bits.push(`you owe them: ${p.owedByMe.map((o) => esc(o.title)).slice(0, 3).join('; ')}`);
  if (p.owedByThem?.length) bits.push(`they owe you: ${p.owedByThem.map((o) => esc(o.title)).slice(0, 3).join('; ')}`);
  return `  - ${name}${p.file ? ` (${p.file})` : ''} — ${bits.join(' · ') || 'in the mail, nothing on file'}`;
}
async function eventBlock(vault, e, cache) {
  const when = e.allDay ? 'all day' : `${e.startsAt ?? ''}${e.endsAt ? '–' + e.endsAt : ''}`;
  const lines = [`- **${esc(e.summary)}** — ${e.startsOn ?? ''} ${when}${e.calendar ? ` · ${e.calendar}` : ''}${e.location ? ` · ${esc(e.location)}` : ''}${e.conference ? ` · ${e.conference}` : ''}${e.myResponse && e.myResponse !== 'accepted' ? ` · your reply: ${e.myResponse}` : ''}`];
  for (const a of e.attendees ?? []) { const l = await attendeeLine(vault, a, cache); if (l) lines.push(l); }
  return lines.join('\n');
}

/* --------------------------------------------------------------- messages */

function messagesSection(changed, extract, blind) {
  if (!changed) return null;
  const need = changed.needs_judgement ?? [];
  const threads = new Map((extract?.threads ?? []).map((t) => [t.chat_id, t]));
  const c = changed.counts ?? {};
  const head = `counts: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}` +
    (changed.unresolved_handles?.length ? `\nhandles nobody can name: ${changed.unresolved_handles.join(', ')}` : '');
  if (!need.length) return head + '\n\nnothing changed since the last judgement.';
  const shown = need.slice(0, CAP.threads);
  const blocks = shown.map((e) => {
    const t = threads.get(e.chat_id);
    // Names: the differ resolved the participants; a thread that aged out of
    // the extract has none, so the previous conclusion's `who` stands in.
    const names = new Map((e.participants ?? []).filter((p) => p.name).map((p) => [String(p.handle).toLowerCase(), p.name]));
    const nameOf = (h) => names.get(String(h ?? '').toLowerCase()) ?? h;
    const who = e.who || e.previous_conclusion?.who || e.chat_id.replace(/^any;-;/, '');
    const lines = [`### ${e.thread_name ? esc(e.thread_name) + ' — ' : ''}${who}`, `chat_id: \`${e.chat_id}\` · ${e.reason}${e.since ? ` since ${e.since}` : ''}`];
    if (e.previous_conclusion && Object.keys(e.previous_conclusion).length) lines.push(`previous conclusion: ${esc(JSON.stringify(e.previous_conclusion)).slice(0, 300)}`);
    if (t) {
      // What arrived since the last judgement is what has to be judged, so a
      // thread carries everything after its watermark (capped), plus a line of
      // context before it. A new thread gets its most recent messages.
      const all = t.messages ?? [];
      let msgs;
      if (e.since) {
        const idx = all.findIndex((m) => String(m.at ?? '') > String(e.since));
        const from = idx < 0 ? all.length : idx;
        msgs = all.slice(Math.max(0, from - 1), from + CAP.msgsPerThread);
        if (all.length - from > CAP.msgsPerThread) lines.push(`  (${all.length - from} new messages; the last ${CAP.msgsPerThread} shown — read integrations/imessage.json for chat_id ${e.chat_id} if the judgement needs the rest)`);
      } else msgs = all.slice(-CAP.msgsPerThread);
      for (const m of msgs) lines.push(`  ${m.at} ${m.from_me ? 'Alex' : nameOf(m.who) || 'them'}: ${esc(m.text).slice(0, 240)}${e.since && String(m.at ?? '') <= String(e.since) ? '  ← before the watermark, for context' : ''}`);
      if (t.awaiting_reply_hours) lines.push(`  awaiting his reply: ${t.awaiting_reply_hours}h`);
    } else if (extract) lines.push('  (thread not in the extract)');
    return lines.join('\n');
  });
  const more = need.length > CAP.threads ? `\n\n…and ${need.length - CAP.threads} more threads need judgement (see integrations/imessage-changed.json).` : '';
  return head + '\n\n' + blocks.join('\n\n') + more;
}

/* ----------------------------------------------------------------- digest */

/**
 * Where a filed thread lives, so the brief can link it.
 *
 * CLAUDE.md has told briefs since 2026-09-17 to "link the thread only for
 * something that is not a to-do at all — a digest line, an awareness item, a
 * thread he might want to read", and the digest section handed the model a
 * sender, a subject and a sentence. No id, no link. So the rule could only be
 * obeyed by inventing one, which the audit then caught — a rule with no
 * mechanism, the failure this repo keeps meeting.
 *
 * It is the MAIL PANE, not the thread page: `/mail#pane=<account>:<id>` is
 * where he can read it, mark it, silence the sender or reply, and the thread
 * page is a dead end he asked to stop linking on 2026-09-19. The colon is
 * encoded because the hash is a bag of `k=v` pairs — see web/histate.mjs.
 */
export function mailLink(t) {
  const account = t?.account || 'personal';
  const id = t?.thread_id;
  if (!id || !/^[0-9a-f]{4,32}$/.test(String(id))) return null;
  return `/mail#pane=${encodeURIComponent(`${account}:${id}`)}`;
}

/**
 * The senders he asked to always see, named individually and never capped away.
 *
 * Alex, 2026-09-19, choosing what `reading-senders.json` should DO: "keep the
 * rule with the list, instead just use that list to guarantee that it is shown
 * in the brief, and if you want to read it you just click on it."
 *
 * It used to be a tier assignment — mail from a listed sender was filed as
 * `reading` and lived behind the Newsletter pill, which is a second place to
 * go and therefore a third touchpoint. As a VISIBILITY PROMISE instead it costs
 * him no navigation: the thing he said he wants to see gets its own line in the
 * brief with a link, and reading it is one tap from there.
 *
 * The promise is only worth something if it cannot be broken quietly, so these
 * rows are lifted out before the per-tier cap is applied. A list of forty other
 * receipts must never be what pushes the one he asked for into "…and 12 more".
 */
async function digestSince(vault, blind) {
  const state = await jsonFile(vault, 'integrations/email-state.json', blind, 'email-state.json');
  if (!state) return null;
  /* NOT through jsonFile: a missing list here is an empty list, not a source
     that could not be read. He has pressed "read in full" zero times, which is
     a fact about his list and not a fault — reporting it under `## blind` would
     put a false "I could not read this" line in every brief until he does. */
  let senders = {};
  try { senders = JSON.parse(await readFile(join(vault, 'integrations', 'reading-senders.json'), 'utf8')).senders ?? {}; }
  catch (err) { if (err?.code !== 'ENOENT') blind.push(`reading-senders.json: ${err.message}`); }
  const keys = Object.keys(senders).map((k) => k.toLowerCase());
  const asked = (c) => {
    const who = String(c?.who ?? '').toLowerCase();
    const at = who.lastIndexOf('@');
    const domain = at === -1 ? '' : who.slice(at);
    return keys.some((k) => (k.startsWith('@') ? k === domain : k === who));
  };
  let cursor = null; try { cursor = JSON.parse(await readFile(join(vault, '.log', 'digest-cursor.json'), 'utf8')); } catch {}
  const since = Math.max(Date.now() - 7 * 86400000, parseMs(cursor?.through) || Date.now() - 86400000);
  /* NOT `digest` OR `reading` ANY MORE. Alex, 2026-09-21: the written digest
     is appended to each brief and archived with it, so those two tiers arrive
     as a finished document rather than as material for the brief model to
     narrate a second time. Two models writing about the same threads in the
     same message is exactly the duplication the rework removed.

     `awareness` and `memory` stay, because nothing else reports them, and so
     does the `surfaced_for` due-today mechanism below, which the appended
     digest does not carry. */
  const TIERS = ['awareness', 'memory'];
  /* The same window digest.mjs prints, from the same function — two copies of
     this filter would be two different digests. `reasonFor` also says WHY each
     row is here, which is what keeps the arrival and the day-of reminder from
     reading as the same line twice. */
  const all = [];
  for (const t of state.threads ?? []) {
    if (!t.conclusion || !TIERS.includes(t.conclusion.tier)) continue;
    const why = reasonFor(t, since);
    if (why) all.push({ ...t, why });
  }
  /* AND THE TEXTS. Review item 6, 2026-09-20: the message triage had no tiers,
     so a text worth knowing about and owing nothing had nowhere to go — it
     was an obligation or it was nothing. It carries a tier now, the same
     window applies, and an awareness text with a `surfaced_for` comes back on
     its morning exactly as a mail does. Missing file is an empty list, not a
     blind source: the Mac may simply never have synced. */
  let msgs = null;
  try { msgs = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8')); }
  catch (err) { if (err?.code !== 'ENOENT') blind.push(`imessage-state.json: ${err.message}`); }
  for (const t of msgs?.threads ?? []) {
    if (!t.conclusion || !TIERS.includes(t.conclusion.tier)) continue;
    const why = reasonFor(t, since);
    if (why) all.push({ ...t, why, channel: 'text' });
  }
  all.sort((a, b) => parseMs(b.reviewed) - parseMs(a.reviewed));
  const due = all.filter((t) => t.why === 'due').sort((a, b) => dueAt(a.conclusion) - dueAt(b.conclusion));
  const news = all.filter((t) => t.why === 'new');
  // Lifted out BEFORE the tier cap, so the promise cannot be broken by volume.
  const yours = news.filter((t) => asked(t.conclusion));
  const rows = news.filter((t) => !asked(t.conclusion));
  const byTier = {}; for (const t of rows) (byTier[t.conclusion.tier] ??= []).push(t);
  return { since: localStamp(new Date(since)), cursor: !!cursor, total: all.length,
           byTier, rows, due, yours, ahead: upcoming(state.threads, TIERS) };
}

/* ------------------------------------------------------------------ main */

/**
 * The stamp of the brief before this one, from its filename. Brief input runs
 * before the new brief is written, so the newest brief on disk is the previous
 * one — which makes "since the last brief" exact rather than "the last 24h",
 * and stops a change being announced twice or not at all.
 */
export async function previousBriefStamp(vault) {
  const { readdir } = await import('node:fs/promises');
  let names = [];
  try { names = (await readdir(join(vault, 'messages'))).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{4}-brief\.md$/.test(f)).sort(); }
  catch { return null; }
  const last = names[names.length - 1];
  return last ? `${last.slice(0, 10)} ${last.slice(11, 13)}:${last.slice(13, 15)}` : null;
}

/** Ledger rows since a stamp, as brief lines. Pure; exported for the tests. */
export function diaryChanges(rows, since) {
  return (rows ?? [])
    .filter((r) => !since || String(r.at) > String(since))
    .map((r) => r.action === 'removed'
      ? `- removed **${r.title}** (${r.when}) — ${r.why}`
      : `- added **${r.title}**, ${r.when}${r.location ? ` at ${r.location}` : ''} — ${r.why}`);
}

/**
 * What the drafting pass did to drafts waiting for him since the last brief.
 * Pure; exported for the tests. Alex, 2026-09-15: a draft that disappears
 * from the Outbox without a word is the assistant deciding something behind his
 * back, even when it was right to.
 */
export function draftChangeLines(rows, since) {
  const q = (t) => `"${String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 90)}${String(t ?? '').length > 90 ? '…' : ''}"`;
  return (rows ?? [])
    .filter((r) => !since || String(r.at) > String(since))
    .map((r) => r.action === 'rewrote'
      ? `- rewrote the ${r.kind === 'mail' ? 'email' : 'text'} to **${r.to}** — now ${q(r.text)} — ${r.why}`
      : r.action === 'closed'
        ? `- closed **${r.title}** because the ${r.kind === 'mail' ? 'email' : 'text'} to **${r.to}** went out — ${q(r.text)} — ${r.why} (link: /todo#pane=${encodeURIComponent(r.obligation ?? '')})`
        : `- threw away the ${r.kind === 'mail' ? 'email' : 'text'} to **${r.to}** — ${q(r.text)} — ${r.why}`);
}

/**
 * Open things he owes one person, with what he has sent or said to that person
 * since the item began. Pure over rows already fetched; exported for the tests.
 *
 * Alex, 2026-09-15, of that morning's brief: "I did sent them yesterday" and
 * "I did call right away". The brief said nothing had gone to Henry Pike and
 * that Ruth Ellis's call had not happened, because it read the item and not
 * the other channels. This is not proof either way — an email to Henry may be
 * about something else — so it is handed over as a fact to check, never a close.
 */
export function inTouchLines(items) {
  return items.filter((x) => x.rows?.length).map((x) => {
    const recent = x.rows.slice(-2);
    const more = x.rows.length - recent.length;
    return `- \`${x.o.id}\` ${x.o.who} — ${esc(x.o.title).slice(0, 90)} (open since ${String(x.o.since).slice(0, 10)})\n`
      + `  in the last three days: ${recent.map((r) => `${r.channel} ${String(r.at).slice(5, 16)}${r.detail ? ` (${esc(r.detail).slice(0, 60)})` : ''}`).join('; ')}`
      + (more ? ` — and ${more} more` : '');
  });
}

export async function briefInput(vault = OBLIGATIONS, slot = 'morning', { now = new Date() } = {}) {
  if (!SLOTS.includes(slot)) throw new Error(`slot must be one of ${SLOTS.join(', ')}`);
  const blind = [];
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - 86400000));
  const tomorrow = day(new Date(now.getTime() + 86400000));
  // Monday's brief carries the week (the review the Sunday evening brief used
  // to write), so its priorities look back seven days, not one.
  const weekly = slot === 'morning' && now.getDay() === 1;
  const sinceMs = now.getTime() - (weekly ? 7 : 1) * 86400000;

  let [hlth, pri, open, cal, conf, closed, verdicts, nowMd, reminders, decisions] = await Promise.all([
    guarded('pipeline-health', blind, () => health(vault)),
    guarded('priorities', blind, () => priorities(vault, { sinceMs })),
    guarded('obligations', blind, () => listObligations(vault)),
    jsonFile(vault, 'integrations/calendar.json', blind, 'calendar.json'),
    guarded('conflicts', blind, () => conflicts(vault)),
    guarded('closed', blind, () => closedSince(vault, slot === 'morning' ? yesterday : today)),
    guarded('verdicts', blind, async () => (await import('./verdict.mjs')).verdicts(vault, BRIEF_VERDICT_SCOPES)),
    text(vault, 'now.md', blind),
    text(vault, 'reminders.md', blind),
    text(vault, 'decisions.md', blind),
  ]);
  // One read of the list, split: the open half is the brief's list, the closed
  // half is what a diary entry or a hand-kept line is checked against.
  const everything = open;
  open = everything ? everything.filter((o) => o.open) : null;
  const closedObs = (everything ?? []).filter((o) => !o.open && o.closed_at);
  const [changed, extract, gmailChanged, journalToday, journalYesterday] = await Promise.all([
    jsonFile(vault, 'integrations/imessage-changed.json', blind, 'imessage-changed.json'),
    jsonFile(vault, 'integrations/imessage.json', blind, 'imessage.json'),
    jsonFile(vault, 'integrations/gmail-changed.json', blind, 'gmail-changed.json'),
    text(vault, `journal/${today}.md`, [], 'journal today'),
    text(vault, `journal/${yesterday}.md`, [], 'journal yesterday'),
  ]);
  const evening = slot === 'evening';
  // What only the evening brief carried until 2026-10-24 is the morning's now.
  const brief = slot === 'morning';
  const [stl, proj, dig] = await Promise.all([
    brief ? guarded('stale', blind, () => stale(vault)) : null,
    brief ? guarded('projects-propose', blind, () => propose(vault)) : null,
    slot === 'morning' ? digestSince(vault, blind) : null,
  ]);

  const S = [];
  const section = (title, body) => { if (body != null && String(body).trim()) S.push(`## ${title}\n\n${String(body).trim()}`); };
  // A file quoted verbatim keeps its headings one level down, so the document's
  // own sections stay the skeleton a reader (or a test) can walk.
  const verbatim = (t) => String(t ?? '').replace(/^(#{1,3}) /gm, (m, h) => '#'.repeat(Math.min(h.length + 2, 5)) + ' ');

  // 1. Health first: a brief written on a stale pipeline should say so in its first line.
  if (hlth) section('pipeline health', hlth.ok ? 'all sources fresh.' : hlth.problems.map((p) => `- ! ${esc(typeof p === 'string' ? p : p.what ?? JSON.stringify(p))}`).join('\n'));
  // 2. His judgement calls outrank every prose rule.
  // What the assistant put in or took out of his diary since the last brief.
  // Alex, 2026-09-14: "how can we make the assistant make schedule changes, as
  // long as it calls it out in the briefs expressively." The permission to add
  // an entry is only safe because of this section — an entry he was not told
  // about is the assistant arranging his week behind his back.
  await guarded('diary changes', blind, async () => {
    const { readChanges } = await import('./integrations/calendar-write.mjs');
    const since = await previousBriefStamp(vault);
    const rows = diaryChanges(await readChanges(vault), since);
    if (rows.length) {
      section(`put in your diary by the assistant since the last brief · ${rows.length}`,
        rows.join('\n')
        + '\n\nLEAD THE BRIEF WITH THIS, before anything else. He agreed to the assistant '
        + 'making calendar entries on the condition that every one is called out '
        + 'plainly: what it added, when, why, and that he can say "take it off" or '
        + 'delete it in Calendar. One line each, in words — never the marker.');
    }
  });

  /* Obligations the assistant corrected against the record since the last brief.
   *
   * The same argument as the two sections around it, and it is the condition
   * the correcting was granted on. Alex, 2026-09-20, on the Pinecrest task that
   * insisted for six days he had no room: "Correct the obligation." An
   * obligation whose facts change silently is the assistant deciding what he owes
   * behind his back — worse than a vanishing draft, because he acts off this
   * list. So every rewrite is named, with the sentence it replaced. */
  await guarded('obligation corrections', blind, async () => {
    const rows = await changesSince(vault, await previousBriefStamp(vault));
    if (rows.length) {
      section(`obligations corrected against the record · ${rows.length}`,
        rows.map((c) => (c.action === 'handed_off'
          ? `- **${c.code ?? c.id}** ${esc(c.title)}\n  - ${esc(c.from ?? 'they')} handed it to ${esc(c.to)} — it will not be chased again\n  - on: ${esc(c.why).slice(0, 140)}`
          : c.action === 'reopened'
          ? `- **${c.code ?? c.id}** reopened by ${esc(c.by ?? '?')}\n  - on: ${esc(c.why).slice(0, 140)}`
          : `- **${c.code ?? c.id}** ${esc(c.title)}\n  - was: ${esc(c.was).slice(0, 140)}\n  - now: ${esc(c.now).slice(0, 140)}\n  - on: ${esc(c.why).slice(0, 140)}`)).join('\n')
        + '\n\nName each one near the top, in a sentence: what the assistant had been telling him, '
        + 'what is actually true, and what it was checked against. If a correction means he no '
        + 'longer owes something, say that plainly — that is the part he acts on.');
    }
  });

  // Drafts the assistant rewrote or threw away since the last brief.
  await guarded('draft changes', blind, async () => {
    const { readDraftChanges } = await import('./drafts.mjs');
    const rows = draftChangeLines(await readDraftChanges(vault), await previousBriefStamp(vault));
    if (rows.length) {
      section(`drafts the assistant changed since the last brief · ${rows.length}`,
        rows.join('\n')
        + '\n\nSay each one in a line, near the top: what it threw away, rewrote or CLOSED, and why. A close is the one that removed something from his list — say what and on what send. A draft '
        + 'that vanishes from his Outbox without a word is the assistant deciding behind his back. '
        + 'A text that was thrown away can be brought back — say so once if any were.');
    }
  });

  if (verdicts) {
    const vs = [...verdicts].reverse();
    const shown = vs.slice(0, VERDICT_CAP);
    section(`verdicts he has made on cases like these (${BRIEF_VERDICT_SCOPES.join(', ')} — a line here outranks any other rule; the triages carry their own) · ${vs.length}`,
      (shown.length ? shown.map((v) => `- ${v.date} [${v.scope}] ${esc(v.call)}${v.why ? ` — ${esc(v.why)}` : ''}`).join('\n') : 'none yet')
      + (vs.length > shown.length ? `\n\n…and ${vs.length - shown.length} older, in rules/verdicts.md` : ''));
  }
  // 3. Priorities: what he is for, and what moved on each.
  if (pri && !pri.error) {
    const lines = [`movement since ${pri.since}`];
    for (const p of pri.priorities ?? []) {
      if (p.untagged) { lines.push(`- **${p.title}** — no #tag; nothing can join it`); continue; }
      const moved = [['closed', p.closed], ['new', p.fresh], ['overdue', p.overdue], ['due this week', p.dueSoon], ['undecided', p.undecided]].filter(([, xs]) => xs?.length);
      lines.push(`- **${p.title}** #${p.tag} — ${p.open} open` + (p.note ? ` — ${esc(p.note)}` : ''));
      for (const [k, xs] of moved) lines.push(`  - ${k}: ${xs.map((o) => esc(o.title)).slice(0, 6).join('; ')}${xs.length > 6 ? ` (+${xs.length - 6})` : ''}`);
      if (!moved.length) lines.push('  - nothing moved');
    }
    const u = pri.unattached ?? {};
    lines.push(`- on no priority: ${u.count ?? '?'} of ${u.of ?? '?'} open (${u.owedByMe ?? '?'} owed by him)`);
    section('priorities — the projects he is for (the `focus:` line in each project file is his; the agent never writes it)', lines.join('\n'));
  } else if (pri?.error) blind.push(`priorities: ${pri.error}`);
  /* 3b. Today's order (rank.mjs). Alex, 2026-10-09: "we need to sort the
     high ones internally." Ranked at 06:45; the morning brief leads with the
     first three. His own order when he has moved one today. */
  if (open) {
    try {
      const { todaysOrder } = await import('./agent-service/rank.mjs');
      const t = await todaysOrder(vault, { open });
      const byId = new Map(open.map((o) => [o.id, o]));
      if (t.order.length) {
        section(`today's order — the top ${t.top}, ${t.his ? 'in his own order' : `ranked ${String(t.ranked_at ?? '').slice(11)}`}`,
          t.order.map((r) => { const o = byId.get(r.id); return `${r.n}. ${o ? obLine(o) : r.id}${r.why ? ` — why: ${esc(r.why)}` : ''}`; }).join('\n')
          + (t.suggest.length ? '\n\nSuggested flag changes (his to make; never make them yourself):\n' + t.suggest.map((x) => `- ${esc(byId.get(x.id)?.title ?? x.id)} → ${x.to}: ${esc(x.why)}`).join('\n') : ''));
      } else if (slot === 'morning') {
        section("today's order", 'not ranked today — say so in one line rather than inventing an order.');
      }
    } catch (err) { blind.push(`today's order: ${String(err?.message ?? err)}`); }
  }
  // 4. Obligations, bucketed the way tasks.mjs prints them.
  if (open) {
    const todayRows = sortObligations(open.filter(isToday), 'due');
    const rest = open.filter((o) => !isToday(o));
    const upcoming = sortObligations(rest.filter((o) => o.due && mine(o)), 'due').filter((o) => (o.lead_days ?? 99) <= 14);
    const waitYou = sortObligations(rest.filter((o) => !o.due && mine(o)));
    // Longest wait first for the others' bucket: the one he has been waiting
    // on for a month is the one worth a sentence.
    let waitThem = sortObligations(rest.filter((o) => !mine(o)));
    try {
      const { loadContext } = await import('./context.mjs');
      const ctx = await loadContext(vault, { now: now.getTime(), open });
      waitThem = await withWait(waitThem, ctx.about, now);
    } catch (err) { blind.push(`how long each wait has been quiet (the ages below are when each started): ${String(err?.message ?? err)}`); }
    waitThem.sort((a, b) => (b.waited ?? b.days ?? 0) - (a.waited ?? a.days ?? 0));
    const chased = await import('./agent-service/obligation-state.mjs').then((m) => m.readObligationState(vault)).then((d) => d.chased).catch(() => ({}));
    const b = (title, rows, cap, what = false, waiting = null) => { const { rows: r, more } = capList(rows, cap); return `### ${title} · ${rows.length}\n\n${r.length ? r.map((o) => obLine(o, { what, waiting })).join('\n') : 'none'}${more ? `\n…and ${more} more (node deploy/tasks.mjs --json)` : ''}`; };
    const overTwoWeeks = waitThem.filter((o) => (o.waited ?? o.days ?? 0) >= 14).length;
    section(`obligations · ${open.length} open (one list, merged from every source — do not re-read todo.md or reminders.md for this)`,
      [b('today (due today, overdue, or high with no date)', todayRows, CAP.today, true), b('upcoming within 14 days', upcoming, CAP.upcoming),
       b('waiting on you (no date)', waitYou, CAP.waitingYou),
       b('waiting on others (longest wait first; each line says how long and when it was last chased)', waitThem, CAP.waitingThem, false, chased)
       + (overTwoWeeks ? `\n\n${overTwoWeeks} of these have waited two weeks or more. Say so in a sentence — who, what, how long — a wait that long is a decision about whether to keep waiting, and it is his.` : '')].join('\n\n'));
    // A promise with his name on it, unanswered. The triage marks these high
    // (see the skills); this pulls them out so a brief cannot bury one in a
    // list of 190. Alex, 2026-09-08: "How could I have this more highly
    // posted in the brief."
    // The merge keeps a source's detail on its evidence, not on the item.
    const promisedOn = (o) => (o.evidence ?? []).map((e) => e.detail?.promised).find(Boolean) ?? null;
    const promises = open.filter((o) => mine(o) && promisedOn(o));
    if (promises.length) {
      // Where he went afterwards, offered as a question rather than an answer.
      // Alex, 2026-09-10, after being told he had not run the Icon keys down
      // when he had — his phone put him at the airport ninety minutes after he
      // said he would: "maybe not a conclusion but a proactive prompt."
      const { unusualStays } = await import('./agent-service/location.mjs');
      const lines = [];
      for (const o of sortObligations(promises)) {
        const on = promisedOn(o);
        lines.push(`${obLine(o, { what: true })}\n  he said so on ${on}`);
        const went = await unusualStays(vault, { since: `${String(on).slice(0, 10)} 00:00` })
          .catch(() => []);
        const real = went.filter((v) => v.minutes >= 5).slice(0, 3);
        if (real.length) {
          lines.push('  since then his phone put him at: '
            + real.map((v) => `${v.place} (${v.from.slice(5, 16)}, ${v.minutes}m)`).join('; '));
        }
      }
      section(`he said he would, and has not · ${promises.length}`,
        lines.join('\n')
        + '\n\nHis own words to another person, not a task he set himself. Lead with them.'
        + '\n\nWhere his phone put him is a PROMPT, never a conclusion. Standing at an '
        + 'airport is not handing over a set of keys. If a place plausibly matches a '
        + 'promise, ask him whether it is done — do not close it, and do not assert it '
        + 'happened. Places he goes all the time are already filtered out; what is listed '
        + 'is somewhere he does not usually go and did not merely drive past.');
    }

    // He has been in touch with the person since. Alex, 2026-09-15: "I did
    // sent them yesterday" / "I did call right away".
    await guarded('in touch since', blind, async () => {
      const { contactSince, handlesFor, loadContactFiles } = await import('./agent-service/contact.mjs');
      const { loadContacts } = await import('./agent-service/contacts.mjs');
      const [book, files] = await Promise.all([loadContacts(vault), loadContactFiles(vault)]);
      // The last three days only. What a brief gets wrong is the recent past —
      // "yesterday", "sixteen hours ago" — and an item open since February has
      // months of unrelated mail to the same person, which says nothing and
      // costs the budget the obligations need.
      const floor = localStamp(new Date(now.getTime() - 3 * 86400000));
      const items = [];
      for (const o of open.filter((x) => mine(x) && x.since && x.who)) {
        if (!handlesFor(book, o.who).size) continue;          // a group, or nobody the book knows
        const from = String(o.since) > floor ? o.since : floor;
        items.push({ o, rows: await contactSince(vault, o.who, from, { contacts: book, files }) });
      }
      const lines = inTouchLines(items);
      if (lines.length) {
        const { rows: r, more } = capList(lines, 20);
        section(`you have been in touch since · ${lines.length}`,
          r.join('\n') + (more ? `\n…and ${more} more` : '')
          + '\n\nThings he owes one person, and what he sent or said to that person in the last three days '
          + '— texts, sent email, connected calls, on any channel. BEFORE writing that something has not '
          + 'happened — "nothing has gone", "you have not called", "still unanswered" — look here. If he '
          + 'was in touch, say what went and when, and ask whether it settles the item: "you emailed Henry '
          + 'at 14:04 yesterday — was that the plans?" Never assert it is undone. Never close on this alone '
          + 'either: contact with a person is not proof this particular thing was dealt with.');
      }
    });

    const tagged = (t) => open.filter((o) => o.tags?.includes(t));
    const bd = tagged('birthday'); if (bd.length) section('birthdays today', bd.map((o) => obLine(o, { what: true })).join('\n'));
    const dc = tagged('decision'); if (dc.length) section('decisions waiting on him', dc.map((o) => obLine(o, { what: true })).join('\n'));
  }
  // 5. Calendar, with each attendee's line from people/ already joined.
  if (cal) {
    const cache = new Map();
    const todays = (cal.today ?? []);
    const upcoming = (cal.upcoming ?? []).filter((e) => e.startsOn === tomorrow);
    const blocks = [];
    for (const e of todays) blocks.push(await eventBlock(vault, e, cache) + doneNote(e.summary, e.startsOn ?? today, closedObs));
    section(`calendar today · ${todays.length}${cal.updated ? ` (calendar.json ${cal.updated})` : ''}`, blocks.length ? blocks.join('\n') : 'nothing on the calendar today');
    if (brief) {
      const tb = []; for (const e of upcoming) tb.push(await eventBlock(vault, e, cache) + doneNote(e.summary, e.startsOn ?? tomorrow, closedObs));
      section(`calendar tomorrow (${tomorrow}) · ${upcoming.length}`, tb.length ? tb.join('\n') : 'nothing on the calendar tomorrow');
    }
  }
  // 5b. Where he is and has been today, from the phone. Absent when the app
  // has never reported; that absence is a fact, not a failure.
  const here = await whereNow(vault).catch(() => null);
  if (here) {
    const ds = await dayStays(vault, today).catch(() => ({ stays: [] }));
    const lines = [`now: ${here.place ?? `${here.lat}, ${here.lon}`} since ${here.since}${here.age_min > 90 ? ` (last report ${here.age_min} min ago)` : ''}`];
    for (const st of ds.stays) lines.push(`- ${st.from.slice(11, 16)}–${st.to.slice(11, 16)} ${st.place ?? `${st.lat}, ${st.lon}`} (${st.minutes} min)`);
    section('where he is (from the phone)', lines.join('\n'));
  }

  // 5c. Conditions: what is open now, and what cleared today. A condition is
  // awareness with state — the triage keys the alert and its recovery.
  const cond = await guarded('conditions', blind, () => conditions(vault));
  // One open past a day is a to-do now and reaches the brief through the
  // merged list; it is counted here, not listed twice (2026-10-17).
  const live = cond ? cond.open.filter((c) => !c.stuck) : [];
  const stuck = cond ? cond.open.length - live.length : 0;
  if (cond && (cond.open.length || cond.resolved.length)) {
    const lines = [];
    if (stuck) lines.push(`- ${stuck} open more than a day with no all-clear: each is a to-do now, in the merged list above — report it there, not here`);
    for (const c of live) lines.push(`- OPEN ${c.severity !== 'normal' ? c.severity.toUpperCase() + ' ' : ''}${c.key} — ${esc(c.what)} — since ${c.since} (${c.minutes} min)`);
    for (const c of cond.resolved) lines.push(`- cleared ${c.key} — ${esc(c.what)} — ${c.opened ?? '?'} → ${c.resolved}${c.minutes != null ? ` (${c.minutes} min)` : ''}`);
    section(`conditions · ${live.length} open, ${stuck} moved to the to-do list, ${cond.resolved.length} cleared today`, lines.join('\n'));
  }

  // 6. Conflicts: only wrong when two sources are read together.
  if (conf) {
    const rows = conf.conflicts ?? conf.rows ?? [];
    const lines = rows.map((c) => `- ${c.kind} ${c.when ?? ''} — ${esc(c.what)} — ${esc(c.why)}${c.trip ? ` [${c.trip}]` : ''}`);
    if (conf.blind?.length) lines.push(...conf.blind.map((b) => `- BLIND: ${esc(b)}`));
    section(`conflicts · ${rows.length}`, lines.length ? lines.join('\n') : 'none found; every source was readable');
  }
  // 7. Closed since the last brief — the cross-check. Yesterday's closes were
  // the evening brief's until 2026-10-24; the morning brief tells them now,
  // so the window is from the previous brief, not from midnight.
  if (closed && !closed.error && brief) {
    const since = await previousBriefStamp(vault);
    const rows = closed.rows.filter((r) => !since || `${r.date} ${r.time ?? ''}` > since);
    section(`closed since the last brief${since ? ` (${since})` : ''} · ${rows.length}`, rows.length ? rows.map((r) => `- ${r.date} ${r.time ?? ''} ${esc(r.title ?? r.what).slice(0, 120)} — by ${r.who ?? r.by ?? '?'}${r.agent ? ' (agent)' : ''}${r.outcome ? ` — ${esc(r.outcome).slice(0, 200)}` : ''}`).join('\n') : 'nothing closed since the last brief');
  } else if (closed && !closed.error) {
    // The title, never the logbook's `what`: that field is the whole
    // conclusion, and four closes at 3KB each pushed the evening input past
    // its budget on 2026-09-20. The outcome is the cross-check; the title is
    // the handle.
    section(`closed today · ${closed.rows.length}`, closed.rows.length ? closed.rows.map((r) => `- ${r.at ?? ''} ${esc(r.title ?? r.what).slice(0, 120)} — by ${r.who ?? r.by ?? '?'}${r.agent ? ' (agent)' : ''}${r.outcome ? ` — ${esc(r.outcome).slice(0, 200)}` : ''}`).join('\n') : 'nothing closed yet today');
  }
  // 7b. The trust ledger: is the assistant earning its closes? One line a day,
  // RECORDED by the evening assembly because 18:00 is the one moment a day is
  // whole; read-only over every other record, its own line is the one write.
  // The morning brief TELLS the last line recorded (since 2026-10-24).
  if (brief) {
    await guarded('trust', blind, async () => {
      const { readTrust, trustLine, trend } = await import('./trust.mjs');
      const rows = await readTrust(vault);
      const row = rows[rows.length - 1] ?? null;
      const t = trend(rows);
      section(`trust — the assistant's own scorecard${row?.date ? ` for ${row.date}` : ''}`,
        trustLine(row)
        + (t ? `\n\nlast ${t.days} days: the assistant closed ${t.closed_agent}, he closed ${t.closed_him}, ${t.reopened} reopened, ${t.dismissed} dismissed as not a task; findings ${t.findings_delta >= 0 ? '+' : ''}${t.findings_delta}; median wait on others ${t.owed_them_median_delta >= 0 ? '+' : ''}${t.owed_them_median_delta}d; ${t.over_14_delta >= 0 ? '+' : ''}${t.over_14_delta} past two weeks` : '')
        + '\n\nOne sentence at the end of the brief, in words, under whatever heading closes it: what the assistant did to his list yesterday and whether he agreed with it — reopened and dismissed are the disagreements. Never the field names.');
    });
  }
  if (evening) {
    await guarded('trust', blind, async () => {
      const { measure, record, readTrust, trustLine, trend } = await import('./trust.mjs');
      const row = await measure(vault, { now, open: open ?? null });
      await record(vault, row);
      const rows = await readTrust(vault);
      const t = trend(rows);
      section('trust — the assistant\'s own scorecard',
        trustLine(row)
        + (t ? `\n\nlast ${t.days} days: the assistant closed ${t.closed_agent}, he closed ${t.closed_him}, ${t.reopened} reopened, ${t.dismissed} dismissed as not a task; findings ${t.findings_delta >= 0 ? '+' : ''}${t.findings_delta}; median wait on others ${t.owed_them_median_delta >= 0 ? '+' : ''}${t.owed_them_median_delta}d; ${t.over_14_delta >= 0 ? '+' : ''}${t.over_14_delta} past two weeks` : '')
        + '\n\nOne sentence at the end of the brief, in words, under whatever heading closes it: what the assistant did to his list today and whether he agreed with it — reopened and dismissed are the disagreements. Never the field names.');
    });
  }
  // 8. Messages: what changed, with everyone named.
  section('messages — what changed since the last judgement (imessage-changed.json; participants already resolved)', messagesSection(changed, extract, blind));
  // 9. Mail: what is filed and waiting.
  if (gmailChanged) {
    const c = gmailChanged.counts ?? {};
    section('mail pipeline', `waiting for the mail job: ${(gmailChanged.needs_judgement ?? []).length} thread(s) · counts: ${Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')} · list generated ${gmailChanged.generated_at ?? '?'}\n\nThe brief does not judge mail; the mail job does. Report the backlog if it is large.`);
  }
  if (dig) {
    const parts = [`${dig.total} filed since ${dig.since}${dig.cursor ? '' : ' (no cursor yet — first digest)'}`];
    /* THE DAY HAS COME. Alex, 2026-09-19: "I need to be made aware of the
       email before the date, with a reminder on the date." He was told about
       each of these when it arrived, possibly weeks ago; this is the reminder,
       and it is the most time-critical thing in the whole filed set — the
       Justworks cutoff was at 2pm on its day. Lead with it, and say it is a
       reminder, so it does not read as news he has never seen. */
    if (dig.due?.length) {
      parts.push(`### DUE TODAY · ${dig.due.length}\n`
        + capList(dig.due, CAP.digest).rows.map((t) => `- ${t.conclusion.surfaced_for} — ${t.conclusion.who ?? '?'} — ${esc(t.conclusion.title ?? t.conclusion.subject)}: ${esc(t.conclusion.what).slice(0, 160)}${mailLink(t) ? ` — link: ${mailLink(t)}` : ''}`).join('\n')
        + '\n\nThese carry a date and that date is now. He was told when each arrived, so write them as a reminder, not as news. Nothing here is an obligation; if one has become his to do, it is already on the to-do list.');
    }
    /* His own list, every one named. Uncapped on purpose — see digestSince. */
    if (dig.yours?.length) {
      parts.push(`### from senders you asked to always see · ${dig.yours.length}\n`
        + dig.yours.map((t) => `- ${t.conclusion.who ?? '?'} — ${esc(t.conclusion.title ?? t.conclusion.subject)}: ${esc(t.conclusion.what).slice(0, 160)}${mailLink(t) ? ` — link: ${mailLink(t)}` : ''}`).join('\n')
        + '\n\nHe asked to be shown everything from these senders, so name each one with its link — never fold them into a group or a count. Nothing here is owed; it is a list to glance at and tap.');
    }
    /* NOT LISTED HERE ANY MORE. Alex, 2026-10-07: "we need a section on
       Memory and Awareness items, otherwise I never see them." This listing
       handed them to the brief model and no brief had a section for them, so
       they reached nobody. The service now appends them to the finished brief
       under their own heading, each once (filed-section.mjs); the model gets
       the count, so it neither repeats them nor mistakes them for unseen. */
    const n = Object.values(dig.byTier).reduce((s, xs) => s + xs.length, 0);
    if (n) parts.push(`${n} awareness and memory item(s) since ${dig.since}. The service appends them to your brief under "Awareness and memory", one line each with its link. Do not list them, and do not write that heading.`);
    /* Only a COUNT of what is still ahead. Each was already reported on the day
       it arrived; listing them again in all three briefs every day until their
       date is the repetition this file's own rules say to delete a brief over.
       The number is here so that "nothing is coming" and "nobody looked" are
       different sentences. */
    if (dig.ahead?.length) {
      parts.push(`${dig.ahead.length} dated item(s) still ahead, the nearest ${dig.ahead[0].conclusion.surfaced_for}.`
        + ' Each was reported when it arrived and comes back on its own morning. Do not list them.');
    }
    parts.push('After the brief is written and its message file exists, run `node deploy/digest.mjs --mark` to advance the cursor. Not before.');
    // Named for what it now is: the two tiers nothing else reports, plus the
    // day-of reminders. The digest proper is appended to the finished brief.
    section('filed mail to report — awareness and memory', parts.join('\n\n'));
  }
  // 10. Follow-through and projects: the brief's (the evening's until 2026-10-24).
  if (stl && !stl.error) {
    const l = (xs, verb) => (xs ?? []).map((o) => `- ${o.who ?? '?'} — ${esc(o.title)} — ${verb} ${o.days}d${o.channel ? ` · via ${o.channel}` : ''}${o.thread ? ` · thread ${o.thread}` : ''}`);
    // The derived layer against the sources it came from — Sunday only.
    //
    // Alex, 2026-09-10, from the LLM-wiki gist: the one thing this repo did
    // not have was a lint. Four guards, and none of them looked at people/,
    // projects/ or decisions.md at all, though CLAUDE.md says outright that the
    // journal wins when they disagree. Weekly on purpose: a list he acts on
    // beats a daily one he learns to skim, and this is bookkeeping rather than
    // anything with a deadline.
    if (slot === 'evening' && new Date().getDay() === 0) {
      try {
        const { lint } = await import('./lint.mjs');
        const r = await lint(vault);
        const real = r.findings.filter((f) => f.kind !== 'BLIND');
        section(`drift in the derived files · ${real.length} (lint.mjs)`,
          (real.length
            ? real.map((f) => `- **${f.kind}** ${f.file}${f.who ? ` — ${f.who}` : ''}\n  ${f.why}`
                + (f.should ? `\n  says: ${f.said} · should be: ${f.should}` : '')).join('\n')
            : 'nothing has drifted')
          + (r.blind.length ? `\n\nnot checked: ${r.blind.join('; ')}` : '')
          + '\n\nArithmetic only — a date against a date, a name against a list. It reports '
          + 'and changes nothing. Fixing a person file is part of the compaction; deciding a '
          + 'project is done is his call, so propose it rather than editing the status.');
      } catch (err) {
        blind.push(`lint: ${String(err?.message ?? err)}`);
      }
    }

    /* WHY A FOLLOW-UP DID NOT GO. Held chases reached him as a count in a log
       and nowhere else — and since 2026-09-21 the holds are strong enough to
       stop most of them (owed the same company, handed off to a colleague).
       A chase suppressed silently is the same failure as a chase sent wrongly,
       and the reason is the useful half: "you owe Nina an answer" IS the
       next move. */
    await guarded('chases held', blind, async () => {
      const { chases } = await import('./drafts.mjs');
      const c = await chases(vault, { now: now.getTime() });
      const rows = (c.heldRows ?? []).filter((h) => h.why);
      if (!rows.length) return;
      section(`follow-ups held, and why · ${rows.length}`,
        rows.map((h) => `- ${esc(h.who ?? '?')} — ${esc(h.title)} (${h.days ?? 0}d quiet)\n  - ${esc(h.why)}`).join('\n')
        + '\n\nThese are people he is waiting on who were NOT chased. Where the reason is '
        + 'that he owes them an answer, that answer is the move — say so as a sentence, with the link.');
    });

    section('follow-through (stale.mjs)', ['### waiting on them, quiet', ...(l(stl.them, 'quiet').length ? l(stl.them, 'quiet') : ['none']), '', '### owed by you, imminent', ...(l(stl.you, 'due in').length ? l(stl.you, 'due in') : ['none'])].join('\n'));
  }
  if (proj && !proj.error) section('project proposals (projects-propose.mjs)', proj.proposals?.length ? proj.proposals.map((p) => `- ${esc(p.name ?? p.slug)} — ${p.count ?? p.items?.length ?? '?'} open obligations${p.tag ? ` #${p.tag}` : ''}`).join('\n') : 'no clusters without a projects/ file');
  // 11. The files he keeps by hand, verbatim.
  if (reminders) section('reminders.md (verbatim; the dispatcher pushes, the brief judges)', verbatim(reminders));
  if (decisions && brief) section('decisions.md (verbatim; only decide.mjs writes it)', verbatim(decisions));
  if (nowMd) section('now.md (verbatim, capped at 150 lines)', verbatim(datedLinesChecked(nowMd, today, closedObs)));
  if (journalToday) section(`journal today (${today}.md so far — append-only)`, verbatim(journalToday));
  else if (journalYesterday && slot === 'morning') {
    const said = journalYesterday.match(/## Said I'd do[\s\S]*?(?=\n## |$)/);
    if (said) section(`from yesterday's journal — what he said he'd do`,
                      verbatim(await keptSince(vault, said[0], yesterday).catch(() => said[0])));
  }
  // Fitting the budget by trimming lists, never by cutting the tail.
  //
  // Found 2026-09-14 while adding the diary section: the open list had grown
  // from 194 to 231 and the morning input reached 62KB, so the old byte slice
  // had been firing. It cut a sentence in half, and it dropped what comes last —
  // now.md, today's journal, and the `blind` section, which is the one that
  // tells the brief what it could not see. A brief written from that document
  // could not know anything was missing: the silence this repo's guards exist
  // to prevent, produced by the assembler of the brief itself.
  //
  // So when over budget the LARGEST ordinary section loses lines from its end —
  // its lists are sorted most-urgent first, so the end is the least of it — and
  // every cut is written into `blind`, which is built afterwards so it can say
  // so. Sections he was promised always survive whole.
  const header = `# Brief input — ${slot}, assembled ${localStamp(now)}\n\nThis is everything the brief needs, read by code. Write the brief from it. Use the tools only for a follow-up the document does not answer (a grep of people/ or journal/ for one detail), and never to re-run what is already here.\n\n`;
  const KEEP_WHOLE = /^## (put in your diary|drafts the assistant changed|pipeline health|verdicts|he said he would)/;
  const budget = MAX_BYTES - 2048;                       // room for the blind section
  const cuts = [];
  for (let round = 0; round < 12 && Buffer.byteLength(header + S.join('\n\n')) > budget; round++) {
    let idx = -1, size = 0;
    S.forEach((sec, i) => { const b = Buffer.byteLength(sec); if (!KEEP_WHOLE.test(sec) && b > size) { size = b; idx = i; } });
    if (idx < 0 || size < 1500) break;
    const over = Buffer.byteLength(header + S.join('\n\n')) - budget;
    const lines = S[idx].split('\n');
    let keep = lines.length;
    while (keep > 6 && Buffer.byteLength(lines.slice(0, keep).join('\n')) > size - over - 120) keep--;
    const dropped = lines.length - keep;
    if (!dropped) break;
    const title = lines[0].replace(/^## /, '').split(' (')[0].slice(0, 60);
    S[idx] = lines.slice(0, keep).join('\n') + `\n\n[${dropped} more lines not shown — cut to fit the input; the list continues]`;
    cuts.push(`${title}: last ${dropped} lines cut to fit (the scripts have the rest)`);
  }
  const blindLines = [...blind, ...cuts];
  section('blind — sources this document could not read (say so in the brief; do not guess)',
    blindLines.length ? blindLines.map((b) => `- ${b}`).join('\n') : 'nothing; every source was readable');

  let markdown = header + S.join('\n\n') + '\n';
  // The last resort stays, but it should never fire now; if it does, the blind
  // section above has already been cut and the note says so.
  if (Buffer.byteLength(markdown) > MAX_BYTES) {
    markdown = markdown.slice(0, MAX_BYTES) + `\n\n[truncated at ${MAX_BYTES / 1024}KB — including the blind section; treat this input as incomplete]\n`;
  }
  return { generated_at: localStamp(now), slot, bytes: Buffer.byteLength(markdown), sections: S.length, blind, cuts, markdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slot = process.argv.slice(2).find((a) => SLOTS.includes(a)) ?? 'morning';
  const out = await briefInput(OBLIGATIONS, slot);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...out, markdown: undefined }, null, 1));
  else process.stdout.write(out.markdown);
}
