/**
 * A mail as its sender built it — the sandboxed frame, and the Text/As-sent
 * switch over it.
 *
 * Alex, 2026-09-21: "when to-dos link to messages, lets offer both HTML and
 * Text view." The Mail page has had both since 2026-09-19 and the task pane
 * had only text, which is the wrong way round for the mail that most often
 * needs looking at: an invoice, a statement, a proposal — the ones whose
 * text/plain part is padding and four tracking URLs.
 *
 * This file exists so there is ONE frame. Two things here are load-bearing
 * and neither should be reasoned out a second time in another file: the two
 * independent locks that stop a stranger's markup running, and the height
 * measurement that avoids a scrollbar inside a scrollbar. Copying them into
 * the task pane is exactly the "same idea in four places" this repo keeps
 * paying for, and it is worse here because one of the copies would be a
 * security property.
 */
import { el } from './ui.mjs';

/**
 * Grow a frame to the height of what is in it, and keep it there.
 *
 * A mail is a document, not a widget: a scrollbar inside a scrollbar means
 * two things move and neither is the page. Measured rather than guessed
 * because the height is the sender's, not ours — a receipt is 300px and a
 * newsletter 6,000. Re-measured as images arrive, since a marketing mail is
 * mostly images and its height is wrong until they land.
 *
 * Everything is wrapped: `contentDocument` is null if the frame is detached
 * or the browser refuses same-origin, and a mail that cannot be measured
 * should be a tall frame rather than a broken pane.
 */
export function fitToContent(f) {
  /* The guard is load-bearing: setting the frame's height changes the layout
   * inside it, which fires the ResizeObserver, which sets the height again.
   * Unguarded that is a hot loop — it span the browser hard enough that the
   * page never went idle. So a measurement only counts when it MOVES the
   * frame by more than a couple of pixels, and the observer stops once the
   * height has settled. */
  let applied = 0;
  let quiet = 0;
  let obs = null;
  const fit = () => {
    try {
      const d = f.contentDocument;
      if (!d?.body) return;
      const h = Math.max(d.body.scrollHeight, d.documentElement?.scrollHeight ?? 0);
      if (!h) return;
      if (Math.abs(h - applied) <= 2) {
        // Settled. A few consecutive no-ops and the observer has nothing left
        // to tell us.
        if (++quiet >= 3 && obs) { obs.disconnect(); obs = null; }
        return;
      }
      quiet = 0;
      applied = h;
      f.style.height = (h + 8) + 'px';
    } catch { /* not measurable: the CSS min-height stands */ }
  };
  f.addEventListener('load', () => {
    fit();
    try {
      const d = f.contentDocument;
      // Images load after the document does, and each one moves everything
      // below it.
      for (const img of d?.images ?? []) {
        if (!img.complete) img.addEventListener('load', fit, { once: true });
      }
      if (typeof ResizeObserver === 'function' && d?.body) { obs = new ResizeObserver(fit); obs.observe(d.body); }
    } catch { /* see above */ }
    // A last look for anything that settles late (web fonts, slow images).
    setTimeout(fit, 400);
    setTimeout(() => { fit(); if (obs) { obs.disconnect(); obs = null; } }, 2500);
  });
}

/**
 * One message, rendered as the sender wrote it.
 *
 * `allow-same-origin`, and NOTHING else — not allow-scripts.
 *
 * Alex, 2026-09-19: "render the email iframe the height of the email, I
 * don't want double scrolling." The only way to learn how tall a framed
 * document is, is to measure it, and measuring needs same-origin access to
 * it. So the frame is same-origin and the sender's markup is stopped from
 * running by TWO independent locks: the sandbox withholds allow-scripts, and
 * the document's own CSP below is `default-src 'none'` with no script-src,
 * which blocks scripts a second time. Either alone would do; two is the
 * number this repo uses for content nobody vetted. Without allow-scripts the
 * same-origin grant buys the sender nothing — there is no code of theirs to
 * spend it.
 *
 * `allow-popups` is what makes a LINK WORK. Alex, 2026-09-20: "links inside
 * the HTML mail view aren't clickable. I have to right click open in new link
 * for them to work." The `<base target="_blank">` has always been there and
 * had always been ignored: a sandboxed frame without allow-popups may not
 * open a tab, so every click was dropped on the floor while the right-click
 * menu — the browser's own, outside the sandbox — worked fine.
 *
 * `allow-popups-to-escape-sandbox` with it, or the tab that opens inherits
 * this sandbox and the site arrives with no scripts and a CSP of
 * `default-src 'none'`, which is a broken page rather than a safe one.
 *
 * Remote images load, which is how a tracking pixel learns the mail was
 * opened — the same trade the reading view has always made.
 */
export function mailFrame(html, { title = 'message' } = {}) {
  const f = document.createElement('iframe');
  f.className = 'read-frame';
  f.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('title', title);
  f.setAttribute('scrolling', 'no');
  f.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src https: data:"><base target="_blank"><style>html,body{margin:0}body{padding:12px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#111;background:#fff;word-wrap:break-word;overflow-y:hidden}img{max-width:100%;height:auto}table{max-width:100%}</style>${html}`;
  fitToContent(f);
  return f;
}

/** The query half of a /api/reading/body call, for one thread. */
export const threadQuery = (account, threadId) =>
  `account=${encodeURIComponent(account)}&thread=${encodeURIComponent(threadId)}`;

/**
 * Could this thread have an HTML twin at all?
 *
 * `has_html` is recorded in the cache; a thread cached before that existed
 * has none, and `undefined` means "ask" rather than "no" — so the switch is
 * offered and `asSent` drops back by itself if the answer turns out to be no.
 * Hiding the switch on a maybe would be the worse failure: a mail he cannot
 * read properly, with nothing on screen saying another view exists.
 */
export const mayHaveHtml = (msgs) => (msgs ?? []).some((m) => m?.has_html !== false);

/**
 * The segmented switch, and the frames it fills.
 *
 * A segmented control, not two loose chips: it is one question with two
 * answers. Alex, 2026-09-19: "lets style 'as sent' and 'Text' nicer."
 *
 * `texts` is the caller's own text rendering — bubbles in the task pane, a
 * flat list on Mail — because that half is genuinely different in the two
 * places and only the frame has to be shared.
 */
export function htmlSwitch({ account, threadId, texts, title = 'message', start = 'text' }) {
  const bar = el('div', 'read-toggle');
  const asHtml = el('button', 'seg', 'As sent');
  const asText = el('button', 'seg', 'Text');
  asHtml.type = asText.type = 'button';
  const frames = el('div', 'read-frames');
  frames.hidden = true;

  const pick = (html) => {
    frames.hidden = !html;
    texts.hidden = html;
    asHtml.setAttribute('aria-selected', String(html));
    asText.setAttribute('aria-selected', String(!html));
  };

  let loaded = false;
  const loadHtml = async () => {
    pick(true);
    if (loaded) return;
    loaded = true;
    frames.textContent = '';
    frames.append(el('div', 'mut read-count', 'fetching the message as it was sent…'));
    try {
      const d = await (await fetch(`/api/reading/body?${threadQuery(account, threadId)}&html=1`)).json();
      const hs = (d.messages ?? []).filter((m) => m.html);
      frames.textContent = '';
      if (!hs.length) {
        /* No HTML twin: the text IS the message, so show it rather than an
           explanation of what is missing, and take the switch away — offering
           a choice with one real answer is noise. */
        pick(false);
        bar.remove();
        return;
      }
      for (const m of hs) frames.append(mailFrame(m.html, { title }));
    } catch (err) {
      frames.textContent = '';
      frames.append(el('div', 'mut', 'could not fetch the HTML: ' + (err?.message ?? err)));
    }
  };

  asHtml.onclick = loadHtml;
  asText.onclick = () => pick(false);
  bar.append(asHtml, asText);
  pick(false);
  if (start === 'html') loadHtml();
  return { bar, frames, pick, loadHtml };
}
