#!/usr/bin/env node
/**
 * The Apple Reminders bridge: what goes on his phone, and what he ticked there.
 *
 * Alex, 2026-09-18: "can we tie it in Apple Reminders through the mac
 * bridge?" The Mac already pushes three extracts over ssh and reads what it
 * needs from this box the same way, so Reminders is that pattern once more:
 *
 *   Mac  →  integrations/reminders-apple.json   everything in his lists
 *   Mac  ←  integrations/reminders-mirror.json  what the Obligations list should hold
 *
 * This writes the second and acts on the first. Two halves, one rule each:
 *
 * **What mirrors.** Alex, 2026-09-18, choosing between four options: dated
 * items and the projects he is for. Overdue or due within a week, plus anything
 * carrying a `focus:` project's tag. 215 open items are his; putting all of
 * them on his phone would recreate the list he already cannot read, and a
 * Reminders list that is never empty is one nobody opens.
 *
 * **What nags.** Nothing here. Alex chose no alarms, and the reason is
 * `rules/reminders.md`: the dispatcher owns the push channel, its daily budget
 * and its quiet hours, and it cannot see an alarm Apple fires. Two nags for one
 * item is exactly what that file exists to prevent. The mirror is a list he
 * looks at, not a second thing that buzzes.
 *
 * The assistant never deletes one of his reminders, never touches a list other than
 * `Obligations`, and never edits a reminder he wrote. Completing is the strongest
 * verb it has here, the same way archiving is for mail.
 *
 *   node deploy/reminders-bridge.mjs            # what would go, and what he ticked
 *   node deploy/reminders-bridge.mjs --write    # write the mirror, close what he ticked
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listObligations } from './agent-service/obligations.mjs';
import { focusProjects } from './agent-service/projects.mjs';
import { mirrorOf, FILE as APPLE, MIRROR_LIST, ticked as tickedHere, TICKED } from './agent-service/sources/apple-reminders.mjs';
import { localStamp } from './agent-service/time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LIST = MIRROR_LIST;
export const MIRROR = 'integrations/reminders-mirror.json';
const SEEN = ['.log', 'reminders-mirrored.json'];
// Every id the bridge has ASKED the Mac to complete. Without this, the Mac
// doing as it was told comes back looking exactly like him ticking the box.
const ASKED = ['.log', 'reminders-asked.json'];
const ASKED_DAYS = 30;
export const SOON_DAYS = 7;
/* THE OBLIGATIONS LIST IS OFF. Alex, 2026-10-08: "there is a lot of junk that shows
   up on my calendar reminders" — the Obligations list, 22 items, 16 dated and so on
   his Calendar too. Offered due-soon-only, no project items, high priority
   only, or off, he chose off. With nothing chosen, every open item already in
   the Obligations list is asked to be completed (never deleted), and the list stays
   empty. The other half is untouched: his own lists still become tasks and his
   ticks still close them. Turning it back on is this line. */
export const MIRRORING = false;
// A ceiling, not a target. If this ever binds, the selection is wrong rather
// than the list being long, and the report says so instead of silently cutting.
export const CAP = 150;

const mine = (o) => (o.owed_by ?? 'me') !== 'them';

/**
 * Which open obligations belong on his phone. Pure, so the rule is testable.
 * `soon` is overdue or due within the week; `focus` is a project he is for.
 */
export function chooseFor(open, { focusTags = new Set(), soonDays = SOON_DAYS } = {}) {
  const rows = open.filter((o) => o.open !== false && mine(o)).filter((o) => {
    // He already wrote himself a reminder for this one, and it was linked to
    // the obligation — so a mirrored copy would put the same task on his phone
    // twice, once in his hand and once in ours. His own is the copy that stays.
    if ((o.evidence ?? []).some((e) => e.source === 'apple')) return false;
    if (o.due && ((o.lead_days ?? 99) <= soonDays || o.overdue)) return true;
    return (o.tags ?? []).some((t) => focusTags.has(String(t).toLowerCase()));
  });
  // Dated first, soonest first; then the rest by how long they have waited. It
  // is the order he would read them in, and Reminders keeps the order it is
  // given within a list.
  return rows.sort((a, b) => {
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    if (a.due && b.due) return String(a.due).localeCompare(String(b.due));
    return (b.days ?? 0) - (a.days ?? 0);
  });
}

/** One obligation as the Mac wants it. */
export function itemFor(o, { base = 'https://obligations.example.com' } = {}) {
  const tags = (o.tags ?? []).filter((t) => t !== 'decision' && t !== 'birthday');
  const note = [
    o.who ? `with ${o.who}` : null,
    o.overdue ? `overdue since ${String(o.due).slice(0, 10)}` : null,
    tags.length ? tags.map((t) => `#${t}`).join(' ') : null,
    o.closes ? `closes when: ${o.closes}` : null,
  ].filter(Boolean).join(' · ');
  return {
    id: o.id,
    title: String(o.title ?? o.what ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    // A date, never a time. A timed reminder is one Apple will alert on, and
    // the whole point of this list is that it does not buzz.
    due: o.due ? String(o.due).slice(0, 10) : null,
    priority: o.priority === 'high' ? 'high' : o.priority === 'low' ? 'low' : 'normal',
    notes: note || null,
    url: `${base}/todo#pane=${encodeURIComponent(o.id)}`,
  };
}

const readJson = async (vault, rel, fallback) => {
  try { return JSON.parse(await readFile(join(vault, rel), 'utf8')); } catch { return fallback; }
};

/**
 * The whole pass.
 *
 * `close` is what he ticked in the Obligations list — a mirrored item he marked done
 * on his phone. That is his own hand on the item, so it closes the obligation
 * with his name on it, the same as the Done button on the page. The evidence is
 * the tick itself; nothing here reads the reminder's words as instructions.
 */
export async function bridge(vault = OBLIGATIONS, { write = false, now = Date.now(), mirror = MIRRORING } = {}) {
  const open = await listObligations(vault);
  const focusTags = new Set((await focusProjects(vault).catch(() => [])).map((p) => p.tag).filter(Boolean));
  const live = open.filter((o) => o.open !== false);
  const chosen = mirror ? chooseFor(live, { focusTags }) : [];
  let items = chosen.slice(0, CAP).map((o) => itemFor(o));
  const over = chosen.length - items.length;

  const byId = new Map(open.map((o) => [o.id, o]));
  const apple0 = await readJson(vault, APPLE, null);
  // Which ids have been folded into another item, so a mirror of the old id can
  // say so rather than claiming a close that never happened.
  const merges = new Map();
  const { readObligationState } = await import('./agent-service/obligation-state.mjs');
  for (const [child, v] of Object.entries((await readObligationState(vault)).links)) if (v?.into) merges.set(child, v.into);

  /* What to tick off his phone.
   *
   * Derived from what is ACTUALLY on the phone — the Obligations list in the latest
   * extract — and not from this side's memory of the last mirror it wrote.
   *
   * The first version kept a ledger of what it had mirrored and diffed against
   * that, which announced each departure exactly once: the pass that dropped an
   * item named it in complete[], the next pass rewrote the ledger without it,
   * and if the Mac's writer had not run in between, the completion was lost.
   * Nineteen closes on 2026-09-18 left 23 items stranded open on his phone that
   * way, found by the Mac session diffing its own extract against the mirror.
   *
   * The extract is the right source because it is the only one that knows what
   * he can see. A mirror is a statement of what the list should hold; the diff
   * belongs against the list itself.
   */
  let complete = [];
  const wanted = new Set(items.map((i) => i.id));
  for (const r of apple0?.reminders ?? []) {
    if (r.completed) continue;
    const id = mirrorOf(r);
    if (!id || wanted.has(id)) continue;
    const o = byId.get(id);
    // Closed, merged, or simply no longer wanted. None of the three is an
    // error: a ticked `todo.md` line stops being an obligation at all, a merge
    // folds one id into another, and an item he has his own reminder for is
    // deliberately not mirrored twice. `why` rides along so the Mac's log says
    // which, and so a person reading it later is not told "closed" about
    // something that is still open under another name.
    const into = o ? null : (merges.get(id) ?? null);
    complete.push({ id, why: into ? `merged into ${into}` : o ? (o.open === false ? 'closed here' : 'no longer due or on a project') : 'closed here (gone from the list)' });
  }

  /* His OWN reminders, closed here rather than there.
  *
  * Alex, 2026-09-18: "so once they are linked, closing one closes both?"
  * When he links his "Sales Tax" reminder to the real task and then closes the
  * task here, the reminder on his phone has to go too — otherwise the source
  * keeps reporting it open, the obligation springs back, and linking means
  * nothing. This is the only case where the Mac touches a list of his: it is
  * named one reminder at a time, it may only complete it, and the queue is
  * written only for a close he made himself (see close() in the source).
  */
  const mine = await tickedHere(vault);
  const byReminder = new Map((apple0?.reminders ?? []).map((r) => [r.id, r]));
  for (const [uid, v] of Object.entries(mine)) {
    const r = byReminder.get(uid);
    if (!r || r.completed) continue;                     // already done, or gone from his list
    complete.push({ reminder: uid, list: r.list ?? null, title: r.title ?? null,
                    why: `he closed it here on ${String(v.at ?? '').slice(0, 16)}` });
  }

  // His ticks, from the last extract the Mac pushed.
  //
  // The trap, spotted by the Mac session before either half had run: when the
  // writer completes something from `complete[]`, the next extract shows it
  // completed WITH a marker — the same shape as him ticking it on his phone.
  // Closing on that would put his name on a decision he never made, and his
  // closes never come back for another look. So every id the bridge asks to be
  // completed is written down first, and a tick on one of those is the Mac
  // obeying, not him deciding.
  const asked = await readJson(vault, join(...ASKED), {});
  const { readCloses } = await import('./agent-service/logbook.mjs');
  const closes = await readCloses(vault);
  const done = {};                                     // id -> the reminder the Mac completed for us
  const apple = apple0;
  const ticked = [];
  const obeyed = [];
  for (const r of apple?.reminders ?? []) {
    if (!r?.completed) continue;
    const id = mirrorOf(r);
    if (!id) continue;                                   // his own reminder: his business
    // ...unless this is a DIFFERENT reminder from the one we asked about.
    //
    // The ledger records which reminder the Mac completed on our behalf, not
    // merely that we asked. An item can leave the mirror for a reason that is
    // not a close — its date moves out of the week — be completed on request,
    // and later come back as a NEW reminder with a new identifier. A tick on
    // that one is his. Keying on the item alone swallowed his real tick; keying
    // on the reminder tells obedience and decision apart even when a stale
    // extract still carries the old completion.
    const a = asked[id];
    if (a && (!a.done || a.done === r.id)) {
      obeyed.push(id);
      done[id] = r.id;
      continue;
    }
    const o = byId.get(id);
    if (!o || o.open === false) continue;                // already closed here
    /* A TICK IS SPENT ONCE. Alex, 2026-09-23: "I don't recall that" — of a
       close at 12:43 that said he had ticked the Gail Quinn item off in
       Reminders. He had, on 09-19 at 09:34, and it closed the item then at
       10:05. Today the mail triage reopened the same thread as a new debt
       (her answer on the threshold engineer), the old completed reminder was
       still in the extract under the same id, and this loop read it as a
       fresh decision — closing a live item in his name with a four-day-old
       tick. A completion the logbook has already closed on at or after is
       the past, not an instruction. */
    const spent = closes.get(id);
    if (spent && r.completed_at && String(spent.at) >= String(r.completed_at)) continue;
    ticked.push({ id, title: o.title ?? id, at: r.completed_at ?? null, reminder: r.id });
  }
  // A mirrored item that came back carrying an alarm. Nothing here sets one and
  // the file says `alarms: false`, so this is either a list default or his own
  // hand — worth a number rather than a silence, because the whole reason he
  // agreed to the mirror is that it does not buzz.
  const alarmed = (apple?.reminders ?? [])
    .filter((r) => r.has_alarm && mirrorOf(r) && !r.completed).map((r) => mirrorOf(r));

  /* One entry per id, always.
   *
   * The Mac's reader drops EVERY copy of an id that appears twice rather than
   * keeping the first, so that a reordered mirror cannot silently pick a
   * different one on the next pass. That is the right rule on their side, and
   * it means a duplicate emitted here does not produce a duplicate reminder —
   * it makes the item vanish from the pass entirely. Both lists are unique by
   * construction (obligations are merged before they get here, and complete[]
   * is keyed off the phone), so this is insurance, not a fix: it counts what it
   * dropped, because a silent de-duplication would hide the bug it is guarding.
   */
  const dedupe = (rows, key) => {
    const seen = new Set(), out = [], dropped = [];
    for (const r of rows) {
      const k = r[key];
      if (k && seen.has(k)) { dropped.push(k); continue; }
      if (k) seen.add(k);
      out.push(r);
    }
    return { out, dropped };
  };
  const uniqueItems = dedupe(items, 'id');
  const uniqueComplete = dedupe(complete.filter((c) => c.id), 'id');
  const duplicated = [...uniqueItems.dropped, ...uniqueComplete.dropped];
  items = uniqueItems.out;
  complete = [...uniqueComplete.out, ...complete.filter((c) => !c.id)];

  const doc = {
    generated_at: localStamp(new Date(now)),
    // What shape this file is in. Added 2026-09-18, the day complete[] grew a
    // second kind of entry while the Mac's writer was live: an older decoder
    // would have refused the whole mirror at the first one and frozen his list.
    // Nothing broke, because the Mac shipped its decoder first — but that was
    // sequencing luck, not design. A reader that knows the number can refuse
    // one entry and say so rather than refusing the file and going quiet.
    schema: 2,
    list: LIST,
    // Stated in the file rather than assumed by the Mac: the nagging belongs to
    // the dispatcher, and a bridge that quietly started setting alarms would be
    // a second pusher nobody budgeted for.
    alarms: false,
    items,
    complete,
  };

  const closed = [];
  if (write) {
    await writeFile(join(vault, MIRROR), JSON.stringify(doc, null, 1) + '\n');
    // The ledger of what was mirrored is kept for the record, but nothing
    // decides anything from it any more — see the comment on `complete`.
    const seen = await readJson(vault, join(...SEEN), {});
    const next = {};
    for (const i of items) next[i.id] = seen[i.id] ?? localStamp(new Date(now));
    await writeFile(join(vault, ...SEEN), JSON.stringify(next, null, 1));
    // The completion ledger: what we have asked for, minus what the Mac has
    // since done and anything old enough that a stray tick cannot plausibly be
    // ours. It is a guard against mistaking obedience for a decision, not a
    // record worth keeping — the logbook holds the closes.
    const cutoff = localStamp(new Date(now - ASKED_DAYS * 86400000));
    const keepAsked = {};
    for (const [id, v] of Object.entries(asked)) {
      if (String(v?.at ?? '') < cutoff) continue;        // old enough that a tick cannot be ours
      keepAsked[id] = done[id] ? { ...v, done: done[id] } : v;
    }
    for (const c of complete) if (c.id) keepAsked[c.id] = { at: localStamp(new Date(now)), why: c.why };
    // And drop the queued ticks the Mac has already done, so the queue is the
    // work outstanding rather than a growing record of everything ever closed.
    const stillPending = {};
    for (const [uid, v] of Object.entries(mine)) {
      const r = byReminder.get(uid);
      if (r && r.completed) continue;                    // done there; stop asking
      if (String(v?.at ?? '') < cutoff) continue;        // old enough to give up on
      stillPending[uid] = v;
    }
    await writeFile(join(vault, ...TICKED), JSON.stringify(stillPending, null, 1));
    await writeFile(join(vault, ...ASKED), JSON.stringify(keepAsked, null, 1));
    // His tick closes it. Same verb as the page's Done button, and his name on
    // it, so the differs never reopen it.
    const { closeObligation } = await import('./agent-service/obligations.mjs');
    for (const t of ticked) {
      const r = await closeObligation(vault, t.id, 'alex', 'ticked off in Reminders')
        .catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
      closed.push({ ...t, ...r });
    }
  }
  // What is open on his phone, wanted by nobody, and not being ticked off. It
  // should always be zero after a rebuild; anything else means a mirror and a
  // list that disagree, which is the bug this pass was rewritten to kill.
  const stranded = (apple?.reminders ?? []).filter((r) => {
    const id = !r.completed && mirrorOf(r);
    return id && !wanted.has(id) && !complete.some((c) => c.id === id);
  }).length;
  return { list: LIST, items, complete, ticked, closed, over, obeyed, alarmed, stranded, duplicated,
           apple_at: apple?.generated_at ?? null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await bridge(OBLIGATIONS, { write: process.argv.includes('--write') });
  console.log(`${r.items.length} item(s) for the ${r.list} list${r.over ? `, ${r.over} over the cap` : ''}`);
  for (const i of r.items.slice(0, 10)) console.log(`  ${i.due ? i.due : '          '}  ${i.title.slice(0, 70)}`);
  if (r.items.length > 10) console.log(`  …and ${r.items.length - 10} more`);
  console.log(`\n${r.complete.length} to tick off (closed or gone)`);
  console.log(r.apple_at ? `his lists last read ${r.apple_at}` : 'no extract from the Mac yet — nothing of his is being read');
  for (const t of r.ticked) console.log(`  he ticked: ${t.title}`);
  if (r.obeyed.length) console.log(`  ${r.obeyed.length} completed because we asked, not because he did`);
  if (r.alarmed.length) console.log(`  ! ${r.alarmed.length} mirrored item(s) came back with an alarm set`);
}
