/**
 * Loads every served page and its JavaScript the way a browser would, so a
 * broken page fails here instead of in Alex's hands.
 *
 * Run:  ./deploy/test.sh    (or directly:)
 *   docker run --rm -v "$PWD:/obligations" --entrypoint node obligations:latest \
 *     /obligations/deploy/agent-service/pages.test.mjs
 *
 * Why this exists: the chat page shipped with a syntax error that killed its
 * entire script — no sending, no history, no model picker — and none of the
 * existing checks noticed, because they tested the server's endpoints and the
 * .mjs modules, never the JavaScript those modules emit. `node --check` on the
 * module passes happily while the string it exports contains garbage.
 *
 * Two levels, because the cheap one alone would have missed half the bug:
 *   1. PARSE  — the script must be valid JavaScript.
 *   2. RUN    — the script must survive top-level execution against a stub DOM,
 *               which catches a missing element id or a typo'd handler that
 *               parses fine and then throws the moment the page loads.
 *
 * The stub DOM is deliberately dumb. It is not trying to be a browser; it is
 * trying to make "the page loaded without throwing" a testable statement.
 */
import { readFile } from 'node:fs/promises';
import { linkParts, linkLabel, trimQuoted } from './web/links.mjs';
import { TIER_LABEL, READS_HIMSELF } from './web/ui.mjs';
// The real functions, not fakes: they are pure and touch no DOM, so the page
// test exercises the code that actually runs rather than a stand-in that
// cannot disagree with it.
import { split as splitWhat, paragraphs as paragraphsOf } from './web/what.mjs';
import { PAGE } from './ui.mjs';
import { DASH_PAGES } from './dashboard.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? '/obligations';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, e) => { console.log(`  FAIL ${m}${e ? ' -> ' + e : ''}`); fail++; };

/* ---------------------------------------------------------------- stub DOM */

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [], style: { setProperty() {} }, dataset: {}, hidden: false,
    className: '', textContent: '', innerHTML: '', value: '', src: '', alt: '',
    title: '', disabled: false, files: [], scrollTop: 0, scrollHeight: 0,
    clientHeight: 0, listeners: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    prepend(...c) { this.children.unshift(...c); },
    insertBefore(c) { this.children.unshift(c); return c; },
    remove() {},
    removeChild() {},
    // Recorded, not discarded: a test that cannot fire a handler cannot check
    // anything the page does after load.
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener() {},
    fire(ev) { for (const fn of this.listeners[ev] ?? []) fn({}); },
    setAttribute() {}, getAttribute: () => null,
    scrollIntoView() {}, focus() {}, click() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    querySelector: () => null, querySelectorAll: () => [],
    matches: () => false,
    requestSubmit() {},
  };
  return el;
}

function makeDom() {
  const byId = new Map();
  const document = {
    createElement: (t) => makeEl(t),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl());
      return byId.get(id);
    },
    querySelector: () => makeEl(),
    querySelectorAll: () => [makeEl(), makeEl()],
    addEventListener() {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
  };
  return { document, byId };
}

/** A fetch that answers every endpoint these pages actually call. */
function makeFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    const bodies = {
      '/models': { models: [{ id: 'claude-opus-5', label: 'Opus 5', note: 'x' }], default: 'claude-opus-5' },
      '/history': { sessionId: 'abcdefgh-1234', messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: '# hi\n\n- a\n- b' },
        { role: 'tool', text: 'Read' },
      ], from: 0, total: 3, more: false },
      '/api/reading': { senders: 55, reason: null, items: [
        { id: 'm1', threadId: 'a1b2c3d4', account: 'personal', address: 'news@localpaper.example',
          from: 'The Gazette Newspaper', subject: 'This week in Springfield',
          at: 1788010000000, snippet: 'A snippet.', url: 'https://mail.google.com/' },
      ] },
      '/api/messages': { messages: [
        { id: 'x.md', kind: 'brief', at: '2026-08-28 07:00', title: 't', read: false,
          delivered: 'none', body: 'b' },
      ], unread: 1 },
      '/health': { ok: true, busy: false, sessionId: 'abcdefgh-1234' },
      '/api/outbox': { outbox: [
        { id: 'd.md', to: '+15551110000', status: 'draft', created: '2026-08-28 16:35',
          text: 'testing from obligations', chatId: null, approvedAt: null, sentAt: null, error: null },
        { id: 'e.md', to: '+15552220000', status: 'sent', created: '2026-08-27 10:00',
          text: 'already gone', chatId: null, approvedAt: null, sentAt: '2026-08-27 10:01', error: null },
      ], pending: 1 },
      '/api/outbox/count': { texts: 1, invites: 0, mail: 0, stale: 1 },
    };
    // The LONGEST matching prefix. First-match meant '/api/outbox' answered
    // '/api/outbox/count' with the draft list, and the page under test saw a
    // count of nothing — a harness bug that reads exactly like a page bug.
    const key = Object.keys(bodies).filter((k) => String(url).startsWith(k))
      .sort((a, b) => b.length - a.length)[0] ?? '/health';
    return { ok: true, status: 200, json: async () => bodies[key] };
  };
}

/* ------------------------------------------------------------------- tests */

let rendered = null;

async function checkPage(name, html) {
  // Every script the page pulls in, inline or referenced.
  const sources = [];
  for (const m of html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)) {
    const file = m[1].replace('/assets/', '');
    try {
      sources.push([m[1], await readFile(new URL(`./web/${file}`, import.meta.url), 'utf8')]);
    } catch (e) {
      bad(`${name}: referenced ${m[1]} is missing`, e.message);
      return;
    }
  }
  for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    sources.push(['(inline)', m[1]]);
  }
  if (!sources.length) { ok(`${name}: no script (nothing to break)`); return; }

  for (const [where, src] of sources) {
    // 1. PARSE
    let fn;
    try {
      // chat.js is an ES module now (it imports the shared renderer), so strip
      // the import line before parsing — the test is checking the page's own
      // code, and the imported module is checked separately by node --check.
      const body = src.replace(/^\s*import .*$/gm, '');
      // Imported names become parameters. Each one added here is a name the
      // page would otherwise hit as a ReferenceError on load — which is a real
      // failure mode (readable() was exactly that) but not one the stripped
      // import is evidence of, so the stub has to keep up with the imports.
      // Imported names become parameters — but ONLY the names this file
      // imports. Injecting every shared export into every file collided with a
      // page's own `const hhmm` and reported a syntax error no browser would
      // ever see. So: read the import lines, take their names, then strip them.
      const imported = [];
      for (const m of src.matchAll(/^\s*import\s*\{([^}]*)\}\s*from/gm)) {
        for (const n of m[1].split(',')) { const nm = n.trim().split(/\s+as\s+/).pop(); if (nm) imported.push(nm); }
      }
      fn = new Function('document', 'window', 'fetch', 'localStorage', 'setInterval',
                        'console', 'requestAnimationFrame', 'addEventListener', 'setTimeout',
                        'history', 'location', 'EventSource', 'CustomEvent',
                        ...imported, body);
      fn.imported = imported;
      ok(`${name} ${where}: parses`);
    } catch (e) {
      bad(`${name} ${where}: SYNTAX ERROR`, e.message);
      continue;
    }

    // 2. RUN against the stub DOM
    const { document, byId } = makeDom();
    const calls = [];
    const fetchStub = makeFetch(calls);
    try {
      // Capture console.error. The page threw a ReferenceError on load for
      // hours and this suite passed, because loadHistory's catch swallowed it
      // and reported a network problem instead. Silence is the assertion.
      const logged = [];
      const spy = { ...console, error: (...a) => logged.push(a.map(String).join(' ')) };
      /* Stubs for anything a page can import. A builder returns a real stub
       * element so append() and classList work; a formatter returns a string.
       * An imported name with no stub here is a real finding — a new shared
       * export the harness has not learned — so it throws by name. */
      const mk = (t) => () => document.createElement(t);
      const STUBS = {
        markdown: (t) => String(t), linkParts, linkLabel, trimQuoted, splitWhat, paragraphsOf,
        openState() {}, closeState() { return false; }, onStateChange() {}, stateFromUrl() { return null; },
        // The URL is the view (histate.mjs). A page reads it on load and
        // writes it on every change; here both are inert.
        readParams: () => ({}), writeView() {},
        el: (t) => document.createElement(t || 'div'), rel: () => '', hhmm: () => '', ms: () => 0,
        chip: mk('button'), chipRow: mk('div'), section: mk('div'), empty: mk('div'), link: mk('a'),
        obligationCard: mk('article'), decisionCard: mk('article'), personCard: mk('article'),
        messageCard: mk('article'), digestCard: mk('article'), eventCard: mk('article'),
        swipeable: (c) => c, composer: mk('form'), kindTag: mk('span'), keepButton: mk('button'),
        // The shared prose renderer (web/prose.mjs), used by the briefs and
        // the digest. It writes into the host it is given, like the real one.
        renderProse: (host, text) => { if (host) host.textContent = String(text ?? ''); },
        // The shared conversation-and-draft pane (web/draft-pane.mjs), used by
        // the To Do pane since the Outbox merged into it.
        renderThread: async (host) => { if (host) host.textContent = ''; return host; },
        draftFoot: mk('div'),
        // The reply box, shared by the Mail pane and the To Do pane (2026-09-30).
        replyBox: async (host) => { if (host) host.textContent = ''; return host; },
        // web/taskmap.mjs — the To Do map (2026-09-30).
        taskMap: (host) => { if (host) host.textContent = ''; },
        // web/project-forms.mjs — By project's doors (2026-10-04). Each draws into its host.
        projectForm: (host) => { if (host) host.textContent = ''; },
        archivedPane: async (host) => { if (host) host.textContent = ''; },
        rankEditor: async (host) => { if (host) host.textContent = ''; },
        projectsIndex: async () => [],
        // web/links.mjs — a stranger's text with its 400-character tracking
        // URLs shortened. Text in, text node out.
        renderText: (host, text) => { if (host) host.textContent = String(text ?? ''); return host; },
        /* web/mail-view.mjs — the sandboxed frame and the Text/As-sent switch,
           shared by Mail and the task pane since 2026-09-21. jsdom has no real
           iframe to measure, and the point of these page tests is that a
           script LOADS, so the frame is a div and the switch is the two
           elements its callers append. */
        mailFrame: mk('div'),
        mayHaveHtml: () => false,
        htmlSwitch: ({ texts } = {}) => ({ bar: mk('div')(), frames: mk('div')(),
                                           pick: () => { if (texts) texts.hidden = false; },
                                           loadHtml: async () => {} }),
        // The real map, not a fake: it is a plain object of words and the page
        // test should read the same names the page does.
        TIER_LABEL,
        READS_HIMSELF,
      };
      const injected = fn.imported.map((n) => {
        if (!(n in STUBS)) throw new Error(`pages.test has no stub for imported name "${n}" — add it to STUBS`);
        return STUBS[n];
      });
      fn(document, { addEventListener() {} }, fetchStub,
         { getItem: () => null, setItem() {} }, () => {}, spy,
         () => {},
         // setTimeout must NOT run its callback synchronously: real code
         // schedules follow-up work with it, and a synchronous stub turns a
         // settle-loop into unbounded recursion that looks like a page bug.
         () => {}, () => 0,
         { state: null, pushState() {}, replaceState() {}, back() {} },
         { hash: '', search: '' },
         // EventSource exists in a browser and not here; chat.js feature-detects
         // it, and passing undefined is what that detection expects to see.
         undefined,
         class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
         ...injected);
      // Let the top-level promise chains settle so a throw inside .then() surfaces.
      await new Promise((r) => setTimeout(r, 50));
      if (logged.length) {
        bad(`${name} ${where}: logged an error during load`, logged[0].slice(0, 160));
      } else {
        ok(`${name} ${where}: loads clean (fetched: ${calls.join(', ') || 'nothing'})`);
      }
      // The DOM the assertions below read must come from the page's real
      // modules, not from a bootstrap in the head. Inline scripts are collected
      // last, so a one-line theme stamp added to the shell on 2026-09-08
      // overwrote this with its own empty document and every chat assertion
      // failed at once — a harness bug that reads exactly like six broken
      // features.
      if (where !== '(inline)' || !rendered) rendered = byId;
    } catch (e) {
      bad(`${name} ${where}: THREW ON LOAD`, e.message);
    }
  }
}

console.log('Served pages');
await checkPage('chat', PAGE);

// Drafts waiting are ONE line in the chat, pointing at the Outbox — never a
// stack of cards. Alex, 2026-09-15, on a phone where six drafts covered the
// whole conversation. The earlier version of this block pinned a Send button
// here as "the entire boundary"; the boundary moved to /outbox, which carries
// the stale warnings and refuses without his identity, and a Send button in the
// chat is now a second, weaker copy of that decision. What still has to hold is
// the reason the old test existed: that a waiting draft cannot pass silently.
{
  const box = rendered?.get('outbox');
  const kids = box?.children ?? [];
  if (kids.length === 1) ok('chat: waiting drafts are one line, not a card each');
  else bad('chat: outbox rendering', `${kids.length} children`);
  const bar = kids[0];
  if (/1 waiting to send/.test(bar?.textContent ?? '')) ok('chat: it says how many are waiting');
  else bad('chat: the count is not shown', bar?.textContent);
  if (/may be out of date/.test(bar?.textContent ?? '')) ok('chat: a stale draft is called out, not hidden');
  else bad('chat: stale drafts are not mentioned', bar?.textContent);
  if (bar?.href === '/outbox' || bar?.getAttribute?.('href') === '/outbox') ok('chat: it takes him to the Outbox');
  else bad('chat: it does not link to the Outbox', bar?.href);
  const labels = (bar?.children ?? []).map((c) => c.textContent);
  if (!labels.includes('Send')) ok('chat: no Send button — sending happens where the warnings are');
  else bad('chat: a Send button is back in the chat', JSON.stringify(labels));
}

// Scroll anchoring: follow the conversation only while already at the bottom.
{
  const log = rendered?.get('log');
  if (log?.listeners?.scroll?.length) ok('chat: a scroll listener is registered (the anchor can release)');
  else bad('chat: no scroll listener — the anchor could never release');

  // After the first history render the view should be at the bottom.
  if (log && log.scrollTop === log.scrollHeight) ok('chat: opens pinned to the newest message');
  else bad('chat: does not open at the bottom', `scrollTop=${log?.scrollTop} scrollHeight=${log?.scrollHeight}`);
}
// notifications and briefs were folded into /digest on 2026-09-05; the
// redirects are covered by the route tests, and the digest page is in DASH_PAGES.
for (const [path, render] of Object.entries(DASH_PAGES)) {
  await checkPage(path.slice(1), await render(OBLIGATIONS, 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
