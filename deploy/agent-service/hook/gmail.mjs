/**
 * The Gmail side of the realtime path: arm the watch, read what changed, fetch
 * headers.
 *
 * `metadata()` asks for an explicit header allow-list, and it is what
 * classification runs on: **the decision that a message is a login code is made
 * from headers alone, before any body is requested.**
 *
 * `body()` exists because most services put the code in the body — Alex's
 * ForeFlight, Zoom, PayPal and Intuit mail all do. It is called only for a
 * message already judged to be a fresh, DMARC-passing code, only by
 * `code.mjs`, and nothing but the extracted code leaves that module. No body
 * text is written to disk, logged, spooled, or shown to a model anywhere on
 * this path.
 *
 * That is a narrower rule than "never fetch a body", and it is the honest one:
 * prompt injection needs a model to read the text, and there is no model here —
 * a regex cannot be talked into anything. `gmail-extract.mjs` keeps the
 * absolute rule, because what it writes IS read by a model.
 *
 * ## The watch expires, and that is the interesting failure
 *
 * `users.watch` lasts seven days. When it lapses Gmail simply stops sending,
 * and *nothing observable happens* — no error, no bounce, just a channel that
 * quietly went dead while looking healthy. That is why `arm()` records
 * `armedAt` and `expiration` where a watchdog outside this process can read
 * them, and why re-arming is cheap and idempotent: call it daily and the
 * seven-day window becomes six days of slack.
 *
 * ## The cursor advances only on success
 *
 * `historyId` is a fetch cursor. Advancing it before the messages it covers
 * have been handled means a push processed during a crash is a push that never
 * happened — and for a login code, missing it is the whole failure. So it moves
 * after work, never before.
 *
 * A cursor too old for Gmail (404 from history.list) is a real state: it means
 * the gap is longer than Gmail retains. The honest response is to re-arm and
 * skip the gap rather than pretend to have processed it, because the
 * alternative is claiming to have seen mail nobody looked at.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { accessToken, accountsWith } from '../../mcp/google-auth.mjs';

/** Headers, and only these. See the header comment. */
const HEADERS = ['Subject', 'From', 'To', 'Cc', 'Delivered-To', 'Date',
                 'Message-ID', 'List-Id', 'Auto-Submitted',
                 'Authentication-Results'];

const statePath = (vault) => join(vault, '.log', 'gmail-watch.json');

/**
 * Which mailboxes exist, from `.mcp.json` — the same list `gmail-extract.mjs`
 * reads, so connecting a third needs no edit here.
 */
export async function accounts(vault) {
  // Which accounts have mail, rather than which MCP servers are configured.
  // The two agreed while every mail account had its own server entry; they stop
  // agreeing the moment an account has mail without one, and the grant is the
  // more truthful source.
  const withMail = await accountsWith('mail', vault);
  return withMail.length ? withMail : ['gmail'];
}

/**
 * Which account a push is about.
 *
 * Every mailbox publishes to the SAME topic, and the only thing distinguishing
 * them is `emailAddress` in the envelope. Without this a push about
 * riverton.example would advance the rivera.example cursor — and the symptom
 * would be codes silently going missing from both, because each mailbox would
 * keep skipping the other's history.
 *
 * Returns null for an address no mailbox claims, which is the right answer for
 * an envelope naming something we do not watch.
 */
export async function accountFor(vault, emailAddress) {
  if (!emailAddress) return null;
  const want = String(emailAddress).toLowerCase();
  const state = await loadWatch(vault);
  for (const [account, s] of Object.entries(state)) {
    if (String(s?.address ?? '').toLowerCase() === want) return account;
  }
  return null;
}

export async function loadWatch(vault) {
  try { return JSON.parse(await readFile(statePath(vault), 'utf8')); }
  catch { return {}; }
}

async function saveWatch(vault, state) {
  await mkdir(dirname(statePath(vault)), { recursive: true });
  await writeFile(statePath(vault), JSON.stringify(state, null, 1) + '\n');
}

async function api(path, token, { params = {}, method = 'GET', body } = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`gmail ${path} (${res.status}): ${text.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Ask Gmail to publish changes to the Pub/Sub topic.
 *
 * **No `labelIds`.** Restricting the watch to INBOX is the obvious
 * optimisation and it would silently drop exactly the mail this feature exists
 * for: a login code from a sender one of Alex's own filters archives never
 * touches the inbox, so the push would never fire and the failure would look
 * like the service not sending codes.
 */
export async function arm(vault, { account = 'gmail', topic } = {}) {
  if (!topic) throw new Error('no Pub/Sub topic configured (GMAIL_PUSH_TOPIC)');
  const token = await accessToken(vault, fetch, account);
  const res = await api('watch', token, {
    method: 'POST',
    body: { topicName: topic, labelFilterBehavior: 'INCLUDE' },
  });
  // Asked here rather than assumed: it is what accountFor() matches an
  // incoming envelope against, and getting it from the mailbox itself means it
  // cannot drift from what Gmail actually calls this account.
  const profile = await api('profile', token).catch(() => ({}));

  const state = await loadWatch(vault);
  state[account] = {
    address: String(profile.emailAddress ?? '').toLowerCase() || null,
    historyId: String(res.historyId),
    // Milliseconds since epoch, as Gmail returns it.
    expiration: Number(res.expiration) || null,
    armedAt: new Date().toISOString(),
    topic,
    error: null,
  };
  await saveWatch(vault, state);
  return state[account];
}

/** Record why arming failed, where the watchdog can see it. */
export async function recordWatchError(vault, account, message) {
  const state = await loadWatch(vault);
  state[account] = { ...(state[account] ?? {}), error: String(message).slice(0, 300) };
  await saveWatch(vault, state);
}

/**
 * Message ids added since the stored cursor.
 *
 * Returns `{ ids, historyId }` without advancing anything — the caller advances
 * after the work is done. `stale: true` means the cursor is older than Gmail
 * retains and the gap cannot be recovered.
 */
export async function since(vault, { account = 'gmail' } = {}) {
  const state = await loadWatch(vault);
  const start = state[account]?.historyId;
  if (!start) return { ids: [], historyId: null, unarmed: true };

  const token = await accessToken(vault, fetch, account);
  const ids = [];
  let pageToken;
  let latest = start;

  try {
    do {
      const page = await api('history', token, {
        params: {
          startHistoryId: start,
          historyTypes: 'messageAdded',
          maxResults: 100,
          pageToken,
        },
      });
      if (page.historyId) latest = String(page.historyId);
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const id = added.message?.id;
          if (id && !ids.includes(id)) ids.push(id);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < 100);
  } catch (e) {
    // 404 means the cursor predates Gmail's history retention. Pretending to
    // have processed the gap would be a lie; saying so and re-arming is the
    // only honest move.
    if (e.status === 404) return { ids: [], historyId: null, stale: true };
    throw e;
  }

  return { ids, historyId: latest };
}

/**
 * The text of one message, for code extraction and nothing else.
 *
 * Returns `{ text, html }` — whichever parts exist. Only the first 64KB of any
 * part is kept: a code is never on page nine, and an unbounded read is how one
 * marketing mail with a megabyte of inlined CSS stalls the push path.
 *
 * See the header for why this is allowed to exist, and `code.mjs` for the
 * conditions that keep it safe.
 */
const MAX_PART_BYTES = 64 * 1024;

export async function body(vault, id, { account = 'gmail' } = {}) {
  const token = await accessToken(vault, fetch, account);
  const m = await api(`messages/${encodeURIComponent(id)}`, token,
                      { params: { format: 'full' } });

  const out = { text: '', html: '' };
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType ?? '';
    const data = part.body?.data;
    if (data && (mime === 'text/plain' || mime === 'text/html')) {
      const decoded = Buffer.from(data, 'base64url').toString('utf8').slice(0, MAX_PART_BYTES);
      if (mime === 'text/plain') out.text ||= decoded;
      else out.html ||= decoded;
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(m.payload);
  return out;
}

/**
 * Move the cursor. Called after the messages it covers have been handled.
 *
 * Also stamps `lastPushAt`, which is the only evidence anywhere that the
 * channel is alive. A lapsed watch produces *silence*, not an error — Gmail
 * simply stops publishing — so "when did a push last arrive" is the question
 * the watchdog in reminder-dispatch.py has to be able to ask. Recorded here
 * because this runs on every push, including ones that turned out to contain
 * nothing worth relaying.
 */
export async function advance(vault, account, historyId) {
  if (!historyId) return;
  const state = await loadWatch(vault);
  state[account] = {
    ...(state[account] ?? {}),
    historyId: String(historyId),
    lastPushAt: new Date().toISOString(),
  };
  await saveWatch(vault, state);
}

/**
 * Headers for one message, flat.
 *
 * `format: 'metadata'` plus an explicit allow-list. The body is not fetched,
 * cannot be fetched by this function, and the classifier that consumes this has
 * no field to read it from even if it were.
 */
export async function metadata(vault, id, { account = 'gmail' } = {}) {
  const token = await accessToken(vault, fetch, account);
  const m = await api(`messages/${encodeURIComponent(id)}`, token, {
    params: { format: 'metadata', metadataHeaders: HEADERS },
  });
  const headers = {};
  for (const h of m.payload?.headers ?? []) headers[h.name] = h.value;
  return {
    id: m.id,
    threadId: m.threadId,
    internalDate: Number(m.internalDate ?? 0),
    labelIds: m.labelIds ?? [],
    headers,
  };
}
