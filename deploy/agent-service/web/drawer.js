import { openState, closeState, onStateChange } from './histate.mjs';
/**
 * The chat as a drawer: slides in from the right, on top of whatever page you
 * are on, and stays open across page loads until you close it.
 *
 * Alex, 2026-09-03: "make the Chat a side bar that slides in from the right,
 * on top of the active page."
 *
 * ## Why an iframe
 *
 * The chat page owns a lot — a streaming turn, a session id, dictation, file
 * drops, an outbox panel, a composer that has to stay pinned above the keyboard
 * on a phone. Re-mounting all of that inside four other pages' documents means
 * four sets of id collisions and one script that must not assume it owns the
 * page. An iframe on `/?embed=1` is the same chat, unchanged, with its top bar
 * hidden because the host page already has one. The full page is one click
 * away from the drawer's own bar.
 *
 * The frame is created on first open, not on page load: five pages each
 * starting a chat session they may never show would be five sessions.
 */
// Any page with the site nav gets the drawer; the embedded chat itself does not.
const siteNav = document.querySelector('nav.links');

/**
 * Light or dark, and remembering which.
 *
 * Alex, 2026-09-08. Three states, not two: the default is to follow the
 * system, and only a press makes it explicit. That matters because most people
 * never touch it and a page that ignores the OS at night is the actual
 * complaint. The stamp is written by a tiny inline script in the page head so
 * the attribute is on <html> before the stylesheet resolves — set it here and
 * the page paints light, then corrects itself, which is worse than either.
 */
{
  const btn = document.getElementById('themetoggle');
  if (btn) {
    const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const current = () => document.documentElement.dataset.theme || (systemDark() ? 'dark' : 'light');
    const paint = () => { btn.textContent = current() === 'dark' ? 'light' : 'dark'; };
    paint();
    btn.onclick = () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('obligations.theme', next); } catch { /* private window */ }
      paint();
    };
    // Until he chooses, the OS is in charge and may change under him at sunset.
    window.matchMedia?.('(prefers-color-scheme: dark)')
      .addEventListener?.('change', () => { if (!document.documentElement.dataset.theme) paint(); });
  }
}

/* The drafts count no longer rides on a nav pill — see nav.mjs. `outboxCount`
 * stays defined because the draft pane calls it after a send, and a page that
 * shows the count itself (To Do's `drafted` filter) re-reads on its own. */
window.outboxCount = () => {};

if (siteNav && !document.body.classList.contains('embed')) {
  const KEY = 'obligations.drawer';
  let drawer = null, frame = null, backdrop = null;

  // The toggle is a floating button in the bottom-right corner, on every page,
  // where a thumb rests on a phone and a mouse can always reach. Alex,
  // 2026-09-03: "make the chat toggle an icon in the bottom right corner." The
  // nav pill goes back to being a plain link to the full page.
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'chatfab';
  fab.setAttribute('aria-label', 'chat');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
    + '<path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';
  document.body.appendChild(fab);

  function build() {
    backdrop = document.createElement('div');
    backdrop.className = 'chatdrawer-backdrop';
    backdrop.onclick = close;

    drawer = document.createElement('aside');
    drawer.className = 'chatdrawer';
    drawer.setAttribute('aria-label', 'chat');

    const bar = document.createElement('div');
    bar.className = 'chatdrawer-bar';
    const name = document.createElement('span');
    name.className = 'chatdrawer-name';
    name.textContent = 'chat';
    const full = document.createElement('a');
    full.href = '/chat';
    full.className = 'chatdrawer-full';
    full.textContent = 'open full ↗';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chatdrawer-close';
    x.setAttribute('aria-label', 'close chat');
    x.textContent = '×';
    x.onclick = close;
    bar.append(name, full, x);

    frame = document.createElement('iframe');
    frame.className = 'chatdrawer-frame';
    frame.title = 'chat';
    frame.src = '/chat?embed=1';   // the chat moved to /chat on 2026-09-05; / is Today
    ready = false;

    drawer.append(bar, frame);
    document.body.append(backdrop, drawer);
  }

  function open() {
    if (!drawer) build();
    document.body.classList.add('drawer-open');
    // A history entry, so the back swipe closes the chat rather than leaving
    // the page underneath it. See histate.mjs.
    openState('drawer', '1');
    drawer.classList.add('open');
    backdrop.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    fab.classList.add('open');
    try { localStorage.setItem(KEY, '1'); } catch {}
  }

  function close() {
    if (!drawer) return;
    document.body.classList.remove('drawer-open');
    drawer.classList.remove('open');
    backdrop.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
    fab.classList.remove('open');
    try { localStorage.setItem(KEY, '0'); } catch {}
  }

  // Through history, so the toggle, the close button and the swipe all travel
  // the same path.
  onStateChange('drawer', (id) => { if (!id) close(); });
  /* A page's composer (web/ui.mjs) speaks through this drawer. Open it, then
   * hand the text to the chat inside once it exists — on first open the iframe
   * is still loading, so wait for it. The chat page owns the turn from there:
   * SSE, approval cards, the transcript. */
  // Delivery to the chat frame is a handshake, not a guess. The frame posts
  // `obligations:ready` when its listeners are live; until then a say waits in the
  // queue. The first version attached a `load` listener at send time, and a
  // frame that had already loaded (the drawer remembers being open) never
  // fired it — Alex, 2026-09-06: "the sidebar opens up, but the question
  // doesn't show for a good minute."
  const queue = [];
  let ready = false;
  const flush = () => { while (ready && frame?.contentWindow && queue.length) frame.contentWindow.postMessage(queue.shift(), location.origin); };
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'obligations:ready') return;
    ready = true; flush();
  });
  window.addEventListener('obligations:say', (e) => {
    const { text, context } = e.detail ?? {};
    if (!text) return;
    open();
    queue.push({ type: 'obligations:say', text, context });
    // A frame that loaded before this page attached any listener is ready
    // too; ask it, and it answers with obligations:ready.
    if (frame?.contentWindow) { try { frame.contentWindow.postMessage({ type: 'obligations:ping' }, location.origin); } catch {} }
    flush();
  });
  // Where a page has its own composer the round button is redundant, and on a
  // phone it sat on top of the composer's send button.
  if (document.querySelector('.composer-dock')) fab.hidden = true;

  fab.onclick = () => (drawer && drawer.classList.contains('open')
    ? (closeState('drawer') || close())
    : open());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer && drawer.classList.contains('open')) close();
  });

  // Reopen where you left it. A drawer that closes on every navigation is a
  // page you have to keep re-opening, which is the thing a drawer is for.
  let wasOpen = false;
  try { wasOpen = localStorage.getItem(KEY) === '1'; } catch {}
  if (wasOpen) open();
}

/* THE MODEL SWITCH, ON EVERY PAGE. Alex, 2026-09-21: "I want to build a
   'Model Enabled' toggle, where we can turn on and off anything that requires
   a claude model."

   It rides here because the drawer is the one script every page loads, so a
   switched-off assistant says so on Today, on Mail, on To Do and on Briefs without
   seven page builders learning about it. Silent when runs are on: a banner
   that is always there is one nobody reads. */
(async () => {
  const bar = document.getElementById('modelgate');
  if (!bar) return;
  try {
    const g = await (await fetch('/api/model-gate')).json();
    if (!g || g.enabled || !g.status) return;   // on is the quiet case
    bar.textContent = g.status;
    const go = document.createElement('a');
    go.href = '/system#models';
    go.className = 'gatebar-go';
    go.textContent = 'turn back on';
    bar.append(' ', go);
    bar.hidden = false;
  } catch { /* the banner is never the thing that breaks a page */ }
})();

/* The control itself, on /system. Here rather than in a page script because
   this file already loads everywhere and already knows the endpoint. */
(() => {
  const box = document.getElementById('models');
  if (!box) return;
  const msg = document.getElementById('mg-msg');
  const say = (t) => { if (msg) msg.textContent = t; };

  async function flip(enabled, { why, until } = {}) {
    say(enabled ? 'turning back on…' : 'pausing…');
    try {
      const r = await fetch('/api/model-gate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, why, until }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? 'refused');
      location.reload();   // the card and the banner both describe the new state
    } catch (err) { say('could not change it: ' + (err?.message ?? err)); }
  }

  /* Tuesday 18:00 — when his Claude credits reset. Alex, 2026-09-21: "lets
     make it tuesday 6pm for the reset." A switch he has to remember to undo is
     one that stays off past the money coming back, which is the whole reason
     this button exists.

     The NEXT reset, which on a Tuesday afternoon is today rather than a week
     away: start at 18:00 today and step forward only while that moment is not
     a future Tuesday. Pausing at 15:00 on the day and being told "back on next
     week" would be wrong by six days. Computed here and sent as an absolute
     stamp — the server never guesses a date. */
  const nextReset = () => {
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    while (d.getDay() !== 2 || d <= new Date()) d.setDate(d.getDate() + 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const ask = () => {
    // A reason, for the same cause an outcome is required on a close: in a
    // week he cannot tell "out of credits" from "I was testing something".
    const why = prompt('Why are model runs pausing?', 'out of Claude credits for the week');
    return why && why.trim() ? why.trim() : null;
  };

  document.getElementById('mg-off')?.addEventListener('click', () => {
    const why = ask(); if (why) flip(false, { why });
  });
  document.getElementById('mg-off-week')?.addEventListener('click', () => {
    const why = ask(); if (why) flip(false, { why, until: nextReset() });
  });
  document.getElementById('mg-on')?.addEventListener('click', () => flip(true));
})();

/* The standing lists on Notes: Remove (autopay) and Un-ignore. Alex,
   2026-09-30: "where can you see the list of bills on autopay?" — "maybe
   under notes?" One confirm, because both change what reaches him. */
(() => {
  for (const b of document.querySelectorAll('[data-unlist]')) {
    b.addEventListener('click', async () => {
      const kind = b.dataset.unlist, key = b.dataset.key;
      const q = kind === 'autopay'
        ? `Take ${key} off autopay? Its next bill becomes a task again.`
        : `Un-ignore ${key}? Their mail is judged again, and tasks the ignore closed reopen.`;
      if (!confirm(q)) return;
      b.disabled = true; b.textContent = '…';
      try {
        const r = await fetch(kind === 'autopay' ? '/api/autopay/remove' : '/api/reading/unignore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error ?? 'refused');
        const rowEl = b.closest('.filed-row');
        if (rowEl) rowEl.replaceWith(Object.assign(document.createElement('div'), {
          className: 'mut', textContent: `${key} — ${kind === 'autopay' ? 'off autopay' : `un-ignored${d.reopened?.length ? `, ${d.reopened.length} reopened` : ''}`}` }));
      } catch (err) { b.textContent = 'could not: ' + (err?.message ?? err); b.disabled = false; }
    });
  }
})();
