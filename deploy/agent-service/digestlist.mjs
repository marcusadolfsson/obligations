/**
 * The digest: everything the system judged and nothing is owed on.
 *
 * Alex, 2026-09-04: "we need a digest tab. The reading list needs an
 * overhaul, those really should be in the digest and then accessible if you
 * want a deep dive. There was nothing special about the newsletter forward list
 * you imported."
 *
 * He is describing a real defect, not a preference. The reading page did not
 * come from the triage at all: `readingList()` builds a live Gmail query from
 * the senders in his imported `gmail-filters.xml` and asks for whatever is
 * unread from them. Its membership was decided by a file he exported from Gmail
 * once — provenance — while every other surface here is decided by judgement.
 * Two lists of mail, one earned and one inherited, and the inherited one had
 * the tab.
 *
 * So this reads conclusions instead. The unit is what the agent decided about a
 * thread, which means the line can say what the thing WAS — "Regional Venture
 * Forum early-bird promotion" — rather than repeating the sender's own subject
 * back at him. That is the whole reason a digest is worth having: the subject
 * line is the sender's claim, the title is ours.
 *
 * `reading` survives as a rank, not a room. A thread judged worth opening sorts
 * to the top and keeps its label; it no longer gets its own destination, which
 * is what made it look like a category when it was only ever a hint.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ignoredSenders, isIgnored, addressOf } from './reading.mjs';
import { withRepoLock } from './lock.mjs';
import { localStamp } from './time.mjs';

/* digest and reading only. `awareness` is the brief's business — it is
 * time-sensitive and being told once is the point — and `memory` is already
 * filed in reference/. Pulling either in here would give one fact two homes,
 * which is the failure this page exists to undo. */
export const DIGEST_TIERS = ['reading', 'digest'];

/**
 * The window the WRITTEN digest narrates, and the list's default.
 *
 * Named rather than left as a literal because it means one thing and was
 * being read as another: it is how far back the model is asked to summarise,
 * not the definition of "unread". Alex, 2026-09-19: "why is there a 14 day
 * limit?"
 */
export const DIGEST_DAYS = 14;

/**
 * THE LINE BEFORE WHICH NOTHING WAS EVER DIGESTED.
 *
 * Alex, 2026-09-21, reworking mail: "I don't know how to deal with really
 * old imported email that was never featured in a Digest … Maybe a tag 'Never
 * Digested'?"
 *
 * Membership in the digest is now "has an archived digest narrated this
 * thread", and for the 1,396 threads judged before this existed the answer is
 * no — four of them were in the two digests archived on the day, and there is
 * no record anywhere that could say anything about the rest. Left alone they
 * would all pour into the Current Digest and the first archive would be
 * unreadable.
 *
 * So a dated line rather than a migration: anything judged before this was
 * never digested and never will be, and it is a view he can browse rather than
 * a queue he has to clear. It never grows again. A constant and not a file,
 * because it is one fact about this repo's history and a file would be a
 * second copy of it that could disagree.
 */
export const DIGESTED_FROM = '2026-09-21 18:00';

const STATE = ['integrations', 'email-state.json'];

/* IGNORING A SENDER HAS TO REACH THE MAIL ALREADY JUDGED.
 *
 * Alex, 2026-09-21: "if I ignore an email @reply-sg.angellist.example it should
 * hide it from the unread list." It did not. The button wrote the rule, the
 * differ stopped offering new threads from them, and the reading page honoured
 * it — but this list, which is what /mail actually shows, read only the tier
 * and the window. So 19 angellist threads judged before he pressed it stayed
 * unread for ever, and ignoring a sender silently meant "from now on".
 *
 * `integrations/ignored-senders.json`'s own docstring has promised since it was
 * written that "the reading list and the digest never show them". This is the
 * half that was missing. reading.mjs owns the file and the matcher — an exact
 * address or a whole `@domain` — and this borrows both rather than keeping a
 * second copy of a rule that must not drift.
 *
 * They are counted, never silently dropped: `counts.ignored` is the number, so
 * a list that got shorter says why. And they stay in the filed history, which
 * is the audit trail — ignoring a sender is not deleting the record of what was
 * done with their mail. */
const senderOf = (who) => addressOf(who);

/* Read state lives in its OWN file, not in email-state.json.
 *
 * That file belongs to the mail job. CLAUDE.md: "Never edit another source's
 * state file by hand — that is how two writers start disagreeing about what is
 * open." Whether Alex has looked at a digest line is a fact about him, not a
 * conclusion about the thread, so it has no business in the judgement record
 * anyway. Same shape and same reason as integrations/ignored-senders.json: a
 * small file the web writes and the agent only reads. */
const READ = ['integrations', 'digest-read.json'];

/** Which threads he has cleared. Exported since 2026-09-19: the read mark now
 *  governs every tier, not only the two the digest used to list. */
export async function readState(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, ...READ), 'utf8'));
    return d?.read && typeof d.read === 'object' ? d.read : {};
  } catch {
    return {};                 // no file yet means nothing has been read
  }
}

/**
 * Mark digest rows read (or unread again).
 *
 * Ids only — nothing about the message is copied in. A row that later falls out
 * of the window leaves a key behind; that is a few dozen bytes and it means the
 * state survives a thread reappearing, which is the behaviour worth having.
 */
export async function markDigestRead(vault, ids, read = true) {
  const list = (Array.isArray(ids) ? ids : [ids])
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^[a-z0-9_-]+:[a-z0-9]+$/i.test(v));      // account:threadId
  if (!list.length) return { changed: 0 };

  let changed = 0;
  await withRepoLock(vault, async () => {
    const path = join(vault, ...READ);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch { d = { read: {} }; }
    d.read ??= {};
    for (const id of list) {
      if (read && !d.read[id]) { d.read[id] = localStamp(); changed++; }
      else if (!read && d.read[id]) { delete d.read[id]; changed++; }
    }
    if (changed) await writeFile(path, JSON.stringify(d, null, 2) + '\n');
  });
  return { changed };
}

const ARCHIVED = ['integrations', 'digest-archived.json'];

/**
 * Which threads an archived digest has already narrated.
 *
 * The one thing the old design never recorded. A digest used to be a 14-day
 * window over whatever was unread, so a thread left it by ageing rather than
 * by being reported, and nothing could answer "has he been told about this".
 * Same shape and same reasoning as `digest-read.json` next door: ids only,
 * stamped, and a key left behind costs a few dozen bytes and survives a thread
 * reappearing.
 *
 * Read state and this are different questions and deliberately different
 * files. Whether he opened something is a fact about him; whether the assistant
 * has reported it is a fact about the assistant.
 */
export async function readArchived(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, ...ARCHIVED), 'utf8'));
    return d?.archived && typeof d.archived === 'object' ? d.archived : {};
  } catch {
    return {};                 // no file yet means nothing has been reported
  }
}

/**
 * Record that a digest has narrated these threads. The one door.
 *
 * Never unsets: a digest that went out cannot be un-sent, and the reopen story
 * here is simply that a new thread on the conversation is judged again and
 * enters the next digest under its own id.
 */
export async function markDigestArchived(vault, ids, { now = null } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids])
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^[a-z0-9_-]+:[a-z0-9]+$/i.test(v));      // account:threadId
  if (!list.length) return { changed: 0 };

  let changed = 0;
  await withRepoLock(vault, async () => {
    const path = join(vault, ...ARCHIVED);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch { d = { archived: {} }; }
    d.archived ??= {};
    const at = now ? localStamp(now) : localStamp();
    for (const id of list) if (!d.archived[id]) { d.archived[id] = at; changed++; }
    // The directory may not exist yet — this is the first artifact written
    // into it on a fresh repo, and an ENOENT here would lose the record of a
    // digest that has already gone out.
    if (changed) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(d, null, 2) + '\n'); }
  });
  return { changed };
}

/**
 * Which of the three buckets a judged thread is in. The one rule.
 *
 * Alex, 2026-09-21: "digest emails that have yet been included in an
 * 'Archived Digest' is labeled 'Current Digest'. You can still track
 * read/unread status, but they will always be in the current digest until that
 * Digest is archived."
 *
 * So read state decides nothing here — it is shown on the row and that is all.
 * What decides is whether a digest has reported the thread, and before that,
 * whether it is old enough to predate the whole mechanism.
 */
export function bucketOf(row, archived = {}, from = DIGESTED_FROM) {
  if (archived[row?.id]) return 'archived';
  return String(row?.reviewed ?? '') < String(from) ? 'never' : 'current';
}

/** `2026-09-04 10:02` -> epoch ms. Bare, offsetless, local — the repo's stamp. */
export function stampMs(s) {
  const t = Date.parse(String(s ?? '').replace(' ', 'T'));
  return Number.isNaN(t) ? 0 : t;
}

/**
 * One row per judged thread, newest first, grouped by sender.
 *
 * @param days   how far back to look. The state file holds everything ever
 *               judged; the page is a digest, not an archive.
 * @param limit  hard ceiling on rows returned, applied AFTER sorting so a busy
 *               fortnight drops the oldest rather than a random slice.
 */
export async function digestList(vault, { days = 0, limit = 400, from = DIGESTED_FROM } = {}) {
  let state;
  try {
    state = JSON.parse(await readFile(join(vault, ...STATE), 'utf8'));
  } catch (err) {
    // Never an empty list on failure. An empty digest reads as "a quiet
    // fortnight", which is a lie a broken read must not be able to tell.
    return { items: [], groups: [], counts: {}, reason: String(err?.message ?? err) };
  }

  const read = await readState(vault);
  // Which threads a digest has already reported. See bucketOf.
  const archived = await readArchived(vault);
  // His standing rule, read fresh: pressing Ignore has to take effect on the
  // next load, not at the next triage.
  const ignored = await ignoredSenders(vault).catch(() => new Set());
  // `days: 0` means no window at all. Alex, 2026-09-19: "why is there a 14
  // day limit?" It was never a decision about what is unread — it is what the
  // WRITTEN digest narrates, and it had quietly become the definition of the
  // unread count as well, hiding 603 unread threads going back to February.
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const items = [];
  let hidden = 0;
  for (const t of state.threads ?? []) {
    const c = t.conclusion;
    if (!c || !DIGEST_TIERS.includes(c.tier)) continue;
    const at = stampMs(c.since || t.watermark);
    if (cutoff && at && at < cutoff) continue;
    if (ignored.size && isIgnored(senderOf(c.who), ignored)) { hidden++; continue; }
    items.push({
      id: `${t.account}:${t.thread_id}`,
      account: t.account,
      threadId: t.thread_id,
      tier: c.tier,
      // The agent's line, with the sender's own subject kept as the fallback
      // and shown underneath — never instead. Seeing both is how he can tell
      // the judgement was about the thing he thinks it was about.
      title: c.title || c.subject || '(no subject)',
      subject: c.subject || '',
      what: c.what || '',
      who: c.who || '',
      at,
      when: c.since || t.watermark || '',
      read: !!read[`${t.account}:${t.thread_id}`],
      // WHEN IT WAS JUDGED, not when it was sent. The bucket rule turns on
      // this and only this: a thread judged before the changeover was never in
      // an archived digest, whatever date the message itself carries.
      reviewed: t.reviewed || t.watermark || '',
      bucket: bucketOf({ id: `${t.account}:${t.thread_id}`, reviewed: t.reviewed || t.watermark || '' }, archived, from),
    });
  }

  // Reading first, then by time. A thread judged worth opening is the one thing
  // on this page with a next action attached to it, even if that action is only
  // "read this", so it does not get to sink under a week of receipts.
  items.sort((a, b) => (a.tier === b.tier ? b.at - a.at : a.tier === 'reading' ? -1 : 1));
  // `limit: 0` means no ceiling. Alex, 2026-09-19: "remove the newest 400
  // shown". The honest way to stop saying it is to stop doing it — hiding the
  // sentence while still dropping 800 rows is the lie the sentence prevented.
  const kept = limit > 0 ? items.slice(0, limit) : items;

  // Grouped by sender, because the questions arrive that way — "what has
  // Stratos been sending me" — and because a sender is the unit he would
  // silence. Groups are ordered by their newest item, not by size: a loud
  // newsletter must not outrank a person who wrote once this morning.
  const by = new Map();
  for (const it of kept) {
    const key = it.who || '(unknown sender)';
    if (!by.has(key)) by.set(key, { who: key, items: [], newest: 0, reading: 0, unread: 0 });
    const g = by.get(key);
    g.items.push(it);
    g.newest = Math.max(g.newest, it.at);
    if (it.tier === 'reading') g.reading += 1;
    if (!it.read) g.unread = (g.unread ?? 0) + 1;
  }
  const groups = [...by.values()].sort((a, b) => b.newest - a.newest);

  return {
    items: kept,
    groups,
    counts: {
      shown: kept.length,
      // Absence gets a number: how many were dropped by the ceiling, and how
      // many by the window. "521 judged, 400 shown" is a different page from
      // "400 judged", and the difference must not be invisible.
      total: items.length,
      dropped: items.length - kept.length,
      reading: kept.filter((i) => i.tier === 'reading').length,
      unread: kept.filter((i) => !i.read).length,
      senders: groups.length,
      /* The two buckets the page is built on. `current` is what the next
         archive will cover and what the Archive button says, so it counts read
         rows too — read state stopped deciding membership on 2026-09-21. */
      current: kept.filter((i) => i.bucket === 'current').length,
      never: kept.filter((i) => i.bucket === 'never').length,
      // Absence gets a number. A sender he silenced is not the same fact as a
      // quiet week, and the page must be able to tell him which it is looking at.
      ignored: hidden,
      days,
    },
    reason: null,
  };
}

/**
 * The work list can lag the judgements by minutes; a thread the mail job has
 * judged since the list was written is not waiting, whatever the list says.
 * Exported for the tests. Alex, 2026-09-06: "so why were they not digested
 * 13 min ago."
 */
export function stillWaiting(need, threads, listAt) {
  const at = stampMs(listAt);
  const judged = new Map((threads ?? []).filter((t) => t.conclusion).map((t) => [`${t.account || 'personal'}:${t.thread_id}`, stampMs(t.reviewed)]));
  return (need ?? []).filter((e) => {
    const when = judged.get(`${e.account || 'personal'}:${e.thread_id}`);
    return !(when && at && when >= at);
  });
}
