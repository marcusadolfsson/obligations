/**
 * Said to you: every message the assistant sent unprompted, full text one tap
 * away. Briefs, prep, debriefs, notes, failures. Today shows the day's; this
 * is all of them, and where a push lands. Alex, 2026-09-06: the briefs left
 * the digest, which is now mail only.
 */
import { el, chip, section, empty, messageCard, swipeable, composer } from './ui.mjs';
import { renderProse } from './prose.mjs';
import { openState, closeState, onStateChange, stateFromUrl, readParams, writeView } from './histate.mjs';

const listEl = document.getElementById('sdlist');
const paneEl = document.getElementById('sdpane');
const splitEl = document.getElementById('sdsplit');
const countEl = document.getElementById('sdcount');
const filtEl = document.getElementById('sdfilters');
const dock = document.getElementById('sddock');
const onPage = !!(listEl && paneEl && countEl && filtEl);

let items = [];
/* The digest's unread count, for the row at the top of the list. `reading` and
   `digest` are the two tiers the written digest narrates — see digestlist.mjs,
   where awareness and memory are excluded on purpose so one fact does not get
   two homes. A count over a different set than the page it links to is the
   disagreement this repo keeps finding; this is the same set. */
/* The digest itself, so it can be read HERE. Alex, 2026-09-21: "load the
   mail digest (and the mark read button) inline so it doesn't have to switch
   to the mail tab."

   The row above stays a pointer into the list — the reasoning below still
   holds, that a live compounding document cannot sit among dated snapshots
   without one of them lying. What changed is where the pointer goes: into
   this page's own pane, which is the same two-pane shape /mail uses, rather
   than to another tab. The words are fetched fresh when it is opened, so
   nothing stale is ever frozen into the list. */
let digestDoc = null;
/* Unread first, and unread by default. Alex, 2026-09-18: "under briefs, put
 * unread first as the default options." This page is where every brief, prep
 * note and debrief lands, so by the second week the list is mostly things he
 * has already read and the three he has not are somewhere down it.
 *
 * Resolved at load rather than remembered: if nothing is unread, defaulting to
 * it would open an empty page, which is the one view that tells him nothing. */
/* From the URL, so a link carries the view. Alex, 2026-09-19: "can we write
   the url on every load, so you can deeplink to a mail, task etc." */
let show = readParams().show || 'unread';     // unread | all | <kind>
const remember = () => writeView({ show: show === 'unread' ? null : show });
// Read while he is looking at the unread list. Without this, opening a brief
// removes it from the list underneath him and everything jumps up a row.
const readHere = new Set();
let current = null;
let reason = null;

const atMs = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };
const dayLabel = (ms) => {
  const d = new Date(ms), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return 'today';
  if (same(d, new Date(t.getTime() - 86400000))) return 'yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

/**
 * The count on the Briefs pill, moved as he reads.
 *
 * Alex, 2026-09-19: "can you update the unread counters in the menu in
 * realtime as items are read." The chips on this page recompute from `items`
 * and always did; the badge in the masthead is rendered by the server, so
 * reading three briefs left it saying three until the next page load — the
 * one number he sees from everywhere else in the app.
 */
function paintNav() {
  const b = document.querySelector('#msglink .navbadge');
  if (!b) return;
  const n = items.filter((i) => !i.read).length;
  b.textContent = n ? String(n) : '';
}

async function setRead(it, read) {
  if (!!it.read === read) return;
  if (read) readHere.add(it.id); else readHere.delete(it.id);
  it.read = read; drawFilters(); draw(); paintNav();
  try { await fetch('/api/messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: it.id, read }) }); }
  catch { it.read = !read; drawFilters(); draw(); paintNav(); }
}

function visible() {
  let xs = items;
  // A reminder push is the record that the dispatcher buzzed him about a task
  // that is already on To Do. Alex, 2026-09-06: "not sure why reminders go
  // into Briefs." Kept (rules/messages.md: every push has a file) but off the
  // default view; the `reminder` chip shows them.
  if (show === 'unread') xs = xs.filter((i) => !i.read || readHere.has(i.id));
  else if (show !== 'all') xs = xs.filter((i) => i.kind === show);
  return [...xs].sort((a, b) => b.atMs - a.atMs);
}

function card(it) {
  const c = messageCard({ id: it.id, kind: it.kind, at: it.at, title: it.title, read: it.read }, { onOpen: () => select(it) });
  if (current === it.id) c.classList.add('selected');
  return swipeable(c, { onRight: () => setRead(it, !it.read), rightLabel: it.read ? 'unread' : 'read' });
}

function draw() {
  listEl.textContent = '';
  const xs = visible();
  if (!xs.length) { listEl.append(empty(reason ? 'could not load: ' + reason : 'nothing here.')); return; }
  const days = new Map();
  for (const it of xs) { const d = dayLabel(it.atMs); if (!days.has(d)) days.set(d, []); days.get(d).push(it); }
  for (const [d, rows] of days) { listEl.append(section(d)); for (const it of rows) listEl.append(card(it)); }
}

function drawFilters() {
  filtEl.textContent = '';
  const unread = items.filter((i) => !i.read).length;
  const mk = (key, label, count) => filtEl.append(chip(label, { count, selected: show === key, on: () => { show = key; remember(); drawFilters(); draw(); } }));
  mk('unread', 'Unread', unread);
  mk('all', 'All', items.length);
  const kinds = new Map();
  for (const i of items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
  // Capitalised like every other pill. Alex, 2026-09-19.
  for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) mk(k, k[0].toUpperCase() + k.slice(1), n);
  countEl.textContent = `${items.length} messages · ${unread} unread`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Morning brief · Monday 7 September, 07:00 · pushed to your phone" */
function byline(it) {
  const d = new Date(atMs(it.at));
  const when = Number.isNaN(d.getTime()) ? String(it.at ?? '')
    : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // `digest` was missing until 2026-09-21 and rendered as the bare word. The
  // automatic ones are inside their brief; a standalone one is an interim,
  // archived by hand between briefs.
  const kind = { brief: 'Brief', prep: 'Meeting prep', debrief: 'Debrief', note: 'Note',
                 failure: 'Failure', reminder: 'Reminder', digest: 'Interim digest',
                 // The realtime lane. "Needs you now" is what the push said.
                 urgent: 'Needs you now' }[it.kind] ?? it.kind;
  return [kind, when, it.delivered && it.delivered !== 'none' ? 'pushed to your phone' : null].filter(Boolean).join('  ·  ');
}

function closePane() { current = null; splitEl?.classList.remove('showing'); draw(); }
const openPane = (id) => { const it = items.find((x) => x.id === id); return it ? select(it) : closePane(); };

function select(it) {
  current = it.id;
  if (!it.read) setRead(it, true);
  draw();
  splitEl?.classList.add('showing');
  openState('pane', it.id);
  paneEl.textContent = '';
  const back = el('button', 'pane-back', '‹ back to list');
  back.onclick = () => { if (!closeState('pane')) closePane(); };
  const head = el('div', 'pane-head brief-head');
  head.append(el('h2', 'pane-title brief-title', it.title));
  head.append(el('div', 'ob-meta brief-byline', byline(it)));
  const inner = el('div', 'pane-inner brief-pane');
  inner.append(back, head);
  // Taken back: the task this pushed closed before he got to it. Said first,
  // above the words that are no longer true. Alex, 2026-09-23.
  if (it.revoked) {
    const [when, ...why] = String(it.revoked).split(' — ');
    inner.append(el('div', 'brief-revoked', `Resolved ${when.slice(5)}${why.length ? ` — ${why.join(' — ')}` : ''}. Nothing needed from you.`));
  }
  const body = el('div', 'body brief-body');
  // A brief writes ### for its sections, so they land on h4. See prose.mjs.
  renderProse(body, it.body ?? '', { offset: 2 });
  inner.append(body);
  /* "Archive", not "dismiss". Alex, 2026-09-30: "rename it Archive." It
     never deleted anything — the file moves to archive/messages and stays in
     git — and "dismiss" read as if it might. */
  const dismiss = el('button', 'pane-act', 'Archive');
  dismiss.title = 'Move this off the list. Kept in archive/messages — nothing is deleted.';
  dismiss.onclick = async () => {
    dismiss.disabled = true;
    try {
      const r = await fetch('/api/messages/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: it.id }) });
      if ((await r.json()).ok) { items = items.filter((x) => x.id !== it.id); drawFilters(); closePane(); }
      else dismiss.disabled = false;
    } catch { dismiss.disabled = false; }
  };
  inner.append(dismiss);
  paneEl.append(inner);
}

async function load() {
  reason = null;
  try {
    const d = await (await fetch('/api/messages')).json();
    // A reminder push is the record of a buzz about a task on To Do, where its
    // ladder now shows; a failure is the system talking about itself, on
    // System. Neither is a brief, so neither is here — not in the list, not
    // in the counts, not as a chip. Alex, 2026-09-06: "the pill says unread
    // 1 but then the column says nothing here."
    // `digest`: an Interim digest, archived by hand — removed 2026-10-03 (Alex:
    // "remove from briefs section"); the two already filed stay on disk.
    const RECORDS = new Set(['reminder', 'failure', 'digest']);   // the server calls this same rule isBrief
    // …except the one a link named: System links a failure here, and a link
    // that opens an empty page is worse than a record in a list.
    const asked = stateFromUrl('pane');
    items = (Array.isArray(d?.messages) ? d.messages : [])
      .filter((m) => !RECORDS.has(m.kind) || m.id === asked)
      .map((m) => ({ ...m, atMs: atMs(m.at) }));
  } catch (err) { items = []; reason = String(err?.message ?? err); }
  // Unread is the default, but only when there is something in it. Everything
  // read means "all" — an empty page as the front door tells him nothing, and
  // the point of the default is to put the three he has not seen at the top.
  if (show === 'unread' && !items.some((i) => !i.read)) show = 'all';
  drawFilters(); draw();
}

if (onPage) {
  onStateChange('pane', (id) => { if (!id) return closePane(); openPane(id); });
  remember();
  load().then(() => {
    paintNav(); const id = stateFromUrl('pane'); if (id) openPane(id); });
  if (dock) dock.append(composer({ placeholder: 'Ask about a brief…', context: () => ({ page: 'said', open: current }) }));
}
