/**
 * Obligations: the object, not the thread.
 *
 * An obligation is *something that is owed*, in one direction or the other. It
 * can be evidenced by a message thread, a line in `todo.md`, a reminder, and in
 * time an email or a calendar invite — and the same obligation routinely
 * arrives on more than one of them. Anna asks for the flight dates by text and
 * again by email; someone asks to be rung back and Alex rings them, which
 * leaves no text at all.
 *
 * Keyed by thread, as this was until 2026-08-29, that is two open items that
 * never close each other: the brief reports the same debt twice and answering
 * the email leaves the text open forever. `rules/knowledge.md` argued for this
 * shape before there was a second source; this is that shape.
 *
 * **The sources stay authoritative.** Nothing here is a mirror. `todo.md` is
 * the truth about hand-typed tasks, `reminders.md` about reminders,
 * `imessage-state.json` about what the triage concluded. This module joins them
 * and closes across them; it never becomes a fourth copy that can drift.
 *
 * Merging two pieces of evidence into one obligation is **judgement** — it
 * needs to know that "the flight dates" and "October travel" are the same
 * question — so code never does it. The agent records merges in
 * `integrations/obligation-links.json` and this reads them.
 */
import { laneOf } from './lanes.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { daysSince, parseStamp, localStamp } from './time.mjs';
import { withRepoLock } from './lock.mjs';
import * as imessage from './sources/imessage.mjs';
import * as todo from './sources/todo.mjs';
import * as reminders from './sources/reminders.mjs';
import * as recurring from './sources/recurring.mjs';
import * as email from './sources/email.mjs';
import * as decisions from './sources/decisions.mjs';
import * as birthdays from './sources/birthdays.mjs';
import * as apple from './sources/apple-reminders.mjs';
import * as condition from './sources/conditions.mjs';
import { appendClose } from './logbook.mjs';
import { readObligationState, markClosed, clearClosed, updateState } from './obligation-state.mjs';
import { readProjects, assignTag } from './projects.mjs';
import * as decide from '../decide.mjs';

export { threadFor } from './sources/imessage.mjs';

// `decision` is the sixth source (2026-09-05): choices waiting on him, from
// decisions.md. In the SAME list, deliberately — "what is outstanding" has to
// include "what have I not decided", and a second list is one he stops reading.
// `condition` (2026-10-17): an alert open past a day with no all-clear —
// see sources/conditions.mjs.
const SOURCES = { imessage, todo, reminder: reminders, recurring, email, decision: decisions, birthday: birthdays, apple, condition };
const RANK = { high: 0, normal: 1, low: 2 };

/**
 * A short handle he can say out loud.
 *
 * Alex, 2026-09-19: "on the to-do list, can you add a unique id (like the
 * reminders have) so I can easily share with you." The real id is exact and
 * unusable in a sentence — `mail:personal:1a092bcaffef867f` is not something
 * anyone reads off a phone — so every obligation also carries four characters
 * he can type.
 *
 * DERIVED, never assigned. A counter would need a file, the file would be a
 * second copy of what is open, and the day it disagreed with the list a code
 * would point at the wrong debt. This is a hash of the id, so the same item has
 * the same code on every machine, forever, with nothing to keep in step.
 *
 * Crawley's alphabet minus the vowels: no O/0, no I/1, and nothing that can
 * spell a word by accident. Four characters is ~1M codes against a list of a
 * few hundred; `codesFor` lengthens a pair that collides rather than pretending
 * it cannot happen.
 */
const CODE_ALPHABET = '23456789CDFGHJKLMNPQRSTVWXZ';
export function shortCode(id, length = 4) {
  const h = createHash('sha1').update(String(id ?? '')).digest();
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[h[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * Codes for a whole list, with collisions made longer for BOTH sides.
 *
 * A code that points at two things is worse than a long one: he would quote it
 * and get the wrong debt, and neither of us would know. When two ids land on
 * the same four characters, both get six — deterministically, so the answer
 * does not depend on which was read first.
 */
export function codesFor(ids) {
  const at = new Map();
  for (const id of ids) {
    const c = shortCode(id);
    if (!at.has(c)) at.set(c, []);
    at.get(c).push(id);
  }
  const out = new Map();
  for (const [code, group] of at) {
    if (group.length === 1) { out.set(group[0], code); continue; }
    for (const id of group) out.set(id, shortCode(id, 6));
  }
  return out;
}

/** `imessage` + a source-local ref → the id the rest of the system uses. */
const idFor = (source, ref) => source === 'imessage' ? `im:${ref}` : ref;

/**
 * Move an obligation's due date, whatever source holds it. Alex,
 * 2026-09-06, the task action center. A reminder takes a time (its push
 * fires at it); a todo line and a decision heading take a date; a judged
 * thread takes either. A recurring item has no date of its own to move.
 */
export async function setDue(vault, id, due, who = null) {
  const kind = String(id).split(':')[0];
  const d = String(due ?? '').trim().replace('T', ' ').slice(0, 16);
  return withRepoLock(vault, async () => {
    switch (kind) {
      case 'rem': return reminders.reschedule(vault, id, /\d{2}:\d{2}$/.test(d) ? d : `${d.slice(0, 10)} 09:00`, who);
      case 'todo': return todo.setDue(vault, id, d);
      case 'mail': return email.setDue(vault, id, d);
      case 'im': return imessage.setDue(vault, id.slice(3), d);
      // Already inside the repo lock, so the variant that does not take it.
      case 'decision': return decide.setDueLocked(vault, id, d);
      case 'recur': throw new Error('a recurring item is due by its definition in recurring.md; change the block there');
      case 'birthday': throw new Error('a birthday is due on the birthday');
      case 'cond': throw new Error('a condition is due now; close it once it is dealt with');
      default: throw new Error(`no due date to move on ${kind}`);
    }
  });
}

/**
 * Alex's tags on obligations, keyed by the merged id so a tag survives a
 * merge. `integrations/obligation-tags.json`, written by the tag editor on
 * /tasks and by nothing else. Absent or malformed means no tags, which is the
 * safe reading — a tag is a convenience for browsing, never a fact about the
 * debt.
 */
/** His tags, from the obligation's own record (the `tags` slice). */
async function tagsFile(vault) {
  return { tags: (await readObligationState(vault)).tags };
}

/** Lower-case, trimmed, de-duplicated, and never a `#` or empty string. */
export function cleanTags(list) {
  const out = new Set();
  for (const t of list ?? []) {
    const v = String(t ?? '').trim().replace(/^#+/, '').toLowerCase();
    if (v && v.length <= 40) out.add(v);
  }
  return [...out].sort();
}

/**
 * Replace the tags on one obligation. Under the repo lock because the file is
 * tracked and the dispatcher commits on the minute tick.
 *
 * **An empty list is kept as `[]`, not deleted.** From 2026-09-16 the assistant
 * assigns a project tag to an item that has none (see `projects.mjs`), and it
 * skips any item this file has an entry for. Deleting the key on an empty save
 * would mean taking the assistant's tag off put it straight back on the next page
 * load, with no way for him to say "this belongs to no project".
 */
export async function setTags(vault, id, tags) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('bad obligation id');
  const clean = cleanTags(tags);
  await updateState(vault, (d) => { d.tags[id] = clean; });
  return { id, tags: clean };
}

/**
 * Recorded merges. Absent, malformed, or empty all mean the same thing: every
 * piece of evidence is its own obligation. That is the safe direction to fail —
 * a duplicate in the list is visible and annoying; a wrongly merged pair hides
 * one of two real debts behind the other.
 */
async function links(vault, state = null) {
  const { links: l } = state ?? await readObligationState(vault);
  const of = new Map();
  for (const [child, v] of Object.entries(l ?? {})) if (v?.into) of.set(child, v.into);
  return of;
}

/**
 * The day it started, at the best precision any source knows.
 *
 * `todo.md` records a date, the triage records a date and a time. Sorting the
 * strings picks the bare date, so a merge would quietly age an obligation by up
 * to a day — midnight is not what "2026-08-26" means. Earliest *day* wins; among
 * stamps on that day, the most precise one does.
 */
function earliest(stamps) {
  const live = stamps.filter(Boolean);
  if (!live.length) return null;
  const day = live.map((s) => String(s).slice(0, 10)).sort()[0];
  return live.filter((s) => String(s).startsWith(day))
    .sort((a, b) => String(b).length - String(a).length)[0];
}

/**
 * A short headline for a row in a list.
 *
 * Best case the triage wrote one: it read the mail and knows the obligation is
 * "Pay the SaunaCo deposit" rather than the two hundred words explaining
 * how that came to be true. Next best is the subject line — weak, but written
 * by a human about this exact thing.
 *
 * Last is a cut of `what`, and it is deliberately a dumb one: first sentence,
 * first clause, hard cap. A cleverer summariser here would be a second opinion
 * competing with the triage's, and the honest fix for a bad derived title is
 * for the triage to write a real one.
 */
const CUT = 72;
export function titleOf(o) {
  if (o.title) return o.title;
  const what = (o.what ?? '').trim();
  if (o.subject && what.length > CUT) return o.subject;
  if (what.length <= CUT) return what;

  // Sentence, then clause, then a word boundary — whichever lands first inside
  // the cap. Never mid-word: a truncated word reads as a rendering bug.
  const head = what.slice(0, CUT + 1);
  for (const re of [/^(.{20,}?[.!?])\s/, /^(.{20,}?)[;—]/, /^(.{20,}?),\s/]) {
    const m = head.match(re);
    if (m) return m[1].trim();
  }
  const sp = head.lastIndexOf(' ');
  return (sp > 20 ? head.slice(0, sp) : what.slice(0, CUT)).trim() + '…';
}

/**
 * Tags that say what KIND of thing an item is, as opposed to which project it
 * belongs to. They sit beside a project tag rather than competing with it:
 * the Webber invoice is both `acme` and `invoice`.
 */
export const KIND_TAGS = new Set(['decision', 'birthday', 'invoice']);

/**
 * The kind tags an item earns from its own title, computed on read.
 *
 * Alex, 2026-09-28: "In the todo list, I want to add a tag for invoices."
 * Timid on purpose, like project assignment: something HE owes whose title
 * starts "Pay …" or "Settle …", or names an invoice. A looser word list read
 * "Give Ruth the go on the PHOA auto-renewal email", "Tell Pete Rourke how
 * to bill Mia's sessions" and a capital-call wire as invoices; this catches
 * the twelve real ones open that day and none of those. Anything it misses he
 * tags by hand, and the triage may tag a bill `invoice` itself.
 */
export function kindTagsOf(o) {
  const t = String(o?.title ?? '');
  if ((o?.owed_by ?? 'me') === 'them') return [];
  /* "Settle" only over money: "Settle the Elmwood listing timeline with Dana
     and Dora" is a decision, and was the one wrong tag on the first live
     read (2026-09-28). */
  const settles = /^settle\b/i.test(t) && /\b(charges?|tax|taxes|bills?|balance|invoices?|interest|fees?|payment|dues|premium)\b/i.test(t);
  return /^pay\b/i.test(t) || settles || /\binvoices?\b/i.test(t) ? ['invoice'] : [];
}

/** The strongest claim wins each field, so a merge never loses information. */
function fold(members, closedRec = null) {
  /* THE OBLIGATION OWNS ITS STATE. `members.some(open)` alone let any one
     source reopen a closed obligation without a decision — an Apple reminder
     the Mac never completed, a text-and-Apple pair where one half refused.
     With a dated close on record, only evidence NEWER than the close can
     outvote it; undated evidence (a todo line, a reminder) cannot. See
     obligation-state.mjs. */
  let open = members.some((m) => m.open);
  let reopenedBy = null;
  /* A NEW MESSAGE, NOT A NEW READING. Alex, 2026-09-24, of the Riverton Bay
     Ventures e-file authorization put back on his list: "my last email in
     that thread says i signed it." It did — "I signed the return today",
     2026-08-25 — and he closed the item himself on 09-21. On 09-23 the mail
     triage re-read the same thread, nothing new on it since August, misread
     it, and its conclusion was newer than his close, so it counted as newer
     evidence and reopened a decision of his.

     A re-judgement is a second opinion on the same evidence. It may reopen a
     close only when the thread has a message newer than the close; anything
     else goes through a door with a reason (Reopen, close.mjs --reopen). A
     source that has no message stamp keeps its own `at`. */
  if (closedRec && open) {
    const stamp = (m) => (m.evidence_at !== undefined ? m.evidence_at : m.at);
    const newer = members.filter((m) => m.open && stamp(m) && String(stamp(m)) > String(closedRec.at));
    open = newer.length > 0;
    if (open) reopenedBy = newer.map((m) => stamp(m)).sort().pop();
  }
  const dues = members.map((m) => m.due).filter(Boolean).sort();
  const priority = members.map((m) => m.priority ?? 'normal')
    .sort((a, b) => (RANK[a] ?? 1) - (RANK[b] ?? 1))[0];

  // The canonical member — the first listed in the merge — decides what this
  // obligation *is*. Direction and wording are judgements the agent already
  // made once; picking them by some rule here would silently overrule it.
  const head = members[0];

  return {
    // The canonical member's headline, falling back through subject to a cut of
    // the prose, so every row has something scannable even for the hundreds of
    // conclusions written before the field existed.
    title: titleOf(head),
    what: head.what,
    who: head.who ?? members.find((m) => m.who)?.who ?? null,
    since: earliest(members.map((m) => m.since)),
    due: dues[0] ?? null,
    priority,
    owed_by: head.owed_by === 'them' ? 'them' : 'me',
    open,
    // What discharge looks like, if any source says. Knowing you are waiting on
    // a receipt from Northwind is most of what makes the item actionable.
    closes: members.map((m) => m.closes).find(Boolean) ?? null,
    closes_when: members.map((m) => m.closes_when).find(Boolean) ?? null,
    handed_to: members.map((m) => m.handed_to).find(Boolean) ?? null,
    // Doubt is the weakest claim, so it loses to any member that is sure.
    confidence: members.some((m) => m.confidence === 'low') && members.every((m) => m.confidence === 'low' || m.confidence == null) ? 'low' : null,
    // The obligation's own close, when it has one — what `/todo`, the brief and
    // the review pass read, whatever the sources still say.
    // From the obligation's own record; before it existed (2026-09-20) the
    // sources carried these, so an older close still shows on /todo's closed view.
    closed_at: closedRec?.at ?? members.map((m) => m.detail?.closed_at).find(Boolean) ?? null,
    closed_by: closedRec?.by ?? members.map((m) => m.detail?.closed_by).find(Boolean) ?? null,
    outcome: closedRec?.outcome ?? members.map((m) => m.detail?.outcome).find(Boolean) ?? null,
    // Set when a newer conclusion outvoted a recorded close. reconcileState
    // drops the record; until then the list is right and the file is stale.
    reopened_by_evidence: reopenedBy,
  };
}

/** Local midnight, so day arithmetic is about days rather than elapsed time. */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * How far off a deadline is, in CALENDAR days, and whether it has passed.
 *
 * Elapsed milliseconds is the obvious implementation and it is wrong, because
 * most due dates here carry no time and parse to midnight. Yesterday then reads
 * as two days overdue, today reads as one day overdue AND overdue at 00:01, and
 * tomorrow reads as zero — which put tomorrow's items under TODAY on the tasks
 * page. The morning brief of 2026-09-03 caught it: "Carta shows 50d overdue and
 * is 49; items dated tomorrow appear under TODAY."
 *
 * Rounding rather than flooring the day difference, because a DST boundary
 * makes a "day" 23 or 25 hours and flooring turns that into an off-by-one twice
 * a year.
 *
 * `overdue` splits on whether the deadline names a time. 09:00 today is overdue
 * at 09:01; a bare date is not overdue until the day is out, which is what
 * anyone means by "due Tuesday".
 */
export function deadline(due, now) {
  if (!due) return { overdue: false, lead_days: null };
  const at = parseStamp(due);
  const lead = Math.round((startOfDay(at) - startOfDay(now)) / 86400000);
  const timed = /\d{1,2}:\d{2}/.test(String(due));
  return { overdue: timed ? at < now : lead < 0, lead_days: lead };
}

/**
 * Every obligation, from every source, merged. Closed ones are included with
 * `open: false` — the caller decides whether to show them, and the diff needs
 * to see them.
 */
export async function listObligations(vault) {
  const state = await readObligationState(vault);
  const merges = await links(vault, state);
  const tagged = state.tags;
  // His projects and their match rules. A file that cannot be read means no
  // assignment at all, never a guess.
  const projects = await readProjects(vault).catch(() => []);
  const now = Date.now();

  const candidates = [];
  for (const [name, mod] of Object.entries(SOURCES)) {
    // One unreadable source must not blank the list. A missing todo.md is
    // normal; a broken triage cache should not take the reminders down with it.
    let rows = [];
    try { rows = await mod.read(vault); } catch { rows = []; }
    for (const row of rows) {
      candidates.push({ ...row, source: name, id: idFor(name, row.ref) });
    }
  }

  const groups = new Map();
  for (const c of candidates) {
    const id = merges.get(c.id) ?? c.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(c);
  }

  const items = [];
  for (const [id, members] of groups) {
    // The canonical member first, so `fold` reads the right one. When the merge
    // names an id that is itself a member, that member is canonical.
    members.sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : 0));
    const f = fold(members, state.closed[id] ?? null);
    // Which project this belongs to, when nothing else says. Computed on read
    // rather than stored: the rules live in projects/, and a second copy of
    // the answer is a thing that can disagree with them. Three conditions, all
    // of which are about not overruling him — he has never edited this item's
    // tags, the item carries no tag of its own, and exactly one project claims
    // it (projects.mjs refuses a tie).
    const own = cleanTags([...(tagged[id] ?? []),
                           ...members.map((m) => m.project).filter(Boolean),
                           ...members.flatMap((m) => Array.isArray(m.tags) ? m.tags : [])]);
    const spoken = Object.prototype.hasOwnProperty.call(tagged, id);
    const auto = (!spoken && !own.filter((t) => !KIND_TAGS.has(t)).length)
      ? assignTag({ ...f, id }, projects) : null;
    const assigned = auto ? { auto_tag: auto.tag, auto_why: auto.why } : {};
    const tags = cleanTags([...own, ...(spoken ? [] : kindTagsOf(f)), ...(auto ? [auto.tag] : [])]);
    items.push({
      id,
      ...f,
      code: shortCode(id),
      days: daysSince(f.since, now),
      ...deadline(f.due, now),
      // Browsing handles. A todo line's #project is shown as a tag too — it is
      // the same idea, written in the file it lives in.
      // Three places a tag can come from: the tags file (his), a member's
      // #project (the line it lives in), and a member's own `tags` — which a
      // source uses to say what KIND of thing it is (decisions.mjs marks every
      // decision `decision`). The third was silently dropped until 2026-09-05,
      // so the first decision arrived in the list indistinguishable from a debt.
      // A kind tag from the title only while he has never edited this item's
      // tags — once he has, what he saved is the whole answer, removals too.
      tags,
      // The kind of work it is — reply, decide, pay, call, admin — so To Do can
      // hand him one lane in a sitting (lanes.mjs; Alex, 2026-10-03).
      lane: laneOf({ ...f, tags }),
      ...assigned,
      evidence: members.map((m) => ({
        source: m.source, ref: m.ref, id: m.id, open: m.open, detail: m.detail ?? null,
        // When this evidence was last judged (mail/text: reviewed; todo: since;
        // Apple: created). What the state rule, the doubt check and the chase
        // hold all read to ask "has anyone looked since". See obligation-state.mjs.
        at: m.at ?? null,
        // A todo line's #project rides along so the tag editor knows which tag
        // it may not remove: that one is owned by todo.md, not by the tags file.
        ...(m.project ? { project: m.project } : {}),
      })),
      // The one piece of evidence a thread can be read from, if there is one.
      chat_id: members.find((m) => m.source === 'imessage')?.ref ?? null,
    });
  }
  // Lengthen any pair that collided. Done over the whole list so the answer is
  // about the list rather than the order it was built in.
  const codes = codesFor(items.map((o) => o.id));
  for (const o of items) o.code = codes.get(o.id) ?? o.code;
  return items;
}

/** Open ones only, which is what every caller so far actually wants. */
export async function listOpen(vault) {
  return (await listObligations(vault)).filter((o) => o.open);
}

export function sortObligations(items, by) {
  const copy = [...items];
  if (by === 'due') {
    // Soonest first, and anything without a date last: a deadline list ordered
    // by age answers a different question than the one being asked.
    copy.sort((a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')));
  } else if (by === 'priority') {
    copy.sort((a, b) =>
      (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) ||
      (b.days ?? -1) - (a.days ?? -1));
  } else {
    copy.sort((a, b) => (b.days ?? -1) - (a.days ?? -1));   // oldest first
  }
  return copy;
}

/**
 * Discharge an obligation everywhere it is evidenced.
 *
 * This is the whole reason the model exists. Answering the email has to close
 * the text too, or the second one sits open forever and the list stops being
 * believable — which is the failure this system is built to avoid.
 *
 * Under the repo lock, because two of the three sources are markdown files the
 * host dispatcher also rewrites every minute.
 */
export async function closeObligation(vault, id, who, outcome) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('bad obligation id');

  const target = (await listObligations(vault)).find((o) => o.id === id);
  if (!target) throw new Error('no such obligation');
  if (!target.open) throw new Error('already closed');

  return withRepoLock(vault, async () => {
    // THE close: the obligation's own record, before any source is touched. A
    // source that refuses below (an agent may not tick his Apple list) is
    // reported and does not undo this. Review 2026-09-20, item 2.
    await markClosed(vault, id, { by: who, outcome });
    const closed = [];
    const failed = [];

    for (const e of target.evidence) {
      if (!e.open) continue;
      try {
        await SOURCES[e.source].close(vault, e.ref, who, outcome);
        closed.push(e.source);
      } catch (err) {
        // Report what did not close rather than claiming the whole thing is
        // done. A half-closed obligation the caller knows about is recoverable;
        // one it does not is a debt that quietly came back.
        failed.push(`${e.source}: ${err?.message ?? err}`);
      }
    }
    // Every source may have refused and the obligation is still closed — an
    // Apple-only item the agent closes stays on his phone until he ticks it,
    // and off his list from now. The caller sees exactly which half refused.

    // One line in the logbook for every obligation discharged, whatever it was
    // evidenced by. Ticking a box says an item is no longer outstanding; it
    // does not say when, by whom, or on what — and that is the part anyone
    // asking about it later actually needs.
    //
    // The recurring adapter has already written its own line, and it reads this
    // file for its state: a second entry would be a duplicate, not a record.
    /* NOT ON A HALF-CLOSE. The re-audit, 2026-09-20: a merged text-promise
       and Apple reminder — the text half closes, the Apple half refuses (an
       agent may not tick his list), the obligation stays OPEN because open is
       any-member-open — and this wrote the logbook line anyway. Then
       review.mjs saw "the logbook says closed, and it is open" every run and
       told the triage to close it again, which failed the same way, for ever,
       at the top of the list. The logbook records what was discharged; a
       half is not. The caller is told which half stayed open. */
    // The logbook line records the DECISION, which was made above whatever the
    // sources did with it. (Earlier today this was skipped on a half-close,
    // when the sources still owned the state and a half was not a close.)
    if (!target.evidence.some((e) => e.source === 'recurring')) {
      await appendClose(vault, { id, what: target.what, who, outcome });
    }
    return { id, closed, failed, partial: failed.length > 0 };
  });
}

/**
 * Record that two obligations are one thing.
 *
 * Alex, 2026-09-18: "sometimes a manual reminder matches an existing todo in
 * the assistant. how can we get them linked?" He says "Sales Tax" into his phone
 * and the mail triage has already concluded something about the same return;
 * two rows, one debt, and closing either leaves the other standing.
 *
 * `integrations/obligation-links.json` is the same file the mail triage writes
 * when it finds one conversation split across two threads. This is the door for
 * the pairs a person spots — the page proposes (`similar.mjs`) and he taps.
 *
 * The refusals matter more than the write. A merge makes one row disappear
 * behind another, and a wrong one hides a real debt where nothing will ever
 * surface it again:
 *
 *   - both ids must exist and be open;
 *   - neither may already be a member of another merge, because a chain would
 *     make the parent ambiguous and the loader keeps only the last mapping;
 *   - an id may not be linked into itself.
 *
 * The older item is the parent, so the merged row keeps the day the debt
 * actually started rather than the day he wrote it down again.
 */
/**
 * Reopen one. A decision with a name and a reason on it — the page's Reopen,
 * rejudge.mjs, or a job that has read the evidence. Clears the obligation's
 * own record and flips the mail or message conclusion back to open, marked, so
 * the differ offers it and the triage sees why.
 */
export async function reopenObligation(vault, id, who, why) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('bad obligation id');
  if (!who) throw new Error('a reopen needs a name on it');
  if (!why?.trim()) throw new Error('a reopen needs a reason');
  return withRepoLock(vault, async () => {
    const r = await clearClosed(vault, id, { by: who, why });
    const all = await listObligations(vault);
    const target = all.find((o) => o.id === id);
    const flipped = [];
    for (const e of target?.evidence ?? []) {
      if (e.source !== 'email' && e.source !== 'imessage') continue;
      const file = join(vault, 'integrations', e.source === 'email' ? 'email-state.json' : 'imessage-state.json');
      let st; try { st = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
      const key = e.source === 'email' ? 'thread_id' : 'chat_id';
      const want = e.source === 'email' ? e.detail?.thread_id : (e.detail?.chat_id ?? e.ref);
      const t = (st.threads ?? []).find((x) => x[key] === want);
      if (!t?.conclusion) continue;
      t.conclusion.open = true;
      t.conclusion.reopened = { at: localStamp(), by: who, why: why.trim() };
      t.reviewed = localStamp();            // newer than any close: the list agrees at once
      await writeFile(file, JSON.stringify(st, null, 1) + '\n');
      flipped.push(e.source);
    }
    return { id, reopened: r.reopened, flipped };
  });
}

/**
 * A dismissal is a lesson. Alex closes something on the page with "Not a
 * task" — it should never have been opened — and the reason he gives is a
 * verdict in `rules/verdicts.md`, the file every triage reads before judging.
 * Review item 3, 2026-09-20: the page was the one place his judgement landed
 * and nothing carried it back to the thing that keeps making the mistake.
 * Pure; the route records what this returns through verdict.mjs.
 */
export function dismissalVerdict(o, why) {
  const src = (o?.evidence ?? []).map((e) => e.source);
  const scope = src.includes('email') ? 'mail' : src.includes('imessage') ? 'message' : 'general';
  const from = src.includes('email') ? 'a mail thread' : src.includes('imessage') ? 'a text thread' : (src[0] ? `the ${src[0]} list` : 'a source');
  // Pipes separate the verdict line's fields, so none may ride inside one.
  const flat = (s) => String(s ?? '').replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  const reason = flat(why);
  return {
    scope,
    call: `"${flat(o?.title ?? o?.id)}" was not a task — opened from ${from}${o?.who ? ` (${o.who})` : ''}${o?.since ? ` on ${String(o.since).slice(0, 10)}` : ''}`,
    why: reason || 'dismissed on the To Do page without a reason',
    outcome: `not a task${reason ? `: ${reason}` : ''}`,
  };
}

export async function linkObligations(vault, id, into, why) {
  if (!id?.trim() || !into?.trim()) throw new Error('two ids are needed');
  if (id === into) throw new Error('that is the same item');
  const all = await listObligations(vault);
  const a = all.find((o) => o.id === id);
  const b = all.find((o) => o.id === into);
  if (!a) throw new Error(`no open obligation called ${id}`);
  if (!b) throw new Error(`no open obligation called ${into}`);
  if (!a.open || !b.open) throw new Error('one of them is already closed');

  // Oldest first: the parent carries the day it started.
  const [parent, child] = String(a.since ?? '9999') <= String(b.since ?? '9999') ? [a, b] : [b, a];
  await updateState(vault, (d) => {
    // A merged item cannot itself be merged elsewhere: a chain hides a debt
    // behind a debt behind a debt, and nothing ever surfaces the last one.
    if (d.links[child.id]) throw new Error(`${child.id} is already merged into ${d.links[child.id].into}`);
    if (d.links[parent.id]) throw new Error(`${parent.id} is already merged into ${d.links[parent.id].into}`);
    if (Object.values(d.links).some((v) => v.into === child.id)) throw new Error(`${child.id} already has items merged into it — link them into ${parent.id} instead`);
    d.links[child.id] = { into: parent.id, why, at: localStamp() };
  });
  return { id: parent.id, merged: child.id, title: parent.title ?? parent.what };
}
