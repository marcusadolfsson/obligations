/**
 * Search, everywhere: ⌘K / Ctrl-K on a keyboard, the ⌕ pill in the nav on a
 * phone. One field over obligations, decisions, people, judged mail and what the
 * system said, each hit typed and linking to where it lives.
 *
 * Alex, 2026-09-05: "no search."
 *
 * Loaded on every page. It adds one pill to the nav and one overlay to the
 * body; nothing else on the page knows it exists. Results are grouped by kind
 * so "Crestline" reads as: the person, then their threads, then the decision they
 * are an option in — not one undifferentiated list.
 */
import { el, empty } from './ui.mjs';

const nav = document.querySelector('nav.links');
if (nav && !document.body.classList.contains('embed')) {
  let overlay = null, input = null, results = null, timer = null, hits = [], cursor = -1;

  const KIND = { obligation: 'to do', decision: 'decisions', person: 'people', mail: 'judged mail', said: 'briefs' };

  function build() {
    overlay = el('div', 'search-overlay');
    overlay.hidden = true;
    const box = el('div', 'search-box');
    input = el('input', 'search-input');
    input.type = 'search'; input.placeholder = 'Search everything…'; input.autocomplete = 'off';
    input.setAttribute('aria-label', 'search');
    results = el('div', 'search-results');
    box.append(input, results);
    overlay.append(box);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 160); };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && cursor >= 0 && hits[cursor]) { e.preventDefault(); location.assign(hits[cursor].href); }
    };
    document.body.append(overlay);
  }

  function open() {
    if (!overlay) build();
    overlay.hidden = false;
    document.body.classList.add('search-open');
    input.value = ''; results.textContent = ''; hits = []; cursor = -1;
    results.append(el('div', 'search-hint', 'obligations · decisions · people · judged mail · said to you'));
    setTimeout(() => input.focus(), 30);
  }
  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove('search-open');
  }
  function move(d) {
    const rows = results.querySelectorAll('.search-hit');
    if (!rows.length) return;
    cursor = Math.max(0, Math.min(rows.length - 1, cursor + d));
    rows.forEach((r, i) => r.classList.toggle('active', i === cursor));
    rows[cursor].scrollIntoView({ block: 'nearest' });
  }

  async function run() {
    const q = input.value.trim();
    results.textContent = ''; hits = []; cursor = -1;
    if (q.length < 2) { results.append(el('div', 'search-hint', 'two or more characters')); return; }
    let d;
    try { d = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json(); }
    catch (err) { results.append(empty('search failed: ' + (err?.message ?? err))); return; }
    if (input.value.trim() !== q) return;                   // a newer query is in flight
    hits = Array.isArray(d?.hits) ? d.hits : [];
    if (!hits.length) { results.append(empty(`nothing matches "${q}"`)); return; }
    const total = d.total > hits.length ? ` · showing ${hits.length} of ${d.total}` : '';
    results.append(el('div', 'search-hint', Object.entries(d.counts ?? {}).map(([k, n]) => `${n} ${KIND[k] ?? k}`).join(' · ') + total));
    let kind = null;
    for (const h of hits) {
      if (h.kind !== kind) { kind = h.kind; results.append(el('div', 'search-kind', KIND[kind] ?? kind)); }
      const a = el('a', 'search-hit');
      a.href = h.href;
      a.append(el('span', 'search-hit-title', h.title));
      if (h.sub) a.append(el('span', 'search-hit-sub', h.sub));
      results.append(a);
    }
  }

  // The pill. Last in the nav, quiet, a glyph rather than a word.
  const pill = el('a', 'pill nav-search', '⌕');
  pill.href = '#search'; pill.setAttribute('aria-label', 'search'); pill.title = 'search  (⌘K)';
  pill.onclick = (e) => { e.preventDefault(); open(); };
  // Into the masthead's tool cluster, beside the theme switch — not the nav
  // itself, which on a phone is the tab bar at the bottom and would make
  // search a seventh tab.
  (document.getElementById('navtools') ?? nav).append(pill);

  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); overlay && !overlay.hidden ? close() : open(); }
    // Escape closes from anywhere on the page, not only while the input has
    // focus. Alex, 2026-09-05: "once you open search, make it close with ESC."
    // The input's own handler stopped working the moment focus left it.
    if (e.key === 'Escape' && overlay && !overlay.hidden) { e.preventDefault(); close(); }
  });
}
