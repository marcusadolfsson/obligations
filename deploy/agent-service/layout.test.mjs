/**
 * Narrow-viewport checks. These exist because a three-column table with prose in
 * the last column shipped to Alex's phone, where the prose column got about a
 * third of 390px and wrapped to one word per line. It was obvious on the device
 * and invisible from here.
 *
 * There is no browser in this environment, so this cannot measure layout. What
 * it can do is fail the specific structural mistakes that produce unreadable
 * narrow screens — which is most of them, because they are structural, not
 * subtle.
 */
import { readFile, readdir } from 'node:fs/promises';
import { PAGE } from './ui.mjs';
import { DASH_PAGES } from './dashboard.mjs';
import { NAV } from './nav.mjs';

const PHONE = 390;                 // iPhone logical width, the target to survive
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };

const OBLIGATIONS = process.env.OBLIGATIONS ?? '/obligations';
const pages = { chat: PAGE, };
for (const [path, render] of Object.entries(DASH_PAGES)) {
  pages[path.slice(1)] = await render(OBLIGATIONS, 0);
}

for (const [name, html] of Object.entries(pages)) {
  /* No timed reload. Alex, 2026-10-05: "Sometimes I am in the middle of
     writing a reply, and the page refreshes" — a three-minute meta refresh on
     every page that had not opted out, To Do's reply box among them. */
  if (/http-equiv=["']?refresh/i.test(html)) bad(`${name}: reloads itself on a timer`, 'a <meta http-equiv=refresh> throws away whatever he is typing');
  else ok(`${name}: no timed reload`);
  // A table is fine for short, aligned values. It is not fine for prose: at
  // 390px a third column of sentences becomes a column of single words.
  // Columns means cells in the widest ROW — not total <th> in the table. A
  // key/value table with one <th> per row is two columns and perfectly fine on
  // a phone; counting <th> tags called that a three-column table.
  const columns = (table) => Math.max(0, ...[...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((r) => (r[1].match(/<t[hd]\b/g) || []).length));
    // A markdown table inside .tablewrap scrolls in its own container — the
    // visual suite proves the page never scrolls sideways — so it is not the
    // failure this rule is about (a table crushing three columns to one word).
    // Strip those before counting; anything left is a real wide table.
    const htmlNoWrap = html.replace(/<div class=tablewrap>[\s\S]*?<\/table><\/div>/g, '');
  const wide = [...htmlNoWrap.matchAll(/<table[\s\S]*?<\/table>/g)]
    .map((t) => [t[0], columns(t[0])])
    .filter(([, n]) => n >= 3);
  if (!wide.length) ok(`${name}: no 3-column table (prose would wrap to one word per line)`);
  else bad(`${name}: has a ${wide[0][1]}-column table`,
           'use cards; a phone cannot give three columns meaningful width');

  if (/<meta name=viewport[^>]*width=device-width/.test(html)) ok(`${name}: declares a viewport`);
  else bad(`${name}: no width=device-width viewport`);
}

// Fixed pixel widths wider than a phone are the other reliable way to overflow.
for (const f of (await readdir(new URL('./web/', import.meta.url))).filter((n) => n.endsWith('.css'))) {
  const css = await readFile(new URL(`./web/${f}`, import.meta.url), 'utf8');
  const offenders = [...css.matchAll(/(?:^|[^-\w])(?:min-)?width\s*:\s*(\d{3,})px/g)]
    .map((m) => +m[1]).filter((n) => n > PHONE);
  if (!offenders.length) ok(`${f}: no fixed width above ${PHONE}px`);
  else bad(`${f}: fixed width ${offenders.join(', ')}px`, `wider than a ${PHONE}px screen`);

  // A textarea's intrinsic `cols` width is what overflowed the composer once.
  if (/textarea\{[^}]*min-width\s*:\s*0/.test(css.replace(/\s+/g, '')) || !/textarea\{/.test(css.replace(/\s+/g, ''))) {
    ok(`${f}: textarea cannot impose its intrinsic width`);
  } else {
    bad(`${f}: textarea without min-width:0`, 'its default cols width overflows a phone');
  }
}

// The three pages must offer the same navigation in the same order. They had
// drifted to three different sets in three different orders.
{
  const navs = {};
  for (const [name, html] of Object.entries(pages)) {
    const m = html.match(/<nav class=links>([\s\S]*?)<\/nav>/);
    navs[name] = m ? [...m[1].matchAll(/<a[^>]*>([^<]*)</g)].map((x) => x[1].replace(/\s*\(\d+\)/, '').trim()) : null;
  }
  const missing = Object.entries(navs).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) bad(`pages without a <nav class=links>: ${missing.join(', ')}`);
  else {
    const [first, ...rest] = Object.values(navs).map((v) => v.join(' | '));
    if (rest.every((r) => r === first)) ok(`nav is identical on all pages: ${first}`);
    else bad('nav differs between pages', Object.entries(navs).map(([k, v]) => `${k}: ${v.join(' | ')}`).join('\n         '));
  }
}

// Every link in the menu must lead somewhere. The nav is generated from one
// list now, so a typo there is a 404 on every page at once rather than on one.
{
  const served = new Set(['/', '/chat', ...Object.keys(DASH_PAGES)]);
  const dead = NAV.filter((n) => !served.has(n.path)).map((n) => n.path);
  if (!dead.length) ok(`every nav link is served (${NAV.length} pages)`);
  else bad(`nav links nothing serves: ${dead.join(', ')}`, 'the menu would 404');
}

// No single panel should be a wall of text. The journal once took 59% of the
// dashboard, which turned a page of modules back into a page you read.
//
// Measured as an absolute amount of visible text, not as a share of the page.
// A share is relative to its siblings, so the same 900-character journal passed
// or failed depending on whether now.md happened to be filled in that day —
// which is a property of Alex's week, not of the layout.
{
  const LIMIT = 1400;                 // characters of visible text in one panel
  for (const [name, html] of Object.entries(pages)) {
    if (name === 'chat' || name === 'notifications' || name === 'briefs') continue;
    // `/notes` is the reader. It exists to show now.md, todo.md and the journal,
    // and now.md has its own cap — 150 lines, enforced by the compaction
    // routine. Applying a 1400-character panel rule there would hide half a
    // legitimate week of state on the page whose whole job is showing it. The
    // rule was written against a MIXED page, where one long panel crowds out
    // the others; notes is not mixed.
    if (name === 'notes') continue;
    // Collapsed <details> is not on screen. The rule is about what a glance
    // shows, and a job report folded behind a summary line shows one line —
    // which is how /system can carry the full text Alex asked for without
    // becoming the wall this test exists to stop. An OPEN details still counts.
    const visible = html.replace(/<details(?![^>]*\bopen\b)[^>]*>[\s\S]*?<\/details>/g, '<details></details>');
    const panels = [...visible.matchAll(/<h2>([^<]*)<\/h2>([\s\S]*?)(?=<h2>|<\/div>\s*<script|$)/g)]
      .map((m) => [m[1], m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length]);
    const hog = panels.find(([, n]) => n > LIMIT);
    if (!hog) ok(`${name}: no panel over ${LIMIT} characters (${panels.length} panels)`);
    else bad(`${name}: "${hog[0]}" is ${hog[1]} characters`,
             'a dashboard page is a glance, not a reader — cap or link out');
  }
}

/**
 * The header sits in the same place on every page.
 *
 * Alex, 2026-09-03: "put the header in the same location as the other pages
 * so they don't bounce around." Notes and system used the centred 46rem column
 * while the two-pane pages filled the window, so the top bar jumped sideways by
 * half the leftover width on every navigation.
 *
 * Checked structurally rather than by pixel: every page's wrap must carry
 * `wide` (the frame), and only pages with a `.split` may carry `panes` (the
 * two-column behaviour). Those were one class, which is why the prose pages
 * could not match the header without inheriting a 100vh flex column.
 */
{
  for (const [name, html] of Object.entries(pages)) {
    // The chat page has no `.wrap`: it is a full-height app with a composer
    // docked to the bottom, and it is not in the nav — it is the corner
    // drawer, and its full-page form is reached from that drawer's own bar.
    // Nothing navigates between it and these, so nothing can bounce.
    if (name === 'chat') continue;
    const m = /<div class="wrap([^"]*)"/.exec(html);
    if (!m) { bad(`${name}: no wrap div`); continue; }
    const classes = m[1].trim().split(/\s+/).filter(Boolean);
    const hasSplit = /class=split|class="split/.test(html);
    if (!classes.includes('wide')) {
      bad(`${name}: wrap is not wide — its header will not line up with the others`);
    } else if (classes.includes('panes') !== hasSplit) {
      bad(`${name}: panes=${classes.includes('panes')} but split=${hasSplit}`,
          'panes is the two-column behaviour and belongs only to pages that have two columns');
    } else {
      ok(`${name}: wide frame${hasSplit ? ' + panes' : ''}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
