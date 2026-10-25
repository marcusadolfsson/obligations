/**
 * The tasks page. Client-rendered because it is the one interactive thing in the
 * dashboard family: items can be read, answered and closed by hand.
 *
 * ## Two panes, one filter
 *
 * Alex, 2026-09-03: a two-column layout — titles, dates and lateness on the
 * left, the body and messages on the right, with a filter across the top for
 * today / upcoming / no date. The previous layout stacked four collapsible
 * sections and expanded each card in place, so reading one item pushed every
 * item below it off the screen.
 *
 * The filter decides WHICH items are on the left. The four buckets are the same
 * four questions as before, because they have different remedies:
 *
 *   today              — a deadline that has arrived, or undated and high
 *   upcoming           — a deadline still ahead
 *   no date            — something he owes with no deadline, aging
 *   waiting on others  — something he asked for and has not got
 *
 * Direction, not source, decides the bucket. A date beats a priority flag:
 * "high" on something due in twelve days means it matters, not that it is today.
 * Anything owed by someone else stays out of today however urgent, because
 * chasing is not the same act as doing.
 *
 * On a phone the two panes become one: the list, then the detail full-width
 * with a way back. Nothing is hidden on a narrow screen, it is just sequenced.
 *
 * ## Title, then detail
 *
 * Every row leads with a short headline. The paragraph the triage wrote, what
 * closes it, the mail threads it came from and the message transcript all live
 * in the pane — the obligation model derives a headline when the triage did not
 * write one; see `titleOf`.
 *
 * ## Evidence
 *
 * One chip per *source*, with a count — not one chip per piece. "8 threads" is
 * the fact worth showing: answering this once settles all eight. The subjects
 * and links are in the pane.
 *
 * The page does not know what a reminder is, or a todo line, or a mail thread —
 * that is the obligation model's job.
 */
import { openState, closeState, onStateChange, stateFromUrl, readParams, writeView } from './histate.mjs';
import { renderText } from './links.mjs';
// Only the composer. Work keeps its own swipe helper (left = close, with an
// outcome); importing ui.mjs's `swipeable` under the same name is what put a
// decision block inside it and broke every row on 2026-09-05.
import { composer, keepButton } from './ui.mjs';
import { renderThread, draftFoot, replyBox } from './draft-pane.mjs';
import { taskMap } from './taskmap.mjs';
import { split as splitWhat, paragraphs as paragraphsOf } from './what.mjs';
import { projectForm, archivedPane, rankEditor, projectsIndex } from './project-forms.mjs';


/* /projects is this page on By project (the Projects tab until 2026-10-04).
   Say so in the address before anything reads it: the path becomes
   /todo?f=projects, and
   an old link's #pane=<tag> — a project, on the page it used to be — becomes
   #proj=<tag>, so To Do does not look for a task by that name. */
if (location.pathname === '/projects') {
  const h = location.hash.replace(/^#pane=/, '#proj=').replace(/&pane=/, '&proj=');
  history.replaceState(history.state, '', '/todo?f=projects' + h);
}
const list = document.getElementById('tasklist');
const pane = document.getElementById('taskpane');
const filt = document.getElementById('filt');
const split = document.getElementById('split');
const sortbar = document.getElementById('sortbar');
const tagsel = document.getElementById('tagsel');

if (list && pane) {
  let items = [];
  let selected = null;
  const FILTERS = ['today', 'upcoming', 'nodate', 'owed', 'decisions', 'projects', 'drafted', 'closed', 'map', 'projectlist'];
  // The map's circle for what no project and no kind claims — a tag nothing carries.
  const NONE = '__none';
  /* The last thirty days of closes, fetched the first time the chip is
     tapped or a #pane arrives for something no longer open. Kept apart from
     `items` so every bucket, count and swipe keeps meaning "open". */
  let closedItems = null;
  async function loadClosed() {
    try { const d = await (await fetch('/api/obligations/closed')).json(); closedItems = d.items ?? []; }
    catch { closedItems = []; }
    return closedItems;
  }
  const at0 = readParams();
  /* Upcoming and No date became part of Mine on 2026-10-03 (Alex:
     "Combine today, upcoming, no date on one page"). A link or a remembered
     chip naming either opens Mine. */
  const MERGED = { upcoming: true, nodate: true };
  /* DECISIONS ARE THE DECIDE LANE. Alex, 2026-10-04: "remove decision as a
     top selection and put that next to reply, decide, pay … I don't want to
     have decide and decisions." A decision was its own chip and kept out of
     Mine; it is now in Mine, and lanes.mjs already files it under Decide. An
     old ?f=decisions link opens Mine on that lane. */
  const wasDecisions = at0.f === 'decisions' || new URLSearchParams(location.search).get('f') === 'decisions';
  let filter = (() => {
    /* The URL wins, then the query, then what he was last looking at. Alex,
       2026-09-19: "can we write the url on every load, so you can deeplink to
       a mail, task etc." A ?f= is a deliberate arrival — Today's "decide · all"
       link, and /outbox's redirect — and beats the remembered chip. */
    if (FILTERS.includes(at0.f)) return at0.f;
    const q = new URLSearchParams(location.search).get('f');
    if (q && FILTERS.includes(q)) return q;
    try { return localStorage.getItem('obligations.filter') || 'today'; } catch { return 'today'; }
  })();
  if (MERGED[filter] || filter === 'decisions') filter = 'today';
  /* ONE PROJECTS TAB. Alex, 2026-10-04: "lets combine By Project and
     Project under to-do. so By Project needs a New Project button, and then
     for each project a way to edit it." The Projects tab's doors — new,
     edit, archive, what leads the briefs, archived — moved into By project
     (project-forms.mjs); a link or a remembered chip naming the old tab
     opens By project. */
  if (filter === 'projectlist') filter = 'projects';
  // Alex, 2026-09-03: "sort by days high or low" — oldest and newest, which
  // were the only two until the four sorts below (2026-10-03).
  /* FOUR SORTS. Alex, 2026-10-03: "Let's add some new sorts. By due date,
     by priority, oldest, newest." Each is one list — he chose that over
     keeping Mine's sections — and each means the same on every tab. Due date
     was the default until 2026-10-09 (see PRIORITY BY DEFAULT). */
  /* LANES AND SITTINGS. Alex, 2026-10-03: "I feel like I need more help to
     tackle similar to dos in one sitting." The server gives each task he owes
     a `lane` — the kind of work it is (lanes.mjs) — and Mine can show one lane
     and step through it: a session. The order mirrors lanes.mjs. */
  const LANE_ORDER = ['reply', 'decide', 'pay', 'call', 'admin', 'other'];
  const LANE_LABEL = { reply: 'Reply', decide: 'Decide', pay: 'Pay', call: 'Call & schedule', admin: 'Admin', other: 'Other' };
  let lane = LANE_ORDER.includes(at0.lane) ? at0.lane : wasDecisions ? 'decide' : '';
  /* A session: the lane's tasks, frozen in the order they were shown when he
     pressed Start, walked one at a time in the task pane. Done closes, Later
     snoozes to tomorrow morning, Skip moves on; each counts toward the summary. */
  let session = null;
  /* What the pane shows on By project when no task is open: 'new',
     'edit:<tag>', 'rank' (what leads the briefs) or 'archived'. Its own
     history entry, #proj=, so the back gesture closes it like a task. */
  let projPane = null;

  const SORTS = ['due', 'priority', 'oldest', 'newest'];
  /* PRIORITY BY DEFAULT. Alex, 2026-10-09: "make priorities the default
     view under todo" — today's order first. A new key for the remembered
     sort, so a phone that remembered "due date" from before opens on it too;
     what he picks from now on is remembered as before. */
  const DEFAULT_SORT = 'priority';
  const SORT_KEY = 'obligations.tasksort.v2';
  let sort = SORTS.includes(at0.sort) ? at0.sort
    : (() => { try { const s = localStorage.getItem(SORT_KEY); return SORTS.includes(s) ? s : DEFAULT_SORT; } catch { return DEFAULT_SORT; } })();
  // A chosen tag cuts across the buckets: "everything tagged ONE" is a
  // different question from "what is due", and it wants every item, dated or not.
  let tag = at0.tag ?? '';
  /** Everything about this view that a link should carry. */
  const remember = () => writeView({ f: filter === 'today' ? null : filter,
                                     tag: tag || null,
                                     sort: sort === DEFAULT_SORT ? null : sort,
                                     lane: lane || null });
  // The projects registry — the `tag:` line in each project file — for the
  // group heads and the add form's picker. Empty is not an error: it means no
  // project carries a tag yet, and the page says so rather than showing an
  // empty dropdown.
  let projects = [];
  // Where he dragged the map's circles, loaded on the first draw (null until then).
  let mapLayout = null;
  /* Waiting drafts, joined to the tasks they answer. Alex, 2026-09-19:
     "Lets merge the outbox into To Do. It should be more of a filter, here are
     the To Do's with items Drafted so you can see which task the entry is
     for." The join is the server's (task-drafts.mjs); this only groups it.
     A draft that joined no task becomes a row of its own, marked `__draft`,
     so the merged queue never loses the half that did not join. */
  let draftsByTask = new Map();
  const draftsFor = (id) => draftsByTask.get(id) ?? [];
  const isLoose = (o) => !!o.__draft;

  const rank = { high: 0, normal: 1, low: 2 };
  // Which side of the debt. Entries judged before the field existed are things
  // he owes — that is all the list has ever shown.
  const mine = (o) => (o.owed_by ?? 'me') !== 'them';
  // A decision is a choice, not a debt (decisions.md, 2026-09-05): never under
  // Waiting on others. Since 2026-10-04 it is in Mine, in the Decide lane.
  const isDecision = (o) => (o.tags ?? []).includes('decision');
  const isToday = (o) => !isDecision(o) && mine(o) && (o.due ? o.lead_days <= 0 : o.priority === 'high');
  /* What each sort means, as one comparison each.
     - due: overdue first, then soonest; undated last, high before normal
       before low among them, then longest-waiting.
     - priority: high, normal, low; within each, the due-date order.
     - oldest / newest: by how long it has waited (`days`); a row with no age
       goes last either way rather than first. */
  const PRI = { high: 0, normal: 1, low: 2 };
  const pri = (o) => PRI[o.priority] ?? 1;
  const byWait = (a, b) => (b.days ?? -1) - (a.days ?? -1);
  const byDueDate = (a, b) => {
    if (a.due && b.due) return String(a.due).localeCompare(String(b.due)) || pri(a) - pri(b);
    if (a.due) return -1;
    if (b.due) return 1;
    return pri(a) - pri(b) || byWait(a, b);
  };
  /* TODAY'S ORDER. Alex, 2026-10-09: "putting a bunch on high doesn't
     help, we need to sort the high ones internally." The daily ranking
     (rank.mjs) puts its top twenty first under the priority sort, his own order when
     he has moved one today; the flag sorts the rest. */
  let ranks = new Map();
  let rankDoc = null;
  const rk = (o) => ranks.get(o.id)?.n ?? 99;
  async function loadRank() {
    try {
      rankDoc = await (await fetch('/api/rank')).json();
      ranks = new Map((rankDoc.order ?? []).map((r) => [r.id, r]));
    } catch { rankDoc = null; ranks = new Map(); }
  }
  async function saveRank(ids, moved) {
    const r = await fetch('/api/rank/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, moved }) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error ?? r.status);
    rankDoc = d; ranks = new Map((d.order ?? []).map((x) => [x.id, x]));
    render();
  }
  const rankIds = () => (rankDoc?.order ?? []).map((r) => r.id);
  /* RANKING, AS IT HAPPENS. Alex, 2026-10-09: "it would be good to have a
     realtime progress report on ranking." Once a second while a run lasts:
     reading the list, asking the model, then how many it has written. */
  let rankWatching = null;
  async function watchRank() {
    const clock = (n) => `${Math.floor((n ?? 0) / 60)}:${String((n ?? 0) % 60).padStart(2, '0')}`;
    const show = (text) => { rankWatching = text; const b = sortbar?.querySelector('.rank-again'); if (b) { b.disabled = true; b.textContent = text; } };
    for (;;) {
      let p;
      try { p = await (await fetch('/api/rank/progress')).json(); } catch { p = null; }
      if (!p || p.state === 'idle') { rankWatching = null; break; }
      if (p.state === 'running') {
        show(p.stage === 'reading' ? `reading your list… ${clock(p.secs)}`
          : p.stage === 'asking' ? `asking the model about ${p.of ?? ''} tasks… ${clock(p.secs)}`
          : `${p.n} of ${p.top} ranked… ${clock(p.secs)}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      rankWatching = null;
      if (p.state === 'failed') {
        const b = sortbar?.querySelector('.rank-again');
        if (b) { b.disabled = false; b.textContent = 'could not: ' + (p.error ?? 'failed') + ' — try again'; }
        return;
      }
      await loadRank(); render();
      return;
    }
  }
  const TOP = () => rankDoc?.top ?? 20;   // the number rank.mjs sets
  const COMPARE = {
    due: byDueDate,
    priority: (a, b) => rk(a) - rk(b) || pri(a) - pri(b) || byDueDate(a, b),
    oldest: byWait,
    newest: (a, b) => (a.days ?? Infinity) - (b.days ?? Infinity),
  };
  const bySort = (rows) => [...rows].sort(COMPARE[sort] ?? COMPARE[DEFAULT_SORT]);

  /* NOT YET. Alex, 2026-09-30, of XPN6 and VJSS — Mia's birthday dinner
     and flowers, due 2027-08-21: "they are way to early to be shown." Upcoming
     already folds anything past 90 days under "later"; the map, its circles'
     lists and By project counted everything open whatever its date. A task
     due more than 30 days out stays off those until it is inside 30 days. */
  const NOT_YET_DAYS = 30;
  const notYet = (o) => !!o.due && (o.lead_days ?? 0) > NOT_YET_DAYS;
  const BUCKETS = {
    // Newest first is arrival order over the whole bucket. The default is the
    // dated rows by due time, then the undated by age. Sorting on `due` alone
    // compared an undated row as the string "null", which put every one of
    // them at the top under newest. Alex, 2026-09-05: "today newest first
    // [doesn't] sort properly."
    /* EVERYTHING HE OWES, ONE PAGE. Alex, 2026-10-03: "Combine today,
       upcoming, no date on one page." What were three chips are four
       sections of this one, drawn in render(): due today or overdue; no date
       but marked high; upcoming; no date. Each sorts itself, so the bucket
       hands them over as they are. Since the four sorts (same day) it is one
       list in the chosen order, with only the far-off folded. */
    today:    { pick: (o) => mine(o), sort: bySort, empty: 'Nothing on your list.' },
    owed:     { pick: (o) => !isDecision(o) && !isToday(o) && !mine(o), sort: bySort, empty: 'Nobody owes you anything.' },
    // Everything, cut a different way: by the project it belongs to rather than
    // by when it is due. Alex, 2026-09-16: "grouped by Tags/Projects." The
    // count on the chip is how many have no project at all, because that is the
    // number that says whether the projects/ match rules are keeping up.
    projects: { pick: (o) => !notYet(o), sort: bySort, empty: 'Nothing to group.' },
    // Was the Outbox. A task is here because something is written and waiting
    // for his Send; a loose draft is here because it answers no task and still
    // has to be somewhere.
    drafted:  { pick: (o) => isLoose(o) || draftsFor(o.id).length > 0, sort: bySort,
                empty: 'Nothing written and waiting for your Send.' },
    closed:   { pick: (o) => !!o.closed, sort: (r) => [...r].sort((a, b) => String(b.closed_at ?? '').localeCompare(String(a.closed_at ?? ''))),
                empty: 'Nothing closed in the last thirty days.' },
  };
  /* A loose draft is a row in `drafted` and nowhere else — it is not an
     obligation and must not appear as one under `no date`. */
  const inBucket = (name, o) => (isLoose(o) ? name === 'drafted' : true) && BUCKETS[name].pick(o);
  // Kind tags say what a thing is, not which project it belongs to.
  const projectsOf = (o) => (o.tags ?? []).filter((t) => t !== 'decision' && t !== 'birthday' && t !== 'invoice');

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = (due) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(due));
    return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}` : String(due);
  };
  const ageText = (d) => d == null ? '' : d < 1 ? 'today' : d === 1 ? '1 day' : `${d} days`;
  // How far off a deadline is, next to the date. The date alone makes you do
  // the arithmetic every time you look at the list.
  const leadText = (d) => d == null ? ''
    : d < 0 ? `${-d === 1 ? '1 day' : -d + ' days'} overdue`
    : d === 0 ? 'today'
    : d === 1 ? 'tomorrow'
    : `in ${d} days`;

  const ONE = { email: 'email', imessage: 'message', todo: 'todo',
                reminder: 'reminder', recurring: 'recurring' };
  const MANY = { email: 'threads', imessage: 'threads', todo: 'todo lines',
                 reminder: 'reminders', recurring: 'recurring' };
  function evidenceChips(o) {
    const n = new Map();
    for (const e of o.evidence ?? []) n.set(e.source, (n.get(e.source) ?? 0) + 1);
    return [...n].map(([src, c]) => c === 1 ? (ONE[src] ?? src) : `${c} ${MANY[src] ?? src}`);
  }

  /**
   * Move the due date. A reminder takes a time — its push fires at it; the
   * others take a date. The server confirms the absolute value back, the way
   * rules/reminders.md asks for any reminder change, and the row updates.
   */
  function dueEditor(o, host, btn) {
    if (host.querySelector('.due-edit')) return;
    btn.disabled = true;
    // Captured before the write: `o.due` is reassigned on success, so asking
    // it afterwards always answers "there was one".
    const had = !!o.due;
    const timed = /^rem:/.test(o.id);
    const row = document.createElement('div'); row.className = 'due-edit';
    const lab = document.createElement('span'); lab.className = 'due-label'; lab.textContent = 'due';
    const inp = document.createElement('input'); inp.type = timed ? 'datetime-local' : 'date';
    /* Today, when there is no date yet — the field opens on the answer he
       most often wants rather than on 1970 or an empty box. `String(null)` is
       the literal "null", which a date input silently drops on the floor. */
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
    const cur = had ? String(o.due) : now.slice(0, 10) + (timed ? ' 09:00' : '');
    inp.value = timed ? cur.slice(0, 16).replace(' ', 'T') : cur.slice(0, 10);
    inp.setAttribute('aria-label', 'due date');
    const go = document.createElement('button'); go.type = 'button'; go.textContent = had ? 'move' : 'set';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ghost'; cancel.textContent = 'Cancel';
    const note = document.createElement('span'); note.className = 'mut';
    cancel.onclick = () => { row.remove(); btn.disabled = false; };
    go.onclick = async () => {
      const v = inp.value.replace('T', ' ').slice(0, 16);
      if (!v) return;
      go.disabled = true; note.textContent = ' moving…';
      try {
        const r = await fetch('/api/obligations/due', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: o.id, due: v }) });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error ?? 'refused');
        o.due = d.due;
        const days = Math.round((Date.parse(String(d.due).replace(' ', 'T')) - Date.now()) / 86400000);
        o.lead_days = days; o.overdue = days < 0;
        note.textContent = ` ${had ? 'moved' : 'set'} to ${d.due}`;
        setTimeout(() => { row.remove(); btn.disabled = false; render(); }, 900);
      } catch (err) { note.textContent = ' could not move: ' + (err?.message ?? err); go.disabled = false; }
    };
    row.append(lab, inp, go, cancel, note);
    host.appendChild(row);
  }

  /** Why it is open again — a decision with a name and a reason on it. */
  function askReopen(o, host, btn) {
    btn.disabled = true;
    const box = document.createElement('div');
    box.className = 'outcomebox';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Why is this open again?';
    input.setAttribute('aria-label', 'Why is this open again?');
    const go = document.createElement('button'); go.textContent = 'Reopen';
    const cancel = document.createElement('button'); cancel.className = 'ghost'; cancel.textContent = 'Cancel';
    const note = document.createElement('span'); note.className = 'mut';
    const row = btn.parentNode;
    const restore = () => { row.style.display = ''; btn.disabled = false; };
    row.style.display = 'none';
    cancel.onclick = () => { box.remove(); restore(); };
    go.onclick = async () => {
      const why = input.value.trim();
      if (!why) { input.focus(); return; }
      go.disabled = true; note.textContent = ' reopening…';
      try {
        const r = await fetch('/api/obligations/reopen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: o.id, why }) });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error ?? 'refused');
        closedItems = (closedItems ?? []).filter((c) => c.id !== o.id);
        // Back onto the open list, in whichever bucket now holds it.
        const fresh = await (await fetch('/api/obligations')).json();
        items = fresh.items ?? items;
        await loadDrafts();
        const back = items.find((x) => x.id === o.id);
        const home = back ? Object.keys(BUCKETS).find((k) => k !== 'closed' && BUCKETS[k].pick(back)) : null;
        if (home) filter = home;
        selected = back ? back.id : null;
        remember();
        render();
      } catch (err) { note.textContent = ' could not reopen: ' + (err?.message ?? err); go.disabled = false; }
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') go.onclick(); if (e.key === 'Escape') cancel.onclick(); };
    box.append(input, go, cancel, note);
    row.parentNode.insertBefore(box, row);
    setTimeout(() => input.focus(), 0);
  }

  /** One line on what happened, with the criterion as the prompt. */
  /* "X or Y" into [X, Y] — only where each side reads as a phrase on its
     own (three words or more), so "Gail or Faye answers on the threshold
     engineer" stays one option rather than leaving "Gail" alone. */
  function closesOptions(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    const parts = t.split(/,?\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
    const phrase = (x) => x.split(' ').length >= 3;
    return parts.length > 1 && parts.length <= 3 && parts.every(phrase) ? parts : [t];
  }

  function askOutcome(o, host, done, { after = null, also = null } = {}) {
    done.disabled = true;
    if (also) also.disabled = true;
    const box = document.createElement('div');
    box.className = 'outcomebox';
    /* OPTIONS, NOT ONE STRING. Alex, 2026-09-30: "when we close a task,
       there are usually two options pre-filled as a text string. maybe we
       should make it three seperate fields with a radio box. option 1, option
       2, and then fully blank one." What closes it, split at its "or"s, each
       its own editable field (2026-09-06: "put the pre-filled text into the
       field as text not just a placeholder"), then a blank one. Typing in a
       field picks it. */
    const group = document.createElement('div');
    group.className = 'outcome-opts';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'What closed this?');
    const radio = 'oc-' + Math.random().toString(36).slice(2);
    const fields = [];
    const option = (value, placeholder) => {
      const row = document.createElement('label');
      row.className = 'outcome-opt';
      const r = document.createElement('input');
      r.type = 'radio'; r.name = radio;
      const f = document.createElement('input');
      f.type = 'text'; f.value = value; f.placeholder = placeholder;
      f.addEventListener('focus', () => { r.checked = true; });
      f.addEventListener('input', () => { r.checked = true; });
      row.append(r, f);
      group.append(row);
      const x = { r, f, row };
      fields.push(x);
      return x;
    };
    for (const v of closesOptions(o.closes)) option(v, '');
    const blank = option('', fields.length ? 'Something else closed it…' : 'What closed this?');
    fields[0].r.checked = true;
    const input = blank.f;   // the free field — also where "Not a task" asks why
    const chosen = () => (fields.find((x) => x.r.checked) ?? blank).f.value.trim();
    setTimeout(() => { const f0 = fields[0].f; f0.focus(); f0.setSelectionRange(f0.value.length, f0.value.length); }, 0);
    const go = document.createElement('button');
    go.textContent = 'Record';
    const skip = document.createElement('button');
    skip.className = 'ghost';
    skip.textContent = 'No note';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';
    /* "Not a task": it should never have been opened. His reason becomes a
     * verdict the triage reads before judging the next one like it, so the
     * mistake teaches rather than repeats. */
    const never = document.createElement('button');
    never.className = 'ghost';
    never.textContent = 'Not a task';
    let dismissing = false;

    // While the editor is open it IS the action row. Inserting it into the row
    // made the input a flex child and pushed the other four buttons out beside
    // it; hiding the row instead says plainly which decision is in progress.
    const row = done.parentNode;
    const restore = () => { row.style.display = ''; done.disabled = false; if (also) also.disabled = false; };
    row.style.display = 'none';

    const finish = (outcome) => { box.remove(); restore(); close(o.id, host, outcome, dismissing); };
    go.onclick = () => finish(chosen() || null);
    skip.onclick = () => finish(null);
    cancel.onclick = () => { box.remove(); restore(); };
    never.onclick = () => {
      dismissing = true;
      for (const x of fields) if (x !== blank) x.row.hidden = true;
      blank.r.checked = true;
      input.value = ''; input.placeholder = 'Why was this never a task? (becomes a verdict the triage reads)';
      go.textContent = 'Record verdict'; skip.hidden = true; never.hidden = true;
      input.focus();
    };
    for (const x of fields) x.f.onkeydown = (e) => { if (e.key === 'Enter') go.onclick(); if (e.key === 'Escape') cancel.onclick(); };

    box.append(group, go, skip, never, cancel);
    // From the top-right Close, the note goes right under the title — the
    // point of that button is not scrolling past the thread to the bottom.
    if (after) after.after(box); else row.parentNode.insertBefore(box, row);
    input.focus();
  }

  async function close(id, host, outcome, dismissed = false) {
    host.classList.add('closing');
    try {
      const r = await fetch('/api/obligations/close', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, ...(outcome ? { outcome } : {}), ...(dismissed ? { dismissed: true } : {}) }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      items = items.filter((i) => i.id !== id);
      if (selected === id) selected = null;
      render();
    } catch (e) {
      host.classList.remove('closing');
      host.classList.add('failed');
      const t = host.querySelector('.ob-title');
      if (t) t.textContent = 'could not close: ' + e.message;
    }
  }

  /**
   * Put message text into an element, with any URLs as links rather than as six
   * hundred characters of query string. textContent everywhere: this is somebody
   * else's text message, and it never becomes markup.
   */
  const fill = renderText;

  /** The iMessage transcript, loaded on first open. */
  async function loadThread(o, detail) {
    const t = await (await fetch('/api/thread?id=' + encodeURIComponent(o.chat_id))).json();
    if (t.error) throw new Error(t.error);

    // Bubbles, and the name only when the speaker changes. A name column beside
    // every line spent 40% of a 390px screen repeating "Clara (mother)" —
    // the thing you opened this to read is the words.
    let prev = null;
    for (const m of t.messages) {
      const speaker = m.from_me ? 'you' : m.who;
      if (speaker !== prev) {
        const w = document.createElement('div');
        w.className = 'msgwho' + (m.from_me ? ' mine' : '');
        w.textContent = speaker;
        detail.appendChild(w);
        prev = speaker;
      }
      const b = document.createElement('div');
      b.className = 'msgline' + (m.from_me ? ' mine' : '');
      b.title = m.at;
      fill(b, m.text);
      detail.appendChild(b);
    }

    if (!t.reply_to) {
      const note = document.createElement('div');
      note.className = 'mut';
      // Replying to a group needs a chat target rather than a person, and
      // guessing one would send a private answer to an audience.
      note.textContent = t.is_group
        ? 'Group thread — reply in Messages.'
        : 'No handle to reply to.';
      detail.appendChild(note);
      return;
    }

    const form = document.createElement('div');
    form.className = 'replybox';
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Reply to ' + t.name;
    const row = document.createElement('div');
    row.className = 'replyrow';
    const send = document.createElement('button');
    send.textContent = 'Send';
    send.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = ta.disabled = true;
      try {
        const r = await fetch('/api/reply', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: t.reply_to, text, chat_id: o.chat_id }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || r.status);
        form.textContent = 'Queued — the Mac sends it within a minute.';
      } catch (e) {
        send.disabled = ta.disabled = false;
        form.appendChild(Object.assign(document.createElement('div'),
          { className: 'replyerr', textContent: 'could not queue: ' + e.message }));
      }
    };
    row.appendChild(send);
    form.append(ta, row);
    detail.appendChild(form);
  }

  /**
   * The threads this obligation was read out of, each linking to the assistant's own
   * copy. Mail was the majority of the list and had no way to see the evidence
   * at all — 32 of 55 items, where tapping did nothing.
   */
  function evidenceList(o) {
    const mail = (o.evidence ?? []).filter((e) => e.source === 'email' && e.detail?.link);
    if (!mail.length) return null;

    const box = document.createElement('div');
    box.className = 'ob-ev';

    /* THE NEWEST THREAD IS OPEN ON ARRIVAL. Alex, 2026-09-21, of the Northwind
       reconciliation: "why can't I see the latest email thread. it is
       referenced in the summary UPDATE 2026-09-21." He could — behind a click
       on a row labelled only by its subject, which on that item is "Payment
       Notification" and says nothing about a reply having landed. So the words
       the summary is about were one unmarked tap away while the pane showed a
       paragraph asserting they existed. A conversation is what the pane is
       for; the older threads stay folded, because they are context. */
    const newest = mail.reduce((a, b) => (String(b.at ?? '') > String(a.at ?? '') ? b : a), mail[0]);

    for (const e of mail) {
      const rowEl = document.createElement('div');
      rowEl.className = 'ob-evrow' + (e.open ? '' : ' done');
      // A thread already archived is still evidence — it is how this obligation
      // came to say what it says — but it is not where the live conversation is.
      rowEl.title = e.open ? e.detail.subject ?? '' : 'already archived';
      const label = document.createElement('span');
      label.textContent = e.detail.subject || e.detail.thread_id;
      // No "open ↗". Alex, 2026-09-19: "Remove the thread open ↗ / Instead
      // stylize the inline thread similarly." The inline copy IS the thread —
      // a link out of the page was a second, worse way to read the same words.
      rowEl.append(label);

      // Alex, 2026-09-03: "when you open a cached email, it opens below it."
      // Text only, from the assistant's own cache first and Gmail second — the same
      // route the reading page uses, so what it shows is what /thread/ shows.
      const body = document.createElement('div');
      body.className = 'mailbody out-thread-msgs';
      // Which thread this is, so a draft answering it can find it (showPane).
      body.dataset.thread = e.detail.thread_id ?? '';
      body.hidden = true;
      let loaded = false;
      rowEl.onclick = async () => {
        body.hidden = !body.hidden;
        rowEl.classList.toggle('opened', !body.hidden);
        if (body.hidden || loaded) return;
        loaded = true;
        // The same bubbles the Outbox draws, from the same module: oldest
        // first, his own side on the right. It used to be a flat <pre> per
        // message, which read as a log rather than a conversation.
        await renderThread(body, { kind: 'mail', account: e.detail.account, threadId: e.detail.thread_id });
      };
      box.append(rowEl, body);
      if (e === newest && e.open) rowEl.onclick();
    }
    return box;
  }

  /* What was filed to Drive from this task, one link each. Alex, 2026-10-15,
     on the Lakeside Jet Hangar Co invoice: "we need to link the filed document in
     the task." The server matches reference/statements.md to the threads in
     the evidence above (filed-docs.mjs); the link opens Drive in a new tab. */
  function filedList(o) {
    if (!o.filed?.length) return null;
    const box = document.createElement('div');
    box.className = 'ob-ev ob-filed';
    for (const d of o.filed) {
      const a = document.createElement('a');
      a.className = 'ob-evrow';
      a.href = d.link; a.target = '_blank'; a.rel = 'noopener';
      // The file name already opens with its date; the size tells two
      // attachments of one mail apart when Gmail gave them one name.
      a.textContent = 'filed · ' + d.name + (d.kb ? ' · ' + d.kb + 'KB' : '');
      a.title = d.title;
      box.append(a);
    }
    return box;
  }

/* The four characters he can say out loud. Alex, 2026-09-19: "can you add a
 * unique id (like the reminders have) so I can easily share with you."
 * Derived from the real id, so it needs no registry and cannot drift.
 *
 * IN THE PANE, NOT ON THE ROW. Alex, 2026-09-21: "can we move the ID numbers
 * on to-do from the sidebar to the main area." It sat on every row in the
 * index, where it competed with the sender, the age and the title for the one
 * line a person scans — four characters of machine identity in the column
 * whose job is telling him what the thing IS. He reads a code when he has
 * already picked something and wants to mention it to the chat, which is
 * exactly when the pane is open. Tapping it still copies. */
function codeChip(o) {
  const code = document.createElement('button');
  code.type = 'button';
  code.className = 'ob-code';
  code.textContent = o.code ?? '';
  code.title = 'copy this code';
  code.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(o.code ?? '').then(() => {
      const was = code.textContent;
      code.textContent = 'copied';
      setTimeout(() => { code.textContent = was; }, 900);
    }).catch(() => {});
  };
  return code;
}

  function meta(o) {
    const el = document.createElement('div');
    el.className = 'ob-meta';

    const when = document.createElement('span');
    // A deadline and an age are different facts. Showing "3 days" for something
    // due next Tuesday is worse than showing nothing: it reads as lateness.
    when.className = 'ob-age ' + (o.due
      ? (o.overdue ? 'overdue' : 'soon')
      : ((o.days ?? 0) >= 7 ? 'overdue' : 'soon'));
    when.textContent = o.closed ? `closed ${shortDate(o.closed_at)}` : o.due ? `${shortDate(o.due)} · ${leadText(o.lead_days)}` : ageText(o.days);
    if (o.closed) when.className = 'ob-age';
    el.appendChild(when);

    // "unknown handle" is a real fact about a message thread: somebody texted
    // and contacts could not name them. It is nonsense on a reminder or a
    // hand-typed task, which never had a handle to fail to resolve.
    const whoText = o.who || (o.chat_id ? 'unknown handle' : '');
    if (whoText) {
      const who = document.createElement('span');
      who.className = 'ob-who';
      who.textContent = whoText;
      el.appendChild(who);
    }
    for (const label of evidenceChips(o)) {
      const src = document.createElement('span');
      src.className = 'ob-src';
      src.textContent = label;
      el.appendChild(src);
    }
    if (o.priority && o.priority !== 'normal') {
      const p = document.createElement('span');
      p.className = 'ob-pri ' + o.priority;
      p.textContent = o.priority;
      el.appendChild(p);
    }
    return el;
  }

  /**
   * A row on the left, in the shape a mail client uses: who on the strong line
   * with the date at the right, the headline beneath, one line of preview, then
   * the source chips. Everything single-line and ellipsised so the list scans
   * as a list; the pane is where things get room.
   */
  function row(o) {
    const el = document.createElement('div');
    // The kind rule down the left says the same thing on every list: hot is
    // late, warm wants attention soon, the accent is a decision, plain is the
    // rest. Alex, 2026-09-19: "we need to standardize on the design language
    // throughout" — a task row had no rule at all, so To Do was the one list
    // where the left edge carried nothing.
    const state = isDecision(o) ? ' decided'
      : o.overdue ? ' urgent'
      : (o.due && (o.lead_days ?? 99) <= 7) || o.priority === 'high' ? ' soon' : '';
    el.className = 'ob' + (o.closed ? ' closed' : state) + (o.id === selected ? ' selected' : '');
    // What is behind this row, marked in the DOM so the visual test can pick one
    // of each kind deliberately.
    if (o.chat_id) el.dataset.chat = '1';
    const mailCount = (o.evidence ?? []).filter((e) => e.source === 'email' && e.detail?.link).length;
    if (mailCount) el.dataset.mail = String(mailCount);

    const inner = document.createElement('div');
    inner.className = 'ob-inner ob-row';
    inner.onclick = () => select(o.id);

    const who = document.createElement('div');
    who.className = 'ob-who';
    // "unknown handle" is a real fact about a message thread: somebody texted
    // and contacts could not name them. A reminder or a hand-typed task never
    // had a handle, so it shows what it is instead.
    who.textContent = o.who || (o.chat_id ? 'unknown handle'
      : (o.evidence?.[0]?.source === 'reminder' ? 'reminder'
        : o.evidence?.[0]?.source === 'recurring' ? 'recurring' : 'note to self'));

    const when = document.createElement('span');
    // A deadline and an age are different facts. Showing "3 days" for something
    // due next Tuesday is worse than showing nothing: it reads as lateness.
    when.className = 'ob-age ' + (o.due
      ? (o.overdue ? 'overdue' : 'soon')
      : ((o.days ?? 0) >= 7 ? 'overdue' : 'soon'));
    when.textContent = o.closed ? `closed ${shortDate(o.closed_at)}` : o.due ? `${shortDate(o.due)} · ${leadText(o.lead_days)}` : ageText(o.days);
    if (o.closed) when.className = 'ob-age';

    const title = document.createElement('div');
    title.className = 'ob-title tappable';
    title.textContent = o.title || o.what;
    const rank = ranks.get(o.id);
    if (rank && !o.closed) {
      const chip = document.createElement('span');
      chip.className = 'rank-chip';
      chip.textContent = `#${rank.n}`;
      chip.title = rank.why ? `Today's #${rank.n} — ${rank.why}` : `Today's #${rank.n}`;
      title.prepend(chip);
    }
    /* Drag to reorder today's order, on a desktop under the priority sort. A
       row from outside it dropped on one joins it there. On a phone the
       same moves are the arrows in the task's pane. */
    if (sort === 'priority' && !o.closed && !isLoose(o) && window.matchMedia?.('(hover: hover)').matches) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', o.id); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      if (rank) {
        el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-here'); });
        el.addEventListener('dragleave', () => el.classList.remove('drop-here'));
        el.addEventListener('drop', (e) => {
          e.preventDefault(); el.classList.remove('drop-here');
          const id = e.dataTransfer.getData('text/plain');
          if (!id || id === o.id) return;
          const ids = rankIds().filter((x) => x !== id);
          ids.splice(ids.indexOf(o.id), 0, id);
          saveRank(ids.slice(0, TOP()), id).catch((err) => console.error('rank: could not save', err));
        });
      }
    }

    const preview = document.createElement('div');
    preview.className = 'ob-preview';
    preview.textContent = o.closed ? `by ${o.closed_by ?? '?'}${o.outcome ? ' — ' + o.outcome : ''}`
      : (o.what && o.what !== o.title) ? o.what : (o.closes ? 'closes when: ' + o.closes : '');

    const tags = document.createElement('div');
    tags.className = 'ob-tags';
    for (const t of o.tags ?? []) {
      const c = document.createElement('span');
      c.className = 'ob-tag';
      c.textContent = '#' + t;
      tags.appendChild(c);
    }
    for (const label of evidenceChips(o)) {
      const src = document.createElement('span');
      src.className = 'ob-src';
      src.textContent = label;
      tags.appendChild(src);
    }
    // Something is written and waiting for his Send. This is the whole point of
    // the merge: the row for the debt says the reply is ready.
    const waiting = isLoose(o) ? 1 : draftsFor(o.id).length;
    if (waiting) {
      const d = document.createElement('span');
      d.className = 'ob-draft';
      d.textContent = waiting === 1 ? 'draft' : `${waiting} drafts`;
      tags.appendChild(d);
    }
    if (o.priority && o.priority !== 'normal') {
      const pri = document.createElement('span');
      pri.className = 'ob-pri ' + o.priority;
      pri.textContent = o.priority;
      tags.appendChild(pri);
    }

    inner.append(who, when, title, preview, tags);
    el.appendChild(inner);
    // A decision carries its recommendation on the row: it is the line that
    // makes the choice tappable rather than a title you have to open.
    if (isDecision(o)) {
      const d = (o.evidence ?? []).find((e) => e.source === 'decision')?.detail ?? {};
      const rec = document.createElement('div');
      rec.className = 'ob-preview';
      rec.textContent = d.recommend ? '\u2192 ' + d.recommend : d.blocked ? 'blocked: ' + d.blocked : `${(d.options ?? []).length} options`;
      inner.append(rec);
    }
    // On the map a row can be picked up and dropped on a circle (assignTo).
    if (filter === 'map' && !o.closed && !isLoose(o)) {
      el.draggable = true;
      el.classList.add('ob-draggable');
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', o.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('ob-dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('ob-dragging'));
    }
    // A closed row has nothing to swipe to: done is done, and reopening is a
    // decision with a reason on it, not a gesture.
    return o.closed ? el : swipeable(el, inner, o);
  }

  /**
   * A draft that answers no task: an invite, or a reply on a thread nobody
   * owes anything on. It still has to be somewhere, or merging the two queues
   * would quietly lose half of one.
   */
  async function showLooseDraft(o, box) {
    const d = o.__draft;
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'pane-back'; back.textContent = '\u2039 back to list';
    back.onclick = () => { if (!closeState('pane')) { selected = null; render(); } };
    const head = document.createElement('div');
    head.className = 'pane-head';
    const h = document.createElement('h3');
    h.className = 'pane-title';
    h.textContent = o.title;
    const m = document.createElement('div');
    m.className = 'ob-meta mut';
    m.textContent = 'not attached to a task';
    head.append(h, m);
    box.append(back, head);
    if ((d.kind === 'mail' && d.threadId) || d.chatId) {
      const thread = document.createElement('div');
      thread.className = 'out-thread-msgs';
      box.appendChild(thread);
      renderThread(thread, d);
    }
    box.appendChild(draftFoot(d, { reload: () => loadDrafts().then(render) }));
    pane.appendChild(box);
  }

  /**
   * Every draft waiting for his Send, grouped by the task the server joined it
   * to. Loose ones become rows of their own. Never silent: a read that fails
   * leaves the map empty AND says so, because an empty `drafted` bucket and a
   * broken one look identical otherwise.
   */
  async function loadDrafts() {
    try {
      const d = await (await fetch('/api/outbox')).json();
      const waiting = [
        ...(Array.isArray(d?.mail) ? d.mail : []).map((m) => ({ ...m, kind: 'mail', status: 'draft' })),
        ...(Array.isArray(d?.outbox) ? d.outbox : []).filter((t) => t.status === 'draft')
          .map((t) => ({ ...t, kind: t.kind ?? 'text' })),
      ];
      draftsByTask = new Map();
      items = items.filter((o) => !isLoose(o));
      for (const x of waiting) {
        if (!x.task) continue;
        if (!draftsByTask.has(x.task)) draftsByTask.set(x.task, []);
        draftsByTask.get(x.task).push(x);
      }
      for (const x of waiting) {
        if (x.task) continue;
        const who = x.toName || String(x.to ?? '').replace(/<.*>/, '').trim() || 'someone';
        items.push({
          id: 'draft:' + x.id, __draft: x, owed_by: 'me', tags: [], evidence: [],
          who: `to ${who}`,
          title: x.kind === 'mail' ? (x.subject || '(no subject)')
            : x.kind === 'invite' ? `invite \u00b7 ${x.when || 'a time already held'}`
            : String(x.text || '').split('\n')[0],
          what: String(x.text || '').replace(/\s+/g, ' ').trim(),
          days: null, due: null,
        });
      }
      for (const b of d?.blind ?? []) console.warn('drafts:', b);
    } catch (err) {
      console.error('drafts: could not read the outbox', err);
      draftsByTask = new Map();
    }
  }

  /** The right pane: everything about the selected item. */
  async function showPane(o) {
    delete pane.dataset.proj;
    pane.textContent = '';
    if (session && session.queue[session.at] === o.id) pane.appendChild(sessionBar(o));
    const box = document.createElement('div');
    box.className = 'pane-inner';
    if (isLoose(o)) return showLooseDraft(o, box);

    // The way back, on a phone. On a wide screen the list is beside this and
    // the button is hidden by CSS.
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'pane-back';
    back.textContent = '‹ back to list';
    // Through history, so the button and the swipe travel the same path.
    back.onclick = () => { if (!closeState('pane')) { selected = null; render(); } };
    box.appendChild(back);

    const head = document.createElement('div');
    head.className = 'pane-head';
    const h = document.createElement('h3');
    h.className = 'pane-title';
    h.textContent = o.title || o.what;
    // The code rides with the meta line — who, when, and the four characters
    // he would type to the chat about this one. See codeChip.
    const m = meta(o);
    if (o.code) m.appendChild(codeChip(o));
    head.append(h, m);
    /* CLOSE, TOP RIGHT. Alex, 2026-09-30: "On each to-do, lets add a Close
       button in top right corner." Since the pane grew the thread and a reply
       box (the same day), the Close in the action row sits a long scroll
       down. This is the same close — the note, No note, Not a task — opened
       under the title. */
    if (!o.closed) {
      const top = document.createElement('button');
      top.type = 'button';
      top.className = 'pane-act ob-close-top';
      top.textContent = 'Close';
      top.title = 'Close this task, with a note or without';
      top.onclick = () => {
        const d = box.querySelector('.ob-done');
        if (d) askOutcome(o, box, d, { after: head, also: top });
      };
      head.classList.add('has-close');
      head.append(top);
    }
    box.appendChild(head);
    if (!o.closed && (o.owed_by ?? 'me') !== 'them') { const rb = rankBlock(o); if (rb) box.appendChild(rb); }
    if (session && session.queue[session.at] === o.id) {
      const pc = prepCard(o);
      if (pc) {
        box.appendChild(pc);
        const e = session.prep[o.id];
        if (e.state === 'ready' && e.kind === 'reply') setTimeout(() => fillReply(o, e, pc), 0);
      }
    }

    /* A CLOSED ITEM: who closed it, when, on what — and the one thing he can
       do about it. Alex's review, 2026-09-20: a wrong close could be neither
       seen nor taken back from the page. Reopen wants a reason: it lands in
       obligation-changes.jsonl, and the next brief names it. */
    if (o.closed) {
      const line = document.createElement('div');
      line.className = 'ob-closes ob-closed-line';
      line.textContent = `closed ${o.closed_at ?? '?'} by ${o.closed_by ?? '?'}${o.outcome ? ` — ${o.outcome}` : ''}`;
      box.appendChild(line);
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      const reopen = document.createElement('button');
      reopen.type = 'button'; reopen.className = 'ob-reopen'; reopen.textContent = 'Reopen';
      reopen.onclick = () => askReopen(o, box, reopen);
      actions.append(reopen);
      if (o.what && o.what !== o.title) {
        const what = document.createElement('div');
        what.className = 'what';
        for (const p of paragraphsOf(splitWhat(o.what).state)) { const el = document.createElement('p'); el.textContent = p; what.appendChild(el); }
        box.appendChild(what);
      }
      const ev = evidenceList(o);
      if (ev) box.appendChild(ev);
      box.appendChild(actions);
      pane.appendChild(box);
      return;
    }

    // The paragraph the triage wrote — the answer to "why is this on my list".
    // Skipped when the headline is already the whole of it.
    //
    // Alex, 2026-09-08, on one that ran to 795 unbroken words: "this is just
    // a wall of text, how can we present cleaner?" `what` is append-only in
    // practice — each run adds a dated entry rather than rewriting — so what
    // he needs on opening is the newest entry, and the rest on request.
    if (o.what && o.what !== o.title) {
      const { state, history } = splitWhat(o.what);
      const what = document.createElement('div');
      what.className = 'what';
      for (const p of paragraphsOf(state)) {
        const el = document.createElement('p');
        el.textContent = p;
        what.appendChild(el);
      }
      box.appendChild(what);

      if (history.length) {
        // <details> rather than a button: it is closed on arrival, it opens
        // without JavaScript, and the browser gives it keyboard and find-in-page
        // behaviour for free.
        const d = document.createElement('details');
        d.className = 'what-history';
        const sum = document.createElement('summary');
        const dated = history.filter((h) => h.date);
        sum.textContent = `how it got here — ${history.length} earlier update${history.length === 1 ? '' : 's'}`
          + (dated.length ? `, ${dated[0].date} to ${dated[dated.length - 1].date}` : '');
        d.appendChild(sum);
        for (const h of history) {
          const entry = document.createElement('div');
          entry.className = 'what-entry';
          const when = document.createElement('div');
          when.className = 'what-when';
          when.textContent = h.date ?? 'as first recorded';
          entry.appendChild(when);
          for (const p of paragraphsOf(h.body)) {
            const el = document.createElement('p');
            el.textContent = p;
            entry.appendChild(el);
          }
          d.appendChild(entry);
        }
        box.appendChild(d);
      }
    }
    // What discharge looks like. Knowing you are waiting on a receipt from
    // Northwind is most of what makes the item actionable.
    if (o.closes) {
      const c = document.createElement('div');
      c.className = 'ob-closes';
      c.textContent = 'closes when: ' + o.closes;
      box.appendChild(c);
    }
    const ev = evidenceList(o);
    if (ev) box.appendChild(ev);
    const fl = filedList(o);
    if (fl) box.appendChild(fl);

    /* The reply that is ready to go, at the foot of what it answers — the
       Outbox's own shape, from the same module. Alex, 2026-09-19. */
    for (const d of draftsFor(o.id)) {
      const foot = draftFoot(d, { reload: () => loadDrafts().then(render) });
      /* ONE COPY OF THE EMAIL. Alex, 2026-10-03: "On to dos, email often
         show twice." The newest thread opens by itself under its row in the
         evidence list above, and a draft answering it drew the same thread
         again here — the comment below assumed the rows stay folded, which
         stopped being true when the newest began opening itself. So a draft
         whose thread is already open above sits directly under it instead. */
      const open = d.kind === 'mail' && d.threadId
        ? [...(ev?.querySelectorAll('.mailbody') ?? [])].find((b) => b.dataset.thread === d.threadId && !b.hidden)
        : null;
      if (open) { open.after(foot); continue; }
      const thread = document.createElement('div');
      thread.className = 'out-thread-msgs';
      box.appendChild(thread);
      // A text task draws its own conversation above (loadThread); a mail
      // task's other threads stay folded behind their rows, so a draft
      // answering one of those brings it with it.
      if (d.kind === 'mail' && d.threadId) renderThread(thread, d);
      else thread.remove();
      box.appendChild(foot);
    }

    // Tags: his browsing handles. Chips with a remove, one input to add. Saved
    // wholesale on each change; the file is the merged id → list, so a tag
    // survives a merge. A todo line's #project appears here too but is owned by
    // todo.md, so it cannot be removed from this editor — it says so.
    const ted = document.createElement('div');
    ted.className = 'tagedit';
    const fromTodo = new Set((o.evidence ?? []).flatMap((e) => e.source === 'todo' && e.project ? [e.project] : []));
    const renderTags = () => {
      ted.textContent = '';
      for (const t of o.tags ?? []) {
        const chip = document.createElement('span');
        chip.className = 'ob-tag' + (fromTodo.has(t) ? ' fixed' : '');
        chip.textContent = '#' + t;
        chip.title = fromTodo.has(t) ? 'from todo.md — edit it there' : 'remove';
        if (!fromTodo.has(t)) chip.onclick = () => saveTags((o.tags ?? []).filter((x) => x !== t));
        ted.appendChild(chip);
      }
      /* EXISTING TAGS FIRST. Alex, 2026-09-30: "the add tag option, should
         first match existing tags, then offer to create one if no match." A
         typo used to make a new tag silently — #fowa beside #phoa, and a
         circle on the map that nothing else is in. Suggestions come from the
         projects (matched on the tag or the name), the kinds, and every tag
         in use; "Create #x" is offered last, and only when nothing matches
         exactly. */
      const wrap = document.createElement('span');
      wrap.className = 'tagin-wrap';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'tagin';
      inp.placeholder = 'add tag';
      inp.setAttribute('aria-label', 'add a tag');
      inp.setAttribute('autocomplete', 'off');
      const menu = document.createElement('div');
      menu.className = 'tagsug';
      menu.hidden = true;
      let hi = 0, choices = [];
      const known = () => {
        const m = new Map();
        for (const p of projects) if (p.tag) m.set(p.tag, p.title || p.name || '');
        for (const [t, l] of Object.entries(KIND_LABEL)) if (!m.has(t)) m.set(t, l);
        for (const x of items) for (const t of x.tags ?? []) if (!m.has(t)) m.set(t, '');
        return m;
      };
      const pick = (t) => { menu.hidden = true; if (t) saveTags([...(o.tags ?? []), t]); };
      const draw = () => {
        const q = inp.value.trim().replace(/^#+/, '').toLowerCase();
        menu.textContent = '';
        if (!q) { menu.hidden = true; choices = []; return; }
        const have = new Set(o.tags ?? []);
        const all = [...known()].filter(([t]) => !have.has(t));
        const starts = all.filter(([t, l]) => t.startsWith(q) || l.toLowerCase().startsWith(q));
        const within = all.filter(([t, l]) => !starts.some(([u]) => u === t) && (t.includes(q) || l.toLowerCase().includes(q)));
        choices = [...starts, ...within].slice(0, 8).map(([t, l]) => ({ tag: t, label: l }));
        const slug = q.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        // Create only when nothing matches: a near-miss is far likelier a typo than a new tag.
        if (!choices.length && slug && !known().has(slug) && !have.has(slug)) choices.push({ tag: slug, create: true });
        hi = Math.min(hi, Math.max(0, choices.length - 1));
        choices.forEach((c, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'tagsug-row' + (i === hi ? ' on' : '') + (c.create ? ' create' : '');
          b.textContent = c.create ? `Create #${c.tag}` : `#${c.tag}${c.label ? ` — ${c.label}` : ''}`;
          b.onmousedown = (e) => { e.preventDefault(); pick(c.tag); };
          menu.append(b);
        });
        menu.hidden = !choices.length;
      };
      inp.oninput = () => { hi = 0; draw(); };
      inp.onblur = () => setTimeout(() => { menu.hidden = true; }, 120);
      inp.onkeydown = (e) => {
        if (e.key === 'ArrowDown' && choices.length) { e.preventDefault(); hi = (hi + 1) % choices.length; draw(); return; }
        if (e.key === 'ArrowUp' && choices.length) { e.preventDefault(); hi = (hi - 1 + choices.length) % choices.length; draw(); return; }
        if (e.key === 'Escape') { menu.hidden = true; return; }
        if (e.key !== 'Enter' && e.key !== ',') return;
        e.preventDefault();
        if (choices[hi]) return pick(choices[hi].tag);
        const v = inp.value.trim().replace(/^#+/, '').toLowerCase();
        if (v) pick(v);
      };
      wrap.append(inp, menu);
      ted.appendChild(wrap);
    };
    const saveTags = async (next) => {
      const prev = o.tags;
      o.tags = [...new Set(next)].sort();
      renderTags();
      try {
        const r = await fetch('/api/obligations/tags', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: o.id, tags: o.tags.filter((t) => !fromTodo.has(t)) }),
        });
        if (!r.ok) throw new Error((await r.json()).error || r.status);
        const d = await r.json();
        o.tags = [...new Set([...(d.tags ?? []), ...fromTodo])].sort();
        fillTagSelect();
        render();
      } catch (e) {
        o.tags = prev;
        renderTags();
      }
    };
    renderTags();
    box.appendChild(ted);

    // A reminder's push history lives here, with the task, not on Briefs.
    // Alex, 2026-09-06: "move reminders from briefs to to do."
    const rd = (o.evidence ?? []).find((e) => e.source === 'reminder')?.detail ?? o.detail;
    if (/^rem:/.test(o.id) && rd && typeof rd.nags === 'number') {
      const l = document.createElement('div'); l.className = 'ob-ladder mut';
      l.textContent = rd.nags === 0 ? `reminder · ${rd.class ?? 'normal'} · not pushed yet`
        : `reminder · ${rd.class ?? 'normal'} · pushed ${rd.nags}×${rd.last ? ' · last ' + String(rd.last).slice(5, 16) : ''}${rd.nags >= 4 ? ' · awaiting your disposition' : ''}`;
      box.appendChild(l);
    }

    /* Two rows for one thing. Alex, 2026-09-18, once his Reminders lists
     * started arriving: "sometimes a manual reminder matches an existing todo
     * in the assistant. how can we get them linked?" The server proposes the pair;
     * this is the tap that records the merge. It is deliberately a sentence he
     * can read and refuse rather than a button labelled Merge — the machine has
     * noticed a resemblance, and only he knows whether it is the same debt. */
    if (o.twin) {
      const row = document.createElement('div');
      row.className = 'ob-twin';
      const said = document.createElement('div');
      said.className = 'ob-meta';
      said.textContent = `Looks like the same thing as "${o.twin.title}"`
        + (o.twin.why?.length ? ` — ${o.twin.why.join(', ')}` : '');
      const tools = document.createElement('div');
      tools.className = 'pr-tools';
      const open = document.createElement('button');
      open.type = 'button'; open.textContent = 'open it';
      open.onclick = () => { selected = o.twin.id; render(); };
      const link = document.createElement('button');
      link.type = 'button'; link.textContent = 'same thing — link them';
      link.onclick = async () => {
        link.disabled = true; said.textContent = 'linking…';
        try {
          const r = await fetch('/api/obligations/link', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: o.id, into: o.twin.id }),
          });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error ?? 'refused');
          const fresh = await (await fetch('/api/obligations')).json();
          items = fresh.items ?? items;
          selected = d.id;
          render();
        } catch (err) { said.textContent = `not linked: ${err.message}`; link.disabled = false; }
      };
      tools.append(open, link);
      row.append(said, tools);
      box.appendChild(row);
    }

    // The action center. Alex, 2026-09-06: "rework the Done button into a
    // task action center. You can either close a task (with a note, or no
    // note), change due date if there is one, ask the agent to do something
    // with the task." Buttons as well as the swipe on the row: a swipe nobody
    // is told about is not a feature, and it is unusable with a keyboard.
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    const mk = (label, cls, on) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; b.onclick = on; return b; };
    const done = mk('Close', 'ob-done', () => askOutcome(o, box, done));
    actions.append(done);
    /* A DATE CAN BE SET, NOT ONLY MOVED. Alex, 2026-09-21: "tasks under
       Today doesnt have a Move due button." They did not, and the reason was
       `!!o.due` — the button appeared only where a date already existed. But
       Today's second half is exactly the items with NO date, the ones he
       marked high, so the one bucket where giving something a day is the
       obvious next move was the one bucket that could not. Every source
       already wrote a date where there was none; only this gate said no.

       An allow list of kinds rather than a blocklist, so a button never
       appears where setDue would refuse: recurring is due by its definition
       in recurring.md and a birthday is due on the birthday. */
    const kind = String(o.id ?? '').split(':')[0];
    if (['rem', 'todo', 'mail', 'im', 'decision'].includes(kind)) {
      const move = mk(o.due ? 'Move due' : 'Set due', 'ob-move', () => dueEditor(o, box, move));
      actions.append(move);
    }
    /* DRAFT, INLINE. Alex, 2026-09-30, on "Reply to ARKO on the cabinetry
       decision": "it would be helpful if I can reply inline. If I click draft
       reply, I want to see that inline too."

       Which way the debt runs decides the button. When HE owes the reply, the
       the assistant writes the words into the reply box under the thread — the box
       mail tasks now have, and text tasks always had — and Save draft or Send
       stays his tap. When THEY owe him, it writes the chase as before, and the
       draft is drawn here at the foot of the task instead of "approve on the
       outbox". Only where there is a thread to answer on: a button that is
       going to refuse is worse than one that is not there. */
    const mailEv = (o.evidence ?? []).find((e) => e.source === 'email' && e.detail?.thread_id);
    const theyOwe = o.owed_by === 'them';
    if (!theyOwe && (mailEv || o.chat_id)) {
      const dr = mk('Draft reply', 'ob-followup', async () => {
        const ta = box.querySelector('.replybox textarea');
        if (!ta) { dr.textContent = 'a draft is already waiting below — edit it there'; return; }
        dr.disabled = true; const was = dr.textContent; dr.textContent = 'drafting…';
        try {
          const r = await fetch('/api/obligations/draft-reply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: o.id }),
          });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error ?? 'refused');
          ta.value = d.text;
          ta.rows = Math.min(14, Math.max(3, d.text.split('\n').length + 1));
          ta.scrollIntoView({ block: 'center', behavior: 'smooth' });
          ta.focus();
          dr.textContent = 'drafted below — edit, then save or send';
          dr.disabled = false;
          setTimeout(() => { dr.textContent = was; }, 6000);
        } catch (err) {
          dr.textContent = 'could not draft: ' + (err?.message ?? err);
          dr.disabled = false;
          setTimeout(() => { dr.textContent = was; }, 6000);
        }
      });
      actions.append(dr);
    } else if (theyOwe && o.who) {
      const fu = mk('Draft follow-up', 'ob-followup', async () => {
        fu.disabled = true; const was = fu.textContent; fu.textContent = 'drafting…';
        try {
          const r = await fetch('/api/obligations/follow-up', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: o.id }),
          });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error ?? 'refused');
          window.outboxCount?.();
          // Drawn here, at the foot of the task, with Send / Edit / Discard.
          await loadDrafts();
          render();
        } catch (err) {
          fu.textContent = 'could not draft: ' + (err?.message ?? err);
          fu.disabled = false;
          setTimeout(() => { fu.textContent = was; }, 6000);
        }
      });
      actions.append(fu);
    }

    // Keep in Inbox, for a task with a mail thread (2026-10-09; see keep-inbox.mjs).
    if (mailEv) actions.append(keepButton(mailEv.detail.account ?? 'personal', mailEv.detail.thread_id, { task: o.id, className: 'ob-keep' }));

    /* ON AUTOPAY. Alex, 2026-09-30: "I only want to be a task if autopay
       fails." On a bill he owes: puts the sender (and the account the bill
       names) on his autopay list and closes every open bill it now covers.
       From then on a statement is filed, and only a failed payment is a task. */
    if (!theyOwe && (o.tags ?? []).includes('invoice') && String(o.who ?? '').includes('@')) {
      const ap = mk('On autopay', 'ob-autopay', async () => {
        ap.disabled = true; const was = ap.textContent; ap.textContent = 'adding…';
        try {
          const r = await fetch('/api/obligations/autopay', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: o.id }),
          });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error ?? 'refused');
          const n = (d.closed ?? []).length;
          ap.textContent = `on autopay${d.account ? ` (account ${d.account})` : ''} — ${n} closed`;
          setTimeout(() => location.reload(), 1600);
        } catch (err) {
          ap.textContent = 'could not: ' + (err?.message ?? err);
          ap.disabled = false;
          setTimeout(() => { ap.textContent = was; }, 6000);
        }
      });
      actions.append(ap);
    }

    actions.append(mk('Ask the assistant', 'ob-ask', () => {
      // Hand the task to the composer, which already carries the open task as
      // context; he finishes the sentence and sends.
      const inp = document.querySelector('#workdock .composer-input');
      if (!inp) return;
      inp.value = `About "${o.title}": `;
      inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    }));

    const detail = document.createElement('div');
    detail.className = 'ob-detail';
    box.append(detail, actions);
    pane.appendChild(box);

    /* A mail task gets a reply box, the way a text task always had one. Not
       when a draft is already waiting: that is drawn above with its own Send /
       Edit / Discard, and two boxes for one reply is how two replies get sent.

       No thread of its own. The first cut drew the last messages above the
       box, and the evidence row above it already opens the newest thread by
       itself — so the email showed twice. Alex, 2026-09-30: "tasks now show
       the inline email twice (V89D)". */
    if (mailEv && !draftsFor(o.id).length) {
      const acct = mailEv.detail.account ?? 'personal';
      const rb = document.createElement('div');
      rb.className = 'mail-reply';
      detail.append(rb);
      replyBox(rb, { account: acct, threadId: mailEv.detail.thread_id, who: o.who },
        // Sent: the box says so in place; the triage closes the task when it
        // reads the reply. Saved as a draft: redraw, so it shows as the draft.
        { onDrafted: () => loadDrafts().then(render) });
    }

    if (!o.chat_id) return;
    const loading = document.createElement('div');
    loading.className = 'mut';
    loading.textContent = 'loading…';
    detail.appendChild(loading);
    try {
      await loadThread(o, detail);
      loading.remove();
    } catch (e) {
      loading.textContent = 'could not load the thread: ' + e.message;
    }
  }

  function select(id) {
    selected = id;
    if (projPane) { projPane = null; writeView({ proj: null }); }
    render();
  }

  function openProj(id) {
    projPane = id;
    selected = null;
    openState('proj', id);
    render();
  }
  function closeProj() {
    if (!closeState('proj')) { projPane = null; writeView({ proj: null }); render(); }
  }
  onStateChange('proj', (id) => { projPane = id; render(); });

  /** The projects and the tasks again, after a project file changed: its match rules may have re-homed work. */
  async function refreshProjects() {
    try {
      projects = (await (await fetch('/api/projects')).json()).projects ?? projects;
      items = (await (await fetch('/api/obligations')).json()).items ?? items;
      fillTagSelect();
    } catch { /* the next load will */ }
  }

  /** A project door in the pane. Drawn once per door — a redraw of the list must not wipe what he is typing. */
  function drawProjPane() {
    if (pane.dataset.proj === projPane && pane.querySelector('.pane-inner')) return;
    pane.dataset.proj = projPane;
    pane.textContent = '';
    const done = async () => { await refreshProjects(); closeProj(); };
    const stay = async () => { await refreshProjects(); render(); };
    if (projPane === 'new') return projectForm(pane, null, { onBack: closeProj, onSaved: done });
    if (projPane === 'rank') return rankEditor(pane, { onBack: closeProj, onSaved: stay });
    if (projPane === 'archived') return archivedPane(pane, { onBack: closeProj, onSaved: stay });
    if (String(projPane).startsWith('edit:')) {
      const want = String(projPane).slice(5);
      return projectsIndex().then((all) => {
        const row = all.find((x) => x.tag === want);
        if (row && projPane === 'edit:' + want) projectForm(pane, row, { onBack: closeProj, onSaved: done });
        else if (!row) closeProj();
      });
    }
    closeProj();
  }

  /* BY PROJECT: every project, each with its tasks and an edit, and the
     doors for new ones at the top. A project with nothing open is still
     listed — it is where its edit lives. What no project claims is hidden
     (Alex, 2026-10-04: "Lets hide the No Project tasks") but counted on the
     last line, with the way to it: a silence must not read as none. */
  function drawByProject(rows, head) {
    const tool = (label, id) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sec-action proj-tool'; b.textContent = label;
      b.onclick = () => openProj(id);
      return b;
    };
    const tools = document.createElement('div');
    tools.className = 'proj-tools';
    tools.append(tool('+ new project', 'new'), tool('what leads the briefs', 'rank'), tool('archived', 'archived'));
    head.prepend(tools);

    const groups = new Map();
    let loose = 0;
    for (const o of rows) {
      const ts = projectsOf(o);
      if (!ts.length) { loose++; continue; }
      for (const t of ts) { if (!groups.has(t)) groups.set(t, []); groups.get(t).push(o); }
    }
    const live = projects.filter((p) => p.tag && (p.status ?? 'active') !== 'done');
    for (const p of live) if (!groups.has(p.tag)) groups.set(p.tag, []);
    const byTag = new Map(live.map((p) => [p.tag, p]));
    // Biggest first, as before; the empty ones last, by name.
    const order = [...groups].filter(([t]) => !tag || t === tag)
      .sort((a, b) => b[1].length - a[1].length || circleLabel(a[0]).localeCompare(circleLabel(b[0])));
    for (const [t, rs] of order) {
      const p = byTag.get(t);
      const h = document.createElement('div'); h.className = 'sec-head proj-head';
      const title = document.createElement('span'); title.className = 'sec-title';
      title.textContent = `${p ? (p.title || p.name || '#' + t) : '#' + t} · ${rs.length}`;
      h.append(title);
      const note = document.createElement('span'); note.className = 'sec-note';
      note.textContent = p ? (p.focus ? `#${t} · leads the briefs` : `#${t}`) : 'no project file';
      h.append(note);
      if (p) {
        const ed = document.createElement('button');
        ed.type = 'button'; ed.className = 'sec-action proj-edit'; ed.textContent = 'edit';
        ed.onclick = () => openProj('edit:' + t);
        h.append(ed);
      }
      list.appendChild(h);
      if (!rs.length) {
        const e = document.createElement('div'); e.className = 'mut proj-empty'; e.textContent = 'nothing open';
        list.appendChild(e);
      }
      for (const o of rs) list.appendChild(row(o));
    }
    if (!order.length) {
      const e = document.createElement('div'); e.className = 'empty';
      e.textContent = 'No projects yet — + new project starts one.';
      list.appendChild(e);
    }
    if (loose && !tag) {
      const f = document.createElement('button');
      f.type = 'button'; f.className = 'proj-loose';
      f.textContent = `${loose} on no project — hidden here; open them on the map`;
      f.onclick = () => { filter = 'map'; tag = NONE; selected = null; try { localStorage.setItem('obligations.filter', filter); } catch {} remember(); render(); };
      list.appendChild(f);
    }
  }

  /** The lanes as chips, with what each holds, and Start for the one shown. */
  function laneBar(all, shown) {
    const bar = document.createElement('div');
    bar.className = 'lanebar';
    const chips = document.createElement('div');
    chips.className = 'lane-chips';
    const count = (l) => all.filter((o) => !isLoose(o) && o.lane === l).length;
    const chip = (key, label, n) => {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'lane-chip';
      c.setAttribute('aria-pressed', String(lane === key));
      c.textContent = label; const b = document.createElement('b'); b.textContent = n ? String(n) : ''; c.append(' ', b);
      c.onclick = () => { lane = key; remember(); render(); };
      return c;
    };
    chips.append(chip('', 'All', all.filter((o) => !isLoose(o)).length));
    for (const l of LANE_ORDER) { const n = count(l); if (n) chips.append(chip(l, LANE_LABEL[l], n)); }
    bar.append(chips);
    const startable = shown.filter((o) => !isLoose(o));
    if (lane && startable.length) {
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'lane-start';
      go.textContent = startable.length === 1 ? 'Work through it' : `Work through these ${startable.length}`;
      go.onclick = () => startSession(startable);
      bar.append(go);
      if (['reply', 'decide', 'pay'].includes(lane)) {
        const hint = document.createElement('div');
        hint.className = 'lane-hint';
        hint.textContent = { reply: 'Each reply is drafted as you go', decide: 'Each decision is set out as you go', pay: 'Each bill is set out as you go' }[lane]
          + ' — one model call a task, at most 20.';
        bar.append(hint);
      }
    }
    return bar;
  }

  /** Where this task sits in today's order, why, and the moves he can make. */
  function rankBlock(o) {
    if (!rankDoc) return null;
    const r = ranks.get(o.id);
    const sug = (rankDoc.suggest ?? []).find((x) => x.id === o.id);
    const box = document.createElement('div');
    box.className = 'rank-block';
    const line = document.createElement('div');
    line.className = 'rank-line';
    line.textContent = r ? `Today's #${r.n}${r.why ? ' — ' + r.why : ''}` : `Not in today's top ${TOP()}`;
    box.append(line);
    if (sug) {
      const s = document.createElement('div');
      s.className = 'rank-suggest mut';
      s.textContent = `Suggested: flag it ${sug.to} — ${sug.why}`;
      box.append(s);
    }
    const acts = document.createElement('div');
    acts.className = 'rank-acts';
    const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'rank-btn'; b.textContent = label; b.onclick = async () => { b.disabled = true; try { await fn(); } catch (err) { line.textContent = 'could not save: ' + (err?.message ?? err); } finally { b.disabled = false; } }; return b; };
    const ids = rankIds();
    if (r) {
      const i = ids.indexOf(o.id);
      if (i > 0) acts.append(mk('↑ up', () => { const x = ids.slice(); [x[i - 1], x[i]] = [x[i], x[i - 1]]; return saveRank(x, o.id); }));
      if (i < ids.length - 1) acts.append(mk('↓ down', () => { const x = ids.slice(); [x[i + 1], x[i]] = [x[i], x[i + 1]]; return saveRank(x, o.id); }));
      if (i > 0) acts.append(mk('to the top', () => saveRank([o.id, ...ids.filter((x) => x !== o.id)], o.id)));
      acts.append(mk(`out of the ${TOP()}`, () => saveRank(ids.filter((x) => x !== o.id), o.id)));
    } else {
      acts.append(mk(`put in today's ${TOP()}`, () => saveRank([...ids.slice(0, TOP() - 1), o.id], o.id)));
    }
    box.append(acts);
    return box;
  }

  function startSession(rows) {
    session = { lane, queue: rows.map((o) => o.id), at: 0, done: 0, later: 0, skipped: 0, prep: {}, plan: null };
    select(session.queue[0]);
    prepareSession(session, rows);
  }

  /* READIED AS HE GOES. Alex, 2026-10-03: "Ok do pre drafting next." The
     server reads each task once with the model, in his order, while he is on
     the first (prepare.mjs): a reply's words go into the reply box under the
     thread, a decision or a bill gets a note under the title. Nothing is
     saved or sent by this — the box is his to edit, and Save or Send is his
     tap. A reply that already has a draft waiting is not readied again. */
  async function prepareSession(s, rows) {
    const ids = rows.filter((o) => !(o.lane === 'reply' && draftsFor(o.id).length)).map((o) => o.id);
    try {
      const r = await fetch('/api/obligations/prepare', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      s.plan = d;
      for (const id of d.queued ?? []) s.prep[id] = { state: 'queued' };
      for (const x of d.skipped ?? []) s.prep[x.id] = { state: 'skipped', why: x.why };
      for (const id of d.over ?? []) s.prep[id] = { state: 'over' };
    } catch (e) {
      s.plan = { error: String(e?.message ?? e) };
      for (const id of ids) s.prep[id] = { state: 'failed', why: s.plan.error };
      return refreshPrep();
    }
    const watch = [...(s.plan.queued ?? []), ...(s.plan.ready ?? [])];
    while (session === s && watch.length) {
      try {
        const d = await (await fetch('/api/obligations/prepared?ids=' + encodeURIComponent(watch.join(',')))).json();
        for (const id of watch) if (d.items?.[id]) s.prep[id] = d.items[id];
      } catch { /* the next look will do */ }
      refreshPrep();
      if (!watch.some((id) => ['queued', 'working'].includes(s.prep[id]?.state))) break;
      await new Promise((res) => setTimeout(res, 4000));
    }
  }

  /** The note under the title for the task the session is on, or null. */
  function prepCard(o) {
    const e = session?.prep?.[o.id];
    if (!e) return null;
    const card = document.createElement('div');
    card.className = 'prepcard';
    card.dataset.key = `${o.id}|${e.state}|${e.at ?? ''}`;
    const head = document.createElement('div');
    head.className = 'prep-head';
    card.append(head);
    if (e.state === 'queued' || e.state === 'working') { card.classList.add('pending'); head.textContent = 'Readying this one…'; return card; }
    if (e.state === 'over') { head.textContent = 'Not readied — past this session’s limit. Start the lane again after these to ready the rest.'; return card; }
    if (e.state !== 'ready') { card.classList.add('quiet'); head.textContent = (e.state === 'skipped' ? 'Nothing readied — ' : 'Could not ready this one — ') + (e.why ?? 'no reason given'); return card; }
    const label = { reply: 'Reply readied', decide: 'The decision, set out', pay: 'What paying it takes' }[e.kind] ?? 'Readied';
    head.textContent = `${label} · ${String(e.at ?? '').slice(11)} · from ${e.read} message${e.read === 1 ? '' : 's'}`;
    const body = document.createElement('div');
    if (e.kind === 'reply') { body.className = 'prep-note'; body.textContent = 'In the reply box below — read it, edit it, then save or send.'; }
    else { body.className = 'prep-text'; body.textContent = e.text; }
    card.append(body);
    return card;
  }

  /* Into the reply box, once it exists (a text thread's box is drawn after
     the thread loads) and only while it is empty — words he has started are
     never replaced. No box on this task: the words go in the note instead. */
  function fillReply(o, e, card) {
    let tries = 0;
    const go = () => {
      if (!session || session.queue[session.at] !== o.id) return;
      const ta = pane.querySelector('.replybox textarea');
      if (!ta) {
        if (++tries < 24) return void setTimeout(go, 250);
        const note = card?.querySelector('.prep-note');
        if (note) { note.className = 'prep-text'; note.textContent = e.text; }
        return;
      }
      if (ta.value.trim() || ta.dataset.prepared === o.id) return;
      ta.value = e.text;
      ta.dataset.prepared = o.id;
      ta.rows = Math.min(14, Math.max(3, e.text.split('\n').length + 1));
    };
    go();
  }

  /** The poll's answer, onto the pane — the note only, never the whole pane, so nothing he typed is lost. */
  function refreshPrep() {
    if (!session) return;
    const o = items.find((i) => i.id === session.queue[session.at]);
    if (!o) return;
    const old = pane.querySelector('.prepcard');
    const card = prepCard(o);
    if (old && card && old.dataset.key === card.dataset.key) return;
    if (old) old.remove();
    if (!card) return;
    pane.querySelector('.pane-head')?.after(card);
    const e = session.prep[o.id];
    if (e.state === 'ready' && e.kind === 'reply') fillReply(o, e, card);
  }

  /** The next task still open, or the summary when the lane is through. */
  function advance() {
    if (!session) return;
    do { session.at++; } while (session.at < session.queue.length && !items.some((o) => o.id === session.queue[session.at]));
    if (session.at >= session.queue.length) { selected = null; render(); return showSummary(); }
    select(session.queue[session.at]);
  }

  async function sessionAct(kind, o) {
    if (kind === 'skip') { session.skipped++; return advance(); }
    const url = kind === 'done' ? '/api/obligations/close' : '/api/obligations/snooze';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: o.id }) });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
    } catch (e) {
      const t = pane.querySelector('.session-msg'); if (t) t.textContent = 'could not save: ' + (e?.message ?? e);
      return;
    }
    session[kind === 'done' ? 'done' : 'later']++;
    items = items.filter((i) => i.id !== o.id);
    advance();
  }

  /** At the top of the pane while a session runs: where he is, and the four moves. */
  function sessionBar(o) {
    const bar = document.createElement('div');
    bar.className = 'sessionbar';
    const where = document.createElement('div');
    where.className = 'session-where';
    where.textContent = `${LANE_LABEL[session.lane] ?? 'Session'} · ${session.at + 1} of ${session.queue.length}`;
    const acts = document.createElement('div');
    acts.className = 'session-acts';
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'session-btn ' + cls; b.textContent = label; b.onclick = fn; return b; };
    acts.append(
      btn('Done ✓', 'done', () => sessionAct('done', o)),
      btn('Later', 'later', () => sessionAct('later', o)),
      btn('Skip', 'skip', () => sessionAct('skip', o)),
      btn('End', 'end', () => { const s = session; session = null; selected = null; render(); showSummary(s); }),
    );
    const msg = document.createElement('div'); msg.className = 'session-msg';
    bar.append(where, acts, msg);
    return bar;
  }

  function showSummary(s = session) {
    if (!s) return;
    session = null;
    pane.textContent = '';
    const box = document.createElement('div');
    box.className = 'pane-inner session-summary';
    const h = document.createElement('h2'); h.className = 'pane-title';
    h.textContent = `${LANE_LABEL[s.lane] ?? 'Session'} — ${s.at >= s.queue.length ? 'all through' : 'ended'}`;
    const p = document.createElement('p');
    p.textContent = [`${s.done} done`, `${s.later} for later`, `${s.skipped} skipped`].join(' · ');
    const preps = Object.values(s.prep ?? {});
    const readied = preps.filter((e) => e.state === 'ready').length;
    const missed = preps.filter((e) => ['failed', 'over'].includes(e.state)).length;
    const r = document.createElement('p'); r.className = 'mut';
    if (readied || missed) r.textContent = `${readied} readied by the assistant` + (missed ? ` · ${missed} could not be` : '');
    const back = document.createElement('button'); back.type = 'button'; back.className = 'lane-start';
    back.textContent = 'Back to the list';
    back.onclick = () => { if (split) split.classList.remove('showing'); render(); };
    box.append(h, p, ...(r.textContent ? [r] : []), back);
    pane.append(box);
    if (split) split.classList.add('showing');
  }

  // Swipe left to complete: the direction that dismisses a thing on iOS, and
  // the direction that does not fight the system's back-swipe from the left
  // edge. Horizontal intent only — a vertical drag has to stay a page scroll,
  // or the list becomes impossible to scroll past.
  /* SAY WHAT THE SWIPE WILL DO, WHILE IT IS HAPPENING. Alex, 2026-10-03:
     "when you swipe away a to do, make it clear during the swipe that you are
     marking as done." The reveal was a small "done ✓" on a fixed green strip,
     and crossing the threshold only recoloured the card's border — easy to
     miss under a thumb. Now "Mark done" fades in with the distance travelled
     (--p, 0 to 1), and past the threshold the strip turns bright green and
     the words gain their tick — letting go now marks it done; under the
     threshold it springs back. The words are short on purpose: at the
     threshold the card has opened 90px, and "Release to mark done" was cut
     off by the card it was explaining. */
  const SWIPE_AT = 90;
  const SWIPE_SLOP = 10;    // px of travel before a touch counts as a swipe or a scroll
  function swipeable(el, inner, o) {
    let x0 = null, y0 = null, dx = 0, horizontal = null;
    el.dataset.swipe = 'Mark done';
    const settle = () => {
      el.classList.remove('armed', 'swiping');
      el.style.removeProperty('--p');
      el.dataset.swipe = 'Mark done';
    };
    el.addEventListener('touchstart', (e) => {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null;
      inner.style.transition = 'none';
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (x0 == null) return;
      const ax = e.touches[0].clientX - x0;
      const ay = e.touches[0].clientY - y0;
      /* SWIPE OR SCROLL — DECIDED ONCE THE FINGER HAS SAID WHICH. Alex,
         2026-10-03: "Sometimes I can't start the swipe." The decision was
         taken on the very first touchmove, and needed sideways to beat
         vertical by more than 4px. A phone reports the first move after a
         pixel or two, so a perfectly sideways start of 3px was filed as a
         scroll and the card ignored the rest of the drag — measured: a 3px,
         a 4px and a 2px start then dragged 120px left all did nothing; a
         6px start worked. Whether it worked depended on how fast the thumb
         was moving when the phone first spoke. Now nothing is decided until
         the finger has moved SLOP pixels; then the dominant direction wins.
         Below it the gesture is neither, so nothing is locked in by a
         twitch. */
      if (horizontal === null) {
        if (Math.hypot(ax, ay) < SWIPE_SLOP) return;
        horizontal = Math.abs(ax) > Math.abs(ay);
      }
      if (!horizontal) return;
      dx = Math.max(0, -ax);                      // leftward only
      inner.style.transform = `translateX(${-dx}px)`;
      const armed = dx > SWIPE_AT;
      el.classList.add('swiping');
      el.style.setProperty('--p', Math.min(1, dx / SWIPE_AT).toFixed(2));
      if (armed !== el.classList.contains('armed')) {
        el.classList.toggle('armed', armed);
        el.dataset.swipe = armed ? 'Mark done ✓' : 'Mark done';
      }
    }, { passive: true });
    const end = (commit) => {
      inner.style.transition = '';
      inner.style.transform = '';
      settle();
      if (commit) close(o.id, el);
      x0 = null;
    };
    el.addEventListener('touchend', () => end(horizontal && dx > SWIPE_AT));
    // The system took the touch (a call, a notification pulled down): never a
    // done — only letting go does that.
    el.addEventListener('touchcancel', () => end(false));
    return el;

  }

  /* The back gesture closes an open task. Registered here rather than at the
     top of the file because `selected` and render() are scoped to this block —
     a handler outside it silently referenced nothing. */
  onStateChange('pane', (id) => { selected = id; render(); });
  const workdock = document.getElementById('workdock');
  if (workdock) workdock.append(composer({ placeholder: 'Tell the assistant about a task…',
    context: () => ({ page: 'work', filter, open: selected ? items.find((i) => i.id === selected)?.title ?? selected : null }) }));

  /* THE MAP. Alex, 2026-09-30: "I love mind maps … projects … show up as
     different circles. The circle gets bigger the more tasks you have inside
     a project. When you click on the circle, it shows all the tasks
     associated with it." And an invoice on ONE belongs to both: "when I sit
     down to pay bills, I'll have them all right there. But I also want to see
     that when I'm working on the 'one' project." So a task sits in every
     circle it belongs to, and a line joins circles that share tasks. What
     belongs nowhere is a circle too — see web/taskmap.mjs for why it is shown
     rather than left out. */
  const KIND_LABEL = { invoice: 'bills to pay', decision: 'decisions', birthday: 'birthdays' };
  // Nowhere: no project and no kind — the same test drawMap sizes the circle by.
  // A loose draft is not a task (see isLoose); the circle does not count it, so its list does not show it.
  const inNone = (o) => !isLoose(o) && !projectsOf(o).length && !(o.tags ?? []).some((t) => KIND_LABEL[t]);
  /* SUB-PROJECTS. Alex, 2026-09-30: "projects can also have sub projects,
     and those sub projects can have tasks." A sub-project is its own circle,
     joined to its parent by a branch; the parent's circle and list hold its
     own tasks and its sub-projects' too, since that is what "working on ONE"
     means. */
  const childrenOf = (t) => projects.filter((p) => p.parent === t).map((p) => p.tag);
  const inCircle = (o, key) => key === NONE ? inNone(o)
    : [key, ...childrenOf(key)].some((t) => (o.tags ?? []).includes(t));
  function circleLabel(key) {
    if (key === NONE) return 'no project';
    if (KIND_LABEL[key]) return KIND_LABEL[key];
    const p = projects.find((x) => x.tag === key);
    return p?.title || p?.name || '#' + key;
  }
  function drawMap(into) {
    into.textContent = '';
    const count = new Map(), over = new Map(), members = new Map();
    const add = (k, o) => {
      count.set(k, (count.get(k) ?? 0) + 1);
      if (o.overdue) over.set(k, (over.get(k) ?? 0) + 1);
      if (!members.has(k)) members.set(k, new Set());
      members.get(k).add(o.id);
    };
    for (const o of items) {
      if (isLoose(o) || notYet(o)) continue;
      const own = [...projectsOf(o), ...(o.tags ?? []).filter((t) => KIND_LABEL[t])];
      // A sub-project's task is in its parent's circle too, counted once.
      const parents = own.map((t) => projects.find((p) => p.tag === t)?.parent).filter(Boolean);
      const keys = [...new Set([...own, ...parents])];
      if (!keys.length) add(NONE, o);
      for (const k of keys) add(k, o);
    }
    /* A project with nothing open is still a circle — the one he just added
       by right-clicking has no tasks yet, and a circle that vanished the
       moment it was made would read as the add having failed. */
    for (const p of projects) if (p.tag && !count.has(p.tag) && (p.status ?? 'active') !== 'done') count.set(p.tag, 0);
    const circles = [...count].map(([key, n]) => {
      const p = projects.find((x) => x.tag === key);
      return { key, n, label: circleLabel(key), overdue: over.get(key) ?? 0, focus: p?.focus ?? null,
               kind: key === NONE ? 'none' : KIND_LABEL[key] ? 'kind' : p?.parent ? 'sub' : 'project', parent: p?.parent ?? null };
    });
    const keys = [...members.keys()].filter((k) => k !== NONE);
    const links = [];
    const family = (a, b) => projects.some((p) => (p.tag === a && p.parent === b) || (p.tag === b && p.parent === a));
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      if (family(keys[i], keys[j])) continue;   // a branch, below — not "shared tasks"
      let n = 0; for (const id of members.get(keys[i])) if (members.get(keys[j]).has(id)) n++;
      if (n) links.push({ a: keys[i], b: keys[j], n });
    }
    for (const c of circles) if (c.parent && count.has(c.parent)) links.push({ a: c.parent, b: c.key, branch: true });
    const bar = document.createElement('div');
    bar.className = 'map-bar';
    const note = document.createElement('p');
    note.className = 'map-note mut';
    note.textContent = 'Bigger circle, more open tasks. A solid branch is a sub-project; a dotted line, tasks two circles share. Tap a circle to list it, drag circles anywhere, drag a task onto one to move it. Right-click empty space for a project, a project for a sub-project.';
    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'sec-action'; addBtn.textContent = '+ project';
    const tidy = document.createElement('button');
    tidy.type = 'button'; tidy.className = 'sec-action'; tidy.textContent = 'Tidy';
    tidy.title = 'Forget where the circles were dragged and pack them again';
    bar.append(note, addBtn, tidy);
    const host = document.createElement('div');
    host.className = 'map-host';
    into.append(bar, host);

    const save = (body) => fetch('/api/todo/map-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json()).then((d) => { if (d.ok) mapLayout = d.positions ?? {}; return d; });
    tidy.onclick = async () => { await save({ reset: true }).catch(() => {}); drawMap(into); };
    addBtn.onclick = () => askNewProject(host, null, null, host.getBoundingClientRect().left + 40, host.getBoundingClientRect().top + 20);
    const draw = () => taskMap(host, circles, links, {
      positions: mapLayout,
      picked: tag || null,
      // Tapping the picked circle again lets go of it — the list's way back to the whole map.
      onPick: (k) => { tag = tag === k ? '' : k; if (tagsel) tagsel.value = tag; selected = null; remember(); render(); },
      onDropTask: (k, id) => assignTo(k, id),
      onBlank: () => { if (tag) { tag = ''; if (tagsel) tagsel.value = ''; remember(); render(); } },
      onAddChild: (k, x, y, cx, cy) => askNewProject(host, x, y, cx, cy, k),
      onMove: (k, x, y) => { save({ key: k, x, y }).catch(() => {}); },
      onAdd: (x, y, cx, cy) => askNewProject(host, x, y, cx, cy),
    });
    if (mapLayout === null) fetch('/api/todo/map-layout').then((r) => r.json()).then((d) => { mapLayout = d.positions ?? {}; draw(); }).catch(() => { mapLayout = {}; draw(); });
    else draw();
  }

  /* A new project from the map. Alex, 2026-09-30: "You can right click to
     add a new circle (project)." The same door as + project on Projects —
     one name, the file is written from it — and the circle lands where he
     clicked. A button does the same on a phone, which has no right-click. */
  function askNewProject(host, x, y, cx, cy, parent = null) {
    host.querySelector('.map-add')?.remove();
    const f = document.createElement('form');
    f.className = 'map-add';
    const r = host.getBoundingClientRect();
    f.style.left = `${Math.max(0, Math.min(cx - r.left, r.width - 260))}px`;
    f.style.top = `${Math.max(0, cy - r.top)}px`;
    const inp = document.createElement('input');
    const under = parent ? circleLabel(parent) : null;
    inp.placeholder = under ? `New sub-project of ${under}` : 'New project name';
    inp.setAttribute('aria-label', inp.placeholder); inp.maxLength = 80;
    const go = document.createElement('button'); go.type = 'submit'; go.textContent = 'Add';
    const no = document.createElement('button'); no.type = 'button'; no.className = 'ghost'; no.textContent = 'Cancel';
    const msg = document.createElement('div'); msg.className = 'mut map-add-msg';
    f.append(inp, go, no, msg);
    no.onclick = () => f.remove();
    inp.onkeydown = (e) => { if (e.key === 'Escape') f.remove(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const name = inp.value.trim();
      if (!name) return;
      go.disabled = true; msg.textContent = 'adding…';
      try {
        const d = await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ...(parent ? { parent } : {}) }) })).json();
        if (!d.ok) throw new Error(d.error ?? 'refused');
        if (x != null && y != null) {
          const s2 = await (await fetch('/api/todo/map-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: d.tag, x, y }) })).json();
          if (s2.ok) mapLayout = s2.positions ?? mapLayout;
        }
        projects = (await (await fetch('/api/projects')).json()).projects ?? projects;
        f.remove();
        render();
      } catch (err) { msg.textContent = 'not added: ' + (err?.message ?? err); go.disabled = false; }
    };
    host.append(f);
    inp.focus();
  }

  /* DROP A TASK ON A CIRCLE. Alex, 2026-09-30: "You can also drag a task
     from the list and onto a circle to assign/re-assign." A project circle
     REPLACES the task's project (kinds stay: a bill moved to ONE is still a
     bill); a kind circle ADDS its kind; the no-project circle takes the
     project off. It writes his tags through the same door the tag editor
     uses, so the item is his from then on and nothing re-assigns it. A
     todo.md #project is owned by the file and stays. */
  async function assignTo(key, id) {
    const o = items.find((x) => x.id === id);
    if (!o) return;
    const fromTodo = new Set((o.evidence ?? []).flatMap((e) => e.source === 'todo' && e.project ? [e.project] : []));
    const kinds = (o.tags ?? []).filter((t) => KIND_LABEL[t]);
    const next = key === NONE ? kinds
      : KIND_LABEL[key] ? [...(o.tags ?? []), key]
      : [...kinds, key];
    const tags = [...new Set([...next, ...fromTodo])].sort();
    const prev = o.tags;
    o.tags = tags;
    render();
    try {
      const r = await fetch('/api/obligations/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: o.id, tags: tags.filter((t) => !fromTodo.has(t)) }) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error ?? r.status);
      o.tags = [...new Set([...(d.tags ?? tags), ...fromTodo])].sort();
      fillTagSelect();
      render();
    } catch (err) {
      o.tags = prev;
      render();
      alert('Could not move it: ' + (err?.message ?? err));
    }
  }
  // From the Projects tab's "on no project" row: open that circle, in place.
  document.addEventListener('todo:open', (e) => {
    filter = e.detail?.filter ?? filter; tag = e.detail?.tag ?? ''; selected = null;
    try { localStorage.setItem('obligations.filter', filter); } catch {}
    remember(); render();
  });

  /* ONE WAY TO ADD A TO-DO. A blank card at the top of the list, written
     straight into todo.md through /api/todo — his file, his grammar; the
     source module formats the line, so a task typed here and one typed in the
     file are the same thing. Filed under the project being looked at (a
     picked circle, or the project filter), which is the reason to add from
     here rather than from the file. Alex, 2026-10-04: "combine the new
     to-do and the new task … put them in the left-hand sidebar" — the + Task
     form at the top of the page had the project and section pickers, the
     map's card had the place; this is both. */
  function newTodoCard(listEl, after) {
    if (listEl.querySelector('.ob-new')) { listEl.querySelector('.ob-new textarea')?.focus(); return; }
    const card = document.createElement('form');
    card.className = 'ob ob-new';
    const picked = tag && tag !== NONE && !KIND_LABEL[tag] ? tag : '';
    const ta = document.createElement('textarea');
    ta.rows = 2; ta.placeholder = picked ? `New to-do for ${circleLabel(picked)}…` : 'New to-do…';
    ta.setAttribute('aria-label', 'New to-do');
    const row2 = document.createElement('div'); row2.className = 'ob-new-row';
    const proj = document.createElement('select'); proj.setAttribute('aria-label', 'Project');
    const none = document.createElement('option'); none.value = ''; none.textContent = 'no project';
    proj.append(none);
    const known = new Map(projects.filter((p) => p.tag).map((p) => [p.tag, p.title || p.name || '']));
    for (const o of items) for (const t of projectsOf(o)) if (!known.has(t)) known.set(t, '');
    for (const [t, name] of [...known].sort((a, b) => (a[1] || a[0]).localeCompare(b[1] || b[0]))) {
      const op = document.createElement('option'); op.value = t; op.textContent = name || '#' + t; proj.append(op);
    }
    proj.value = picked;
    const due = document.createElement('input'); due.type = 'date'; due.setAttribute('aria-label', 'Due date');
    const sec = document.createElement('select'); sec.setAttribute('aria-label', 'Section');
    for (const [v, l] of [['Now', 'now'], ['Next', 'next'], ['Someday', 'someday']]) {
      const op = document.createElement('option'); op.value = v; op.textContent = l; sec.append(op);
    }
    const go = document.createElement('button'); go.type = 'submit'; go.textContent = 'Add';
    const no = document.createElement('button'); no.type = 'button'; no.className = 'ghost'; no.textContent = 'Cancel';
    const msg = document.createElement('span'); msg.className = 'mut ob-new-msg';
    row2.append(proj, due, sec, go, no, msg);
    card.append(ta, row2);
    no.onclick = () => card.remove();
    ta.onkeydown = (e) => { if (e.key === 'Escape') card.remove(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) card.requestSubmit(); };
    card.onsubmit = async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      go.disabled = true; msg.textContent = 'adding…';
      try {
        const r = await fetch('/api/todo', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, tag: proj.value || null, due: due.value || null, section: sec.value }) });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error ?? r.status);
        // Re-read rather than inventing the row: the merge decides its id, its
        // lane and — when no project was picked — which project claims it.
        const fresh = await (await fetch('/api/obligations')).json();
        items = fresh.items ?? items;
        fillTagSelect();
        if (d.id && items.some((o) => o.id === d.id)) selected = d.id;
        render();
      } catch (err) { msg.textContent = 'not added: ' + (err?.message ?? err); go.disabled = false; }
    };
    after.after(card);
    ta.focus();
  }

  function render() {
    // The closed view is fetched on first use, and painted when it lands.
    if (filter === 'closed' && closedItems === null) {
      loadClosed().then(render);
      list.textContent = '';
      const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'loading…'; list.appendChild(e);
      return;
    }
    // Counts on every chip, whatever is selected: the numbers you compare are
    // the point of showing them.
    for (const [name, b] of Object.entries(BUCKETS)) {
      const n = name === 'closed' ? (closedItems ? closedItems.length : 0)
        : name === 'projects'
        ? items.filter((o) => inBucket(name, o) && projectsOf(o).length).length
        // What waits for his Send is DRAFTS, not tasks: two replies on one
        // task is two taps. That is the number the nav pill carries too.
        : name === 'drafted'
        ? items.filter((o) => inBucket(name, o)).reduce((t, o) => t + (isLoose(o) ? 1 : draftsFor(o.id).length), 0)
        : items.filter((o) => inBucket(name, o)).length;
      const c = document.getElementById('n-' + name);
      if (c) c.textContent = n ? String(n) : '';
      if (name === 'projects' && c) c.title = `${n} open on a project`;
    }
    for (const btn of filt ? filt.querySelectorAll('button') : []) {
      btn.setAttribute('aria-selected', String(btn.dataset.f === filter));
    }

    // The project filter belongs to By project and shows nowhere else.
    if (tagsel) tagsel.hidden = filter !== 'projects';

    /* THE MAP KEEPS THE SIDEBAR. Alex, 2026-09-30: "in map mode, lets keep
       the sidebar column. When you click on a project, the tasks there should
       be filterd to that project." So the list stays on the left — a circle's
       tasks once one is picked — and the map is drawn where the task pane
       sits. Opening a task puts its pane there instead, with the way back. */
    const onMap = filter === 'map';

    const b = BUCKETS[filter] ?? BUCKETS.today;
    // A tag, when chosen, replaces the bucket: every item carrying it, whatever
    // its date or direction, oldest first by age.
    const pool = filter === 'closed' ? (closedItems ?? []) : items;
    const onMine = filter === 'today' && !tag && !onMap;
    const mineAll = onMine ? b.sort(pool.filter((o) => inBucket(filter, o))) : [];
    const rows = tag
      // On the map the far-off wait (notYet); the tags menu still means every item with the tag.
      ? bySort(items.filter((o) => inCircle(o, tag) && !(onMap && notYet(o))))
      : onMap ? []
      : onMine ? (lane ? mineAll.filter((o) => o.lane === lane) : mineAll)
      : b.sort(pool.filter((o) => inBucket(filter, o)));
    for (const btn of filt ? filt.querySelectorAll('button') : []) {
      btn.setAttribute('aria-selected', String(btn.dataset.f === filter));
    }
    for (const btn of sortbar ? sortbar.querySelectorAll('button[data-s]') : []) {
      btn.setAttribute('aria-selected', String(btn.dataset.s === sort));
    }
    // Under the priority sort, where today's order came from, and his way to ask again.
    if (sortbar) {
      let note = sortbar.querySelector('.rank-note');
      if (sort === 'priority' && rankDoc) {
        if (!note) { note = document.createElement('span'); note.className = 'rank-note'; sortbar.append(note); }
        note.textContent = '';
        const t = document.createElement('span'); t.className = 'mut';
        t.textContent = rankDoc.stale ? 'not ranked yet today' : `today's ${TOP()}${rankDoc.his ? ', your order' : ''} · ranked ${String(rankDoc.ranked_at ?? '').slice(11)}`;
        const again = document.createElement('button'); again.type = 'button'; again.className = 'rank-again'; again.textContent = 're-rank';
        again.onclick = async () => {
          again.disabled = true;
          try {
            const r = await fetch('/api/rank/run', { method: 'POST' });
            const d = await r.json();
            if (!r.ok || d.error) throw new Error(d.error ?? r.status);
            watchRank();
          } catch (err) { again.textContent = 'could not: ' + (err?.message ?? err); again.disabled = false; }
        };
        note.append(t, again);
        if (rankWatching) { again.disabled = true; again.textContent = rankWatching; }
      } else if (note) note.remove();
    }
    list.textContent = '';
    let head = null;
    if (!onMap && filter !== 'closed') {
      head = document.createElement('div');
      head.className = 'list-new';
      const nb = document.createElement('button');
      nb.type = 'button'; nb.className = 'sec-action map-new'; nb.textContent = '+ new To Do';
      nb.onclick = () => newTodoCard(list, head);
      head.append(nb);
      list.appendChild(head);
    }
    if (onMine) list.appendChild(laneBar(mineAll, rows));
    /* On the map: which circle the list shows, and a new to-do. Alex,
       2026-09-30: "Remove the <map navigations. instead add a +new To Do
       button, and when you click on it you get a blank entry in the left
       column, styled like a card, but you can enter a manual to-do." The way
       back to the whole map is tapping the picked circle again, or empty map. */
    if (onMap) {
      const crumb = document.createElement('div');
      crumb.className = 'map-crumb';
      const what = document.createElement(tag ? 'b' : 'span');
      what.textContent = tag ? `${circleLabel(tag)} · ${rows.length}` : 'Tap a circle to list its tasks here.';
      if (!tag) what.className = 'mut';
      const nb = document.createElement('button');
      nb.type = 'button'; nb.className = 'sec-action map-new'; nb.textContent = '+ new To Do';
      nb.onclick = () => newTodoCard(list, crumb);
      crumb.append(what, nb);
      list.appendChild(crumb);
    }
    if (filter === 'projects' && !onMap) {
      drawByProject(rows, head);
    } else if (!rows.length) {
      if (!(onMap && !tag)) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = onMap ? 'Nothing open here.' : b.empty;
        list.appendChild(e);
      }
    } else if (!tag && filter === 'today') {
      /* ONE LIST, IN THE CHOSEN ORDER. Alex, 2026-10-03: four sorts, and
         "one list for every sort" — so the four sections (due today, no date
         but high, upcoming, no date) are gone; a HIGH tag and a date on each
         row still say what the sections did. What stays folded is a due date
         more than 90 days out: Alex, 2026-09-06, of a birthday next August
         under upcoming — "not sure how useful that is in that view." */
      const soon = rows.filter((o) => !o.due || (o.lead_days ?? 0) <= 90);
      const later = rows.filter((o) => o.due && (o.lead_days ?? 0) > 90);
      for (const o of soon) list.appendChild(row(o));
      if (later.length) {
        const h = document.createElement('div'); h.className = 'sec-head later-head';
        const t = document.createElement('span'); t.className = 'sec-title'; t.textContent = `later · ${later.length}`;
        const bt = document.createElement('button'); bt.type = 'button'; bt.className = 'sec-action'; bt.textContent = 'show';
        h.append(t, bt);
        const box = document.createElement('div'); box.className = 'later-box'; box.hidden = true;
        for (const o of later) box.appendChild(row(o));
        bt.onclick = () => { box.hidden = !box.hidden; bt.textContent = box.hidden ? 'show' : 'hide'; };
        list.append(h, box);
      }
    } else {
      for (const o of rows) list.appendChild(row(o));
    }

    const current = items.find((o) => o.id === selected) ?? (closedItems ?? []).find((o) => o.id === selected);
    // On a phone one column shows at a time: the map until a circle is picked,
    // then the circle's list, then a task.
    const onProjPane = !current && !!projPane && filter === 'projects';
    if (split) split.classList.toggle('showing', !!current || (onMap && !tag) || onProjPane);
    // The open task is a history entry, so the back swipe closes it rather than
    // leaving the page. See histate.mjs.
    if (current) openState('pane', current.id);
    if (current) {
      showPane(current);
      if (onMap) {
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'crumb map-back'; back.textContent = '‹ map';
        back.onclick = () => { if (!closeState('pane')) { selected = null; render(); } };
        pane.prepend(back);
      }
    } else if (onMap) {
      delete pane.dataset.proj;
      drawMap(pane);
    } else if (onProjPane) {
      drawProjPane();
    } else {
      delete pane.dataset.proj;
      pane.textContent = '';
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = rows.length ? 'Select a task.' : '';
      pane.appendChild(e);
    }
  }

  for (const btn of filt ? filt.querySelectorAll('button') : []) {
    btn.onclick = () => {
      if (!btn.dataset.f) return;
      filter = btn.dataset.f;
      tag = '';
      if (tagsel) tagsel.value = '';
      selected = null;
      try { localStorage.setItem('obligations.filter', filter); } catch {}
      remember();
      render();
    };
  }
  for (const btn of sortbar ? sortbar.querySelectorAll('button[data-s]') : []) {
    btn.onclick = () => {
      if (!btn.dataset.s) return;
      sort = btn.dataset.s;
      try { localStorage.setItem(SORT_KEY, sort); } catch {}
      remember();
      render();
    };
  }

  /** The project filter on the Projects tab: every project with a tag, by
      name, with its open count — a sub-project's tasks count to its parent
      too, as on the map. Picking one lists its tasks; "all projects" is the
      project list again. */
  function fillTagSelect() {
    if (!tagsel) return;
    const current = tag;
    const named = projects.filter((p) => p.tag)
      .map((p) => ({ tag: p.tag, label: p.title || p.name || '#' + p.tag, n: items.filter((o) => inCircle(o, p.tag)).length }))
      .sort((a, b) => a.label.localeCompare(b.label));
    tagsel.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = named.length ? 'all projects' : 'no projects yet';
    tagsel.appendChild(none);
    for (const p of named) {
      const op = document.createElement('option');
      op.value = p.tag;
      op.textContent = `${p.label} · ${p.n}`;
      tagsel.appendChild(op);
    }
    const known = named.some((p) => p.tag === current);
    tagsel.value = known ? current : '';
    if (!known && current !== NONE && !KIND_LABEL[current] && filter === 'projects') tag = '';
  }
  if (tagsel) {
    tagsel.onchange = () => {
      tag = tagsel.value || '';
      selected = null;
      remember();
      render();
    };
  }

  fetch('/api/projects').then((r) => r.json()).then((d) => {
    projects = d.projects ?? [];
    fillTagSelect();
    fillTagSelect();
    if (filter === 'projects') render();
  }).catch(() => {});

  remember();
  fetch('/api/obligations').then((r) => r.json()).then(async (d) => {
    items = d.items ?? [];
    await loadRank();
    // A ranking already under way (06:45, or a tap on another device): follow it.
    fetch('/api/rank/progress').then((r) => r.json()).then((p) => { if (p?.state === 'running') watchRank(); }).catch(() => {});
    fillTagSelect();
    // The drafts come after the tasks and before the first paint: the bucket
    // and every row's marker depend on the join, and painting without it would
    // show an empty `drafted` for a second and then fill it in.
    await loadDrafts();
    // Arriving with #pane=<id> — every card on Today links here that way — opens
    // that task, switching to whichever bucket holds it. The page only ever
    // honoured the hash on a back-swipe, so a tap on Today landed on the list
    // with nothing open. Alex, 2026-09-06: "clicking on most items on today
    // doesn't actually take you to the item clicked on."
    // Arriving with #tag=<t> opens the list already filtered — the #invoice
    // chip on Today links here that way. Alex, 2026-09-28.
    /* Since 2026-10-04 a tag filters only on the map (a circle) and on the
       Projects tab (a project); an older link naming a kind goes to its lane. */
    /* #proj= was the Projects tab's open item: a tag, or one of its doors
       ('edit' was what leads the briefs). It opens By project on the same. */
    const wantProj = stateFromUrl('proj');
    if (wantProj) {
      filter = 'projects';
      if (['new', 'rank', 'archived'].includes(wantProj) || wantProj.startsWith('edit:')) projPane = wantProj;
      else if (wantProj === 'edit') projPane = 'rank';
      else { tag = wantProj; writeView({ proj: null }); fillTagSelect(); }
    }
    const wantTag = stateFromUrl('tag');
    if (wantTag === 'invoice' || wantTag === 'decision') { filter = 'today'; lane = wantTag === 'invoice' ? 'pay' : 'decide'; }
    else if (wantTag && items.some((o) => (o.tags ?? []).includes(wantTag))) {
      if (filter !== 'map') filter = 'projects';
      tag = wantTag; if (tagsel) tagsel.value = wantTag;
    }
    const want = stateFromUrl('pane');
    const target = want && items.find((o) => o.id === want);
    if (target) {
      if (!BUCKETS[filter]?.pick(target)) {
        const home = Object.keys(BUCKETS).find((k) => BUCKETS[k].pick(target));
        if (home) { filter = home; tag = ''; if (tagsel) tagsel.value = ''; }
      }
      selected = target.id;
    } else if (want) {
      // Not open — perhaps closed. "closed today" in the brief links here.
      const c = (await loadClosed()).find((o) => o.id === want);
      if (c) { filter = 'closed'; tag = ''; if (tagsel) tagsel.value = ''; selected = c.id; }
      else console.warn('work: no task with id', want);
    }
    render();
  }).catch((err) => {
    // Say WHAT failed. This catch swallowed a render error and showed "Could not
    // load." for a page whose API had answered in 126ms — the exact silence the
    // guards exist to prevent, and an hour of looking in the wrong place.
    console.error('work: could not render', err);
    list.innerHTML = '';
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = 'Could not load: ' + (err?.message ?? err);
    list.appendChild(e);
  });
}
