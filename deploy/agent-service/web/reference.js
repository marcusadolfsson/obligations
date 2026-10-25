import { openState, closeState, onStateChange, stateFromUrl } from './histate.mjs';
/**
 * The reference page: pick a group on the left, read it on the right.
 *
 * A module, not a classic script: `reading.js` is loaded on every page and
 * declares its own top-level `list`, so two plain scripts sharing the global
 * scope collide and BOTH die — which took every page down, not just this one.
 *
 * Everything is already in the document — trips are sixty lines and the filed
 * lists are capped server-side — so this only shows and hides. No fetch, no
 * state, nothing to go stale between the render and the click.
 */
const list = document.getElementById('reflist');
const pane = document.getElementById('refpane');
const split = document.getElementById('refsplit');

if (list && pane) {
  const panes = [...pane.querySelectorAll('.ref-pane')];
  const empty = pane.querySelector('.ref-empty');

  function closePane() {
    for (const p of panes) p.hidden = true;
    for (const r of list.querySelectorAll('.ref-row')) r.classList.remove('selected');
    if (empty) empty.hidden = false;
    if (split) split.classList.remove('showing');
  }

  onStateChange('pane', (id) => { if (id) select(id); else closePane(); });

  function select(key) {
    for (const p of panes) p.hidden = p.dataset.ref !== key;
    for (const r of list.querySelectorAll('.ref-row')) {
      r.classList.toggle('selected', r.dataset.ref === key);
    }
    if (empty) empty.hidden = true;
    if (split) split.classList.add('showing');
    openState('pane', key);      // so the back swipe closes the trip, not the page
    // On a phone the panes take turns, so the way back has to exist.
    if (!pane.querySelector('.pane-back')) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'pane-back';
      back.textContent = '‹ back to list';
      back.onclick = () => { if (!closeState('pane')) closePane(); };
      pane.prepend(back);
    }
  }

  for (const row of list.querySelectorAll('.ref-row')) {
    row.onclick = () => select(row.dataset.ref);
  }

  // Section chips: all, bookings, documents, mail. The rows carry data-sec;
  // a chip hides every other section. Sections are the split Alex asked
  // for on 2026-09-05; the chips are how one fits on a phone.
  const filt = document.getElementById('reffilters');
  if (filt) {
    /* `archived` is a section like the others, and it is the ONE that `all`
       leaves out. Alex, 2026-09-19: "a filter to see Archived filings." A
       shelf you cannot help seeing is not a shelf — the whole point of
       archiving last spring's weekend is that it stops being in the way — so
       `all` means everything still live, and archived trips have their own
       chip and their own section head. The count on the head is what stops
       "put away" and "gone" looking the same. */
    const archived = list.querySelectorAll('[data-sec="archived"]').length;
    const SECS = [['all', 'all'], ['bookings', 'bookings'], ['documents', 'documents']]
      .concat(archived ? [['archived', `archived (${archived})`]] : []);
    let active = 'all';
    const apply = () => {
      for (const n of list.querySelectorAll('[data-sec]')) {
        n.hidden = active === 'all' ? n.dataset.sec === 'archived' : n.dataset.sec !== active;
      }
      for (const b of filt.querySelectorAll('.chip')) b.setAttribute('aria-selected', b.dataset.k === active ? 'true' : 'false');
    };
    for (const [k, label] of SECS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.k = k; b.textContent = label;
      b.setAttribute('aria-selected', k === active ? 'true' : 'false');
      b.onclick = () => { active = k; apply(); };
      filt.append(b);
    }
    apply();        // archived rows are hidden from `all` on first paint too
  }

  /* Archive, and restore. The page is server-rendered with no state of its
     own, so the honest thing after a write is to reload rather than to guess
     at what the file now says — the button is pressed once in a while and a
     wrong guess would be a trip that looks archived and is not. */
  for (const b of pane.querySelectorAll('.trip-archive')) {
    b.onclick = async () => {
      const was = b.textContent;
      b.disabled = true;
      b.textContent = 'working…';
      try {
        const r = await fetch('/api/reference/trip', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trip: b.dataset.trip, archived: b.dataset.archived !== '1' }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error ?? 'refused');
        location.reload();
      } catch (err) {
        b.textContent = `could not: ${err?.message ?? err}`;
        b.disabled = false;
        setTimeout(() => { b.textContent = was; }, 4000);
      }
    };
  }

  // Open the first group so the page shows something at rest rather than an
  // instruction to click.
  // ...but only where both panes are on screen. On a phone the panes take
  // turns, and opening the first group hid the whole list behind it: nine
  // rows in the DOM, none visible, the guard said. There the list is the page.
  const first = list.querySelector('.ref-row:not([data-sec="archived"])');
  if (first && matchMedia('(min-width: 44rem)').matches) select(first.dataset.ref);   // .split goes two-column at 44rem (style.css)
}
