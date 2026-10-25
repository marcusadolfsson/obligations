/**
 * In-page state that the back gesture understands.
 *
 * Alex, 2026-09-05: "is there a way to hijack the swipe back gesture and
 * drive a back mode in our UI instead ... right now some things trigger a page
 * load and others don't, so the back swipe is very inconsistent."
 *
 * You cannot hijack it. Safari's edge swipe is a system gesture: nothing
 * cancellable fires, preventDefault does not apply, and beforeunload does not
 * fire for a same-document navigation. Anything that tries to intercept it is
 * fighting the browser and will lose.
 *
 * What you can do is stop swallowing it. The inconsistency is not that the app
 * is multi-page — it is that opening a pane changes what is on screen without
 * adding anything to history, so the gesture correctly does the only thing left
 * to do and leaves the page. Give the pane a history entry and the same gesture
 * closes it instead, because now there is something to go back to.
 *
 * Two rules that matter more than the code:
 *
 *   - Opening a pane from the list PUSHES; moving between rows while the pane
 *     is already open REPLACES. Otherwise back walks you through every row you
 *     looked at before it finally returns to the list, which is worse than the
 *     bug it fixes.
 *   - The in-app back button calls history.back() rather than closing directly,
 *     so the button and the gesture travel the same path. Two code paths that
 *     both "close the pane" drift, and then the button works and the swipe does
 *     not — which is exactly the state this file exists to end.
 */

/**
 * THE URL IS THE VIEW.
 *
 * Alex, 2026-09-19: "can we write the url on every load, so you can deeplink
 * to a mail, task etc." An open pane already went in the hash; which FILTER he
 * was looking at did not, so `/mail` always opened on Unseen and a link to
 * "Mail, Action tier" or "To Do, drafted" could not be written at all — not by
 * him, not by a brief, not by the chat.
 *
 * So the hash is a small bag of `k=v` pairs rather than one. `pane` is one key
 * among them, which is what keeps the old `#pane=<id>` links working: a single
 * pair parses as a bag of one.
 *
 * Who pushes and who replaces is the whole design. Opening a pane PUSHES,
 * because back should close it. Changing a filter REPLACES, because back
 * walking through every chip he tried is worse than the thing it fixes — the
 * same rule that already governed moving between rows.
 */
export function readParams() {
  const out = {};
  const h = location.hash.replace(/^#/, '');
  if (!h) return out;
  for (const part of h.split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1)); } catch { /* skip */ }
  }
  return out;
}

const toHash = (p) => {
  const bits = Object.entries(p)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  // An empty bag means the bare path — not a dangling "#", which a reload
  // keeps and a copied link carries around for no reason.
  return bits.length ? '#' + bits.join('&') : location.pathname + location.search;
};

/**
 * Record the view he is looking at, without adding a history entry.
 *
 * Merged into whatever else the hash holds, so writing the filter never closes
 * an open pane and opening a pane never forgets the filter.
 */
export function writeView(params) {
  const merged = { ...readParams(), ...params };
  history.replaceState(history.state, '', toHash(merged));
}

/**
 * Open, or move within, a piece of in-page state.
 *
 * @param kind  a short name for the layer ('pane', 'drawer') — popstate uses it
 *              to tell whose entry it is looking at.
 * @param id    what is open. Goes in the URL, so a reload and a shared link
 *              land back on the same thing.
 */
export function openState(kind, id) {
  const url = toHash({ ...readParams(), [kind]: id ?? '' });
  const already = history.state && history.state.kind === kind;
  const entry = { kind, id };
  // Replace while the layer is already open; push when entering it.
  if (already) history.replaceState(entry, '', url);
  else history.pushState(entry, '', url);
}

/**
 * Leave the current layer. Always through history, never by mutating the DOM
 * directly — see the second rule above.
 *
 * If we are not the entry that history is on (a reload landed here, or another
 * script pushed) there is nothing of ours to pop, so the caller is told to
 * close by hand rather than sending the browser somewhere unexpected.
 */
export function closeState(kind) {
  if (history.state && history.state.kind === kind) {
    history.back();
    return true;
  }
  return false;
}

/**
 * Called when the browser leaves one of our entries — the swipe, the back
 * button, or closeState() above.
 *
 * The handler is given the state being moved TO, so a layer can tell "closed"
 * from "moved to a different row".
 */
export function onStateChange(kind, close) {
  addEventListener('popstate', (e) => {
    const s = e.state;
    if (!s || s.kind !== kind) close(null);
    else close(s.id ?? null);
  });
}

/**
 * What the URL says should be open on first paint, if anything.
 *
 * This is what makes a pane survive a reload — which is not a nicety here: the
 * phone drops connections, he reloads, and landing back on the list having lost
 * the thing he was reading is the same class of annoyance as the approval that
 * did not survive.
 */
export function stateFromUrl(kind) {
  return readParams()[kind] ?? null;
}
