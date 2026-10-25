/**
 * The reading list — newsletters, as a rolling list rather than a feed.
 *
 * ## Why this reads archived mail
 *
 * Alex's Gmail filters archive 122 senders on arrival, so none of this ever
 * reaches the inbox. Archived is not hidden: the mail is in the mailbox, it just
 * has no `INBOX` label, and the API finds it exactly as well. **The filters do
 * not need to change for the assistant to see this mail**, which matters because
 * editing a filter is a capability deliberately withheld.
 *
 * ## Where "which senders are newsletters" comes from
 *
 * `integrations/gmail-filters.xml`, his own export. The 55 filters that forward
 * to `newsletters@rivera.example` are the definition — he wrote each one, and the
 * forwarding target is the name he gave the group. No second list to maintain,
 * and no guessing from subject lines.
 *
 * ## Why there is (almost) no state file
 *
 * Unread *is* the list. Gmail already tracks whether he has opened something,
 * so opening one drops it off without anything here recording that it happened.
 * A `reading.json` alongside would be a second copy of a fact Gmail owns, and it
 * would be the copy that goes stale. Opening a message INLINE on the reading
 * page therefore marks it read in Gmail — the page changes the fact where the
 * fact lives, rather than keeping its own.
 *
 * The one file this does own is `integrations/ignored-senders.json`: senders
 * Alex has told the whole system to stop showing him. That is not a copy of
 * anything Gmail knows — Gmail has no such concept short of a filter, and the
 * agent may not create filters — so it is a decision of his, recorded in the
 * repo, honoured here, in the differ and in the mail job alike.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { accountsWith, accessToken } from '../mcp/google-auth.mjs';
import { withRepoLock } from './lock.mjs';
import { localStamp } from './time.mjs';
import { closeObligation } from './obligations.mjs';
import { read as cachedThread, readHtml as cachedHtml, cacheThread, cacheHtml, shape, readable }
  from '../integrations/mail-cache.mjs';
export { sendersFor } from '../integrations/gmail-filters.mjs';
import { sendersFor } from '../integrations/gmail-filters.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/**
 * The mailbox the reading list is drawn from. The sender list comes from
 * personal's filter export, so this is the only account it can mean; named
 * rather than defaulted because the mail cache is keyed by account and the
 * default in google-auth is the legacy `gmail` alias.
 */
const ACCOUNT = 'personal';
const IGNORED = ['integrations', 'ignored-senders.json'];

// Gmail's query string has a practical length limit and 55 `from:` terms
// comfortably exceeds anything worth relying on, so ask in batches.
const SENDERS_PER_QUERY = 15;
const CONCURRENCY = 6;


/**
 * The ignore list, as a matcher. Keys are lower-case addresses or `@domain`.
 *
 * Exact address first, then domain, so `@substack.com` silences every
 * newsletter on that platform in one click while `alerts@bank.com` never drags
 * `statements@bank.com` with it by accident.
 */
export async function ignoredSenders(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, ...IGNORED), 'utf8'));
    return new Set(Object.keys(d.senders ?? {}).map((k) => k.toLowerCase()));
  } catch {
    return new Set();
  }
}

export function isIgnored(address, ignored) {
  const a = String(address ?? '').toLowerCase().trim();
  if (!a) return false;
  if (ignored.has(a)) return true;
  const at = a.lastIndexOf('@');
  return at !== -1 && ignored.has(a.slice(at));
}

/** `Name <addr>` or bare `addr` → lower-case address. */
export function addressOf(value) {
  const m = /<([^>]+)>/.exec(String(value ?? ''));
  return (m ? m[1] : String(value ?? '')).replace(/^"|"$/g, '').trim().toLowerCase();
}

async function gmail(path, token, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    // An absent value is left off, not sent. `url.searchParams.set('pageToken',
    // undefined)` sends the literal text "undefined", and Gmail rejects the
    // FIRST page of every search with "Invalid pageToken" — so the archive
    // step of ignoring a sender failed before it read anything. Found
    // 2026-09-15 ignoring SkyAngel, the first time the path was ever run from
    // a command line that showed the error instead of swallowing it.
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gmail ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * The only writes this module makes to Gmail, and both are label changes on
 * Alex's own mail in response to something HE clicked. That is why they go
 * straight to the REST API rather than through the MCP door the agent uses:
 * the fences on that door exist to constrain a model reading strangers' mail,
 * and a button he pressed is neither. The destination is fixed (his mailbox),
 * the verb is fixed (remove a label), and nothing here is ever chosen by text
 * that arrived in an email.
 */
async function gmailPost(path, token, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gmail ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

/** Run `fn` over `items` a few at a time — a reading list is not a crawl. */
async function pool(items, fn, width = CONCURRENCY) {
  const out = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...await Promise.all(items.slice(i, i + width).map(fn)));
  }
  return out;
}

const header = (m, name) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';

/** Strip `Name <addr>` down to something worth showing in a list. */
function fromName(value) {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(value);
  if (named) return named[1].trim();
  return value.replace(/[<>]/g, '').trim();
}

/**
 * Unread newsletters, newest first.
 *
 * `days` bounds it because a reading list is what is worth reading now. Older
 * unread newsletters are not a backlog to work through — they are why the RSS
 * reader stopped being opened.
 */
export async function readingList(vault, { days = 21, limit = 60 } = {}) {
  const ignored = await ignoredSenders(vault);
  const senders = (await sendersFor(vault)).filter((a) => !isIgnored(a, ignored));
  if (!senders.length) {
    return { items: [], senders: 0, ignored: ignored.size,
             reason: 'no gmail-filters.xml — export it from Gmail' };
  }

  const token = await accessToken(vault, fetch, ACCOUNT);
  const chunks = [];
  for (let i = 0; i < senders.length; i += SENDERS_PER_QUERY) {
    chunks.push(senders.slice(i, i + SENDERS_PER_QUERY));
  }

  const ids = new Set();
  await pool(chunks, async (group) => {
    const q = `is:unread -in:sent -in:draft newer_than:${days}d ` +
              `from:(${group.join(' OR ')})`;
    const page = await gmail('/messages', token, { q, maxResults: limit });
    for (const m of page.messages ?? []) ids.add(m.id);
  }, 3);

  const messages = await pool([...ids].slice(0, limit), async (id) => {
    try {
      const m = await gmail(`/messages/${id}`, token, {
        format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const rawFrom = header(m, 'from');
      return {
        id,
        // The thread is what the cache and /thread/ are keyed by; the message
        // id alone could not open anything inline.
        threadId: m.threadId ?? null,
        account: ACCOUNT,
        from: fromName(rawFrom),
        // The address is what "Ignore sender" acts on — a display name is not
        // a stable key and two senders can share one.
        address: addressOf(rawFrom),
        subject: header(m, 'subject') || '(no subject)',
        at: Number(m.internalDate) || 0,
        snippet: (m.snippet ?? '').slice(0, 200),
        // Gmail stays as the second door. Opening there marks it read too.
        url: `https://mail.google.com/mail/u/0/#all/${id}`,
      };
    } catch {
      return null;   // one unreadable message must not empty the list
    }
  });

  // Post-filter as well as pre-filter: a `from:` query on a domain can return a
  // sender that is ignored by exact address, and the list must never show one.
  const items = messages.filter(Boolean)
    .filter((m) => !isIgnored(m.address, ignored))
    .sort((a, b) => b.at - a.at);
  return { items, senders: senders.length, ignored: ignored.size, reason: null };
}

/**
 * A thread's readable text for the reading page, from the cache when it has
 * been opened before and from Gmail when not. Text only, never the sender's
 * HTML — the same argument as mail-cache.mjs, and the page escapes it again.
 *
 * Cached on first open. The cache was documented as "only threads with a
 * conclusion"; a newsletter Alex chose to open is the same kind of thing — a
 * thread he wants to read on his own page — and caching it is what makes the
 * second open instant.
 */
/** An account this may read: any with the mail grant. The digest lists both. */
async function mailAccount(vault, account) {
  const ok = await accountsWith('mail', vault).catch(() => [ACCOUNT]);
  if (!ok.includes(account)) throw new Error('unknown account');
}

export async function readingBody(vault, account, threadId, { html = false } = {}) {
  // Both accounts. This guard used to admit only the newsletter account, so
  // every work item on the digest opened to "unknown account".
  await mailAccount(vault, account);
  /* Cached both ways since 2026-09-19. Alex: "can we cache the html version
     too?" — asked because As sent became the default view, so every open was
     costing a Gmail call for the one body deliberately never stored. The HTML
     lives in its own file, out of reach of anything that reads a thread for
     the agent; see mail-cache.mjs on why that separation is the safety
     argument rather than a tidiness one. */
  const hit = html ? await cachedHtml(vault, account, threadId)
                   : await cachedThread(vault, account, threadId);
  // Cleaned on the way out as well as on the way in: threads cached before
  // `readable()` existed still hold their preheader padding, and re-fetching
  // the mailbox to tidy old text is not worth a Gmail quota unit.
  if (hit) {
    return { ...hit, cached: true, ...(html ? { html: true } : {}),
             messages: (hit.messages ?? []).map((m) => ({ ...m, text: readable(m.text) })) };
  }
  const token = await accessToken(vault, fetch, account);
  const full = await gmail(`/threads/${encodeURIComponent(threadId)}`, token, { format: 'full' });
  const shaped = shape(full, { account, html });
  if (html) {
    // Best effort: an unwritable cache must not fail the read.
    await cacheHtml(account, threadId, shaped).catch(() => {});
    return { ...shaped, cached: false, html: true };
  }
  // Best effort: the read must not fail because the cache dir was unwritable.
  await cacheThread(account, threadId).catch(() => {});
  return { ...shaped, cached: false };
}

/**
 * Mark messages read in Gmail. This is how an inline open takes an item off the
 * list — by changing the fact where it lives, not by keeping a second one.
 */
export async function markRead(vault, account, ids) {
  await mailAccount(vault, account);
  const clean = [...new Set((ids ?? []).map(String).filter((s) => /^[0-9a-f]{4,32}$/.test(s)))];
  if (!clean.length) return { marked: 0 };
  const token = await accessToken(vault, fetch, account);
  await gmailPost('/messages/batchModify', token, { ids: clean, removeLabelIds: ['UNREAD'] });
  return { marked: clean.length };
}

/**
 * Ignore a sender everywhere, from now on and for what is already there.
 *
 * Two halves. The DECISION is the JSON file: the differ, the mail job and this
 * list all read it, so from the next tick nothing from this sender is offered
 * for judgement, shown here, or counted in a digest. The CLEAN-UP is
 * immediate: everything from the sender in the last year is marked read and
 * archived, so the button visibly does what it says rather than in fifteen
 * minutes when the pipeline notices.
 *
 * Nothing is deleted. Un-ignoring is removing the key; the mail is in All Mail.
 */
const READING = ['integrations', 'reading-senders.json'];

/** His list of senders whose mail is reading, always. Empty is a fact. */
export async function readingSenders(vault) {
  try { const d = JSON.parse(await readFile(join(vault, ...READING), 'utf8')); return d.senders ?? {}; } catch { return {}; }
}
export const isReadingSender = (address, senders) => isIgnored(address, new Set(Object.keys(senders ?? {})));   // same address-or-@domain match

/**
 * Add a sender to the reading tier — the "read in full" button — or remove
 * one. Alex, 2026-09-06: "How do we add an email to that list?" The file is
 * his, like ignored-senders.json: the triage reads it and tiers anything from
 * a listed sender as reading; the agent never adds to it. What is already
 * judged from that sender is re-tiered at once, so the reading view shows it
 * now rather than after the next mail run — but never an action or a memory
 * item, which are obligations and facts, not reading.
 */
export async function readAsNewsletter(vault, address, { by = 'web', name = null, remove = false } = {}) {
  const addr = String(address ?? '').toLowerCase().trim();
  if (!/^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(addr)) throw new Error('not an address or @domain');
  let retiered = 0;
  await withRepoLock(vault, async () => {
    const path = join(vault, ...READING);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch {
      d = { $comment: ['Senders whose mail Alex reads in full: the "read in full" button on Mail writes this,',
                       'the mail triage tiers anything from them as reading, and the agent never adds to it.'], senders: {} };
    }
    d.senders ??= {};
    if (remove) delete d.senders[addr];
    else if (!d.senders[addr]) d.senders[addr] = { since: localStamp(), by, ...(name ? { name } : {}) };
    await writeFile(path, JSON.stringify(d, null, 2) + '\n');
    // Re-tier what is already judged from this sender.
    const statePath = join(vault, 'integrations', 'email-state.json');
    let st; try { st = JSON.parse(await readFile(statePath, 'utf8')); } catch { return; }
    const from = remove ? 'reading' : null;
    const to = remove ? 'digest' : 'reading';
    for (const t of st.threads ?? []) {
      const c = t.conclusion;
      if (!c || !isIgnored(String(c.who ?? '').toLowerCase(), new Set([addr]))) continue;
      if (['action', 'memory'].includes(c.tier)) continue;
      if (from && c.tier !== from) continue;
      if (c.tier !== to) { c.tier = to; retiered++; }
    }
    if (retiered) await writeFile(statePath, JSON.stringify(st, null, 1) + '\n');
  });
  return { address: addr, remove, retiered };
}

/**
 * Which rule silences an address, and what he said when he wrote it.
 *
 * Alex, 2026-09-19, of the controls on a silenced thread: "if they are
 * already silent, we should show why they were silent." The match is address
 * first, then `@domain` — the same order `isIgnored` uses, because a page that
 * explained the decision differently from the code that made it would be
 * worse than not explaining it.
 */
export async function ignoredBy(vault, address) {
  const a = String(address ?? '').toLowerCase().trim();
  if (!a) return null;
  let d;
  try { d = JSON.parse(await readFile(join(vault, ...IGNORED), 'utf8')); } catch { return null; }
  const senders = d?.senders ?? {};
  const at = a.lastIndexOf('@');
  const key = senders[a] ? a : (at !== -1 && senders[a.slice(at)] ? a.slice(at) : null);
  if (!key) return null;
  const v = senders[key];
  return { key, whole: key.startsWith('@'), ...(v && typeof v === 'object' ? v : {}) };
}

/**
 * Take a name back off the ignore list.
 *
 * The list is his, so removing from it is his too — and it has to be possible
 * from the same place it is added, or the button is a one-way door. Nothing is
 * un-archived: what was archived stays archived, which is the difference
 * between undoing a rule and undoing its history.
 */
/* IGNORING SOMEONE CLOSES WHAT IS OPEN WITH THEM. Alex, 2026-09-30: "yes
   adding someone on ignore list closes tasks." He had asked three times to
   stop hearing from Charity Flights and put @charityflights.example on the list
   on 09-17; "Decide the CFN mission, Fairview GA-Bryce MS" sat on his list
   at high priority for another two weeks, because silencing a sender only
   ever touched mail still to come. Matched on the obligation's counterparty,
   the address or anything at the domain (a subdomain too, as Gmail's from:
   matches it); closed by agent:ignore with the reason, so the evening brief
   names each one and Reopen or un-ignoring puts them back. */
export function senderMatches(who, addr) {
  const m = String(who ?? '').match(/<([^>]+)>/);
  const email = String(m ? m[1] : who ?? '').trim().toLowerCase();
  if (!email.includes('@')) return false;
  const a = String(addr ?? '').toLowerCase().trim();
  if (!a.startsWith('@')) return email === a;
  const host = email.split('@').pop(), dom = a.slice(1);
  return host === dom || host.endsWith('.' + dom);
}

async function openFrom(vault, addr) {
  const { listOpen } = await import('./obligations.mjs');
  return (await listOpen(vault).catch(() => [])).filter((o) => senderMatches(o.who, addr));
}

export async function unignoreSender(vault, key) {
  const k = String(key ?? '').toLowerCase().trim();
  let removed = false;
  let closedByIgnore = [];
  await withRepoLock(vault, async () => {
    const path = join(vault, ...IGNORED);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
    if (!d?.senders?.[k]) return;
    closedByIgnore = Array.isArray(d.senders[k].closed) ? d.senders[k].closed : [];
    delete d.senders[k];
    await writeFile(path, JSON.stringify(d, null, 2) + '\n');
    removed = true;
  });
  // What the ignore closed comes back — unless someone has closed it since
  // for a reason of their own.
  const reopened = [];
  if (closedByIgnore.length) {
    const { reopenObligation } = await import('./obligations.mjs');
    const { readObligationState } = await import('./obligation-state.mjs');
    const st = await readObligationState(vault).catch(() => ({ closed: {} }));
    for (const id of closedByIgnore) {
      if (st.closed?.[id]?.by !== 'agent:ignore') continue;
      const r = await reopenObligation(vault, id, 'agent:ignore', `${k} is no longer ignored`).catch(() => null);
      if (r) reopened.push(id);
    }
  }
  return { address: k, removed, reopened };
}

export async function ignoreSender(vault, address, { by = 'web', name = null } = {}) {
  const addr = String(address ?? '').toLowerCase().trim();
  if (!/^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(addr)) {
    throw new Error('not an address or @domain');
  }

  await withRepoLock(vault, async () => {
    const path = join(vault, ...IGNORED);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch { d = { senders: {} }; }
    d.senders ??= {};
    if (!d.senders[addr]) {
      d.senders[addr] = { since: localStamp(), by, ...(name ? { name } : {}) };
      await writeFile(path, JSON.stringify(d, null, 2) + '\n');
    }
  });

  // Before the mail sweep, so a Gmail refusal cannot leave him ignoring
  // someone whose tasks are still open.
  const tasks = [];
  for (const o of await openFrom(vault, addr)) {
    const r = await closeObligation(vault, o.id, 'agent:ignore',
      `${addr} was put on the ignore list (${localStamp()}) — nothing from them is his to act on`).catch((e) => ({ error: String(e?.message ?? e) }));
    if (!r?.error) tasks.push({ id: o.id, code: o.code, title: o.title });
  }
  if (tasks.length) {
    await withRepoLock(vault, async () => {
      const path = join(vault, ...IGNORED);
      let d; try { d = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
      if (!d?.senders?.[addr]) return;
      d.senders[addr].closed = [...new Set([...(d.senders[addr].closed ?? []), ...tasks.map((t) => t.id)])];
      await writeFile(path, JSON.stringify(d, null, 2) + '\n');
    });
  }

  // Clean up what is already there, in every account that reads mail — the
  // first version swept only the newsletter account, so ignoring a sender on
  // a work thread archived nothing and looked like nothing happened.
  // `from:` on a bare domain needs the @ stripped; Gmail matches it as a suffix.
  const term = addr.startsWith('@') ? addr.slice(1) : addr;
  const accounts = await accountsWith('mail', vault).catch(() => [ACCOUNT]);
  const per = {};
  let matched = 0, inbox = 0, unread = 0;
  /* What was actually touched, so this can be undone.
   *
   * Alex, 2026-09-19, having tapped the domain button by accident: "I
   * accidentially clicked ignore everyone at amazon, it changed the button
   * into 'ignored amazon.com — 1825 archived' … I don't understand where 1825
   * archived came from." Two failures. The number was unexplained, and the act
   * was unrepeatable in reverse: it recorded a count and threw away the ids,
   * so nothing could put back the handful that had actually been in his inbox.
   * Now the ids that HAD `INBOX` or `UNREAD` are written down before they are
   * changed. */
  const touched = { inbox: {}, unread: {} };
  for (const acct of accounts) {
    const token = await accessToken(vault, fetch, acct);
    const ids = [];
    let pageToken;
    do {
      const page = await gmail('/messages', token, {
        q: `from:${term} -in:sent -in:draft newer_than:365d`, maxResults: 500, pageToken,
      });
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < 2000);
    // Which of them the change will actually alter — the rest are already
    // archived and read, and counting those as "archived" is what made the
    // number meaningless.
    const wasIn = (await searchIds(token, `from:${term} in:inbox newer_than:365d`)).slice(0, 2000);
    const wasUn = (await searchIds(token, `from:${term} is:unread newer_than:365d`)).slice(0, 2000);
    if (wasIn.length) touched.inbox[acct] = wasIn;
    if (wasUn.length) touched.unread[acct] = wasUn;
    for (let i = 0; i < ids.length; i += 500) {
      await gmailPost('/messages/batchModify', token, {
        ids: ids.slice(i, i + 500), removeLabelIds: ['UNREAD', 'INBOX'],
      });
    }
    per[acct] = { matched: ids.length, inbox: wasIn.length, unread: wasUn.length };
    matched += ids.length; inbox += wasIn.length; unread += wasUn.length;
  }
  try {
    await mkdir(join(vault, '.log', 'silenced'), { recursive: true });
    await writeFile(join(vault, '.log', 'silenced', `${addr.replace(/[^a-z0-9@.-]/g, '_')}.json`),
                    JSON.stringify({ address: addr, at: localStamp(), by, ...touched }, null, 1));
  } catch { /* the sweep still happened; only the undo record is missing */ }
  // `archived` kept for callers that already read it, but it now means what it
  // says: messages that were in an inbox and are not any more.
  return { address: addr, matched, archived: inbox, inbox, unread, per, tasks };
}

/** Every message id a query matches, to the 2,000 the sweep caps at. */
async function searchIds(token, q) {
  const ids = [];
  let pageToken;
  do {
    const page = await gmail('/messages', token, { q, maxResults: 500, pageToken });
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 2000);
  return ids;
}

/**
 * What silencing a sender would change, before it changes it.
 *
 * Alex, 2026-09-19: "we should have a confirmation." A button whose effect
 * is measured in four figures should say the figure first — and the figure
 * that matters is not how much mail exists, it is how much of it moves.
 */
export async function ignorePreview(vault, address) {
  const addr = String(address ?? '').toLowerCase().trim();
  const term = addr.startsWith('@') ? addr.slice(1) : addr;
  if (!term) return { address: addr, matched: 0, inbox: 0, unread: 0 };
  const accounts = await accountsWith('mail', vault).catch(() => [ACCOUNT]);
  let matched = 0, inbox = 0, unread = 0;
  for (const acct of accounts) {
    const token = await accessToken(vault, fetch, acct);
    const count = async (q) => (await gmail('/messages', token, { q, maxResults: 1 }))?.resultSizeEstimate ?? 0;
    matched += await count(`from:${term} -in:sent -in:draft newer_than:365d`);
    inbox += await count(`from:${term} in:inbox newer_than:365d`);
    unread += await count(`from:${term} is:unread newer_than:365d`);
  }
  // And the tasks it would close — part of what "confirm" is confirming.
  const tasks = (await openFrom(vault, addr)).map((o) => ({ id: o.id, code: o.code, title: o.title }));
  return { address: addr, matched, inbox, unread, tasks };
}
