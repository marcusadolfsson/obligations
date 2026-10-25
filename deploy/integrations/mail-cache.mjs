#!/usr/bin/env node
/**
 * Cache the readable text of threads the assistant has an opinion about, so the web
 * UI can show a message instead of sending Alex to Gmail.
 *
 *   node deploy/integrations/mail-cache.mjs            # every thread with a conclusion
 *   node deploy/integrations/mail-cache.mjs <acct> <threadId>   # just one
 *
 * ## Why this is a separate store, and not part of the extract
 *
 * `gmail-extract.mjs` writes metadata only, and that stays true. What it writes
 * is read by a model on every triage run, so sweeping six hundred bodies into it
 * would put six hundred pieces of attacker-controlled text into the one file the
 * agent always reads. The no-body rule there is not squeamishness; it is the
 * reason an injection has no reader on that path.
 *
 * This file has a different consumer: a browser, showing Alex his own mail.
 * The text is rendered as text and never enters a prompt. So the trade is
 * different and the answer is different — but only because the stores are
 * separate. If anything ever starts feeding this cache to the agent, the
 * argument above stops holding and this comment is the warning.
 *
 * ## What it caches, and what it does not
 *
 * Threads with a conclusion in `integrations/email-state.json` — the ones an
 * obligation can point at — plus, since 2026-09-03, any newsletter Alex opens
 * inline on the reading page (`reading.mjs` calls `cacheThread` on first open).
 * Both are threads he wants to read on his own page; neither is the whole
 * mailbox. A cache of everything would be a second copy of his Gmail on disk
 * for no benefit.
 *
 * Bodies are stored as **text**, never as the original HTML. Rendering a
 * sender's HTML in a page served from his own domain would hand any sender a
 * script tag on `obligations.example.com`, and no amount of sanitising is worth that
 * when the plain text is what he wants to read anyway.
 *
 * Attachments are listed, not stored. `file-attachment.mjs` puts the ones worth
 * keeping in Drive, and duplicating a PDF here would mean two copies ageing
 * apart.
 *
 * ## Where it lives
 *
 * `.log/mail-cache/`, gitignored. It is derived — regenerable from Gmail while
 * the thread exists — personal, and large. The conclusions in
 * `integrations/email-state.json` are the record; this is a convenience.
 */
import { readFile, writeFile, mkdir, readdir, stat, rm, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken } from '../mcp/google-auth.mjs';
import { stripHtml } from '../agent-service/hook/code.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(OBLIGATIONS, '.log', 'mail-cache');
const STATE = join(OBLIGATIONS, 'integrations', 'email-state.json');

/** Per message. Long enough for a contract summary, short enough to render. */
const MAX_CHARS = 20000;
/**
 * Concurrent fetches. Lower than gmail-extract's 6 because `format=full` is a
 * heavier call than metadata: 472 of them at 6-wide exhausted Gmail's
 * per-minute quota ("Units per minute per user") and 308 came back 403 in one
 * run. Three-wide plus the retry below stays under it.
 */
const CONCURRENCY = 3;

export const cachePath = (account, threadId) =>
  join(CACHE, account, `${threadId}.json`);

/**
 * The sender's own markup, cached SEPARATELY from the text.
 *
 * Alex, 2026-09-19: "can we cache the html version too?" — after "As sent"
 * became the default view, which made every open cost a Gmail call because
 * the HTML was the one thing deliberately never stored.
 *
 * Its own file, and that is the whole safety argument. The header above says
 * the text cache is safe to keep because a browser renders it as text and it
 * never enters a prompt; a sender's HTML is a different kind of thing, so it
 * lives where `read()` cannot return it. Anything reading a thread for the
 * agent gets the text file and nothing else, exactly as before. The HTML is
 * sanitised before it is written and rendered in a frame with no scripts and
 * its own CSP — two locks it already had, plus a third: nothing feeds it to a
 * model.
 */
export const htmlPath = (account, threadId) =>
  join(CACHE, account, `${threadId}.html.json`);

/** How many HTML bodies to keep per account. They are 10–50x the text. */
const HTML_KEEP = 400;

const header = (headers, name) => (headers ?? [])
  .find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/**
 * One thread as readable text plus an attachment manifest.
 *
 * Same walk as `mail-body.mjs`: prefer `text/plain`, fall back to stripped HTML,
 * and take attachments from the parts rather than from a field that lies about
 * them.
 */
/**
 * A sender's HTML, fit to render inside a sandboxed frame: no scripts, no
 * frames, no forms, no event handlers, no javascript: links, no meta refresh.
 * The frame itself carries a CSP and a sandbox with no permissions; this is
 * the belt to that braces. Exported for the tests. Alex, 2026-09-06: "some
 * newsletters I want to read in full."
 */
export function sanitizeHtml(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|iframe|frame|object|embed|applet|form|input|button|textarea|select|link|meta|base)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|frame|object|embed|applet|form|input|button|textarea|select|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action|formaction|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, ' $1="#"')
    .replace(/\s(href|src)\s*=\s*("\s*data:text\/html[^"]*"|'\s*data:text\/html[^']*')/gi, ' $1="#"')
    .slice(0, 600 * 1024);
}

/**
 * Marketing preheader padding, taken out.
 *
 * Alex, 2026-09-19, of a GoDaddy renewal notice: "why does this email from
 * godaddy not render properly". Its text/plain part opens with 865 characters
 * of `&zwnj;` — zero-width non-joiners, which bulk senders pad the preview
 * line with so an inbox list shows nothing after the teaser. A mail client
 * renders them as nothing; we were showing the entities themselves, so the
 * message read as a wall of `&zwnj; &zwnj; &zwnj;`.
 *
 * Both spellings go: the literal characters, and the HTML entities that a
 * text/plain part has no business carrying but routinely does.
 */
const PADDING = /(?:&zwnj;|&zwj;|&nbsp;|&#8203;|&#847;|&#65279;|[\u200b-\u200d\u2060\ufeff\u00a0])/gi;
export function readable(s) {
  return String(s ?? '')
    .replace(PADDING, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shape(thread, { account, html = false }) {
  const messages = (thread.messages ?? []).map((m) => {
    const h = m.payload?.headers ?? [];
    const out = { text: [], html: [], attachments: [] };

    const walk = (part) => {
      if (!part) return;
      const data = part.body?.data;
      if (part.filename) {
        out.attachments.push({
          filename: part.filename,
          mimeType: part.mimeType ?? null,
          bytes: part.body?.size ?? 0,
        });
      } else if (data && part.mimeType === 'text/plain') {
        out.text.push(Buffer.from(data, 'base64url').toString('utf8'));
      } else if (data && part.mimeType === 'text/html') {
        out.html.push(Buffer.from(data, 'base64url').toString('utf8'));
      }
      for (const c of part.parts ?? []) walk(c);
    };
    walk(m.payload);

    // The plain part first — but only if there is a message in it. A part that
    // is nothing but preheader padding is not the mail, and the HTML twin is;
    // GoDaddy's renewal notice is 4,594 characters of text/plain that reduce
    // to one teaser line.
    const plain = readable(out.text.join('\n\n'));
    const body = plain.length >= 80 || !out.html.length
      ? plain
      : (readable(stripHtml(out.html.join('\n\n'))) || plain);
    return {
      id: m.id,
      // A draft is part of the thread and worth knowing about — but it has not
      // been sent, and reading one as sent is how four conclusions came to
      // assert chases that never went (2026-09-07).
      draft: (m.labelIds ?? []).includes('DRAFT'),
      from: header(h, 'From'),
      to: header(h, 'To'),
      cc: header(h, 'Cc') || null,
      date: header(h, 'Date'),
      subject: header(h, 'Subject'),
      at: Number(m.internalDate ?? 0),
      // Collapsed but not reflowed: blank-line structure is most of what makes
      // a quoted reply readable.
      text: body.slice(0, MAX_CHARS),
      truncated: body.length > MAX_CHARS,
      // Whether there is an HTML twin to render, recorded so the page can
      // offer it without a speculative fetch. Alex, 2026-09-19, of the
      // GoDaddy renewal notice: "can we render the html?" The cache holds
      // text; this says whether asking for more would get anything.
      has_html: out.html.length > 0,
      attachments: out.attachments,
      // Only when asked, never cached: the reading view renders it in a
      // sandboxed frame; nothing else here wants a sender's markup.
      ...(html && out.html.length ? { html: sanitizeHtml(out.html.join('\n\n')) } : {}),
    };
  }).sort((a, b) => a.at - b.at);

  return {
    thread_id: thread.id,
    account,
    subject: messages[0]?.subject ?? '(no subject)',
    cached_at: new Date().toISOString(),
    messages,
  };
}

/**
 * Retry the transient statuses, honouring Retry-After. Gmail reports a quota hit
 * as 403 with "Quota exceeded" / "rateLimitExceeded" in the body — not 429 — so
 * the body is checked rather than the status alone; a real permission failure
 * has a different reason and fails fast.
 */
/* Exported since 2026-09-22 for the urgency classifier, which needs the words
   of ONE new thread to answer "does he need this within the hour" and must not
   write a body to the cache to get them — the cache is deliberately only
   threads that already have a conclusion. Read-only, like everything here. */
export async function fetchThread(account, threadId) {
  const token = await accessToken(OBLIGATIONS, fetch, account);
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`;
  let wait = 500;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    const throttled = res.status === 429
      || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|Quota exceeded/i.test(body));
    if (!(throttled || res.status >= 500) || attempt >= 6) {
      throw new Error(`gmail thread ${threadId} (${res.status})`);
    }
    // A per-minute quota needs a per-minute wait, so the ceiling is 30s rather
    // than the extractor's 8s; with jitter so three workers do not retry as one.
    const after = Number(res.headers.get('retry-after'));
    const pause = Number.isFinite(after) && after > 0 ? after * 1000 : wait + Math.random() * wait;
    await new Promise((r) => setTimeout(r, pause));
    wait = Math.min(wait * 2, 30000);
  }
}

/**
 * Cache a thread — text, and the sender's own markup beside it.
 *
 * Alex, 2026-09-19, on being told an open is free after the first one: "can
 * we cache it at triage?" It costs nothing to: `format=full` is ALREADY the
 * fetch this makes, and it already carries every part. Shaping it twice is
 * two passes over a response in hand, not a second call — so a thread the
 * triage has judged opens from disk the first time he looks at it, rather
 * than the second.
 *
 * The HTML still goes in its own file, out of reach of `read()`. What is
 * cheap to store and what is safe to hand a model are different questions,
 * and the separation is the answer to the second one.
 */
export async function cacheThread(account, threadId) {
  const full = await fetchThread(account, threadId);
  const shaped = shape(full, { account });
  const path = cachePath(account, threadId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(shaped, null, 1) + '\n');
  // Best effort, and deliberately after the text: the text is what every
  // other reader needs, and an HTML write that fails must not cost it.
  try {
    const withHtml = shape(full, { account, html: true });
    if ((withHtml.messages ?? []).some((m) => m.html)) await cacheHtml(account, threadId, withHtml);
  } catch { /* the thread is cached as text; the markup fetches on open */ }
  return shaped;
}

/**
 * Store a thread's HTML, and keep the store bounded.
 *
 * `ids` rides along so a stale copy can be spotted: a thread that has gained a
 * reply since it was cached has a different set of message ids, and serving
 * the old markup would show him a conversation missing its newest message.
 */
export async function cacheHtml(account, threadId, shaped, { vault = OBLIGATIONS } = {}) {
  // `obligations` is a parameter because OBLIGATIONS is captured when this module loads,
  // so a test pointing at a temp dir would otherwise write into the real
  // cache — which is exactly what it did the first time.
  const path = join(vault, '.log', 'mail-cache', account, `${threadId}.html.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...shaped, ids: (shaped.messages ?? []).map((m) => m.id) }) + '\n');
  await pruneHtml(account, vault).catch(() => {});
  return shaped;
}

/** Oldest out first, by last use. Unbounded, this would be a second Gmail. */
async function pruneHtml(account, vault = OBLIGATIONS) {
  const dir = join(vault, '.log', 'mail-cache', account);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.html.json'));
  if (names.length <= HTML_KEEP) return;
  const aged = await Promise.all(names.map(async (n) => {
    try { return { n, at: (await stat(join(dir, n))).mtimeMs }; } catch { return { n, at: 0 }; }
  }));
  aged.sort((a, b) => a.at - b.at);
  for (const { n } of aged.slice(0, aged.length - HTML_KEEP)) {
    await rm(join(dir, n)).catch(() => {});
  }
}

/**
 * The cached HTML, if it is still the same conversation.
 *
 * `ids` is compared against the text cache, which the nightly pass refreshes:
 * different ids mean a reply has landed since, and a cached body missing the
 * newest message is worse than a fetch.
 */
export async function readHtml(vault, account, threadId) {
  try {
    const hit = JSON.parse(await readFile(join(vault, '.log', 'mail-cache', account, `${threadId}.html.json`), 'utf8'));
    const text = await read(vault, account, threadId);
    if (text?.messages) {
      const now = text.messages.map((m) => m.id).join(',');
      if (now !== (hit.ids ?? []).join(',')) return null;       // a reply has landed
    }
    // Touched, so pruning evicts what he has not opened rather than what he
    // happened to open first.
    await utimes(join(vault, '.log', 'mail-cache', account, `${threadId}.html.json`), new Date(), new Date()).catch(() => {});
    return hit;
  } catch {
    return null;
  }
}

/** Read one from cache. Null when absent — the caller decides what to say. */
export async function read(vault, account, threadId) {
  try {
    const path = join(vault, '.log', 'mail-cache', account, `${threadId}.json`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const [account, threadId] = process.argv.slice(2);
  if (account && threadId) {
    const t = await cacheThread(account, threadId);
    console.log(`cached ${t.messages.length} message(s) — ${t.subject}`);
    return;
  }

  let state;
  try {
    state = JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    console.error('no integrations/email-state.json — nothing has been judged yet');
    process.exitCode = 1;
    return;
  }

  // Open obligations first. If the quota bites mid-run, it should bite on the
  // threads nobody is waiting to read — a task on /tasks whose evidence cannot
  // be opened is the thing this cache exists to prevent.
  const want = (state.threads ?? [])
    .filter((t) => t.thread_id && t.conclusion)
    .sort((a, b) => Number(!!b.conclusion.open) - Number(!!a.conclusion.open))
    .map((t) => ({ account: t.account || 'personal', thread_id: t.thread_id }));

  let done = 0, skipped = 0, failed = 0;
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < want.length) {
      const { account: a, thread_id: id } = want[next++];
      // Already cached is left alone. A thread's text does not change, and
      // re-fetching 600 of them on every run would spend quota to rewrite
      // identical files.
      try {
        await stat(cachePath(a, id));
        skipped++;
        continue;
      } catch { /* not cached yet */ }
      try {
        await cacheThread(a, id);
        done++;
      } catch (e) {
        failed++;
        console.error(`  ${id}: ${e.message}`);
      }
    }
  }));

  console.log(`mail cache: ${done} fetched, ${skipped} already cached` +
              (failed ? `, ${failed} failed` : ''));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
