import { markdown } from './markdown.mjs';

const log = document.getElementById('log');
const form = document.getElementById('f');
const box = document.getElementById('t');
const btn = document.getElementById('b');
const status = document.getElementById('status');
const sid = document.getElementById('sid');
const modelSel = document.getElementById('model');
const chips = document.getElementById('chips');
const fileInput = document.getElementById('file');
const clip = document.getElementById('clip');
const jump = document.getElementById('jump');   // read by pin(), declared here
                                                // so it is never in a temporal
                                                // dead zone when pin runs

// Uploaded-and-staged attachments for the next turn: {name, path}. Cleared once
// the turn is sent — they live in the repo from then on, not in this list.
let pending = [];

function renderChips() {
  chips.textContent = '';
  pending.forEach((a, i) => {
    const el = document.createElement('span');
    el.className = 'chip';
    if (/\.(png|jpe?g|gif|webp)$/i.test(a.name)) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = '/file?path=' + encodeURIComponent(a.path);
      img.alt = a.name;
      el.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = a.name;
    const x = document.createElement('b');
    x.textContent = '×';
    x.title = 'Remove from this message (the file stays in inbox/)';
    x.onclick = () => { pending.splice(i, 1); renderChips(); };
    el.append(label, x);
    chips.appendChild(el);
  });
}

async function upload(files) {
  for (const file of files) {
    const chip = add('tool', '↑ uploading ' + file.name + '…');
    try {
      const res = await fetch('/upload', {
        method: 'POST',
        headers: {'x-filename': encodeURIComponent(file.name).replace(/%20/g, ' ')},
        body: file,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
      pending.push({name: d.name, path: d.path});
      renderChips();
      chip.textContent = '↑ ' + d.path + ' (' + Math.round(d.bytes / 1024) + ' KB)';
    } catch (err) {
      chip.className = 'err';
      chip.textContent = 'Upload failed for ' + file.name + ': ' + err.message;
    }
  }
}

clip.onclick = () => fileInput.click();
fileInput.onchange = () => { upload([...fileInput.files]); fileInput.value = ''; };

// Drag and drop anywhere on the page.
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, e => { e.preventDefault(); document.body.classList.add('drag'); });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, e => { e.preventDefault(); document.body.classList.remove('drag'); });
}
document.addEventListener('drop', e => {
  if (e.dataTransfer?.files?.length) upload([...e.dataTransfer.files]);
});

// Model picker. The last choice is remembered per browser; the server still
// validates it, so a stale value from an older build fails loudly rather than
// being passed through to the CLI.
fetch('/models').then(r => r.json()).then(({models, default: dflt}) => {
  const saved = (() => { try { return localStorage.getItem('obligations.model'); } catch { return null; } })();
  const chosen = models.some(m => m.id === saved) ? saved : dflt;
  // Two labels per option: the short name while closed, the descriptive one
  // while choosing. A native <select> renders option text in both states, so
  // the text is swapped around focus rather than adding a second control.
  const render = (expanded) => {
    for (const o of modelSel.options) {
      const m = models.find(x => x.id === o.value);
      if (!m) continue;
      o.textContent = expanded
        ? (m.note ? m.label + ' — ' + m.note : m.label)
        : (m.short || m.label);
    }
  };
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    if (m.id === chosen) opt.selected = true;
    modelSel.appendChild(opt);
  }
  render(false);
  modelSel.addEventListener('focus', () => render(true));
  modelSel.addEventListener('blur', () => render(false));
  modelSel.addEventListener('change', () => render(false));
}).catch(() => {
  const opt = document.createElement('option');
  opt.textContent = 'models unavailable';
  modelSel.appendChild(opt);
});

modelSel.onchange = () => {
  try { localStorage.setItem('obligations.model', modelSel.value); } catch {}
};

// --- scroll anchoring --------------------------------------------------------
// Follow the conversation only while the reader is already at the bottom.
const STICK_SLOP = 80;      // px from the bottom that still counts as "at the bottom"
let stick = true;

// Set while pin() is scrolling. Without it, the scroll event pin() itself causes
// recomputes `stick` against a layout that is still growing, concludes we are no
// longer at the bottom, and switches the anchor off — so every follow-up pin
// does nothing. That is why the page kept opening part-way up.
let pinning = 0;

function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_SLOP;
}

function pin() {
  if (!stick) { jump.classList.add('show'); return; }
  jump.classList.remove('show');
  pinning++;
  log.scrollTop = log.scrollHeight;
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; pinning--; });
}

/**
 * Hold the view at the bottom while the page settles. Fonts swap, images decode
 * and long lines rewrap for a while after the markup exists, and each of those
 * makes the content taller than it was when we last scrolled.
 */
function pinUntilSettled(ms = 1500) {
  const until = Date.now() + ms;
  const tick = () => {
    if (!stick || Date.now() > until) return;
    pin();
    setTimeout(tick, 100);
  };
  tick();
  document.fonts?.ready?.then(pin).catch(() => {});
}

/**
 * What a pending tool call looks like on the approval card.
 *
 * Deleted in a restyle on 2026-08-29 while its only caller stayed, which threw
 * a ReferenceError inside the `approval` branch, killed the SSE reader and
 * surfaced as "Lost the connection to the agent". Six days of the web chat
 * being unable to approve anything — including, per CLAUDE.md, the permission
 * prompt that IS the gate on sending mail as Alex.
 *
 * It shows the command, path or URL rather than the raw JSON, because this is
 * the string he reads before deciding. Falls back to the whole object when the
 * tool has no obvious subject, and to the raw text when it will not parse — an
 * approval card that renders nothing is one you cannot safely say yes to.
 */
function readable(input) {
  try {
    const o = typeof input === 'string' ? JSON.parse(input) : input;
    return o.command || o.file_path || o.path || o.url || JSON.stringify(o, null, 1);
  } catch {
    return String(input);
  }
}

/* The approval card.
 *
 * Drawn from either stream: the turn's own SSE while the page is live, and the
 * durable /api/events channel, which replays anything still unanswered when a
 * dropped page comes back. Hence the dedupe — after a reconnect the same
 * question legitimately arrives twice.
 */
const shownApprovals = new Map();      // id -> card element

function approvalCard(d) {
  if (shownApprovals.has(d.id)) return shownApprovals.get(d.id);
  const card = document.createElement('div');
  card.className = 'ask';
  shownApprovals.set(d.id, card);

  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = 'approve ' + d.tool + '?';
  const pre = document.createElement('pre');
  pre.textContent = readable(d.input);

  const yes = document.createElement('button');
  yes.className = 'allow';
  yes.textContent = 'Approve';
  const no = document.createElement('button');
  no.textContent = 'Deny';

  const answer = async (decision, always = false) => {
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    try {
      await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: d.id, decision, always }),
      });
      hd.textContent = decision !== 'allow' ? 'denied'
                     : always ? 'approved — and remembered' : 'approved';
      for (const b of card.querySelectorAll('button')) b.remove();
    } catch {
      for (const b of card.querySelectorAll('button')) b.disabled = false;
    }
  };
  yes.onclick = () => answer('allow');
  no.onclick = () => answer('deny');
  card.append(hd, pre, yes);

  /* "Always" only where the server says the tool qualifies. It is not offered
   * for Bash or WebFetch, and the reason is worth knowing: for those the
   * payload is the decision, so remembering the TOOL would be remembering every
   * command or URL anyone can ever put in one — including one an injected email
   * suggests. The server re-checks; this flag only decides what is drawn. */
  if (d.remember) {
    const always = document.createElement('button');
    always.className = 'always';
    always.textContent = 'Always';
    always.title = 'Approve this, and stop asking for ' + d.tool;
    always.onclick = () => answer('allow', true);
    card.append(always);
  }
  card.append(no);

  log.appendChild(card);
  pin();
  return card;
}

/* The question was settled — answered here, answered on another page, or timed
 * out. Retire the card rather than leaving a live one that invites a second,
 * contradictory tap. */
function retireApproval(d) {
  const card = shownApprovals.get(d.id);
  if (!card) return;
  for (const b of card.querySelectorAll('button')) b.remove();
  const hd = card.querySelector('.hd');
  if (hd && /^approve /.test(hd.textContent)) hd.textContent = d.why ?? 'settled';
}

/* The composer on other pages hands its text to this page through the drawer.
 * `context` is what that page was looking at — "on /work, Cabinetry vendor" —
 * so "push this to Friday" means something. It rides along on the next POST
 * only, then is cleared: a stale context on a later message would be a lie. */
let pendingContext = null;
function takeContext() { const c = pendingContext; pendingContext = null; return c; }
// What a send from another page waits on while a turn is running. Shown at
// once as a bubble marked queued, sent the moment the turn ends — never
// dropped, which is what the old early return on a disabled button did.
const queued = [];
let running = false;
const IDLE_HINT = box.placeholder || 'Tell the assistant…';
function setRunning(on) {
  running = on;
  box.placeholder = on ? 'Queue for after this turn…' : IDLE_HINT;
  form.classList.toggle('running', on);
}
function drain() {
  if (running || !queued.length) return;
  const q = queued.shift();
  q.el?.remove();
  pendingContext = q.context;
  box.value = q.text;
  form.requestSubmit();
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;               // only our own drawer
  const d = e.data;
  if (d?.type === 'obligations:ping') { if (historyReady) window.parent?.postMessage({ type: 'obligations:ready' }, location.origin); return; }
  if (!d || d.type !== 'obligations:say' || typeof d.text !== 'string' || !d.text.trim()) return;
  const context = d.context ? JSON.stringify(d.context).slice(0, 500) : null;
  if (running) {
    const el = add('me queued', d.text);
    el.append(contextChip(context));
    el.append(noteEl('queued — a turn is running; sent when it ends'));
    queued.push({ text: d.text, context, el });
    return;
  }
  pendingContext = context;
  box.value = d.text;
  form.requestSubmit();
});
/**
 * Ready means *history is on screen*, not merely that a listener exists.
 *
 * Sending from a task opened the drawer, the frame announced itself at once,
 * and the turn began while the first `/history` fetch was still in flight —
 * so thirty older messages landed underneath the live answer and the pin
 * scrolled to them. Alex, 2026-09-07: "I don't see anything, and it just
 * sits there." The queue in the drawer holds the message until this fires.
 */
let historyReady = false;
function announceReady() {
  historyReady = true;
  if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'obligations:ready' }, location.origin);
}

/** His words, with the model's preamble taken off. Both prefixes are ours. */
function stripPreamble(raw) {
  let text = String(raw ?? ''), context = null;
  text = text.replace(/^\[Now:[^\]]*\]\s*\n+/, '');
  const m = /^\[Context: ([\s\S]*?)\]\s*\n+([\s\S]*)$/.exec(text);
  if (m) { context = m[1]; text = m[2]; }
  return { text: text.trim(), context };
}

/** The page context a send carried, as a quiet chip rather than raw JSON. */
function contextChip(ctx) {
  const chip = document.createElement('span');
  chip.className = 'ctx';
  if (!ctx) return chip;
  let c = null; try { c = JSON.parse(ctx); } catch {}
  chip.textContent = c && typeof c === 'object'
    ? 'from ' + [c.page, c.open && String(c.open).slice(0, 48), c.filter].filter(Boolean).join(' · ')
    : String(ctx).slice(0, 80);
  return chip;
}
function noteEl(text) { const n = document.createElement('div'); n.className = 'note'; n.textContent = text; return n; }

/* /chat?say=… pre-fills the box and leaves the cursor at the end. The debrief
 * message links here with "Debrief PHOA with Hank: " so answering is one tap
 * and a sentence. Pre-fill, never auto-send: the text is a prompt for him, not
 * something anyone else typed. */
{
  const say = new URLSearchParams(location.search).get('say');
  if (say && box && !box.value) {
    box.value = say;
    setTimeout(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 60);
  }
}

/**
 * The live line while the model works: a pulsing dot and a verb that changes
 * every few seconds — Thinking…, Tinkering…, Reading… — the way Claude's own
 * interface does it. Folds into "Thought for Ns" over the reasoning when there
 * was any, disappears when there was not.
 */
const VERBS = ['Thinking…', 'Tinkering…', 'Considering…', 'Reading…', 'Working…', 'Mulling…', 'Checking…', 'Puzzling…', 'Sorting…', 'Weighing…'];
function thinkingLine() {
  const el = document.createElement('details');
  el.className = 'think live';
  const sum = document.createElement('summary'); sum.textContent = VERBS[0];
  const body = document.createElement('div'); body.className = 'think-body';
  el.append(sum, body);
  let i = 0;
  const tick = setInterval(() => {
    if (!el.classList.contains('live') || !el.isConnected) { clearInterval(tick); return; }
    i = (i + 1 + Math.floor(Math.random() * 3)) % VERBS.length;
    sum.textContent = VERBS[i];
  }, 2800);
  log.appendChild(el);
  pin();
  return el;
}

/** "Bash — git status" with a spinner glyph while it runs. */
function toolLabel(name, what) {
  const w = document.createElement('span');
  w.className = 'tool-label';
  const n = document.createElement('b'); n.textContent = name;
  w.append(n);
  if (what) { w.append(' — '); const t = document.createElement('span'); t.className = 'tool-what'; t.textContent = what; w.append(t); }
  return w;
}

function add(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  log.appendChild(el);
  pin();
  return el;
}

function grow() {
  // Let CSS own the ceiling (max-height:33dvh) instead of duplicating a pixel
  // figure here that would silently disagree with it.
  box.style.height = 'auto';
  box.style.height = box.scrollHeight + 'px';
  measureDock();
}
box.addEventListener('input', grow);

/**
 * The composer floats over the transcript, so the transcript pads itself by the
 * composer's height. That height is not a constant — it changes when the box
 * grows, when a file chip appears, when the status line fills — and a stale
 * figure hides the newest message behind the thing you are typing into.
 */
const dock = document.querySelector('.dock');
function measureDock() {
  if (!dock) return;
  const h = dock.getBoundingClientRect().height;
  if (!h) return;
  document.documentElement.style.setProperty('--dockh', h + 'px');
  pin();                     // no-op unless we were already following the tail
}
if (dock && typeof ResizeObserver === 'function') new ResizeObserver(measureDock).observe(dock);
measureDock();

box.addEventListener('keydown', e => {
  // Enter inserts a newline. On a phone there is no shift key worth reaching
  // for, and losing a half-written paragraph to a stray return is worse than
  // needing to tap send. A hardware keyboard still gets cmd/ctrl-enter.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// --- history -----------------------------------------------------------------
// The session lives on disk and outlives this page, so without a redraw the
// agent remembers the whole thread and the browser shows an empty box — which
// reads as data loss even though nothing was lost. A long thread loads a window
// at a time: newest on open, older as you scroll up.
let oldest = null;      // index of the earliest message currently rendered
let more = false;       // is anything older still on the server
let loading = false;
let marker = null;      // the "scroll up for older" hint, when there is more

function renderMessage(m, prepend) {
  const el = document.createElement('div');
  if (m.role === 'tool') {
    el.className = 'tool done';
    el.append(toolLabel(m.text, m.what));
  } else if (m.role === 'user') {
    el.className = 'me';
    // What he typed, not what the model was told. Every turn is prefixed with
    // the wall clock and, from a page, its context; both are for the model.
    // Alex, 2026-09-07, seeing them in his own bubble: "the question should
    // probably [be] better formatted".
    const { text, context } = stripPreamble(m.text ?? '');
    el.textContent = text;
    if (context) el.append(contextChip(context));
  } else {
    el.className = 'obligations';
    el.innerHTML = markdown(m.text);
  }
  // The event ticker places system lines among these by time; without the stamp
  // it would have nothing to compare against and could only append.
  if (m.at) el.dataset.at = String(Date.parse(m.at));
  if (prepend) log.prepend(el); else log.appendChild(el);
  return el;
}

/* --- the running context ------------------------------------------------------
 * What the system did while you were sitting here: a brief landed, a digest is
 * ready, a login code went to your phone. Alex, 2026-09-04.
 *
 * These are not turns. Nothing here went through the model, so a system line is
 * drawn as a line and never as a bubble — it must not be mistakable for
 * something the assistant said to you, because it is something the assistant DID.
 *
 * The source is /api/messages, the same list /briefs and /notifications render,
 * so the curation (rules/messages.md: never write a message for a routine
 * no-op) already happened upstream and there is no second policy here to drift.
 */
const KIND_PAGE = { brief: '/briefs', note: '/briefs' };   // the rest are /notifications
const seenEvents = new Set();

function renderEvent(m, before) {
  // A div, not a link. Alex, 2026-09-04: "clicking on it should expand
  // inline, not navigate me away." Sending him to /briefs to read one line
  // costs him the conversation he was in the middle of — and the body is
  // already here in the payload, so the round trip bought nothing.
  const el = document.createElement('div');
  el.className = 'sys' + (m.read ? '' : ' fresh');
  if (m.at) el.dataset.at = String(Date.parse(String(m.at).replace(' ', 'T')));

  const head = document.createElement('div');
  head.className = 'sys-head';
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', 'false');
  const k = document.createElement('span');
  k.className = 'sys-kind';
  k.textContent = m.kind ?? 'note';
  const t = document.createElement('span');
  t.className = 'sys-title';
  t.textContent = m.title ?? m.id;
  const w = document.createElement('span');
  w.className = 'sys-when';
  w.textContent = String(m.at ?? '').slice(11, 16);
  head.append(k, t, w);

  const body = document.createElement('div');
  body.className = 'sys-body';
  body.hidden = true;
  // The message body is markdown the system wrote — the same renderer the
  // transcript uses. It is not a model reply, so it stays inside the system
  // line's own frame rather than being drawn as one.
  body.innerHTML = markdown(m.body ?? '');
  const open = document.createElement('a');
  open.className = 'sys-open';
  open.href = (KIND_PAGE[m.kind] ?? '/notifications') + '#' + encodeURIComponent(m.id);
  open.target = '_top';                  // in the drawer, open the page, not the iframe
  open.textContent = 'open on its page ›';
  body.append(open);

  const toggle = () => {
    const show = body.hidden;
    // Hold this row exactly where it is. Alex, 2026-09-04: "when you expand a
    // message in the chat don't scroll to the bottom of message." Expanding
    // inserts content BELOW the header, so the header has no reason to move —
    // and pin(), which this used to call, scrolls to the tail, throwing the
    // reader to the end of the thing they just asked to see the start of.
    // Collapsing needs the same care in reverse: the log shrinks, the browser
    // clamps scrollTop, and the row slides. Measure, then correct.
    const before = head.getBoundingClientRect().top;
    body.hidden = !show;
    el.classList.toggle('open', show);
    head.setAttribute('aria-expanded', show ? 'true' : 'false');
    // Opening one is a deliberate departure from following the tail. Release
    // the anchor, or the next pin() — the dock's ResizeObserver fires one —
    // drags the view back down in the middle of reading.
    if (show) { stick = false; jump.classList.add('show'); }
    log.scrollTop += head.getBoundingClientRect().top - before;
  };
  head.onclick = toggle;
  head.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };

  el.append(head, body);
  if (before) log.insertBefore(el, before); else log.appendChild(el);
  return el;
}

/* Place an event among what is currently drawn, by time.
 *
 * The transcript is paginated and the event list is not, so an event older than
 * the oldest drawn message has no honest place on this screen. It is not lost —
 * it is on /briefs, where it is the point of the page. Appending it instead
 * would put a 04:00 job failure underneath a 09:00 reply and say something
 * false about when it happened. */
function placeEvent(m) {
  if (!m || !m.id || seenEvents.has(m.id)) return;
  const t = Date.parse(String(m.at ?? '').replace(' ', 'T'));
  if (Number.isNaN(t)) return;
  seenEvents.add(m.id);
  const rows = [...log.children].filter((r) => r.dataset.at);
  for (const row of rows) {
    if (Number(row.dataset.at) > t) { renderEvent(m, row); return; }
  }
  renderEvent(m, null);
}

async function backfillEvents() {
  try {
    const r = await fetch('/api/messages');
    const d = await r.json();
    for (const m of (d.messages ?? [])) placeEvent(m);
  } catch (err) { console.error('events backfill failed', err); }
}

/* Live. An EventSource reconnects on its own, which is why it is used here
 * rather than the hand-rolled SSE the turn uses: this stream stays open while
 * the page is idle, which is exactly when a phone drops it. */
function openEvents() {
  // Feature-detect rather than catch-and-log. A runtime without EventSource
  // (the stub DOM the page tests parse against, an old browser) simply has no
  // ticker — that is a missing feature, not a fault, and reporting it as an
  // error trains the eye to skip a line that will one day mean something.
  if (typeof EventSource !== 'function') return;
  let es;
  try { es = new EventSource('/api/events'); } catch (err) { console.error('events', err); return; }
  es.addEventListener('message', (e) => {
    try {
      const wasAtTail = stick;
      placeEvent(JSON.parse(e.data));
      if (wasAtTail) pin();
    } catch { /* a malformed frame must not break the stream */ }
  });
  /* Approvals arrive here as well as on the turn's own stream, and this is the
   * copy that survives a dropped connection: on reconnect the server replays
   * everything still unanswered, so a reloaded page can finish a turn it was
   * never watching. */
  es.addEventListener('approval', (e) => {
    try { approvalCard(JSON.parse(e.data)); } catch { /* ignore a bad frame */ }
  });
  es.addEventListener('approval-gone', (e) => {
    try { retireApproval(JSON.parse(e.data)); } catch { /* ignore a bad frame */ }
  });
}

async function loadHistory(before) {
  if (loading) return;
  loading = true;
  const first = before === undefined;
  try {
    const res = await fetch('/history?limit=30' + (first ? '' : '&before=' + before));
    const h = await res.json();
    if (h.sessionId) sid.textContent = h.sessionId.slice(0, 8);
    if (h.error) { add('tool', 'could not load history: ' + h.error); return; }

    if (marker) { marker.remove(); marker = null; }

    if (first) {
      for (const m of h.messages ?? []) renderMessage(m, false);
      stick = true;
      pinUntilSettled();
      if (h.total) status.textContent = h.total + ' messages in this conversation';
    } else {
      // Prepending changes the scroll height under the reader's thumb. Measure
      // first, restore the offset after, so the view doesn't jump.
      const hBefore = log.scrollHeight, tBefore = log.scrollTop;
      for (const m of [...(h.messages ?? [])].reverse()) renderMessage(m, true);
      log.scrollTop = tBefore + (log.scrollHeight - hBefore);
    }

    oldest = h.from;
    more = !!h.more;
    if (more) {
      marker = document.createElement('div');
      marker.className = 'tool';
      marker.textContent = '↑ scroll up for older messages';
      log.prepend(marker);
    }
  } catch (err) {
    // A history failure must not take the page down. But this catch previously
    // swallowed a ReferenceError from a missing function and made broken code
    // look like a network hiccup, so say so loudly as well as degrading.
    console.error('history failed', err);
    status.textContent = 'could not load history: ' + (err?.message ?? err);
    fetch('/health').then(r => r.json()).then(h => {
      if (h.sessionId) sid.textContent = h.sessionId.slice(0, 8);
    }).catch(() => {});
  } finally {
    loading = false;
  }
}

// --- dictation ---------------------------------------------------------------
// Not from the SDK — it has none. Its `voice` setting is Claude Code's own
// terminal dictation, not something a web page can call. This is the browser's
// Web Speech API, which iOS Safari has had since 14.5: nothing leaves the
// device beyond what Apple's own dictation already sends, and there is no
// service to run or key to hold.
const mic = document.getElementById('mic');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR && mic) {
  mic.hidden = false;
  let rec = null;
  mic.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;

    // Anchor to whatever was already typed, so dictation appends rather than
    // replacing a half-written message.
    const base = box.value ? box.value.replace(/\s*$/, ' ') : '';
    mic.classList.add('rec');
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      box.value = base + text;
      grow();
    };
    const end = () => { mic.classList.remove('rec'); rec = null; box.focus(); };
    rec.onerror = (e) => { status.textContent = 'dictation: ' + e.error; end(); };
    rec.onend = end;
    rec.start();
  };
}

jump.onclick = () => { stick = true; log.scrollTop = log.scrollHeight; jump.classList.remove('show'); };

log.addEventListener('scroll', () => {
  // Ignore scrolls that pin() caused; only a real gesture releases the anchor.
  if (pinning > 0) return;
  stick = atBottom();
  jump.classList.toggle('show', !stick);
  if (log.scrollTop < 80 && more && !loading) loadHistory(oldest);
});
// History first, then the system lines placed among it — the reverse order
// would have nothing to place them against and would pile them all at the end.
loadHistory().then(backfillEvents).then(openEvents).finally(announceReady);

// Fresh conversation. The old transcript stays on disk — this forgets the
// session id, it does not delete anything.
document.getElementById('newchat').onclick = async () => {
  const r = await fetch('/api/session/new', {method: 'POST'});
  if (r.ok) {
    log.textContent = '';
    // The ticker's dedupe is per-render, not per-session. Without this the
    // system lines are wiped from the log and never come back, because every
    // one of them is still marked seen.
    seenEvents.clear();
    sid.textContent = '';
    status.textContent = 'new conversation — the previous one is still on disk';
    oldest = null; more = false; marker = null;
  } else {
    status.textContent = 'could not start a new conversation';
  }
};

// --- outbox ------------------------------------------------------------------
// One line saying drafts are waiting, and where to send them — not the drafts.
//
// Alex, 2026-09-15, with a phone screenshot: "these messages have stacked up
// as overlays and makes it impossible to view the chat." This block predates
// the Outbox page. It rendered every pending draft as a full card above the
// conversation, so six waiting texts filled the screen before a word of chat —
// and it rendered them WITHOUT the stale warnings the Outbox page carries, so two
// different drafts to Ari sat one above the other, each with a Send button and
// neither mentioning the other.
//
// Sending belongs where the warnings are. The Outbox page names the recipient,
// says what has stopped being true, and refuses without the signed-in identity;
// a second, thinner copy of that decision inside the chat was the weaker one.
// It reads the count endpoint, which is local files only — the old version
// fetched every Gmail draft from both accounts every thirty seconds.
const outboxEl = document.getElementById('outbox');

async function loadOutbox() {
  let d;
  try { d = await (await fetch('/api/outbox/count')).json(); } catch { return; }
  const n = (d.texts ?? 0) + (d.invites ?? 0) + (d.mail ?? 0);
  outboxEl.textContent = '';
  if (!n) return;
  const bar = document.createElement('a');
  bar.className = 'outbox-bar' + (d.stale ? ' has-stale' : '');
  bar.href = '/outbox';
  // Inside the drawer the chat is a frame; the Outbox should open as the page.
  bar.target = '_top';
  bar.textContent = `${n} waiting to send`
    + (d.stale ? ` · ${d.stale} may be out of date` : '')
    + ' — review on Outbox ›';
  outboxEl.appendChild(bar);
}
loadOutbox();
setInterval(loadOutbox, 30000);

// Unread badge, so the queue is visible from the page you actually sit on.
fetch('/api/messages').then(r => r.json()).then(d => {
  // The pill this badges is Briefs — it was renamed on 2026-09-06 and this
  // line kept relabelling it "messages", which is what the chat page showed.
  const badge = document.querySelector('#msglink .navbadge');
  if (badge) badge.textContent = d.unread ? String(d.unread) : '';
}).catch(() => {});

const stopBtn = document.getElementById('stop');
stopBtn.onclick = async () => {
  stopBtn.disabled = true;
  try {
    await fetch('/stop', {method: 'POST'});
    status.textContent = 'stopping…';
  } catch { /* the turn ends on its own or the connection is already gone */ }
};

form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = box.value.trim();
  if (!text && !pending.length) return;
  // Typed while a turn runs: queued, shown at once, sent when the turn ends —
  // the composer says so. Claude's own UI does the same.
  if (running) {
    const el = add('me queued', text);
    if (pendingContext) el.append(contextChip(pendingContext));
    el.append(noteEl('queued — sent when this turn ends'));
    queued.push({ text, context: pendingContext, el });
    pendingContext = null; box.value = ''; grow();
    return;
  }

  // You just sent something; you want to watch the reply regardless of where
  // you had scrolled to.
  stick = true;

  const attachments = pending.map(a => a.path);
  const mine = add('me', stripPreamble(text).text + (attachments.length ? '\n― ' + attachments.join(', ') : ''));
  if (pendingContext) mine.append(contextChip(pendingContext));
  // Kept so a turn the service lost can be sent again with one tap.
  const sentAt = Date.now(), sentText = text, sentContext = pendingContext, sentPending = pending.slice();
  pending = [];
  renderChips();
  box.value = '';
  grow();
  btn.disabled = true;
  setRunning(true);
  status.textContent = 'thinking…';

  let bubble = null, raw = '', finished = false;
  // The thinking line, the way Claude's own UI does it: a shimmering
  // "Thinking…" the instant the message goes, folding into "Thought for Ns"
  // with the reasoning behind a disclosure when the model reasoned, gone when
  // it did not. Alex, 2026-09-06: "When the agent is thinking, let's mimic
  // Claude's user interface."
  const thinkStart = Date.now();
  let think = thinkingLine();
  let thought = '';
  const settleThinking = () => {
    if (!think) return;
    const secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
    if (thought.trim()) { think.classList.remove('live'); think.querySelector('summary').textContent = `Thought for ${secs}s`; }
    else think.remove();
    think = null;
  };
  try {
    const res = await fetch('/message', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text, model: modelSel.value || undefined, attachments, context: takeContext()}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // The single-flight guard: the assistant runs one thing at a time, and a
        // job (usually mail) can hold it for a few minutes. A message that
        // arrives then waits, visibly, and goes when the assistant is free — it
        // is not an error and he should not have to retype it. Alex,
        // 2026-09-06, after "A turn is already running … Try again".
        mine.classList.add('queued');
        const note = noteEl('the assistant is busy' + (body.busyWith ? ` with the ${body.busyWith === 'chat' ? 'previous turn' : body.busyWith + ' job'}` : '') + ' — sent when it is free');
        mine.append(note);
        for (;;) {
          await new Promise((r) => setTimeout(r, 4000));
          try {
            const h = await (await fetch('/health')).json();
            note.textContent = 'the assistant is busy' + (h.busyWith ? ` with the ${h.busyWith === 'chat' ? 'previous turn' : h.busyWith + ' job'}` : '') + ' — sent when it is free';
            if (!h.busy) break;
          } catch { /* keep waiting */ }
        }
        mine.remove();
        queued.unshift({ text: sentText, context: sentContext, el: null });
        pending = sentPending;
        return;
      }
      add('err', body.error || ('HTTP ' + res.status));
      return;
    }

    // SSE over a POST response, so EventSource is not an option: parse the
    // event stream off the body reader by hand. Frames are separated by a
    // blank line; we only care about the last data: line in each frame.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = 'message', data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        let d = {};
        try { d = JSON.parse(data); } catch { continue; }

        if (event === 'session' && d.sessionId) {
          sid.textContent = d.sessionId.slice(0, 8);
        } else if (event === 'thinking') {
          if (!think) think = thinkingLine();
          thought += d.text;
          think.querySelector('.think-body').textContent = thought;
        } else if (event === 'text') {
          settleThinking();
          if (!bubble) { bubble = add('obligations', ''); raw = ''; }
          // Keep the raw markdown and re-render the whole bubble each chunk:
          // a partial stream can split a fence or a list mid-way, so rendering
          // incrementally would produce markup that never closes.
          raw += d.text;
          bubble.innerHTML = markdown(raw);
          pin();
        } else if (event === 'tool') {
          settleThinking();
          // Name and what it is doing, live until the result lands. Alex,
          // 2026-09-06: "the output is just · Bash · Bash … No indicator on
          // what is happening."
          const row = add('tool running', '');
          row.dataset.tool = d.id ?? '';
          row.append(toolLabel(d.name, d.what));
          bubble = null;
          raw = '';
        } else if (event === 'tool_done') {
          const row = d.id && log.querySelector(`.tool[data-tool="${d.id}"]`);
          if (row) {
            row.classList.remove('running'); row.classList.add(d.ok === false ? 'failed' : 'done');
            if (d.preview) row.append(noteEl(d.preview));
          }
        } else if (event === 'approval') {
          approvalCard(d);
          bubble = null;
        } else if (event === 'auto') {
          // A yes he gave earlier, being spent. Shown, never silent: the point
          // of remembering is to skip the interruption, not to hide the action.
          add('tool', '· ' + d.tool + ' (auto-approved)');
          bubble = null;
        } else if (event === 'stopped') {
          finished = true;
          status.textContent = 'stopped';
        } else if (event === 'error') {
          add('err', d.error);
        } else if (event === 'result') {
          finished = true;
          status.textContent = d.isError
            ? 'ended with an error'
            : Math.round(d.durationMs / 100) / 10 + 's · $' + (d.costUSD || 0).toFixed(3);
        }
      }
    }
  } catch (err) {
    add('err', 'Lost the connection to the agent: ' + err.message);
  } finally {
    settleThinking();
    btn.disabled = false;
    setRunning(false);
    drain();
    stopBtn.style.display = 'none';

    // The stream ended without the turn reporting a result. On a phone this is
    // routine — a backgrounded tab or a cellular blip drops the connection —
    // and the turn keeps running on the server regardless. The answer is in the
    // session transcript, so go and get it rather than leaving a half-finished
    // turn on screen looking like the agent died.
    if (!finished) {
      status.textContent = 'connection dropped — checking whether the turn is still running…';
      const started = Date.now();
      const poll = setInterval(async () => {
        try {
          const h = await (await fetch('/health')).json();
          // The service restarted after this turn began: the turn is gone,
          // not late. Say so and offer the same message again, rather than
          // reloading history and calling it "the answer is above".
          if (h.started && Date.parse(h.started) > sentAt) {
            clearInterval(poll);
            const when = new Date(h.started).toTimeString().slice(0, 5);
            const el = add('err', `The service restarted at ${when} while this turn was running, so it did not finish.`);
            const again = document.createElement('button');
            again.type = 'button'; again.textContent = 'Send it again';
            again.onclick = () => { again.disabled = true; pendingContext = sentContext; pending = sentPending; box.value = sentText; form.requestSubmit(); };
            el.append(' ', again);
            status.textContent = 'not finished';
            return;
          }
          if (h.busy && Date.now() - started < 10 * 60 * 1000) { status.textContent = 'connection dropped — the turn is still running, waiting for it…'; return; }
          clearInterval(poll);
          log.textContent = '';
          oldest = null; more = false; marker = null;
          await loadHistory();
          status.textContent = 'reconnected — the answer is above';
        } catch {
          clearInterval(poll);
          status.textContent = 'connection lost; reload to pick the answer up';
        }
      }, 3000);
    }

    box.focus();
  }
});
box.focus();
