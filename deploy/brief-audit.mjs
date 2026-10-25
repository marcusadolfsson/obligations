#!/usr/bin/env node
/**
 * Audit a brief against the record it was written from.
 *
 * Alex, 2026-09-07, after two briefs asserted things that were not true —
 * one dated his own words a day early, one reported five Gmail drafts as
 * chases he had sent: "Keep re-generating briefs and audit them for similar
 * issues." The reading is the model's; the checking is arithmetic, and this
 * is the arithmetic.
 *
 * Every check answers a question that has one right answer in the repo:
 *
 *   DATE      a day named in the text ("today", "tomorrow", a weekday) must
 *             agree with the brief's own stamp
 *   SENT      a claim that something went out must match a message in SENT,
 *             not a draft — the 2026-09-07 failure
 *   THREAD    a /thread/<account>/<id> link must exist in email-state
 *   TASK      an obligation id must name an obligation that exists (open or
 *             closed — a closed one has a page, and a brief's "closed today"
 *             section is told to link each item)
 *   LINK      a thread linked for something that is an open to-do — the to-do
 *             page is where he can act on it (Alex, 2026-09-17)
 *   COUNT     "N open obligations" must match the list
 *   PERSON    an address quoted as a person must not be a machine
 *   ESCAPED   a brief that blames the pipeline must name a thread that really
 *             escaped — it may not invent a machine failure to explain itself
 *   JARGON    it may not name its own scripts or state files, quote an
 *             internal field, or paste a raw thread path
 *   REPEAT    the brief links each to-do once (2026-10-07)
 *   LONG      the brief stays inside its budget above the digest
 *
 * It cannot check judgement, and does not try. It reports; it changes nothing.
 *
 *   node deploy/brief-audit.mjs [messages/<file>.md] [--json] [--all]
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOpen, listObligations } from './agent-service/obligations.mjs';
import { isMachine } from './agent-service/handles.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/** The frontmatter and body of a message file. Exported for the tests. */
export function parseMessage(raw) {
  const m = String(raw ?? '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(raw ?? '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

/**
 * Dates the text names, and what they should be given when it was written.
 * Exported for the tests.
 */
export function dateClaims(body, atText) {
  const at = new Date(String(atText ?? '').replace(' ', 'T'));
  if (Number.isNaN(at.getTime())) return [];
  const day = (n) => dayKey(new Date(at.getTime() + n * 86400000));
  const out = [];
  // "today, 2026-09-07" / "tomorrow, 2026-09-08" / "yesterday (2026-09-06)"
  for (const m of body.matchAll(/\b(today|tomorrow|yesterday)\b[^.\n]{0,24}?(\d{4}-\d{2}-\d{2})/gi)) {
    /* A day word in quotes is a word being talked about, not one being used.
       The 2026-10-05 morning brief reported a headline it had corrected —
       'said he wanted the meeting "today", which meant 2026-10-03' — and was
       flagged for calling the 3rd today, for doing exactly what the
       no-relative-dates rule asks. */
    const before = body[m.index - 1] ?? '', after = body[m.index + m[1].length] ?? '';
    if (/["“'‘]/.test(before) && /["”'’]/.test(after)) continue;
    const want = { today: day(0), tomorrow: day(1), yesterday: day(-1) }[m[1].toLowerCase()];
    if (want && m[2] !== want) out.push({ kind: 'DATE', text: m[0].trim(), said: m[2], should: want, why: `"${m[1]}" on ${day(0)} is ${want}` });
  }
  // "Alex, 2026-09-06: \"…\"" — an attribution to a day that has not happened
  for (const m of body.matchAll(/(\d{4}-\d{2}-\d{2})\s*:\s*[*"“]/g)) {
    if (m[1] > day(0)) out.push({ kind: 'DATE', text: m[0].trim(), said: m[1], should: `on or before ${day(0)}`, why: 'quoted from the future' });
  }
  // "on Monday" — the weekday of a date named in the same clause
  for (const m of body.matchAll(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b[^.\n]{0,20}?(\d{4}-\d{2}-\d{2})/g)) {
    const d = new Date(m[2] + 'T12:00:00');
    const want = DAYS[d.getDay()];
    if (!m[0].toLowerCase().startsWith(want.slice(0, 3))) out.push({ kind: 'DATE', text: m[0].trim(), said: m[1] + 'day', should: want, why: `${m[2]} is a ${want}` });
  }
  return out;
}

/** Sentences claiming something was sent, with the time they claim. Exported for the tests. */
export function sentClaims(body) {
  const out = [];
  const re = /[^.\n]*\b(sent|went out|has gone|i sent|you sent|chased|replied to them)\b[^.\n]*\./gi;
  for (const m of body.match(re) ?? []) {
    if (/\b(draft|drafted|not sent|never sent|waiting on|unsent|approve)\b/i.test(m)) continue;   // says so itself
    const when = m.match(/\b(\d{4}-\d{2}-\d{2})(?:\s+at\s+|\s+)?(\d{2}:\d{2})?/);
    out.push({ text: m.trim().slice(0, 200), date: when?.[1] ?? null, time: when?.[2] ?? null });
  }
  return out;
}

export async function auditBrief(vault, file) {
  const raw = await readFile(join(vault, file), 'utf8');
  const { meta, body } = parseMessage(raw);
  // A file with no frontmatter — now.md, a journal day — is dated by when it
  // was last written, so the same date arithmetic applies to it.
  const at = meta.at ?? (await stat(join(vault, file))).mtime.toISOString().slice(0, 16).replace('T', ' ');
  const findings = [...dateClaims(body, at)];

  const read = async (p) => { try { return JSON.parse(await readFile(join(vault, p), 'utf8')); } catch { return null; } };
  const mail = await read('integrations/email-state.json');
  const threads = new Map((mail?.threads ?? []).map((t) => [t.thread_id, t]));

  // SENT: a claim of an outbound message on a day, against the drafts sitting
  // in Drafts with that same stamp. This is the 2026-09-07 failure, checkable.
  let drafts = [];
  try {
    const { listDrafts } = await import('./integrations/mail-drafts.mjs');
    const { accountsWith } = await import('./mcp/google-auth.mjs');
    for (const a of await accountsWith('mail', vault)) drafts.push(...await listDrafts(vault, a));
  } catch { /* offline: the SENT check is skipped, and says so below */ }
  const claims = sentClaims(body);
  for (const c of claims) {
    if (!c.date || !c.time) continue;
    const stamp = `${c.date} ${c.time}`;
    const twin = drafts.find((d) => {
      const at = new Date(d.updatedMs ?? 0);
      return !Number.isNaN(at.getTime()) && new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ') === stamp;
    });
    if (twin) findings.push({ kind: 'SENT', text: c.text, said: stamp, should: 'a draft, not a send', why: `a draft to ${twin.to} carries that exact stamp — it is still in Drafts` });
  }
  if (!drafts.length && claims.some((c) => c.date && c.time)) findings.push({ kind: 'SENT?', text: 'drafts could not be read', said: 'unchecked', should: 'checked against Drafts', why: 'no Gmail access from here; the send claims were not verified' });

  // THREAD: every deep link must resolve.
  for (const m of body.matchAll(/\/thread\/([a-z]+)\/([0-9a-f]+)/g)) {
    if (!threads.has(m[2])) findings.push({ kind: 'THREAD', text: m[0], said: m[2], should: 'a thread in email-state', why: 'no such judged thread' });
  }

  // ESCAPED: a brief may not explain an open obligation by inventing a
  // pipeline failure.
  //
  // Alex, 2026-09-08: an evening brief said "the mail pipeline never saw it.
  // The thread left the extract before the mail job could judge it
  // (integrations/gmail-escaped.json)" about a thread that had been judged at
  // 11:24 that morning, was in the current extract, and was in no escaped
  // file. It read as a diagnosis, cited a real file by name, and was fiction.
  // He asked "why can't it self cure?" — and the answer was that there was
  // nothing to cure, which is worse than a broken pipeline: it sent him
  // looking for a bug in the one part that was working.
  //
  // A machine failure is the easiest thing to assert and the hardest for him
  // to check, so it is exactly what has to be checked here. If the brief names
  // escaping, the thread it names must actually be in that file.
  //
  // PER PARAGRAPH, not per brief. Alex, 2026-09-22, of "Audit: 40
  // unsupported claims in the morning brief": the brief said, truthfully, that
  // one thread had left the extract unread — and because the word appeared
  // anywhere, every thread link in the whole brief was held to it, including
  // the twenty receipts in the mail digest appended at its foot. A claim that
  // a thread escaped is made in the sentence that names it; that paragraph is
  // what has to be checked.
  const ESCAPE = /escaped|left the extract|never saw it|pipeline never/i;
  if (ESCAPE.test(body)) {
    let escaped = {};
    try { escaped = JSON.parse(await readFile(join(vault, 'integrations', 'gmail-escaped.json'), 'utf8')); } catch {}
    const claims = body.split(/\n\s*\n/).filter((para) => ESCAPE.test(para)).join('\n\n');
    for (const m of claims.matchAll(/\/thread\/[a-z]+\/([0-9a-f]+)/g)) {
      if (!escaped[m[1]] && threads.has(m[1])) {
        findings.push({ kind: 'ESCAPED', text: m[0], said: 'it escaped the extract',
                        should: 'a thread in gmail-escaped.json',
                        why: 'that thread was judged and is not in the escaped file — the pipeline did see it' });
      }
    }
  }

  // JARGON: the brief may not explain itself by naming its own plumbing.
  //
  // Alex, 2026-09-08, reading the evening brief: "It feels very code like.
  // Can we drop references to Mjs files etc." Across eight briefs it had cited
  // conflicts.mjs, stale.mjs, server.mjs, drafts.mjs, reminder-dispatch.py and
  // gmail-escaped.json, quoted `sent_at` and `needsAction`, and pasted raw
  // thread paths. None of that is information about his day. It is the assistant
  // talking about itself in its own vocabulary, and it makes a brief read like
  // a stack trace at the moment he is trying to decide what to do next.
  //
  // The line is *whose file it is*. A reminder of his that says to re-run
  // login.sh is content and passes — the reminder names it, not the assistant. A
  // module under deploy/ or a state file under integrations/ is plumbing.
  for (const m of body.matchAll(/\b[\w-]+\.(?:mjs|py)\b|\bintegrations\/[\w-]+\.json\b|(?<!\w)\.log\/[\w-]+/g)) {
    findings.push({ kind: 'JARGON', text: m[0], said: m[0], should: 'plain words',
                    why: 'that is one of the assistant\'s own files — say what happened, not which script noticed' });
  }
  // An internal field name in backticks. Deliberately narrow: snake_case or
  // camelCase with no spaces, which is what a field is and what a tail number,
  // an amount or a confirmation code is not.
  for (const m of body.matchAll(/`([a-z]+(?:_[a-z]+)+|[a-z]+[A-Z][a-zA-Z]*)`/g)) {
    findings.push({ kind: 'JARGON', text: m[0], said: m[1], should: 'plain words',
                    why: 'an internal field name — he never sees this word anywhere else' });
  }
  // A deep link is good; a raw path in the middle of a sentence is not. It has
  // to be written as a link with a label, so it reads as a place to go.
  for (const m of body.matchAll(/(.{0,2})(\/thread\/[a-z]+\/[0-9a-f]+)/g)) {
    if (m[1].endsWith('](')) continue;
    findings.push({ kind: 'JARGON', text: m[2], said: 'a bare thread path', should: 'a labelled link',
                    why: 'write it as [the Noah & Co thread](…) so it reads as somewhere to go' });
  }
  for (const m of body.matchAll(/(.{0,2})(\/todo#pane=[^\s)\]]+)/g)) {
    if (m[1].endsWith('](')) continue;
    findings.push({ kind: 'JARGON', text: m[2], said: 'a bare task path', should: 'a labelled link',
                    why: 'write the thing itself as the link, so it reads as somewhere to go' });
  }

  /* TASK: an obligation id must name something that EXISTS — open or closed.
   *
   * It used to demand `open`, and on 2026-09-21 that fired nine times on one
   * midday brief for a section the brief is instructed to write: "Closed since
   * 07:00", with each item linked to its to-do, which is CLAUDE.md's rule for
   * every item a brief describes. The links were correct and they worked — the
   * To Do page grew a Closed view the day before, so a closed obligation has a
   * page now.
   *
   * The failure worth catching is a link to something that is not there at
   * all: an id the model invented, or one from a repo that no longer holds it.
   * Nine false positives in one note is how a channel stops being read, which
   * is the thing this auditor exists to protect.
   */
  const all = await listObligations(vault).catch(() => null);
  if (all) {
    const open = all.filter((o) => o.open);
    const ids = new Set(all.map((o) => o.id));
    /* LINK asks about OPEN to-dos only. Every judged thread is an obligation
       record — a receipt filed as digest is one with `open: false` — so `ids`
       holds all 2,192 of them. When TASK was widened to accept closed items on
       2026-09-21, LINK shared that set and began telling him to link every
       digest receipt to a to-do page: twenty findings on the first brief to
       carry the digest, 2026-09-22. */
    const openIds = new Set(open.map((o) => o.id));
    for (const m of body.matchAll(/`((?:mail|todo|rem|recur|im|decision|birthday):[^`]+)`/g)) {
      if (!ids.has(m[1])) findings.push({ kind: 'TASK', text: m[1], said: m[1], should: 'an obligation that exists', why: 'no obligation has that id — open or closed' });
    }
    // A to-do link has to name a real item, the same as a quoted id.
    for (const m of body.matchAll(/\/todo#pane=([^\s)\]]+)/g)) {
      const id = decodeURIComponent(m[1]);
      if (!ids.has(id)) findings.push({ kind: 'TASK', text: id, said: id, should: 'an obligation that exists', why: 'linked as a to-do, but no obligation has that id' });
    }
    // LINK: the thread, where the to-do was the thing to point at. Alex,
    // 2026-09-17: "the brief needs to link to the to-do if there is one, to the
    // mail thread if not to-do related." The thread is where the words are; the
    // to-do page is where he can close it, move it or draft the reply, and a
    // brief that sends him to read when he could act is sending him the long
    // way round.
    for (const m of body.matchAll(/\]\((\/thread\/([a-z]+)\/([0-9a-f]+))\)/g)) {
      const asTask = `mail:${m[2]}:${m[3]}`;
      if (openIds.has(asTask)) {
        findings.push({ kind: 'LINK', text: m[1], said: 'the mail thread', should: `/todo#pane=${encodeURIComponent(asTask)}`,
                        why: 'this one is an open to-do — link where he can close it, not only where he can read it' });
      }
    }
    // COUNT: only a claim about the whole list. "5 open obligations across
    // three Carta addresses" is a scoped count and true; the check has to see
    // the difference or it cries wolf, which is how a check stops being read.
    for (const m of body.matchAll(/(\d+)\s+open obligations?\b/gi)) {
      const before = body.slice(Math.max(0, m.index - 60), m.index);
      const after = body.slice(m.index + m[0].length, m.index + m[0].length + 40);
      // Scoped either side: "5 open obligations across three Carta addresses",
      // "#phoa — 2 open obligations". Only a claim about the whole list is
      // checkable against the whole list.
      if (/\b(across|under|tagged|project|priority|of (?:those|these|which)|from)\b[^.]*$/i.test(before) || /#\w+[^.]*$/.test(before)) continue;
      if (/^\s*(across|on|for|in|under|from|tagged|belonging|against)\b/i.test(after)) continue;
      const n = Number(m[1]);
      if (Math.abs(n - open.length) > Math.max(3, open.length * 0.05)) findings.push({ kind: 'COUNT', text: m[0], said: m[1], should: String(open.length), why: 'the list says otherwise' });
    }
  }

  // PERSON: an address quoted as someone he deals with should not be a queue.
  for (const m of body.matchAll(/\b(?:to|from|chase|chased|ask|asked|reply to|replied to)\s+([\w.+-]+@[\w.-]+\.\w{2,})/gi)) {
    if (isMachine(m[1])) findings.push({ kind: 'PERSON', text: m[0], said: m[1], should: 'a person', why: 'that address is a machine or a queue' });
  }

  if (meta.kind === 'brief') findings.push(...shapeFindings(body));

  return { file, at: meta.at ?? null, title: meta.title ?? '', kind: meta.kind ?? '', findings };
}

/* THE EVENING'S SHAPE. Alex, 2026-10-07, of a 2,400-word Tomorrow's Brief:
   "very wandering. many things repeated. how can we tighten it up". Mateo's
   drawings were in it six times — changed, said today, promises, the trust
   line — because the brief had thirteen sections and nothing said an item
   lives in one. Two arithmetic answers: each to-do is linked once, and the
   part above the digest has a budget. The job runs this before it commits.

   Every brief since 2026-10-24, when the morning became the only one and took
   over the evening's sections (closes, held chases, the long waits, the trust
   line). 900 rather than 800 because it also carries today's order, the
   priorities and today's calendar; unchanged since yesterday is still a count. */
export const BRIEF_WORDS = 900;

export function shapeFindings(body) {
  const out = [];
  // Above what the service appends: the awareness-and-memory section and the digest.
  const above = String(body).split(/^## (?:Mail digest|Awareness and memory)\s*$/m)[0];
  const seen = new Map();
  for (const m of above.matchAll(/\/todo#pane=([^)\s]+)/g)) {
    const id = decodeURIComponent(m[1]);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) out.push({ kind: 'REPEAT', text: id, said: `linked ${n} times`, should: 'once, in the first section it belongs to',
                          why: 'each item lives in one place in the brief' });
  }
  const words = above.replace(/\]\([^)]*\)/g, ']').split(/\s+/).filter((w) => /\w/.test(w)).length;
  if (words > BRIEF_WORDS) out.push({ kind: 'LONG', text: `${words} words above the digest`, said: String(words), should: `${BRIEF_WORDS} or fewer`,
                                        why: 'what is unchanged since the last brief is a count, not a paragraph' });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let files = argv.filter((a) => a.endsWith('.md'));
  if (!files.length) {
    const all = (await readdir(join(OBLIGATIONS, 'messages'))).filter((f) => /-(brief|note)\.md$/.test(f)).sort();
    /* NOT ITS OWN NOTES. An audit note names this script on purpose — "checked
       by node deploy/brief-audit.mjs" — and naming a script is the one thing
       JARGON exists to catch in a brief, so auditing its own output reports a
       finding for ever and each run writes another note to find it in. A note
       about the machinery is allowed to name the machinery; a brief he reads
       on a phone is not. 2026-09-21. */
    const mine = async (f) => {
      try { return /^title:\s*Audit:/m.test(await readFile(join(OBLIGATIONS, 'messages', f), 'utf8')); }
      catch { return false; }
    };
    const candidates = [];
    for (const f of all) if (!(await mine(f))) candidates.push(f);
    files = (argv.includes('--all') ? candidates : candidates.slice(-1)).map((f) => join('messages', f));
  }
  const out = [];
  for (const f of files) out.push(await auditBrief(OBLIGATIONS, f));
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
  let n = 0;
  for (const r of out) {
    console.log(`\n${r.file}  ${r.at}  ${r.title.slice(0, 70)}`);
    if (!r.findings.length) { console.log('  clean on every mechanical check'); continue; }
    for (const f of r.findings) { n++; console.log(`  ${f.kind.padEnd(7)} ${f.why}\n          said: ${f.said}  ·  should be: ${f.should}\n          "${f.text.slice(0, 150)}"`); }
  }
  console.log(`\n${n} finding${n === 1 ? '' : 's'} across ${out.length} message${out.length === 1 ? '' : 's'}`);
  process.exit(n ? 1 : 0);
}
