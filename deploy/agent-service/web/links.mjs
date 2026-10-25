/**
 * Turning URLs in message text into something readable.
 *
 * Message threads are full of pasted links, and a Google search URL is six
 * hundred characters of tracking parameters wrapped over fifteen lines on a
 * phone. It buries the two sentences either side of it, which are the reason
 * you opened the thread.
 *
 * The preview is derived **entirely from the URL string**. Nothing here fetches
 * the page. These links arrive inside someone else's text message; fetching one
 * would tell whoever sent it that Alex's repo read their link, from the
 * the assistant's own address, and would pull untrusted remote content into a page that
 * can queue outbound messages. A decoded `?q=` is honest about where it came
 * from and costs nothing.
 */

// Deliberately http(s) only. A javascript: or data: "link" in a message is not
// a link, it is an attack, and it must stay plain text.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

// Trailing punctuation belongs to the sentence, not the URL.
const TRAIL = /[.,;:!?)\]}'"]+$/;

/** Split text into ordered text and link runs. Never loses a character. */
export function linkParts(text) {
  const src = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of src.matchAll(URL_RE)) {
    const href = m[0].replace(TRAIL, '') || m[0];
    if (m.index > last) out.push({ type: 'text', value: src.slice(last, m.index) });
    out.push({ type: 'link', href });
    // Only the URL is consumed; any punctuation trimmed off it stays in the
    // sentence, where it belongs.
    last = m.index + href.length;
  }
  if (last < src.length) out.push({ type: 'text', value: src.slice(last) });
  return out;
}

/**
 * A human label for a URL: what it is, and where it lives.
 * @returns {{host: string, title: string, kind: string}}
 */
export function linkLabel(href) {
  let u;
  try { u = new URL(href); } catch { return { host: '', title: href.slice(0, 60), kind: 'raw' }; }

  const host = u.hostname.replace(/^www\./, '');
  const clean = (s) => decodeURIComponent(String(s).replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();

  // A search is the common case in a text thread — someone looked something up
  // and sent the results. The query is the entire content of the link.
  for (const key of ['q', 'query', 'search_query', 'text']) {
    const v = u.searchParams.get(key);
    if (v) return { host, title: clean(v), kind: 'search' };
  }

  const seg = u.pathname.split('/').filter(Boolean).pop();
  if (seg) {
    const title = clean(seg).replace(/\.(html?|php|aspx?|pdf)$/i, '').replace(/[-_]+/g, ' ');
    if (title) return { host, title, kind: /\.pdf$/i.test(seg) ? 'file' : 'page' };
  }
  return { host, title: host, kind: 'site' };
}

/**
 * A stranger's text, with its links made readable.
 *
 * A marketing mail's tracking URL is 400 characters of campaign parameters;
 * rendered raw it is most of the message. Alex, 2026-09-19, of a GoDaddy
 * renewal notice that was padding and then four of those: "why does this
 * email from godaddy not render properly".
 *
 * Text goes in as a text node, never as markup — this is the one place a
 * sender's words reach the page, and they reach it as words.
 */
export function renderText(el, text) {
  const parts = linkParts(text);
  const alone = parts.length === 1 && parts[0].type === 'link';

  for (const part of parts) {
    if (part.type === 'text') {
      el.appendChild(document.createTextNode(part.value));
      continue;
    }
    const { host, title, kind } = linkLabel(part.href);
    const a = document.createElement('a');
    a.href = part.href;
    a.target = '_blank';
    // Untrusted origin: do not hand it a referrer, an opener, or ranking credit.
    a.rel = 'noopener noreferrer nofollow';
    a.referrerPolicy = 'no-referrer';
    a.title = part.href;                       // the real URL is one hover away

    if (alone) {
      a.className = 'linkcard';
      const h = document.createElement('div');
      h.className = 'lc-kind';
      h.textContent = kind === 'search' ? 'search \u00b7 ' + host : host;
      const t = document.createElement('div');
      t.className = 'lc-title';
      t.textContent = title;
      a.append(h, t);
    } else {
      a.className = 'linkinline';
      a.textContent = title.length > 38 ? title.slice(0, 36) + '\u2026' : title;
    }
    el.appendChild(a);
  }
  return el;
}

/**
 * The reply, without the conversation stapled underneath it.
 *
 * Alex, 2026-09-19: "on the inline threads, can we try to remove the static
 * in-line content that clutters 'On Fri, Sep 18, 2026 at 11:49 AM
 * <wmercer@mac.com> wrote:' etc." Every mail client quotes the whole
 * previous message below the new one, so a three-word reply arrives as three
 * words and forty lines of what he already read — and in a threaded view the
 * quoted copy is sitting right above it anyway.
 *
 * Conservative on purpose, and it NEVER DROPS SILENTLY: it returns what was
 * cut alongside what was kept, so the caller can offer it. Two rules make it
 * safe — a marker only counts at the start of a line, and a cut that would
 * leave almost nothing is refused, because a forward whose entire body is a
 * quote is a real message rather than an empty one.
 */
export function trimQuoted(text) {
  const lines = String(text ?? '').split('\n');
  const near = (i) => lines.slice(i, i + 4).join('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    /* "On <date> …, <someone> wrote:" — wrapped across two lines as often as
       not, and followed immediately by the quote, so `wrote:` is looked for
       WITHIN the next few lines rather than at the end of them. Anchored to a
       line starting "On", which is what keeps it off ordinary prose. */
    if (/^\s*On\b/.test(l) && /^\s*On\b[\s\S]{0,220}?\bwrote:/.test(near(i))) { cut = i; break; }
    if (/^\s*>/.test(l)) { cut = i; break; }                       // a quoted line
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(l)) { cut = i; break; }
    if (/^\s*_{10,}\s*$/.test(l)) { cut = i; break; }              // Outlook's divider
    // Outlook's forwarded header block: From: followed by Sent:/To:/Subject:.
    if (/^\s*From:\s*\S/.test(l) && /^\s*(Sent|To|Subject|Date):/m.test(lines.slice(i + 1, i + 4).join('\n'))) { cut = i; break; }
    // Apple Mail and others: "Begin forwarded message:".
    if (/^\s*Begin forwarded message:/i.test(l)) { cut = i; break; }
  }
  if (cut < 0) return { text: String(text ?? ''), quoted: '' };
  const kept = lines.slice(0, cut).join('\n').replace(/\s+$/, '');
  const quoted = lines.slice(cut).join('\n').trim();
  // A message that is ALL quote is a forward, not an empty note.
  if (kept.trim().length < 20) return { text: String(text ?? ''), quoted: '' };
  return { text: kept, quoted };
}
