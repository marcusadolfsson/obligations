/** Move between tiers. Each one is a fresh slice from the server. */
/**
 * Back to the top of the list.
 *
 * Alex, 2026-09-19: "when you change sort by sender by date, you need to
 * scroll to the top of the list." Re-grouping the same threads leaves the
 * scroller exactly where it was, so a switch from By date to By sender landed
 * him 600px down a list with a completely different order — the same rows, in
 * a place that means nothing, with no way to tell it had worked.
 *
 * Both scrollers: the column scrolls on a desktop and the page scrolls on a
 * phone, and which one is live depends on the width.
 */
function toTop() {
  for (const n of [listEl, listEl?.parentElement, listEl?.closest('.listcol'), document.scrollingElement]) {
    if (n && n.scrollTop) n.scrollTop = 0;
  }
}

async function pick(key) {
  tier = key;
  current = null;
  remember();
  // A different tier is a different list; keeping the offset is the same bug.
  toTop();
  drawFilters(); draw();
  if (key !== 'pending') await load();
}

/**
 * Digest: judged mail, one stream, unread first.
 *
 * Alex, 2026-09-06: "the digest should be like the briefing, but either by
 * date or by sender for anything that is unread. then you can click into
 * anything that sounds interesting and see the message." And the briefs are
 * gone from here — they are on Today and on /said.
 *
 * Every item is a conclusion the mail job wrote: who, the subject, and one
 * line on what it was (`what`). The pane shows that line, then the message
 * itself, from both accounts. A line at the top says how much mail is still
 * waiting for the job, because an empty digest and a stalled pipeline must
 * not look the same.
 */
import { el, chip, section, empty, digestCard, swipeable, composer, link, kindTag, keepButton, TIER_LABEL, READS_HIMSELF } from './ui.mjs';
import { openState, closeState, onStateChange, stateFromUrl, readParams, writeView } from './histate.mjs';
import { draftFoot, replyBox } from './draft-pane.mjs';
import { trimQuoted } from './links.mjs';
import { mailFrame, mayHaveHtml } from './mail-view.mjs';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const listEl = document.getElementById('diglist');
const paneEl = document.getElementById('digpane');
const splitEl = document.getElementById('digsplit');
const countEl = document.getElementById('digcount');
const filtEl = document.getElementById('digfilters');
const dock = document.getElementById('digdock');
const onPage = !!(listEl && paneEl && countEl && filtEl);

/* Every judged thread for the tier being shown, from /api/filed — the one
   dataset. `counts` is the per-tier {total, unread} that the pills read. */
let items = [];
let counts = null;       // per tier: { total, unread }
let totals = { total: 0, unreadTotal: 0, matching: 0 };
let waiting = null;
let reason = null;
/* ONE DATASET, A TOGGLE, AND THE TIERS.
 *
 * Alex, 2026-09-19: "lets simplify further. Unread Only (toggle) — then All
 * 2020, Action 399, Memory 62, Awareness 139, Newsletter 83, Digest 1276,
 * Ephemeral 23, Silent 38 — derived from the toggle."
 *
 * Before this the page held two overlapping datasets: an "unread" list of the
 * two ambient tiers, and an "archive" of all seven. Every count confusion of
 * the last day came from a number computed over one of them sitting beside a
 * list drawn from the other — 400 against 738, 296 against 1233, 83 against a
 * handful. One dataset cannot disagree with itself.
 *
 * THE UNREAD TOGGLE IS GONE, 2026-09-21. Alex: "Remove the Unread Only
 * toggle … digest emails that have yet been included in an 'Archived Digest'
 * is labeled 'Current Digest'. You can still track read/unread status, but
 * they will always be in the current digest until that Digest is archived."
 *
 * It was a second definition of what the digest held, competing with the one
 * the Archive button used, which is why their two numbers kept disagreeing.
 * Membership is now a fact — has an archived digest reported this thread —
 * and read state is a mark on a row and nothing more. `pending` is still the
 * one thing outside the model, with no tier because it has not been judged.
 */
/* Read from the URL, so a link carries the view. Alex, 2026-09-19: "can we
   write the url on every load, so you can deeplink to a mail, task etc." */
const TIERS = ['all', 'current', 'never', 'action', 'memory', 'awareness', 'reading', 'digest', 'ephemeral', 'silent', 'pending'];
/** The order he reads them in — see drawFilters. `all` and `pending` are not
 *  here: neither is a tier, and both sit at the end of the row on purpose. */
/* NEWSLETTERS LOST THEIR PILL. Alex, 2026-09-19: "we will remove Newsletters
 * from the mail menu, since they will be in the digest." The tier is unchanged
 * — his reading list still assigns it, the written digest still opens with it,
 * and the rows still carry a Newsletter tag and the long-read rule — but it is
 * no longer a place to go. That was the third touchpoint: the digest already
 * narrates these, and a tab for the same threads made reading them a decision
 * about which page to be on. */
/* `current` leads: it is the one place with anything waiting in it.

   NEVER DIGESTED HAS NO PILL. Alex, 2026-09-22, of "1352 judged never
   digested": "i would just hide that area, it doesnt add much value." It is
   a fixed pile that never grows and asks nothing of him, so a pill for it was
   a number to read past on every visit. The bucket still exists — it is what
   keeps those threads out of the Current Digest — and `#tier=never` still
   opens it for anyone who goes looking. */
const PILLS = ['current', 'action', 'memory', 'awareness', 'ephemeral', 'silent'];
const atStart = readParams();
/* THE DIGEST IS THE FRONT DOOR. Alex, 2026-09-19: "the default mail view
   should be digest." All is the whole judged history, most of it handled — the
   right thing to fall back to and the wrong thing to open on. The digest is
   what is actually waiting for him to read, and it is the only view the
   written summary above the list describes. */
let tier = TIERS.includes(atStart.tier) ? atStart.tier : 'current';
let by = atStart.by === 'sender' ? 'sender' : 'date';
/** Everything about this view that a link should carry. */
const remember = () => writeView({ tier: tier === 'current' ? null : tier,
                                   by: by === 'date' ? null : by });
let current = null;

const dayLabel = (ms) => {
  const d = new Date(ms), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return 'today';
  if (same(d, new Date(t.getTime() - 86400000))) return 'yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
const atMs = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };

/* ------------------------------------------------------------- read state */

/* Opened while he was looking at an unread list.
 *
 * Alex, 2026-09-19, of the digest: "and it disappears once you open it."
 * Opening marks it read, and the unread filters are computed live, so the row
 * he just tapped vanished from underneath him and the list jumped. The filter
 * means "what had not been read when I arrived", not a live re-sort — the same
 * fix the Briefs page got a day earlier. */
const readHere = new Set();

/**
 * Move the pills by hand when he clears something.
 *
 * Alex, 2026-09-19: "can you update the unread counters in the menu in
 * realtime as items are read." They did not, and the reason is worth knowing:
 * the list is drawn from `items` and re-renders on every change, but the pills
 * are drawn from `counts`, which is the SERVER's tally and only arrives with a
 * load. So marking forty newsletters read emptied the list and left every
 * number where it was.
 *
 * Applied the same way the read flag is — optimistically, and reversed on a
 * refusal — so the number and the row it came from can never disagree about
 * whether the write succeeded. `silent` is kept out of the running total
 * because `All` excludes it, exactly as the server does.
 */
function countRead(changed, read) {
  const by = read ? -1 : 1;
  for (const i of changed) {
    /* Only the two tiers he reads himself have a number to move, and a
       newsletter moves the DIGEST pill — the same fold the server does, or the
       optimistic update would credit a count with no pill to show it and the
       row would clear while the menu stood still. */
    if (!READS_HIMSELF.has(i.tier)) continue;
    const view = i.tier === 'reading' ? 'digest' : i.tier;
    counts ??= {};
    counts[view] ??= { total: 0, unread: 0 };
    counts[view].unread = Math.max(0, (counts[view].unread ?? 0) + by);
    totals.unreadTotal = Math.max(0, totals.unreadTotal + by);
  }
}

async function setRead(list, read) {
  for (const i of list) { if (read) readHere.add(i.id); else readHere.delete(i.id); }
  const changed = list.filter((i) => !!i.read !== read);
  if (!changed.length) return;
  const was = changed.map((i) => i.read);
  for (const i of changed) i.read = read;
  countRead(changed, read);
  drawFilters(); draw();
  try {
    const r = await fetch('/api/digest/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ ids: changed.map((i) => i.id), read }) });
    if (!(await r.json()).ok) throw new Error('refused');
  } catch {
    changed.forEach((i, k) => { i.read = was[k]; });
    countRead(changed, !read);
    drawFilters(); draw();
  }
}

/* ------------------------------------------------------------------- list */

function visible() {
  if (tier === 'pending') return [];                   // draw() renders these itself
  // The server has already applied the tier and the toggle; `readHere` keeps a
  // row he just opened from vanishing out from under him.
  return [...items].sort((a, b) => b.at - a.at);
}

function card(it) {
  // The card draws itself, tags and all — see digestCard. Everything the page
  // used to append after the fact is why the rows were "a bit all over the
  // place": two tag positions with prose between them.
  const c = digestCard(it, { onOpen: () => select(it) });
  if (current === it.id) c.classList.add('selected');
  /* Swipe-to-read only where read is a state. On an action or memory row the
     gesture offered to mark something read that the assistant read for him, and
     the mark then moved a count he was never shown. Alex, 2026-09-19. */
  if (!READS_HIMSELF.has(it.tier)) return c;
  return swipeable(c, { onRight: () => setRead([it], !it.read), rightLabel: it.read ? 'unread' : 'read' });
}

/**
 * A thread the mail job has not judged yet. Tapping it opens the message like
 * any other — the thread is in Gmail already; only the judgement is missing.
 * Alex, 2026-09-06: "clicking on it should show the content."
 */
// The differ's reasons, in words that say what to expect. Alex, 2026-09-06:
// explain "(left the extract before it was ever judged)". The extract is the
// 14-day window of mail the pipeline sees; a thread that was archived or
// filtered out of it before the mail job got to it is kept on the list — an
// escape is still judged, never dropped — and the job can fetch it by id.
const REASONS = {
  'not seen before': 'new — first time on the list',
  'new messages': 'new messages since it was last judged',
  'conclusion not revisited in 7+ days': 'already judged — due another look after 7 quiet days',
  'left the extract before it was ever judged': 'archived or filtered out before it was judged — kept on the list',
  'archived by hand, never judged': 'you archived it before it was judged — kept on the list',
  'ignored sender': 'from an ignored sender — will be archived, not judged',
};
function waitingCard(w) {
  const c = el('article', 'card card-waiting');
  const top = el('div', 'card-top');
  top.append(el('span', 'card-who', w.who || 'sender not known yet'), el('span', 'card-when', REASONS[w.reason] ?? w.reason));
  c.append(top, el('div', 'card-title', w.subject));
  if (w.signals?.length) c.append(el('div', 'card-sub', 'signals: ' + w.signals.join(', ')));
  const it = { id: 'waiting:' + w.account + ':' + w.threadId, account: w.account, threadId: w.threadId, subject: w.subject, title: w.subject,
               who: w.who, when: w.since ?? '', at: atMs(w.since), read: true, waiting: true,
               what: `Not judged yet — waiting for the mail job (${w.reason}). What you read here is the mail itself, before any decision about it.` };
  c.onclick = () => select(it); c.tabIndex = 0; c.setAttribute('role', 'button');
  if (current === it.id) c.classList.add('selected');
  return c;
}

/**
 * The digest: everything judged that he has not read, rolled up — one
 * document, not a list. Alex, 2026-09-06: "unread very much feels like an
 * inbox … the digest keeps compounding by looking at the unread status … the
 * latest digest incorporates the previous unread digests." So it is computed
 * over the unread set whenever the page opens: each mail-job run adds to the
 * set, reading the digest clears it, and there is nothing to write or merge.
 * The words are the judgements the mail job already wrote per thread.
 */
/** A day, spelled the way the rest of the app spells one. */
const dayOf = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
};

/**
 * The written digest, and what it covers.
 *
 * Only on `unread / all`. Alex, 2026-09-19: "this should only show on the
 * unread all tab" — under `newsletters` it was describing a set the lens was
 * not showing, and it has nothing to say about the archive at all.
/* No archive by hand. Alex, 2026-10-03: "Remove the ability to manually make a
   mail digest, and remove from briefs section." The digest is filed only by the
   three daily briefs it rides; the Current Digest empties when one of them does. */

function groupRows(xs) {
  const groups = new Map();
  for (const it of xs) {
    const k = by === 'sender' ? (it.who || 'unknown sender') : dayLabel(it.at);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const ordered = [...groups.entries()];
  const sections = ordered.length;
  // By sender, the biggest first and the most recent among equals; by date,
  // newest first, which the incoming sort already gives.
  if (by === 'sender') ordered.sort((a, b) => b[1].length - a[1].length || b[1][0].at - a[1][0].at);
  for (const [k, rows] of ordered) {
    listEl.append(section(k, { count: rows.length }));
    /* EVERY ROW. Alex, 2026-09-19: "on mail always show all emails in the
       list not the xx more." The fold at eight was there to keep a long sender
       group from burying the next one, and the cost was that the list stopped
       being the list: what he was looking at depended on how many buttons he
       had pressed, and a group of forty read as a group of eight. Scrolling is
       cheaper than remembering which sections you expanded. */
    for (const it of rows) listEl.append(card(it));
    const unread = rows.filter((i) => !i.read);
    if (unread.length) {
      const b = el('button', 'sec-action dg-mark', `Mark ${unread.length} read`);
      b.type = 'button';
      b.onclick = () => setRead(rows, true);
      const foot = el('div', 'dg-foot');
      foot.append(b);
      listEl.append(foot);
    }
  }
  return sections;
}

function draw() {
  listEl.textContent = '';
  // What the mail job has not judged yet sits above the judged, so an empty
  // digest and a backlog cannot look the same. Alex, 2026-09-06: "under
  // digest show the 3 waiting to be digested."
  /* `pending` is a place now, not a banner. Alex, 2026-09-19 put it on the
   * filter row beside unread and archive — the count stays visible there, so
   * an empty digest and a stalled pipeline still cannot look the same, which
   * is the whole reason it used to sit on top of every list. */
  if (tier === 'pending') {
    const w = waiting?.items ?? [];
    if (!w.length) { listEl.append(empty(waiting?.stale ? `backlog unknown — ${waiting.why}` : 'nothing waiting — the mail job is current.')); return; }
    /* Two different things were under one heading. Alex, 2026-09-19: "why is
     * Re: Your 12-week journey starts now … sitting in waiting to be
     * digested?" It was not new mail at all — it was judged on 09-12 and came
     * back after seven quiet days so the triage can confirm the obligation is
     * still open, which is the mechanism that stops a wrong call standing
     * forever. Calling that "waiting to be digested" says the pipeline is
     * behind when it is doing its job. */
    const fresh = w.filter((x) => !/not revisited/.test(x.reason ?? ''));
    const again = w.filter((x) => /not revisited/.test(x.reason ?? ''));
    if (fresh.length) {
      // The cadence is on the count line now, where the number it explains is.
      listEl.append(section('waiting to be digested', { count: fresh.length }));
      for (const x of fresh) listEl.append(waitingCard(x));
    }
    if (again.length) {
      listEl.append(section('due another look', { count: again.length }));
      listEl.append(el('div', 'mut dg-cadence', 'Already judged, and quiet for seven days. The triage re-reads these to confirm what they say is still true — nothing is behind.'));
      for (const x of again) listEl.append(waitingCard(x));
    }
    if (waiting.count > w.length) listEl.append(empty(`…and ${waiting.count - w.length} more`));
    return;
  }
  const xs = visible();
  if (!xs.length) {
    listEl.append(empty(reason ? 'could not load: ' + reason
      : tier === 'current' ? 'nothing waiting — everything judged has been reported in a brief.'
      : tier === 'never' ? 'nothing here: every judged thread has been through a digest.'
      : (tier === 'all' ? 'nothing judged yet.' : `nothing judged as ${TIER_LABEL[tier] ?? tier}.`)));
    return;
  }
  const sections = groupRows(xs);

  /* And one at the very bottom that clears the whole list. Alex, 2026-09-19:
   * "at the bottom of each list, put a Mark all X Read." The per-section
   * buttons clear a day or a sender, which is the right grain while reading
   * and the wrong one once he has decided the tier is done — thirty sections
   * meant thirty taps.
   *
   * X is the unread count of THIS list, and nothing else. The same button on
   * the digest pane once read "mark 1233 read" under a digest of 294, which is
   * how a clear-all button stops being trustworthy: it has to promise exactly
   * what is in front of him. So it is the rows the tier and the toggle are
   * showing, and where there is only one section the section's own button
   * already says that number — a second one under it would offer the same tap
   * twice with two different labels. */
  const unread = xs.filter((i) => !i.read);
  if (sections > 1 && unread.length) {
    const b = el('button', 'sec-action dg-mark', `Mark all ${unread.length.toLocaleString()} read`);
    b.type = 'button';
    b.onclick = () => setRead(xs, true);
    const foot = el('div', 'dg-foot dg-foot-all');
    foot.append(b);
    listEl.append(foot);
  }


}

/**
 * Which senders count as newsletters — and the half of that he can change.
 *
 * Alex, 2026-09-19: "remove that and instead link to an editable list of
 * emails." The count line used to say "from the senders your filters forward
 * to newsletters@", which names a rule and shows none of it.
 *
 * Two sources, and the difference is the whole point. The Gmail filters are
 * his, exported, and the agent may not touch them — CLAUDE.md forbids creating
 * or editing standing rules — so they are listed read-only and Gmail is named
 * as the place to change one. `reading-senders.json` is the assistant's own list,
 * written by the "read in full" button, and that one is editable here.
 */
async function showSenders() {
  current = 'senders';
  splitEl?.classList.add('showing');
  openState('pane', 'senders');
  paneEl.textContent = '';
  const inner = el('div', 'pane-inner');
  const back = el('button', 'pane-back', '\u2039 back to the list');
  back.onclick = () => { if (!closeState('pane')) closePane(); };
  const head = el('div', 'pane-head');
  head.append(el('h2', 'pane-title', 'Newsletter senders'));
  head.append(el('div', 'ob-meta mut', 'Mail from these is filed to read at leisure rather than summarised.'));
  inner.append(back, head);
  const body = el('div');
  inner.append(body);
  paneEl.append(inner);

  body.textContent = 'reading the list…';
  let d;
  try { d = await (await fetch('/api/reading/senders')).json(); }
  catch (err) { body.textContent = `could not read the list: ${err?.message ?? err}`; return; }
  body.textContent = '';
  if (d.error) body.append(empty('could not read the list: ' + d.error));

  const row = (address, { removable = false } = {}) => {
    const r = el('div', 'snd-row');
    r.append(el('span', 'snd-addr', address));
    if (removable) {
      const x = el('button', 'snd-x', 'remove');
      x.type = 'button';
      x.onclick = async () => {
        x.disabled = true;
        try {
          const res = await fetch('/api/reading/sender', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address, remove: true }) });
          if (!(await res.json()).ok) throw new Error('refused');
          showSenders();
        } catch (err) { x.disabled = false; x.textContent = 'could not remove'; }
      };
      r.append(x);
    }
    return r;
  };

  // His own list first: it is the one he can act on.
  /* His list, and only his. Alex, 2026-09-19: "ignore the from your Gmail
   * filter. I deleted most of them." The export is a 2026-08-29 snapshot and
   * `gmail.settings.basic` is ungranted, so nothing here can tell which of
   * those filters survive — listing them would be showing him a rule that no
   * longer exists. See rules/email-triage.md. */
  body.append(section('newsletter senders', { count: (d.mine ?? []).length }));
  body.append(el('div', 'mut dg-cadence', 'Mail from these is filed to read at leisure rather than summarised into the digest. Added by "treat as newsletter" on a message, or here.'));
  const form = el('form', 'addform');
  const input = el('input', 'snd-in');
  input.type = 'text'; input.placeholder = 'name@example.com, or @whole-domain.com'; input.autocomplete = 'off';
  const add = el('button', 'addgo', 'Add');
  add.type = 'submit';
  const note = el('div', 'addnote');
  const rowEl = el('div', 'addrow');
  rowEl.append(input, add);
  form.append(rowEl, note);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const address = input.value.trim();
    if (!address) return;
    note.textContent = 'adding…';
    try {
      const res = await fetch('/api/reading/sender', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }) });
      const got = await res.json();
      if (!got.ok) throw new Error(got.error || 'refused');
      input.value = '';
      showSenders();
    } catch (err) { note.textContent = `not added: ${err?.message ?? err}`; }
  };
  body.append(form);
  if (!(d.mine ?? []).length) body.append(empty('none yet. Until one is added, the triage decides for itself whether something is a long read.'));
  for (const m of d.mine ?? []) body.append(row(m.address, { removable: true }));

}

function drawFilters() {
  filtEl.textContent = '';
  /* Every pill shows its total. There is nothing else to show since the
     unread toggle went: a tier's count is how many threads are in it, and for
     the two digest buckets that is what the next brief will file (no
     archive by hand since 2026-10-03). */
  const n = (t) => counts?.[t]?.total;

  const pill = (key, text, count, title) => {
    const c = chip(text, { count, selected: tier === key, on: () => pick(key) });
    if (title) c.title = title;
    c.dataset.view = key;
    filtEl.append(c);
  };
  /* HIS ORDER, AND ALL AT THE END. Alex, 2026-09-19: "on mail page show
   * Digest, Newsletter, Action, Memory, Awareness, Ephemeral, Silent, All."
   *
   * It used to lead with All and then run in tier order. The two he reads sit
   * at the front now and the roll-up closes the row — which is the order of a
   * row of tabs rather than a table of contents: All is not a category beside
   * the others, it is what you fall back to, and putting it first made the
   * seven that follow look like a breakdown of it rather than places to go.
   * The DEFAULT view is still All, which is why it stays on the row at all. */
  for (const t of PILLS) {
    const name = TIER_LABEL[t] ?? t;
    pill(t, name[0].toUpperCase() + name.slice(1), n(t), TIER_MEANS[t]);
    // The current digest leads, then a break before the tiers the assistant
    // handled for him.
    if (t === 'current') filtEl.append(el('span', 'filt-sep'));
  }

  /* ALWAYS THE WHOLE ARCHIVE. Alex, 2026-09-19: "All should always have the
     full count." It followed the toggle, so switching to Unread only turned
     "All 2,029" into "All 1,283" — which reads as the archive having shrunk.
     All means everything judged; that is the number it is for, and the pill it
     is next to now carries the one that moves. */
  pill('all', 'All', totals.total, 'every thread the mail job has judged');
  /* Pending is outside the model on purpose: it has no tier because it has not
   * been judged, so it cannot be a slice of the same dataset. It keeps a pill
   * because its count is the one that says the pipeline is or is not behind. */
  filtEl.append(el('span', 'filt-sep'));
  pill('pending', 'Pending', waiting?.count ?? 0, 'not judged yet, or judged and due another look after seven quiet days');

  if (tier !== 'pending') {
    const tail = el('span', 'filt-tail');
    const sortBy = (how) => { by = how; remember(); drawFilters(); draw(); toTop(); };
    tail.append(chip('By date', { selected: by === 'date', on: () => sortBy('date') }));
    tail.append(chip('By sender', { selected: by === 'sender', on: () => sortBy('sender') }));
    filtEl.append(tail);
  }

  const w = waiting ?? {};
  const what = tier === 'all' ? 'threads' : `judged ${TIER_LABEL[tier] ?? tier}`;
  /* The whole explanation on one line. Alex, 2026-09-19: "put 'The mail job
     runs at most once an hour…' into the '1 waiting — only 1 waiting, holding
     for a batch' line." It was a paragraph above the list saying the same
     thing the count line half-said. The gate's own `why` already carries the
     number — "only 1 waiting, holding for a batch" — so repeating it as
     "1 waiting — only 1 waiting…" was the count said twice. */
  const cadence = 'the mail job runs at most once an hour, and sooner when three or more are waiting or one has waited three hours';
  const bits = tier === 'pending'
    ? [w.due ? `${w.count ?? 0} waiting — the mail job is due`
             : w.why ? w.why.charAt(0).toUpperCase() + w.why.slice(1)
             : `${w.count ?? 0} waiting`,
       cadence]
    /* WHAT IS TRUE OF THIS SET, not what a toggle happens to be set to.
       Alex, 2026-09-21, on "23 judged ephemeral not yet cleared": "that is
       not the right verbiage, it is more like they are archived."

       Two things were wrong in one phrase. The unread language was appended
       on every tier, including the five he is not the reader of — where the
       toggle is hidden and the server ignores it, so nothing had been
       filtered and the sentence described a queue that did not exist. And
       "cleared" is not what he does even where it applies: the button says
       Mark read.

       Every judged thread is archived — capture the obligation, then archive
       — so that is the honest thing to say about a set he is not being asked
       to work through. */
    : [`${totals.matching} ${what}${tier === 'current' ? ' waiting for the next brief'
        : tier === 'never' ? ', never digested' : ', archived'}`
       + (totals.matching > items.length ? ` · newest ${items.length} shown` : ''),
       ...(tier !== 'all' && TIER_MEANS[tier] ? [TIER_MEANS[tier]] : [])];
  if (tier !== 'pending') {
    if (w.count) bits.push(`${w.count} pending`);
    else if (w.stale) bits.push(`backlog unknown — ${w.why}`);
  }
  countEl.textContent = bits.join(' · ');
  /* The newsletter list, rather than a sentence about it. Alex, 2026-09-19:
   * "remove that and instead link to an editable list of emails." */
  if (tier === 'reading') {
    const a = el('button', 'sec-action', 'which senders?');
    a.type = 'button';
    a.onclick = () => showSenders();
    countEl.append(' ', a);
  }
  countEl.classList.toggle('err', !!w.stale);
}

/** What the mail job meant by each tier, in his words rather than the label. */
const TIER_MEANS = {
  /* The two halves of the digest, 2026-09-21. Not tiers — slices of the two
     tiers he is the reader of, by whether a brief has reported them yet. */
  current: 'waiting to be written up in the next brief — read or not, they stay here until then',
  never: 'judged before the assistant kept a record of what it had reported, so no digest ever covered them',
  action: 'something was owed — these became tasks on To Do',
  memory: 'a fact worth keeping: a booking, a confirmation, a number',
  awareness: 'worth knowing, nothing owed — alerts and status',
  reading: 'newsletters and long pieces, archived to read at leisure',
  digest: 'receipts, notices and confirmations — filed, summarised, nothing owed',
  ephemeral: 'true for a moment and then not: a code, a delivery window',
  silent: 'archived without a word, by your own ignore list',
};

/* ------------------------------------------------------------------- pane */

function closePane() { current = null; writeView({ pane: null }); splitEl?.classList.remove('showing'); draw(); }

async function select(it) {
  current = it.id;
  if (!it.read) setRead([it], true);
  draw();
  splitEl?.classList.add('showing');
  openState('pane', it.id);
  paneEl.textContent = '';

  const back = el('button', 'pane-back', '‹ back to list');
  back.onclick = () => { if (!closeState('pane')) closePane(); };
  const head = el('div', 'pane-head');
  head.append(el('h2', 'pane-title', it.subject || it.title));
  const metaLine = el('div', 'ob-meta', `${it.who || 'sender not known yet'} · ${it.when} · ${it.account}`);
  head.append(metaLine);
  const inner = el('div', 'pane-inner');
  inner.append(back, head);

  // The judgement before the message: what it was, and why it is here rather
  // than on Work.
  inner.append(el('p', 'what', it.what || '(no note recorded)'));
  /* ONE CONTROL BLOCK, AND IT DESCRIBES THE STATE BEFORE IT OFFERS AN ACT.
   *
   * Alex, 2026-09-19, looking at a silenced Uber thread that still offered
   * "ignore noreply@uber.com" and "ignore everyone at uber.com": "if they are
   * already silent, we should show why they were silent. the whole block in
   * the attachment can be cleaned up."
   *
   * It was three stacked rows of buttons, and on a silenced thread two of them
   * proposed a decision he had already made — which reads as the system not
   * knowing its own mind. So: ask what is already true of this sender, say it
   * in a sentence, and offer only the acts still available. One row, under one
   * quiet line naming the sender the buttons act on — which is also the answer
   * to "treat as newsletter = what does that mean?": it is a decision about
   * the sender, and it now says so.
   */
  const acts = el('div', 'mail-acts');
  inner.append(acts);

  const act = (label, title, run) => {
    const b = el('button', 'pane-act', label);
    b.type = 'button';
    if (title) b.title = title;
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'working…';
      try { await run(b); } catch (err) { b.textContent = `could not: ${err?.message ?? err}`; b.disabled = false; return; }
      setTimeout(() => load(), 900);
    };
    return b;
  };
  /* SILENCING ASKS FIRST, AND SAYS WHAT IT WILL MOVE.
   *
   * Alex, 2026-09-19, having hit the domain button by accident: "we should
   * have a confirmation" and "I don't understand where 1825 archived came
   * from". Two failures in one tap. It acted immediately on a decision
   * measured in four figures, and then reported a number nobody could place —
   * it was every message from the domain in a year, most of them already
   * archived, so "1825 archived" described almost nothing that changed.
   *
   * So the first tap asks Gmail what would actually move, says it, and waits.
   * The numbers that matter are the ones that change: what is in an inbox and
   * what is unread. The rest is context.
   */
  const silence = (address, label) => {
    const wrap = el('span', 'silence');
    const b = el('button', 'pane-act', label);
    b.type = 'button';
    b.title = `Never judge, list or count mail from ${address.startsWith('@') ? 'anyone at ' + address.slice(1) : address} again.`;
    wrap.append(b);
    b.onclick = async () => {
      b.disabled = true;
      const was = b.textContent;
      b.textContent = 'checking…';
      let p = null;
      try { p = await (await fetch(`/api/reading/ignore-preview?address=${encodeURIComponent(address)}`)).json(); } catch { /* ask anyway */ }
      b.remove();
      const ask = el('div', 'silence-ask');
      const what = p && p.matched != null
        ? `${p.matched.toLocaleString()} message${p.matched === 1 ? '' : 's'} from ${address.startsWith('@') ? address.slice(1) : address} in the last year`
          + (p.inbox || p.unread
              ? `. ${p.inbox.toLocaleString()} in your inbox and ${p.unread.toLocaleString()} unread would be archived and marked read.`
              : '. None are in your inbox or unread, so nothing moves — only what arrives next is silenced.')
        : `Mail from ${address} will be archived and marked read.`;
      ask.append(el('div', 'silence-what', what));
      // The tasks it would close go in the confirmation too — Alex,
      // 2026-09-30: "adding someone on ignore list closes tasks."
      const tasks = p?.tasks ?? [];
      if (tasks.length) {
        ask.append(el('div', 'silence-what', `${tasks.length === 1 ? 'This task' : `These ${tasks.length} tasks`} with them would close:`));
        const ul = el('ul', 'silence-tasks');
        for (const t of tasks) ul.append(el('li', '', t.title));
        ask.append(ul);
      }
      ask.append(el('div', 'silence-what mut', 'Nothing is deleted; everything stays searchable in All Mail. Future mail is archived without being judged, listed or counted.'));
      const go = el('button', 'pane-act silence-go', 'Silence');
      const no = el('button', 'pane-act', 'Cancel');
      go.type = no.type = 'button';
      no.onclick = () => { ask.replaceWith(b); b.disabled = false; b.textContent = was; };
      go.onclick = async () => {
        go.disabled = no.disabled = true;
        go.textContent = 'silencing…';
        try {
          const r = await fetch('/api/reading/ignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error ?? 'refused');
          ask.textContent = '';
          ask.append(el('div', 'silence-what',
            `Silenced. ${(d.inbox ?? 0).toLocaleString()} archived out of your inbox, ${(d.unread ?? 0).toLocaleString()} marked read`
            + `, of ${(d.matched ?? 0).toLocaleString()} matched`
            + ((d.tasks ?? []).length ? `; ${d.tasks.length} task${d.tasks.length === 1 ? '' : 's'} with them closed` : '')
            + '. You can undo this from the thread.'));
          setTimeout(() => load(), 1400);
        } catch (err) { go.textContent = `could not: ${err?.message ?? err}`; go.disabled = no.disabled = false; }
      };
      const row2 = el('div', 'mail-acts-row');
      row2.append(go, no);
      ask.append(row2);
      wrap.append(ask);
    };
    return wrap;
  };

  // Styled like the acts beside it. Alex, 2026-09-19: "Style the Open in
  // Gmail the same way as the other buttons." It is one of the things you can
  // do with this thread, so it looks like one.
  /* A NEW TAB. Alex, 2026-09-19: "the open in gmail link needs to open in a
     new tab." Following it in place threw the page away — the tier, the open
     pane, the digest he was halfway through — to land him somewhere the back
     button has to climb out of. `noopener` with it: a named tab can otherwise
     reach back through `window.opener`. */
  const gmailLink = () => {
    if (it.account !== 'personal') return null;
    const a = link('Open in Gmail', `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(it.threadId)}`, 'pane-act');
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };

  const drawActs = (state) => {
    acts.textContent = '';
    if (!it.who || it.waiting) {
      /* In a row, not loose in the column. `.mail-acts` is a flex COLUMN, so a
         lone child stretches to its full width — which on a pending thread,
         where Gmail is the only act, made one button the width of the pane.
         Alex, 2026-09-19: "on pending, the open in gmail button is really
         long." */
      const only = el('div', 'mail-acts-row');
      const g = gmailLink(); if (g) only.append(g);
      if (!it.who) only.append(el('span', 'mail-acts-why', 'the sender appears once the message loads'));
      if (only.childNodes.length) acts.append(only);
      return;
    }
    const who = it.who;
    const domain = (who.match(/@([\w.-]+)$/) ?? [])[1];
    const row = el('div', 'mail-acts-row');

    /* Already silenced: say which rule did it, when, and what he said at the
     * time — then offer the only thing left, which is undoing it. */
    /* `key` is what makes it an ignore RECORD rather than, say, a count named
       `ignored` from another endpoint. Shape-checked because a truthy field
       with the right name and the wrong type rendered "stop ignoring
       undefined" — a button offering to undo something it could not name. */
    if (state?.ignored?.key) {
      const g = state.ignored;
      const since = g.since ? ` on ${String(g.since).slice(0, 10)}` : '';
      acts.append(el('div', 'mail-acts-why',
        `Silenced because you ignore ${g.whole ? `everyone at ${g.key.slice(1)}` : g.key}${since}.`
        + (g.name ? ` You said: ${g.name}.` : '')
        + ' Mail from them is archived, never listed and never counted.'));
      row.append(act(`stop ignoring ${g.whole ? g.key.slice(1) : g.key}`,
        'Take this off the ignore list. Nothing already archived comes back — this only changes what happens next.',
        async (b) => {
          const r = await fetch('/api/reading/unignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: g.key }) });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error ?? 'refused');
          b.textContent = 'no longer ignored';
        }));
      const gm = gmailLink(); if (gm) row.append(gm);
      acts.append(row);
      return;
    }

    /* If this thread is still a debt, the place to act on it is To Do, where
       it can be closed, dated or answered. Alex, 2026-09-19, of the `open`
       tag: "I don't know what 'Open' means on the card" — so the pane says it
       in words and hands him the task. */
    // A heading, not a sentence about the sender. Alex, 2026-09-19: "it is
    // not 'About ecastle@co83a4.example:' it is more like actions" — and the
    // buttons name the sender themselves where it matters.
    acts.append(el('div', 'mail-acts-head', 'Actions'));
    /* NAMED BY WHERE IT PUTS THINGS.
     *
     * Alex, 2026-09-19, twice: "what does this mean", then "I still don't
     * get what 'treat as newsletter' does". Fair both times — it named a
     * category rather than an effect. The effect is that this sender's mail
     * stops being summarised into the digest and appears under the Newsletter
     * pill instead, and "Move to Newsletters" says exactly that, against a
     * pill he can see in the row above. */
    /* Only where the move means something. Alex, 2026-09-19: "'Move to
     * Newsletters' should probably only exist for items already set to
     * Digest?" Yes — Newsletter and Digest are the two ambient tiers and the
     * button swaps between them. On an Action it offered to reclassify a debt
     * as light reading, and on a Memory or an Ephemeral it was a no-op with a
     * confident label. */
    const asReading = state ? !!state.reading : it.tier === 'reading';
    if (it.tier === 'digest' || it.tier === 'reading' || asReading) {
      row.append(act(asReading ? 'Move to Digest' : 'Move to Newsletters',
        asReading ? `Mail from ${who} goes back to being summarised in the digest.`
                  : `Mail from ${who} stops being summarised in the digest and is listed under Newsletters instead, to read at leisure. Nothing is archived or hidden.`,
        async (b) => {
          const r = await fetch('/api/reading/sender', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: who, remove: asReading }) });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error ?? 'refused');
          b.textContent = asReading ? `moved back — ${d.retiered}` : `moved — ${d.retiered}`;
        }));
    }
    /* "Silence", not "ignore" — the word the tier uses. Alex, 2026-09-19:
     * "ignore should say 'Silence noreply@amazon.com', 'Silence everyone
     * @amazon.com'." And the domain one is broader than it looks: Alex,
     * 2026-09-08, silenced marketing@coeab4.example and the next one
     * arrived from news@. So it is never the same tap as the address. */
    /* The task itself, where it can be closed, dated or answered. Alex,
       2026-09-19: "move 'open it on To Do' to the actions bar, relabel 'Open
       Task'." It was a sentence above the row; it is one of the things you can
       do with this thread, so it belongs with them. */
    if (it.open) {
      row.append(link('Open Task', `/todo#pane=${encodeURIComponent(`mail:${it.account}:${it.threadId}`)}`, 'pane-act'));
    }
    row.append(keepButton(it.account, it.threadId, { task: it.open ? `mail:${it.account}:${it.threadId}` : null }));
    row.append(silence(who, `Silence ${who}`));
    if (domain) row.append(silence('@' + domain, `Silence everyone @${domain}`));
    const gm = gmailLink(); if (gm) row.append(gm);
    acts.append(row);
  };

  drawActs(null);
  if (it.who && !it.waiting) {
    fetch(`/api/reading/sender-state?address=${encodeURIComponent(it.who)}`)
      .then((r) => r.json()).then(drawActs).catch(() => {});
  }

  const body = el('div', 'read-body', 'loading the message…');
  inner.append(body);
  /* The reply, at the foot of the thread — the same place the Outbox puts one.
   *
   * Alex, 2026-09-19: "Next, lets add reply box." It DRAFTS; it does not
   * send. CLAUDE.md is explicit both ways: "Drafting is always fine, anywhere.
   * A Gmail draft reaches nobody," and sending is his tap on a button that
   * names the recipient. So the box writes a threaded Gmail draft, and the
   * draft then appears here with the Outbox's own Send / Edit / Discard — one
   * door, one gate, and the reply is visible on To Do's `drafted` filter
   * beside whatever task it answers.
   */
  const replyBox = el('div', 'mail-reply');
  if (!it.waiting) inner.append(replyBox);
  paneEl.append(inner);
  if (!it.waiting) drawReply(replyBox, it);

  // The message itself. /api/reading/body returns the thread — `messages`,
  // each with from/at/text — never a flat `text`; the first version read the
  // field that did not exist and printed "(no readable text)" under everything.
  // A reading-tier item is fetched with its HTML and rendered in full inside
  // a sandboxed frame — no scripts, no forms, no same-origin, a CSP of its
  // own — with a plain-text toggle. Everything else shows the text.
  /* THE MESSAGE — as text, or as the sender built it.
   *
   * Alex, 2026-09-19, of a GoDaddy renewal notice whose text/plain part is
   * padding and four tracking URLs: "can we render the html?" Rendering the
   * HTML was already built for newsletters and gated on the reading tier
   * alone, which is the wrong test — what decides it is whether the message
   * has an HTML twin and whether the text is worth reading, not which tier
   * the triage filed it under.
   *
   * Text is still the default and still free: it is what the cache holds, so
   * opening a thread costs no Gmail quota. HTML is fetched on the tap, or
   * straight away when the text is too thin to be the message.
   *
   * The frame is the same one the reading view has always used: `sandbox=""`,
   * so no scripts, no forms, no same-origin and no popups; its own CSP; no
   * referrer; and `base target=_blank` so a link leaves rather than replacing
   * the frame. Remote images load, which is how a tracking pixel learns the
   * mail was opened — the same trade the reading view has always made.
   */

  const thread = `account=${encodeURIComponent(it.account)}&thread=${encodeURIComponent(it.threadId)}`;
  try {
    const r = await fetch(`/api/reading/body?${thread}`);
    const d = await r.json();
    body.textContent = '';
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    // Why `undefined` means "ask" rather than "no": see mayHaveHtml.
    if (mayHaveHtml(msgs)) {
      // A segmented control, not two loose chips: it is one question with two
      // answers. Alex, 2026-09-19: "lets style 'as sent' and 'Text' nicer."
      const bar = el('div', 'read-toggle');
      const asHtml = el('button', 'seg', 'As sent'), asText = el('button', 'seg', 'Text');
      asHtml.type = asText.type = 'button';
      const frames = el('div', 'read-frames'); frames.hidden = true;
      const texts = el('div', 'read-texts');
      for (const m of msgs) {
        const box = el('div', 'read-msg');
        box.append(el('div', 'read-msg-head', `${m.from || '?'}${msgWhen(m) ? ' · ' + msgWhen(m) : ''}`),
                   el('pre', 'read-msg-text', String(m.text ?? '').trim() || '(no text in this part)'));
        texts.append(box);
      }
      let loaded = false;
      const pick = (html) => {
        frames.hidden = !html; texts.hidden = html;
        asHtml.setAttribute('aria-selected', String(html));
        asText.setAttribute('aria-selected', String(!html));
      };
      const loadHtml = async () => {
        pick(true);
        if (loaded) return;
        loaded = true;
        frames.textContent = '';
        frames.append(el('div', 'mut read-count', 'fetching the message as it was sent…'));
        try {
          const h = await (await fetch(`/api/reading/body?${thread}&html=1`)).json();
          const hs = (h.messages ?? []).filter((m) => m.html);
          frames.textContent = '';
          if (!hs.length) {
            // No HTML twin: the text IS the message, so show it rather than
            // an explanation of what is missing.
            frames.textContent = '';
            pick(false);
            bar.remove();
            return;
          }
          /* One frame per message, from the shared module — mail-view.mjs
             holds the two locks and the height measurement, so the task pane
             and this page cannot drift on either. */
          for (const m of hs) frames.append(mailFrame(m.html, { title: it.subject || 'message' }));
        } catch (err) {
          frames.textContent = '';
          frames.append(empty('could not fetch the HTML: ' + (err?.message ?? err)));
        }
      };
      asHtml.onclick = loadHtml;
      asText.onclick = () => pick(false);
      bar.append(asHtml, asText);
      body.append(bar, frames, texts);
      /* AS SENT IS THE DEFAULT. Alex, 2026-09-19: "set 'As sent' as the
       * default email view." A mail is a document its sender laid out, and
       * the flattened text is a fallback for when that fails — which is the
       * order this had backwards. `loadHtml` drops back to the text by itself
       * if the message turns out to have no HTML part, so the default costs
       * nothing on a plain-text mail beyond the fetch.
       *
       * That fetch is the trade, and it is worth naming: the text comes from
       * the cache and the HTML does not, so opening a message now spends one
       * Gmail call. Fine for reading one at a time; it is bulk fetching that
       * exhausted the quota this morning, not this. */
      loadHtml();
      return;
    }
    if (d.error) body.append(empty('could not read the message: ' + d.error));
    else if (!msgs.length) body.append(empty('the thread came back with no messages'));
    // The message names its sender even when the work list could not: a
    // thread that escaped the extract has no participants to read. Fill it
    // in, so the header and the Ignore button both have an address.
    if (!it.who) {
      const from = msgs.map((m) => m.from).find(Boolean) ?? '';
      const addr = (String(from).match(/<([^>]+)>/) ?? [])[1] ?? (/@/.test(from) ? from.trim() : '');
      if (addr) {
        it.who = addr.toLowerCase();
        metaLine.textContent = `${it.who} · ${it.when} · ${it.account}`;
        // Now the controls have a sender to act on, and a state to ask about.
        drawActs(null);
        fetch(`/api/reading/sender-state?address=${encodeURIComponent(it.who)}`)
          .then((r) => r.json()).then(drawActs).catch(() => {});
        draw();
      }
    }
    for (const m of msgs) {
      const box = el('div', 'read-msg');
      const when = msgWhen(m);
      box.append(el('div', 'read-msg-head', `${m.draft ? 'DRAFT, not sent · ' : ''}${m.from || '?'}${when ? ' · ' + when : ''}`));
      /* The reply, without the conversation stapled under it. Never dropped
         silently — what was cut is one tap away. Alex, 2026-09-19: "can we
         try to remove the static in-line content that clutters 'On Fri, Sep
         18, 2026 at 11:49 AM <wmercer@mac.com> wrote:' etc." */
      const raw = String(m.text ?? '').trim();
      const { text, quoted } = trimQuoted(raw);
      box.append(el('pre', 'read-msg-text', text || '(this message has no text — an image, or HTML the reader could not flatten)'));
      if (quoted) {
        const more = el('details', 'quoted');
        more.append(el('summary', null, `quoted reply — ${quoted.split('\n').length} lines`));
        more.append(el('pre', 'read-msg-text', quoted));
        box.append(more);
      }
      if (m.truncated) box.append(el('div', 'mut', 'truncated'));
      if (m.attachments?.length) box.append(el('div', 'mut', `${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}`));
      body.append(box);
    }
  } catch (err) { body.textContent = 'could not load the message: ' + (err?.message ?? err); }
}

/**
 * When a message was sent, as a person writes it.
 *
 * The cache stores `at` as epoch milliseconds, and two separate places printed
 * it raw — "Henry Mercer <hank@phoa.example> · 1787520008000". Alex,
 * 2026-09-19, having already reported the first one. One function now, because
 * two copies of a format is how the second one kept the bug.
 */
function msgWhen(m) {
  if (typeof m?.at === 'number' && m.at) {
    return new Date(m.at).toLocaleString(undefined,
      { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return String(m?.date ?? m?.at ?? '');
}

/** The Mail pane's reply box — the shared one in draft-pane.mjs. */
const drawReply = (host, it) => replyBox(host, it, { onSent: () => setTimeout(() => load(), 1200) });

/* ------------------------------------------------------------------- load */

/**
 * The page, in two requests: the list (one dataset, sliced by tier and the
 * and the pending backlog.
 *
 * `/api/digest` is no longer where the list comes from — it supplies the
 * written digest and what the mail job has not reached. One list source is
 * the whole point of the simplification: two of them is how a count and a
 * list came to disagree four separate times.
 */
async function load() {
  reason = null;
  const q = new URLSearchParams({ limit: '2000' });
  if (tier !== 'all' && tier !== 'pending') q.set('tier', tier);
  try {
    const [filedRes, digestRes] = await Promise.all([
      fetch('/api/filed?' + q).then((r) => r.json()),
      fetch('/api/digest').then((r) => r.json()).catch(() => null),
    ]);
    items = (Array.isArray(filedRes?.items) ? filedRes.items : [])
      .map((it) => ({ ...it, at: atMs(it.at) || atMs(it.when) }));
    counts = filedRes?.counts ?? {};
    totals = { total: filedRes?.total ?? 0, unreadTotal: filedRes?.unreadTotal ?? 0, matching: filedRes?.matching ?? 0 };
    if (filedRes?.error) reason = filedRes.error;
    waiting = digestRes?.waiting ?? null;
  } catch (err) { items = []; reason = String(err?.message ?? err); }
  drawFilters(); draw();
}

if (onPage) {
  onStateChange('pane', (id) => { if (!id) return closePane(); if (id === 'senders') return showSenders(); const it = items.find((x) => x.id === id); if (it) select(it); });
  remember();
  /* A LINK OPENS ITS THREAD, WHATEVER THE TAB. Alex, 2026-10-07: "the
     deeplinks in the brief dont land properly". A brief links the threads it
     reports — and reporting one moves it out of the Current digest, the tab
     the page opens on — so the link arrived, found nothing in the list, and
     opened nothing. When the thread is not in this view, the page moves to
     All (every judged thread), then Silent, and opens it there. */
  load().then(async () => {
    const id = stateFromUrl('pane');
    if (!id || id === 'senders') return;
    let it = items.find((x) => x.id === id);
    for (const other of ['all', 'silent']) {
      if (it || tier === other) continue;
      await pick(other);
      it = items.find((x) => x.id === id);
    }
    if (it) select(it);
    else console.warn('mail: no judged thread', id);
  });
  if (dock) dock.append(composer({ placeholder: 'Ask about any of this…', context: () => ({ page: 'mail', open: current, tier, by }) }));
}
