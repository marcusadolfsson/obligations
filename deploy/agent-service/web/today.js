/**
 * Today: the front door.
 *
 * Alex, 2026-09-05: "It has no front door. / is the chat. But the first thing
 * you read every day is the morning brief — a message, in a list. A chief of
 * staff's desk isn't a chat window or a filing cabinet; it's one screen that
 * says here's your day."
 *
 * This is that screen. It is the morning brief as a live surface: the next
 * meetings with prep one tap away, decisions waiting, due today, movement on
 * priorities, what closed, and anything the assistant is waiting on him for. One
 * request (/api/today) assembles it server-side; the page only draws.
 *
 * Every section states its count, including zero. "Nothing due" is a fact and
 * a section that vanishes on a quiet day cannot be told from one that failed.
 */
import { el, rel, section, empty, obligationCard, decisionCard, messageCard, eventCard, link, composer } from './ui.mjs';

const root = document.getElementById('today');
if (root) {
  const q = new URLSearchParams(location.search);
  let data = null;

  const KEY = 'obligations.today';

  async function load() {
    try {
      const r = await fetch('/api/today');
      const got = await r.json();
      if (got && !got.error) { try { localStorage.setItem(KEY, JSON.stringify(got)); } catch {} }
      root.classList.remove('stale');
      // Normalise rather than trust the shape. A stubbed or partial response
      // reached draw() as `undefined.length` and took the page down — the same
      // failure the digest page had, and a page that dies on a bad response
      // says nothing about which response was bad.
      const arr = (v) => (Array.isArray(v) ? v : []);
      data = got?.error ? got : {
        generated_at: got?.generated_at ?? '', health: arr(got?.health), approvals: arr(got?.approvals),
        events: arr(got?.events), decisions: arr(got?.decisions), due: arr(got?.due),
        priorities: arr(got?.priorities), unattached: got?.unattached ?? null, waiting: arr(got?.waiting),
        closed: arr(got?.closed), briefs: arr(got?.briefs),
      };
    } catch (err) { data = { error: String(err?.message ?? err) }; }
    draw();
  }

  /* A section is a block: heading + its cards, so the desktop grid can place
   * whole sections side by side. Alex, 2026-09-05: "today looks odd on
   * desktop" — one 46rem column hugging the left of a 2000px screen. */
  let cur = null;
  const block = (title, opts, { wide = false } = {}) => {
    cur = el('section', 'today-sec' + (wide ? ' wide' : ''));
    cur.append(section(title, opts));
    root.append(cur);
    return cur;
  };
  const put = (node) => (cur ?? root).append(node);

  function draw() {
    root.textContent = '';
    cur = null;
    if (!data || data.error) { put(empty('Today could not be assembled: ' + (data?.error ?? 'no data'))); return; }

    // Health first, in its own words, only when red. A green light repeated
    // every morning is noise; the absence of the red one carries the meaning.
    if (data.health?.length) {
      const h = el('div', 'today-health');
      for (const line of data.health) h.append(el('div', 'today-health-line', '! ' + line));
      root.append(h); h.classList.add('wide');
    }

    // Where he is, from the phone, when it has said recently. One line, quiet.
    if (data.where?.place || data.where?.lat != null) {
      const w = data.where;
      const line = el('div', 'today-where wide', `${w.place ? 'at ' + w.place : `at ${w.lat}, ${w.lon}`}${w.since ? ' since ' + String(w.since).slice(11, 16) : ''}${w.age_min > 90 ? ` · last heard ${Math.round(w.age_min / 60)}h ago` : ''}`);
      root.append(line);
    }

    // Live conditions — a UPS on battery, a service down — with how long, and
    // what cleared today. Alex, 2026-09-06: "a stateful awareness."
    // One open past a day is a to-do on /todo instead (sources/conditions.mjs;
    // Alex, 2026-10-17: "I don't see a todo"), so it is not listed twice.
    const cond = data.conditions ?? {};
    const live = (cond.open ?? []).filter((c) => !c.stuck);
    if (live.length || cond.resolved?.length) {
      block('conditions', { count: live.length }, { wide: true });
      for (const c of live) {
        const card = el('article', 'card card-cond ' + c.severity);
        const top = el('div', 'card-top');
        top.append(el('span', 'card-who', c.key), el('span', 'card-when', `open ${c.minutes >= 60 ? Math.round(c.minutes / 60) + 'h' : c.minutes + ' min'}`));
        card.append(top, el('div', 'card-title', c.what), el('div', 'card-sub', `since ${String(c.since).slice(5, 16)}${c.severity !== 'normal' ? ' · ' + c.severity : ''}`));
        card.onclick = () => location.assign('/mail#pane=' + encodeURIComponent(`${c.account}:${c.threadId}`)); card.tabIndex = 0; card.setAttribute('role', 'button');
        put(card);
      }
      for (const c of cond.resolved ?? []) {
        const card = el('article', 'card card-cond resolved');
        const top = el('div', 'card-top');
        top.append(el('span', 'card-who', c.key), el('span', 'card-when', c.minutes != null ? `cleared after ${c.minutes} min` : 'cleared'));
        card.append(top, el('div', 'card-title', c.what), el('div', 'card-sub', `${c.opened ? String(c.opened).slice(11, 16) + ' → ' : ''}${String(c.resolved).slice(11, 16)}`));
        put(card);
      }
    }

    // The assistant waiting on him goes above everything: it is the one section
    // where a tap unblocks work already in flight.
    if (data.approvals?.length) {
      block('the assistant is waiting on you', { count: data.approvals.length }, { wide: true });
      for (const a of data.approvals) {
        const c = el('article', 'card card-ask');
        c.append(el('div', 'card-title', 'approve ' + a.tool + '?'));
        c.append(el('div', 'card-sub', typeof a.input === 'string' ? a.input.slice(0, 160) : ''));
        c.append(link('answer in chat ›', '/chat', 'lk-prep'));
        put(c);
      }
    }

    // Messages waiting for his Send — texts the assistant drafted, Gmail drafts —
    // sit with the approvals: a tap here is something already written going out.
    const ob = data.outbox;
    if (ob && ((ob.texts ?? 0) + (ob.mail ?? 0)) > 0) {
      const n = (ob.texts ?? 0) + (ob.mail ?? 0);
      block('waiting to send', { count: n, action: () => location.assign('/outbox'), actionLabel: 'outbox' }, { wide: true });
      const c = el('article', 'card card-outbox');
      c.append(el('div', 'card-title', [ob.texts ? `${ob.texts} text${ob.texts === 1 ? '' : 's'}` : null, ob.mail ? `${ob.mail} mail draft${ob.mail === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')));
      c.append(el('div', 'card-sub', ob.stale
        ? `${ob.stale} may have stopped being true — read before you send`
        : 'written, not sent — read and tap Send on the outbox'));
      if (ob.stale) c.classList.add('has-stale');
      c.onclick = () => location.assign('/outbox'); c.tabIndex = 0; c.setAttribute('role', 'button');
      put(c);
    }

    // What the assistant said today, high: Alex, 2026-09-05, "SAID TO YOU needs to
    // sit higher on the dashboard." The brief is the first thing he reads each
    // day, so it sits above the calendar — under only the things waiting on him.
    if (data.briefs?.length) {
      block('briefs', { count: data.briefs.length, action: () => location.assign('/briefs'), actionLabel: 'all' });
      for (const m of data.briefs) put(messageCard(m, { onOpen: () => location.assign('/briefs#pane=' + encodeURIComponent(m.id)) }));
    }

    // Meetings still ahead of now.
    block('today', { count: data.events.length });
    if (!data.events.length) put(empty('nothing on the calendar'));
    for (const e of data.events) put(eventCard(e, { prepHref: e.prep ? '/briefs#pane=' + encodeURIComponent(e.prep) : null }));

    // Decisions before debts: the choice is the thing only he can do.
    block('decide', { count: data.decisions.length, action: () => location.assign('/todo#lane=decide'), actionLabel: 'all' });
    if (!data.decisions.length) put(empty('nothing undecided'));
    for (const d of data.decisions) put(decisionCard(d, { onOpen: () => location.assign('/todo#pane=' + encodeURIComponent(d.id)) }));

    block('due today', { count: data.due.length, action: () => location.assign('/todo'), actionLabel: 'all tasks' });
    if (!data.due.length) put(empty('nothing due today'));
    for (const o of data.due) put(obligationCard(o, { compact: true, onOpen: () => location.assign('/todo#pane=' + encodeURIComponent(o.id)) }));

    // People waiting on him — a reply owed, whatever the date. Newest first,
    // because the one who wrote this morning is the one a holding line stops
    // from chasing.
    block('waiting on you', { count: data.waiting.length, action: () => location.assign('/todo?f=nodate'), actionLabel: 'all' });
    if (!data.waiting.length) put(empty('nobody waiting on a reply'));
    for (const o of data.waiting) put(obligationCard(o, { compact: true, onOpen: () => location.assign('/todo#pane=' + encodeURIComponent(o.id)) }));

    // Priorities: one line each, name + movement. A priority where nothing moved
    // gets its name and a dash, not a paragraph.
    block('priorities', { count: data.priorities.length, action: () => location.assign('/todo?f=projectlist'), actionLabel: 'edit' });
    if (!data.priorities.length) put(empty('priorities.md is empty — say what you are for'));
    for (const p of data.priorities) {
      const row = el('a', 'pri-line' + (p.moved ? ' moved' : ''));
      row.href = '/todo?f=projectlist#proj=' + encodeURIComponent(p.tag);
      row.append(el('span', 'pri-name', p.title));
      row.append(el('span', 'pri-move', p.summary || '—'));
      put(row);
    }
    if (data.unattached?.count) {
      put(el('div', 'today-note', `${data.unattached.count} of ${data.unattached.of} open obligations belong to no priority.`));
    }

    block('closed today', { count: data.closed.length });
    if (!data.closed.length) put(empty('nothing closed yet today'));
    for (const c of data.closed) {
      const row = el('div', 'closed-line' + (c.agent ? ' by-agent' : ''));
      row.append(el('span', 'closed-mark', '✓'));
      row.append(el('span', 'closed-title', c.title));
      if (c.agent) row.append(el('span', 'closed-by', 'agent'));
      if (c.outcome) row.append(el('div', 'closed-outcome', c.outcome));
      put(row);
    }

    cur = null; const stamp = el('div', 'today-stamp wide', `assembled ${data.generated_at}`); root.append(stamp);
  }

  // The composer at the bottom of the desk. Context is the whole screen: the
  // drawer gets "on Today" and the assistant can look things up from there.
  const dock = document.getElementById('todaydock');
  if (dock) dock.append(composer({ placeholder: 'Tell the assistant…', context: () => ({ page: 'today' }) }));

  // Paint the last picture first, then replace it. Alex, 2026-09-06: "I want
  // to pre-cache the today page so we never see Assembling on load." The server
  // keeps the payload warm; this keeps the last one the phone saw, so the page
  // has content in the first frame even on a cold tab or a slow link. Placed
  // after every helper is defined: draw() reaches for them, and a call above
  // their declarations was a ReferenceError on load.
  const remembered = (() => { try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; } })();
  if (remembered && !remembered.error) { data = remembered; draw(); root.classList.add('stale'); }
  load();
  // Live: when a message lands or the approval list changes, redraw. The
  // events stream already exists for the chat; here it is only a nudge to
  // refetch, so the page stays a projection of one API call.
  if (typeof EventSource === 'function') {
    try {
      const es = new EventSource('/api/events');
      let t = null;
      const bump = () => { clearTimeout(t); t = setTimeout(load, 400); };
      es.addEventListener('message', bump);
      es.addEventListener('approval', bump);
      es.addEventListener('approval-gone', bump);
    } catch { /* no live updates; the page still loads */ }
  }
}
