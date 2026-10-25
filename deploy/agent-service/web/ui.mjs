/**
 * Shared UI: the pieces every page is made of, written once.
 *
 * Alex, 2026-09-05: "build a best-in-class UI." The audit before it: seven
 * pages, one two-pane pattern, and I had copied the JavaScript each time — six
 * near-copies of the same 200 lines. Consistent, which is good; uniform, which
 * is not: a person, a decision, a newsletter and a brief all rendered as rows
 * with a title and a date, and the shape carried no information about what
 * kind of thing you were looking at.
 *
 * So: one module. Cards that look like what they are, and link sideways to each
 * other. Chips, section heads and empty states with the same voice everywhere.
 * A swipe grammar — right is done/read, left is later — that is the same on
 * every list. Pages become thin: fetch, map to cards, done.
 *
 * Everything here builds DOM with createElement and textContent. Nothing takes
 * HTML from data; the one renderer that does (markdown.mjs) is called
 * explicitly where prose is expected.
 */

export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};

export const ms = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };

/** "today" / "yesterday" / "3d ago" / "in 2d" — relative, for a glance. */
export function rel(stamp) {
  const t = typeof stamp === 'number' ? stamp : ms(stamp);
  if (!t) return '';
  const d = Math.round((t - Date.now()) / 86400000);
  if (d === 0) return 'today';
  if (d === -1) return 'yesterday';
  if (d === 1) return 'tomorrow';
  return d < 0 ? `${-d}d ago` : `in ${d}d`;
}
export const hhmm = (stamp) => String(stamp ?? '').slice(11, 16);

/**
 * `17 Sep 14:10` — the date beside the clock.
 *
 * Alex, 2026-09-19: "the mail needs a date next to the clock." A bare `14:10`
 * is only unambiguous under a day heading, and half the views have none: by
 * sender there are no day sections at all, so every row read as though it had
 * arrived today. The year is left off — these are days old, not years — and
 * appears only when it is not this one.
 */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function stampShort(stamp) {
  const s = String(stamp ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(s);
  if (!m) return hhmm(s);
  const [, y, mo, d, hm] = m;
  const year = Number(y) === new Date().getFullYear() ? '' : ` ${y}`;
  return `${Number(d)} ${MON[Number(mo) - 1] ?? mo}${year}  ${hm}`;
}

/* ------------------------------------------------------------------ chips */

export function chip(text, { cls = '', on = null, selected = false, count } = {}) {
  const b = el('button', 'chip' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  b.setAttribute('aria-selected', selected ? 'true' : 'false');
  if (count !== undefined) b.append(' ', el('b', null, count));
  if (on) b.onclick = on;
  return b;
}

/** A row of filter chips. `items` = [{key,label,count}], `active` key. */
export function chipRow(items, active, onPick) {
  const row = el('div', 'filt');
  for (const it of items) {
    row.append(chip(it.label, { count: it.count, selected: it.key === active, on: () => onPick(it.key) }));
  }
  return row;
}

/* ---------------------------------------------------------------- section */

export function section(title, { count, action, actionLabel } = {}) {
  const h = el('div', 'sec-head');
  h.append(el('span', 'sec-title', count === undefined ? title : `${title}  ·  ${count}`));
  if (action) {
    const b = el('button', 'sec-action', actionLabel ?? 'all');
    b.type = 'button';
    b.onclick = action;
    h.append(b);
  }
  return h;
}

export function empty(text) { return el('div', 'empty', text); }

/* ------------------------------------------------------------------- cards */

/** A small typed label in the card's corner: OBLIGATION, DECISION, BRIEF… */
export const kindTag = (kind) => el('span', `card-kind card-kind-${kind}`, kind);

/** A sideways link: to a person, a priority, a thread. Rendered as a quiet chip. */
export function link(text, href, cls = '') {
  const a = el('a', 'card-link ' + cls, text);
  a.href = href;
  return a;
}

/**
 * An obligation — a debt, one direction or the other. Who is the strong line;
 * the title beneath; then the sideways links: the person, each tag as a
 * priority, the thread. The right edge carries the one number that matters —
 * days waiting, or the deadline — coloured by urgency.
 */
export function obligationCard(o, { onOpen, compact = false } = {}) {
  const c = el('article', 'card card-ob' + (o.overdue ? ' urgent' : '') + (o.owed_by === 'them' ? ' theirs' : ''));
  c.dataset.id = o.id;
  const top = el('div', 'card-top');
  top.append(el('span', 'card-who', o.who || (o.owed_by === 'them' ? 'waiting on them' : 'you')));
  const when = el('span', 'card-when');
  if (o.overdue) when.textContent = 'overdue';
  else if (o.due) when.textContent = `due ${rel(o.due)}`;
  else if (o.days) when.textContent = `${o.days}d`;
  top.append(when);
  c.append(top);
  c.append(el('div', 'card-title', o.title));
  if (!compact && o.what) c.append(el('div', 'card-sub', o.what));
  const links = el('div', 'card-links');
  if (o.who) links.append(link(o.who.split('@')[0], '/people#pane=' + encodeURIComponent(String(o.who).toLowerCase()), 'lk-person'));
  for (const t of o.tags ?? []) {
    if (t === 'decision') { links.prepend(kindTag('decision')); continue; }
    links.append(link('#' + t, tagHref(t), 'lk-tag'));
  }
  const thread = (o.evidence ?? []).find((e) => e.source === 'email')?.detail;
  if (thread?.link) links.append(link('thread', thread.link, 'lk-thread'));
  if (links.childElementCount) c.append(links);
  if (onOpen) { c.onclick = () => onOpen(o); c.tabIndex = 0; c.setAttribute('role', 'button'); }
  return c;
}

/** Where a tag chip goes: a project's page, or — for a kind tag, which has no
 *  page — its home on To Do: bills are the Pay lane (2026-10-04, when the tag
 *  filter went), birthdays their circle on the map. */
const tagHref = (t) => (t === 'invoice' ? '/todo#lane=pay'
  : t === 'birthday' ? '/todo?f=map#tag=birthday'
  : '/todo?f=projects#proj=' + encodeURIComponent(t));

/** A decision: options are the body, the recommendation is the strong line. */
export function decisionCard(o, { onOpen } = {}) {
  const d = o.evidence?.find((e) => e.source === 'decision')?.detail ?? o.detail ?? {};
  const c = el('article', 'card card-decision' + (o.overdue ? ' urgent' : ''));
  c.dataset.id = o.id;
  const top = el('div', 'card-top');
  top.append(kindTag('decision'));
  top.append(el('span', 'card-when', o.overdue ? 'overdue' : o.due ? `by ${String(o.due).slice(5, 10)}` : ''));
  c.append(top, el('div', 'card-title', o.title));
  if (d.recommend) c.append(el('div', 'card-sub card-rec', '→ ' + d.recommend));
  if (d.blocked) c.append(el('div', 'card-sub card-blocked', 'blocked: ' + d.blocked));
  if (Array.isArray(d.options) && d.options.length) {
    c.append(el('div', 'card-meta', `${d.options.length} options`));
  }
  const links = el('div', 'card-links');
  for (const t of (o.tags ?? []).filter((t) => t !== 'decision')) links.append(link('#' + t, tagHref(t), 'lk-tag'));
  if (links.childElementCount) c.append(links);
  if (onOpen) { c.onclick = () => onOpen(o); c.tabIndex = 0; c.setAttribute('role', 'button'); }
  return c;
}

/** A person: name strong, the two numbers a chief of staff carries into a room. */
export function personCard(p, { onOpen } = {}) {
  const c = el('article', 'card card-person');
  c.dataset.id = p.key;
  const top = el('div', 'card-top');
  top.append(el('span', 'card-who', p.name));
  top.append(el('span', 'card-when', p.last ? rel(p.last) : ''));
  c.append(top);
  const bits = [];
  if (p.owedByMe?.length) bits.push(`you owe ${p.owedByMe.length}`);
  if (p.owedByThem?.length) bits.push(`owed ${p.owedByThem.length}`);
  if (!bits.length) bits.push(`${p.threads ?? 0} thread${p.threads === 1 ? '' : 's'}`);
  c.append(el('div', 'card-title', bits.join(' · ') + (p.org ? ` — ${p.org}` : '')));
  if (p.lastSubject) c.append(el('div', 'card-sub', p.lastSubject));
  if (onOpen) { c.onclick = () => onOpen(p); c.tabIndex = 0; c.setAttribute('role', 'button'); }
  return c;
}

/** Something the system said: a brief, a note, a prep, a failure. */
export function messageCard(m, { onOpen } = {}) {
  // `urgent` is the kind that buzzed his phone, and a failure is the other
  // thing that should stop him — both take the hot rule down the left.
  const c = el('article', 'card card-msg' + (m.read ? '' : ' fresh') + (m.kind === 'failure' || m.kind === 'urgent' ? ' urgent' : ''));
  c.dataset.id = m.id;
  const top = el('div', 'card-top');
  top.append(kindTag(m.kind ?? 'note'));
  top.append(el('span', 'card-when', hhmm(m.at) || rel(m.at)));
  c.append(top, el('div', 'card-title', m.title ?? m.id));
  if (onOpen) { c.onclick = () => onOpen(m); c.tabIndex = 0; c.setAttribute('role', 'button'); }
  return c;
}

/** What each tier is called on screen. `reading` is a newsletter; the internal
 *  name is a leftover from the reading list it used to feed. */
export const TIER_LABEL = { reading: 'newsletter', digest: 'digest', action: 'action',
  memory: 'memory', awareness: 'awareness', ephemeral: 'ephemeral', silent: 'silent',
  // The two digest buckets. Two words each, because "Current" alone on a pill
  // says nothing about what it is current for.
  current: 'current digest', never: 'never digested' };

/**
 * The two tiers Alex is the reader of. Everywhere else the assistant read it for
 * him and did something — an obligation on To Do, a fact in reference/, a line
 * in a brief — so "unread" is not a state those threads are in.
 *
 * Alex, 2026-09-19: "action | memory | awareness | ephemeral won't have
 * read/unread status shown, since the Obligations read it on behalf of the user and
 * featured it in the Brief if needed."
 *
 * Mirrors DIGEST_TIERS in digestlist.mjs, which is the authority; /api/filed
 * sends it back as `readable` so the page never has to hold the list itself.
 */
export const READS_HIMSELF = new Set(['digest', 'reading']);

/** A judged mail thread: the agent's title strong, the sender's subject faint. */
export function digestCard(it, { onOpen } = {}) {
  /* THE SAME ROW A TASK DRAWS.
   *
   * Alex, 2026-09-19: "on the left hand side use the same design for the
   * cards as on to do." They were already the same SHAPE — who and a stamp,
   * the line, a note, tags — but built from two sets of classes with two sets
   * of sizes, so the columns did not quite line up when read one after the
   * other. This emits `ob-row`, the grid the task and reference columns use,
   * so they are the same component rather than two that resemble each other.
   *
   * The sender's raw subject is on the row's tooltip: a check that the
   * judgement is about the thread he thinks it is, worth keeping and not
   * worth a line now the category is on the card.
   */
  /* The read/unread rule only where he is the reader — see READS_HIMSELF. On an
     action or a memory row it said "unread" about mail the assistant had already
     turned into a task or a filed fact, which is a backlog that does not
     exist. Those rows draw plain. */
  const mine = READS_HIMSELF.has(it.tier);
  const c = el('article', 'card card-digest' + (mine && it.read ? ' read' : '')
    + (mine && !it.read ? ' unread' : '') + (it.tier === 'reading' ? ' longread' : ''));
  c.dataset.id = it.id;
  if (it.subject && it.subject !== it.title) c.title = it.subject;

  const row = el('div', 'ob-row');
  row.append(el('div', 'ob-who', it.who || '(unknown sender)'));
  row.append(el('span', 'ob-age', stampShort(it.when) || rel(it.at)));
  row.append(el('div', 'ob-title', it.title));
  if (it.what) row.append(el('div', 'ob-preview', it.what));

  /* THE CATEGORY THE TRIAGE GAVE IT, on every card.
   *
   * Alex, 2026-09-19: "do the emails in the list have been through the
   * categorization engine? if so show the category as a pill." They have —
   * being judged is what puts a thread on this list at all, and the un-judged
   * are under Pending. Only the tag was missing on everything but newsletters,
   * so a receipt and a building notice looked like undifferentiated mail when
   * the triage had in fact decided something about each.
   *
   * The same word the filter row uses for that tier, so the pill on the card
   * and the pill in the row are recognisably the same thing.
   */
  const tags = el('div', 'ob-tags');
  if (it.tier) tags.append(kindTag(TIER_LABEL[it.tier] ?? it.tier));
  /* "open task", not "open". Alex, 2026-09-19: "I don't know what 'Open'
   * means on the card, that it is unread?" In a mail list "open" reads as
   * unopened. It means the OBLIGATION the triage wrote from this thread has
   * not been discharged — which only happens on the action tier. He named it:
   * "ok name it 'Open Task'". */
  if (it.open) tags.append(kindTag('open task'));
  if (tags.childElementCount) row.append(tags);

  c.append(row);
  if (onOpen) { c.onclick = () => onOpen(it); c.tabIndex = 0; c.setAttribute('role', 'button'); }
  return c;
}

/** A calendar event, with the prep one tap away when one exists. */
export function eventCard(e, { prepHref } = {}) {
  const c = el('article', 'card card-event' + (e.mine === false ? ' theirs' : ''));
  const top = el('div', 'card-top');
  top.append(el('span', 'card-who', e.allDay ? 'all day' : hhmm(e.startsAt)));
  const others = (e.attendees ?? []).filter((a) => !a.self && a.email);
  top.append(el('span', 'card-when', e.mine === false ? (e.calendar ?? 'someone else') : (others.length ? `${others.length} ${others.length === 1 ? 'person' : 'people'}` : '')));
  c.append(top, el('div', 'card-title', e.summary ?? '(untitled)'));
  const sub = [e.location, e.myResponse === 'needsAction' ? 'not answered' : ''].filter(Boolean).join(' · ');
  if (sub) c.append(el('div', 'card-sub', sub));
  if (prepHref) c.append(link('prep ›', prepHref, 'lk-prep'));
  return c;
}

/* ------------------------------------------------------------------ swipe */

/**
 * One swipe grammar for every list. Right = done/read (the positive, forward
 * gesture); left = later. The card slides with the thumb and commits past a
 * threshold; under it, it springs back. Vertical movement cancels, so a scroll
 * that starts on a card scrolls.
 */
export function swipeable(card, { onRight, onLeft, rightLabel = 'done', leftLabel = 'later' } = {}) {
  const wrap = el('div', 'swipe');
  const bgR = el('div', 'swipe-bg swipe-bg-right', rightLabel);
  const bgL = el('div', 'swipe-bg swipe-bg-left', leftLabel);
  wrap.append(bgR, bgL, card);
  card.classList.add('swipe-card');
  let x0 = 0, y0 = 0, dx = 0, active = false, cancelled = false;
  const T = 88;
  card.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; active = true; cancelled = false;
    card.style.transition = 'none';
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (!active || cancelled) return;
    const t = e.touches[0];
    const dy = t.clientY - y0; dx = t.clientX - x0;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { cancelled = true; card.style.transform = ''; return; }
    if ((dx > 0 && !onRight) || (dx < 0 && !onLeft)) dx = 0;
    card.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle('arm-right', dx > T);
    wrap.classList.toggle('arm-left', dx < -T);
  }, { passive: true });
  const finish = () => {
    if (!active) return; active = false;
    card.style.transition = '';
    if (!cancelled && dx > T && onRight) { card.style.transform = 'translateX(110%)'; setTimeout(() => onRight(), 160); }
    else if (!cancelled && dx < -T && onLeft) { card.style.transform = 'translateX(-110%)'; setTimeout(() => onLeft(), 160); }
    else card.style.transform = '';
    wrap.classList.remove('arm-right', 'arm-left');
  };
  card.addEventListener('touchend', finish);
  card.addEventListener('touchcancel', finish);
  return wrap;
}

/* -------------------------------------------------------------- composer */

/**
 * The composer that lives at the bottom of every screen. It does not run a
 * turn itself — it hands the text to the chat drawer, which owns the SSE, the
 * approval cards and the transcript, and opens it. `context` is what the page
 * is looking at, so "push this to Friday" means something.
 */
export function composer({ placeholder = 'Tell me…', context = () => null } = {}) {
  const form = el('form', 'composer-bar');
  const input = el('input', 'composer-input');
  input.type = 'text'; input.placeholder = placeholder; input.autocomplete = 'off';
  const send = el('button', 'composer-send', '↑');
  send.type = 'submit'; send.setAttribute('aria-label', 'send');
  form.append(input, send);
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    window.dispatchEvent(new CustomEvent('obligations:say', { detail: { text, context: context() } }));
  };
  return form;
}

/* KEEP IN INBOX. Alex, 2026-10-09: "moves the message back to Inbox, and
 * keeps it there until I manually archive OR we determine that the task is
 * closed." One button for the Mail pane and a mail task's pane: it puts the
 * thread back and holds it; once held, the same button lets it go (the next
 * mail sweep then files it as usual). keep-inbox.mjs has the rest. */
let keptCache = null;
const keptNow = () => (keptCache ??= fetch('/api/mail/kept').then((r) => r.json()).then((d) => d.kept ?? {}).catch(() => ({})));
export function keepButton(account, threadId, { task = null, className = 'pane-act' } = {}) {
  const key = `${account || 'personal'}:${threadId}`;
  const b = el('button', `${className} keep-inbox`, 'Keep in Inbox');
  b.type = 'button';
  b.title = 'Back to the inbox, and held there until you archive it or its task is closed.';
  const paint = (on) => {
    b.dataset.kept = on ? '1' : '';
    b.textContent = on ? 'Kept in Inbox · let go' : 'Keep in Inbox';
    b.title = on ? 'Stop holding it; the next mail run files it as usual.' : 'Back to the inbox, and held there until you archive it or its task is closed.';
  };
  keptNow().then((k) => paint(!!k[key]));
  b.onclick = async () => {
    const on = !b.dataset.kept;
    b.disabled = true; const was = b.textContent; b.textContent = on ? 'moving to inbox…' : 'letting go…';
    try {
      const r = await fetch('/api/mail/keep', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: account || 'personal', threadId, keep: on, task }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? 'refused');
      keptCache = null;
      paint(on);
    } catch (err) {
      b.textContent = 'could not: ' + (err?.message ?? err);
      setTimeout(() => { b.textContent = was; }, 5000);
    } finally { b.disabled = false; }
  };
  return b;
}
