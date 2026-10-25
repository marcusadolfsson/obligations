/**
 * The people page: who, and what stands between you.
 *
 * Alex, 2026-09-05, from the chief-of-staff audit: the relationship layer was
 * the weakest part of the system — 492 senders judged, 3 with a file. This is
 * the surface for people.mjs, which derives the graph from what the system
 * already knows rather than waiting for Sunday's compaction to write a file.
 *
 * Two panes like everything else. Left: people, with the two numbers a chief
 * of staff carries into a room — what you owe them and what they owe you.
 * Right: the person — how you know them, both lists in full, their traffic,
 * and a link to the file when there is one.
 *
 * PEOPLE ONLY, YOURS FIRST. Alex, 2026-09-22: "needs a complete rethink.
 * Lets make it people only to begin with, it has a lot of organizations in
 * there … those [in the contact book] should be more high value people than
 * non-contact book people." Two sections: Your people (a people/ file or a
 * contact card) and Others who wrote. Organisations and mailboxes are left off
 * by people.mjs and counted in the line under the chips.
 */
import { openState, closeState, onStateChange, stateFromUrl } from './histate.mjs';
import { composer, section } from './ui.mjs';

const listEl = document.getElementById('pplist');
const paneEl = document.getElementById('pppane');
const splitEl = document.getElementById('ppsplit');
const countEl = document.getElementById('ppcount');
const filtEl = document.getElementById('ppfilters');
const onPage = !!(listEl && paneEl && countEl && filtEl);

let data = { people: [], counts: {} };
let filter = 'open';      // open | yours | all
let current = null;

const daysAgo = (stamp) => {
  const t = Date.parse(String(stamp ?? '').replace(' ', 'T'));
  if (Number.isNaN(t)) return '';
  const d = Math.round((Date.now() - t) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`;
};

function visible() {
  let xs = data.people;
  if (filter === 'open') xs = xs.filter((p) => p.owedByMe.length || p.owedByThem.length);
  if (filter === 'yours') xs = xs.filter((p) => p.circle === 'yours');
  return xs;
}

/** How much has passed between you, in words: "4 emails · 2 chats". */
const traffic = (p) => [
  p.threads ? `${p.threads} email${p.threads === 1 ? '' : 's'}` : '',
  p.texts ? `${p.texts} chat${p.texts === 1 ? '' : 's'}` : '',
].filter(Boolean).join(' · ');

function row(p) {
  const el = document.createElement('div');
  el.className = 'ob' + (current === p.key ? ' selected' : '');
  const inner = document.createElement('div');
  inner.className = 'ob-inner';
  const r = document.createElement('div');
  r.className = 'ob-row';

  const who = document.createElement('span');
  who.className = 'ob-who';
  who.textContent = p.name;
  const age = document.createElement('span');
  age.className = 'ob-age';
  // How you last spoke, and when: "text · today".
  age.textContent = [p.lastChannel, daysAgo(p.last)].filter(Boolean).join(' · ');
  const title = document.createElement('span');
  title.className = 'ob-title';
  // The two numbers. "you owe 2 · owed 1" is the whole reason to open a row.
  const bits = [];
  if (p.owedByMe.length) bits.push(`you owe ${p.owedByMe.length}`);
  if (p.owedByThem.length) bits.push(`owed ${p.owedByThem.length}`);
  if (!bits.length && traffic(p)) bits.push(traffic(p));
  title.textContent = bits.join(' · ') + (p.org ? ` — ${p.org}` : '');
  r.append(who, age, title);

  if (p.lastSubject) {
    const sub = document.createElement('span');
    sub.className = 'ob-preview';
    sub.textContent = p.lastSubject;
    r.append(sub);
  }
  if (!p.file && p.threads >= 3) {
    const tags = document.createElement('span');
    tags.className = 'ob-tags';
    const t = document.createElement('span');
    t.className = 'ob-tag';
    t.textContent = 'no file';
    tags.append(t);
    r.append(tags);
  }
  inner.append(r);
  el.append(inner);
  el.onclick = () => select(p);
  return el;
}

function draw() {
  listEl.textContent = '';
  const xs = visible();
  if (!xs.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = data.reason ? 'could not load people: ' + data.reason : 'nobody here.';
    listEl.append(e);
    return;
  }
  // The two circles, yours first. The server has already sorted within each.
  for (const [circle, title] of [['yours', 'Your people'], ['others', 'Others who wrote']]) {
    const rows = xs.filter((p) => (p.circle ?? 'others') === circle);
    if (!rows.length) continue;
    listEl.append(section(title, { count: rows.length }));
    for (const p of rows) listEl.append(row(p));
  }
}

function drawFilters() {
  filtEl.textContent = '';
  const mk = (key, label, count) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-selected', filter === key ? 'true' : 'false');
    b.textContent = label;
    const n = document.createElement('b');
    n.textContent = String(count);
    b.append(' ', n);
    b.onclick = () => { filter = key; drawFilters(); draw(); };
    filtEl.append(b);
  };
  const c = data.counts;
  mk('open', 'Something open', c.withOpen ?? 0);
  mk('yours', 'Your people', c.yours ?? 0);
  mk('all', 'Everyone', c.total ?? 0);
}

function list(title, rows) {
  if (!rows.length) return null;
  const h = document.createElement('h5');
  h.textContent = title;
  const ul = document.createElement('ul');
  ul.className = 'pp-list';
  for (const r of rows) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/todo#pane=' + encodeURIComponent(r.id);
    a.textContent = r.title;
    li.append(a);
    const meta = document.createElement('span');
    meta.className = 'mut';
    meta.textContent = r.overdue ? ` · overdue` : r.due ? ` · due ${String(r.due).slice(0, 10)}` : r.days ? ` · ${r.days}d` : '';
    li.append(meta);
    ul.append(li);
  }
  const wrap = document.createElement('div');
  wrap.append(h, ul);
  return wrap;
}

function select(p) {
  current = p.key;
  draw();
  splitEl?.classList.add('showing');
  openState('pane', p.key);
  paneEl.textContent = '';

  const back = document.createElement('button');
  back.className = 'pane-back';
  back.textContent = '‹ back to list';
  back.onclick = () => { if (!closeState('pane')) closePane(); };

  const head = document.createElement('div');
  head.className = 'pane-head';
  const h = document.createElement('h2');
  h.className = 'pane-title';
  h.textContent = p.name;
  const meta = document.createElement('div');
  meta.className = 'ob-meta';
  meta.textContent = [p.role, p.org, p.last ? `last ${[p.lastChannel, daysAgo(p.last)].filter(Boolean).join(' ')}` : '', traffic(p)]
    .filter(Boolean).join(' · ');
  head.append(h, meta);

  const inner = document.createElement('div');
  inner.className = 'pane-inner';
  inner.append(back, head);

  if (p.how) {
    const how = document.createElement('p');
    how.className = 'what';
    how.textContent = p.how;
    inner.append(how);
  }

  // Both directions, yours first: what you owe is what you can act on.
  const mine = list('you owe them', p.owedByMe);
  const theirs = list('they owe you', p.owedByThem);
  if (mine) inner.append(mine);
  if (theirs) inner.append(theirs);
  if (!mine && !theirs) {
    const q = document.createElement('p');
    q.className = 'mut';
    q.textContent = 'Nothing open between you.';
    inner.append(q);
  }

  const handles = document.createElement('p');
  handles.className = 'mut';
  handles.textContent = p.handles.join(' · ');
  inner.append(handles);

  if (p.file) {
    const a = document.createElement('a');
    a.className = 'sys-open';
    a.href = '/notes#' + encodeURIComponent(p.file);
    a.textContent = 'open ' + p.file + ' ›';
    inner.append(a);
  } else if (p.threads >= 3) {
    const n = document.createElement('p');
    n.className = 'mut';
    n.textContent = `No people/ file yet. ${p.threads} threads judged — the compaction would create one on a journal mention; ask the assistant to write it now if this is someone.`;
    inner.append(n);
  }
  paneEl.append(inner);
}

function closePane() {
  current = null;
  splitEl?.classList.remove('showing');
  draw();
}

async function load() {
  try {
    const r = await fetch('/api/people');
    const got = await r.json();
    data = { people: Array.isArray(got?.people) ? got.people : [], counts: got?.counts ?? {}, reason: got?.reason ?? null };
  } catch (err) {
    data = { people: [], counts: {}, reason: String(err?.message ?? err) };
  }
  const c = data.counts;
  countEl.textContent = data.reason ? 'people could not be read: ' + data.reason
    // What was left off gets a number: a shorter page and a broken one must
    // not look the same.
    : `${c.yours ?? 0} of your people · ${c.others ?? 0} others who wrote · ${c.withOpen ?? 0} with something open`
      + (c.orgsHidden ? ` · ${c.orgsHidden} organisations and mailboxes not shown` : '');
  drawFilters();
  draw();
}

if (onPage) {
  const ppdock = document.getElementById('ppdock');
  if (ppdock) ppdock.append(composer({ placeholder: 'Ask about someone…', context: () => ({ page: 'people', open: current }) }));
  /* BY KEY, HANDLE OR NAME. To Do links a person as /people#pane=<who>, and
     `who` is an address, a phone or a name — while a row's key is a file slug
     or a `contact:` key for everyone the page knows best. Matching the key
     alone meant those links opened nothing for exactly the people who matter
     most. Found in the rethink of 2026-09-22. */
  const find = (id) => {
    const q = String(id ?? '').trim().toLowerCase();
    if (!q) return null;
    const digits = q.replace(/\D/g, '');
    const phone = digits.length >= 10 ? '+1' + digits.slice(-10) : null;
    return data.people.find((x) => x.key === id || x.key === q) ?? data.people.find((x) => (x.handles ?? []).includes(q)
      || (phone && (x.handles ?? []).includes(phone)) || String(x.name ?? '').toLowerCase() === q) ?? null;
  };
  onStateChange('pane', (id) => {
    if (!id) return closePane();
    const p = find(id);
    if (p) select(p); else closePane();
  });
  load().then(() => {
    const p = find(stateFromUrl('pane'));
    if (p) select(p);
  });
}
