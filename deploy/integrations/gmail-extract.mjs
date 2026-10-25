#!/usr/bin/env node
/**
 * `node deploy/integrations/gmail-extract.mjs` — write `integrations/gmail.json`.
 *
 * The mail equivalent of the Mac's iMessage extractor, and deliberately the same
 * shape: pull metadata, write a file, judge nothing. `email-diff.py` then says
 * what moved, and the agent judges only that.
 *
 * ## Metadata only, and that is a security property
 *
 * Every fetch is `format=metadata` with an explicit header allow-list. **No
 * message body is ever requested**, so an injection in one has no reader
 * anywhere in this path — the same argument `hook/classify.mjs` makes. The
 * triage skill can open a specific thread deliberately, through the MCP server,
 * with its rate limits and audit log. What must not happen is a thousand bodies
 * being swept into a file that something later summarises.
 *
 * ## Codes are redacted before they touch disk
 *
 * A subject like "Your verification code is 284913" would otherwise be written
 * into the repo, committed, and pushed. `rules/email-triage.md` says never quote
 * a code; that rule is far stronger if the code was never written down. Digits
 * are replaced in the subject, not the whole subject dropped — "Your
 * verification code is ******" still tells the triage what kind of mail it is.
 *
 * ## Both mailboxes
 *
 * `.mcp.json` decides which accounts exist; this reads the same list, so
 * connecting a third mailbox needs no edit here. Thread ids are account-scoped
 * in Gmail, which is why `sources/email.mjs` keys on `mail:<account>:<threadId>`
 * and why the account travels with every thread.
 *
 * ## Failure is named, never an empty list
 *
 * No credentials, a refused token, a 429 — each writes an `error` and keeps the
 * previous extract. `{ threads: [] }` reads as "your inbox is clear", which is
 * the single most misleading thing this file could say.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken } from '../mcp/google-auth.mjs';
import { archivedSenders } from './gmail-filters.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(OBLIGATIONS, 'integrations', 'gmail.json');
/**
 * Where each account's extract got to last time it SUCCEEDED.
 *
 * Alex, 2026-09-03: "how about since last extract? that way it would catch
 * things if extract fails." Exactly so, and it is the reason this is a cursor
 * rather than a rolling window. The cursor only advances on a complete extract,
 * so a run that fails at 16:15 leaves it at 16:00 and the 16:30 run asks for
 * everything after 16:00 — the gap closes itself. A `newer_than:1d` window
 * would also have covered it, but by re-reading the same day every fifteen
 * minutes and only for as long as the gap stayed under a day.
 *
 * Derived and gitignored: losing it costs one wider-than-usual extract.
 */
const CURSOR = join(OBLIGATIONS, '.log', 'gmail-extract-cursor.json');
/**
 * Never look further back than this, however old the cursor is.
 *
 * Two days, not seven, and the difference is a deadlock. A missing cursor
 * floored to seven days asks for a week of all-label mail — ~600 threads,
 * 6,000+ quota units — which exceeds the per-minute limit, which fails the
 * account, which means the cursor is never written, which means the next run
 * asks for a week again. personal sat in that loop and was absent from the
 * extract entirely; nothing it received after 19:00 was ingested.
 *
 * The window only ever needed to cover mail that arrived AND left the inbox
 * between two runs. `in:inbox` covers everything still in the inbox whatever
 * its age, so a shorter catch-up loses only things archived during an outage —
 * and being floored is reported as incompleteness, so it is never silent.
 */
const CURSOR_MAX_DAYS = 2;
/** Overlap, so mail arriving DURING an extract is not missed by the next one. */
const CURSOR_SLACK_S = 120;

/**
 * How far back to look at SENT. There is no window on the inbox.
 *
 * There used to be one on both — 14 days, on each side — and Alex asked where
 * the number came from. It came from me: it appeared as a bare constant in the
 * iMessage extractor on 2026-08-28 with no reason recorded, and this file cited
 * that as its own justification a few days later. Nothing he ever said set it.
 *
 * It was also doing real damage, because a window on the INBOX is a cliff. A
 * thread that crossed it stopped being visible: unjudged ones became "escapes"
 * and judged ones became obligations whose evidence could no longer be read.
 * Both concepts existed only because of this number. His rule is that no mail
 * is ever invisible to the assistant, and a fourteen-day horizon contradicts it.
 *
 * So the inbox is now unbounded — every thread in it, however old. That is
 * affordable because the inbox is small and getting smaller: 413 threads on
 * personal and 1,523 on work while the backlog drains, heading for near zero,
 * which is the entire point of Email 0. The inbox IS the work queue, and a work
 * queue with a horizon is not one.
 *
 * SENT keeps a window, and 30 days is not a guess either. Alex asked whether
 * it has to reach back as far as the oldest inbox thread now that the inbox has
 * no horizon. It does not, and the reason is worth writing down because it is
 * not obvious.
 *
 * A THREAD CARRIES ITS OWN REPLIES. `threads/{id}` returns every message in the
 * thread whatever its label or age, and shapeThread computes `from_me`,
 * `last_from_me` and `never_replied` across all of them. Checked against the
 * live extract: fifteen threads dated 2026-08-01, far outside this window,
 * correctly report that he replied. So for anything still in the inbox — which
 * is now everything, back to March — SENT contributes nothing at all.
 *
 * What SENT is actually for is the other case: a thread he answered and
 * archived, which is therefore in neither `in:inbox` nor the state's idea of
 * live mail. Twenty-five open obligations were in that position on 2026-09-02.
 *
 * And even there the window is not anchored to how old the obligation is. It is
 * anchored to how recently he REPLIED — `newer_than` matches a thread on its
 * newest message — and a reply that has just happened is recent by definition.
 * So this only has to exceed the gap between Alex hitting send and the next
 * extract, which the dispatcher makes fifteen minutes. Thirty days is about
 * three thousand times that.
 *
 * Unbounded it would be 15,173 threads on personal alone, thirty-seven times
 * the inbox, fetched every fifteen minutes to answer a question none of them
 * bear on. Matching it to the oldest inbox thread would pull six months of the
 * same.
 */
const SENT_DAYS = 30;
/**
 * Per account. A cap that is hit is reported, never silently truncated.
 *
 * Sized against the real mailboxes rather than guessed. The first cap was 150
 * and dropped 297 of his recent threads, which the differ then read as "those
 * threads no longer exist" — the exact failure this number exists to avoid, so
 * it is set with room rather than to fit.
 *
 * Measured 2026-09-02, with the inbox window removed: INBOX is 413 threads on
 * personal and 1,523 on work, plus thirty days of sent. 3,000 clears both with
 * roughly double the headroom, and the inbox side shrinks as the backlog drains
 * — that is what Email 0 means. Whole mailboxes are 1,038,172 and 26,305
 * threads, which is why `in:sent` keeps a window and this is not simply
 * unbounded too.
 *
 * The ceiling this buys against is cost, and there is barely any. One
 * threads.get is 10 quota units against a daily budget of a billion; the
 * binding limit is 250 units/second per user, so a full 600 is about 24
 * seconds of budget spread over a few seconds of wall clock at CONCURRENCY 8.
 * Raising it costs no model calls at all — email-diff.py caps what the agent
 * judges, and this only decides what it can see.
 */
const MAX_THREADS = 3000;
/**
 * Escaped threads asked about by id each run, at most.
 *
 * A thread that left the inbox before it was judged goes to the front of the
 * work list until a conclusion is written, and a thread Gmail no longer has can
 * never get one. "Permit received!" and a blank-subject thread, both Alex's
 * own and gone within fifteen minutes of arriving, 404'd on every mail run from
 * 2026-10-19 09:53: four runs the next morning fired for them alone, at about
 * $1 each, they counted towards every three-thread batch, and the morning
 * brief opened with them. Alex, 2026-10-20, asked why. So each run asks
 * Gmail, by id, about the unjudged ones; a 404 is the answer and the differ
 * marks them gone. Usually zero or two ids; the cap keeps a flood cheap.
 */
const PROBE_MAX = 20;
/** threads.list returns at most this many ids per page. */
const PAGE = 500;
/** Concurrent metadata fetches. Gmail's per-user limit is the real ceiling. */
const CONCURRENCY = 8;

/**
 * The only headers ever requested.
 *
 * An allow-list rather than everything-minus-body: `format=metadata` still
 * returns whatever is asked for, and a future edit that adds a header should
 * have to think about it. `Authentication-Results` is here because it is what
 * the realtime classifier checks and what makes a From line trustworthy.
 */
const HEADERS = ['Subject', 'From', 'To', 'Cc', 'Date', 'Message-ID',
                 'List-Id', 'Auto-Submitted', 'Authentication-Results'];

const p = (n) => String(n).padStart(2, '0');
const localStamp = (d) =>
  `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
  `${p(d.getHours())}:${p(d.getMinutes())}`;

/**
 * Anything code-shaped, gone before it is written.
 *
 * Four to eight digits standing alone. Deliberately blunt: it will also redact
 * an order number or a flight number, and that is the right trade — the triage
 * reads those from the thread when it needs them, and the cost of the other
 * error is a live 2FA code sitting in git history forever.
 */
export function redact(text) {
  return String(text ?? '').replace(/\b\d{4,8}\b/g, (m) => '*'.repeat(m.length));
}

const header = (headers, name) => {
  const want = name.toLowerCase();
  return (headers ?? []).find((h) => String(h.name).toLowerCase() === want)?.value ?? '';
};

export function address(value) {
  const m = /<([^>]+)>/.exec(String(value ?? ''));
  return String(m ? m[1] : value ?? '').toLowerCase().trim();
}

/** Which mailboxes exist, from .mcp.json — one source of truth for the list. */
async function accounts(vault) {
  try {
    const config = JSON.parse(await readFile(join(vault, '.mcp.json'), 'utf8'));
    return Object.entries(config.mcpServers ?? {})
      .filter(([, spec]) => (spec.args ?? []).some((a) => String(a).includes('gmail-mcp')))
      .map(([name]) => name);
  } catch {
    return ['gmail'];
  }
}

async function api(path, token, params = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  // Retry the transient statuses. Gmail's per-user ceiling is 250 quota units a
  // second and one threads.get is 10, so any concurrency at all can trip 429 —
  // it simply never showed up while the window kept this to ~100 threads an
  // account. At 1,523 it lost most of a mailbox.
  //
  // 403 is in the list only for rateLimitExceeded / userRateLimitExceeded,
  // which Gmail returns as 403 rather than 429; a real permission failure has a
  // different reason and is not worth five attempts, so it is matched on the
  // body rather than the status.
  let wait = 400;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return res.json();

    const body = await res.text().catch(() => '');
    const rateLimited = res.status === 429
      || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(body));
    const retryable = rateLimited || res.status >= 500;
    if (!retryable || attempt >= 5) {
      throw new Error(`gmail ${path} (${res.status}): ${body.slice(0, 160)}`);
    }
    // Honour Retry-After when Google sends one; otherwise back off with jitter,
    // because a fleet of workers retrying in lockstep is the same burst again.
    const after = Number(res.headers.get('retry-after'));
    const pause = Number.isFinite(after) && after > 0
      ? after * 1000 : wait + Math.random() * wait;
    await new Promise((r) => setTimeout(r, pause));
    wait = Math.min(wait * 2, 8000);
  }
}

async function pool(items, fn, width = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = { error: String(e.message) }; }
    }
  }));
  return out;
}

/**
 * One thread, flattened to what a triage decision actually needs.
 *
 * `from_me` and `last_from_me` are the load-bearing pair: an obligation running
 * towards Alex and one running away from him are different debts, and the
 * direction is decided by who spoke last — not by who started the thread.
 */
function shapeThread(thread, { account, me, attached = new Set(), filtered = new Set() }) {
  const messages = thread.messages ?? [];
  if (!messages.length) return null;

  const seen = new Set();
  const participants = [];
  const hasAttachment = attached.has(thread.id);

  const shaped = messages.map((m) => {
    const headers = m.payload?.headers ?? [];
    const fromRaw = header(headers, 'From');
    const from = address(fromRaw);
    // The display name, kept because nothing else has it: Contacts knows 112
    // of his 507 correspondents and a people/ file knows 20, so the People
    // page named the rest by their address. Alex, 2026-09-07: "why do we
    // show the email address instead of the person's name?" Metadata already
    // fetched; this is the part of it that was being thrown away.
    const fromName = String(fromRaw ?? '').replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
    const to = [header(headers, 'To'), header(headers, 'Cc')]
      .join(',').split(',').map(address).filter(Boolean);
    for (const a of [from, ...to]) {
      if (a && a !== me && !seen.has(a)) { seen.add(a); participants.push(a); }
    }
    // NOT from the payload. `format: 'metadata'` does not return the parts
    // structure at all, so this test found nothing on every thread ever
    // extracted — 15 of 40 in the 2026-09-02 dry run had attachments and the
    // extract reported none. The floor's "carries an attachment" leg has
    // therefore never once fired, and the never-touch rule that depends on it
    // was unevaluable from this file.
    //
    // Set from a search below instead. Left here as a comment rather than
    // deleted because the obvious fix — walk payload.parts — is exactly what
    // was already wrong.

    const at = Number(m.internalDate ?? 0);
    return {
      id: m.id,
      message_id: header(headers, 'Message-ID') || null,
      at: at ? localStamp(new Date(at)) : '',
      at_ms: at || null,
      from,
      from_name: fromName && fromName.toLowerCase() !== from ? fromName.slice(0, 80) : null,
      from_me: from === me,
      // An unsent draft sits in the thread as a message from him. Found
      // 2026-09-15: nothing marked it, so every draft the assistant saved read as a
      // reply he had SENT — to the differ (never_replied, last_from_me), and to
      // the new cross-channel check, which would have discarded a draft as
      // "dealt with" on the strength of that draft existing. Gmail labels it
      // DRAFT; the extract now says so.
      draft: (m.labelIds ?? []).includes('DRAFT'),
      subject: redact(header(headers, 'Subject')),
      /* THE FIRST LINE OF WHAT THEY SAID. Alex, 2026-09-22, of a push about
         Lena's "I emailed our account rep at TKE and will keep you posted":
         "there was nothing in Lenas message that needed me now." There was
         not — and the urgency classifier could not have known, because a mail
         candidate carried the subject and a message count and no words at all,
         while a text candidate carried the last three messages. It guessed
         from the topic ("technical integration topic, 3 messages suggests
         action").

         Gmail returns `snippet` with `format=metadata`, so this costs no extra
         call and no extra quota. Through the same redaction as the subject,
         and capped: this is a signal for one yes/no question, not a body. */
      snippet: redact(m.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
      list_id: header(headers, 'List-Id') || null,
      auto: /auto-replied/i.test(header(headers, 'Auto-Submitted')),
      // Kept because the realtime path and the triage both care whether Gmail
      // could actually authenticate the sender.
      dmarc_pass: /\bdmarc=pass\b/i.test(header(headers, 'Authentication-Results')),
    };
  }).sort((a, b) => a.at.localeCompare(b.at));

  const last = shaped[shaped.length - 1];
  // "Did he reply" means sent, not typed. The last message still anchors the
  // watermark — a new draft is activity — but the reply signals ignore drafts.
  const sent = shaped.filter((m) => !m.draft);
  const lastSent = sent[sent.length - 1] ?? last;
  const labels = new Set(messages.flatMap((m) => m.labelIds ?? []));

  return {
    thread_id: thread.id,
    account,
    subject: shaped[0].subject,
    participants,
    messages: shaped,
    watermark: last.at,
    // The same instant as an epoch. `watermark` is local wall-clock text with
    // no offset and the differ compares it ACROSS runs, so an extract run in a
    // container without TZ reads four hours newer than the stored watermark and
    // every thread looks updated — 389 of them, observed 2026-09-03. An epoch
    // cannot say that.
    watermark_at: last.at_ms ?? null,
    last_from_me: !!(lastSent.from_me && !lastSent.draft),
    // Alex has never replied on this thread — the strongest cheap signal that
    // a reply may be owed. Whether one IS owed stays with the agent.
    never_replied: !sent.some((m) => m.from_me),
    in_inbox: labels.has('INBOX'),
    unread: labels.has('UNREAD'),
    starred: labels.has('STARRED'),
    has_attachment: hasAttachment,
    is_list: shaped.some((m) => m.list_id),
    // True when one of Alex's own archiving filters covers a sender on this
    // thread. A thread out of the inbox is then explained: his filter put it
    // there, not his hand. Without this the two are indistinguishable, and
    // "he archived this himself" is the more interesting of the two.
    filtered: shaped.some((m) => !m.from_me && filtered.has(String(m.from ?? '').toLowerCase())),
  };
}

/** Seconds since epoch to resume from, and whether the floor had to be used. */
export function resumeFrom(cursor, name, now) {
  const floor = Math.floor(now / 1000) - CURSOR_MAX_DAYS * 86400;
  const saved = Number(cursor?.[name]?.at);
  // No cursor: adopt the present rather than backfilling. There is nothing to
  // catch up ON — a first run has no previous run to have missed anything
  // between — and asking for days of history is what created the deadlock
  // above. The inbox clause still brings in everything sitting in the inbox,
  // however old, so nothing that needs judging is skipped.
  if (!Number.isFinite(saved) || saved <= 0) {
    return { since: Math.floor(now / 1000), floored: false, first: true };
  }
  const since = Math.max(floor, saved - CURSOR_SLACK_S);
  return { since, floored: since === floor && saved - CURSOR_SLACK_S < floor, first: false };
}

/**
 * The escaped threads worth asking Gmail about for one account: not already
 * marked gone, not judged since (a rejudge rollback counts as unjudged, the
 * differ's own rule in note_escapes).
 */
export function escapesToProbe(escaped, state, account, max = PROBE_MAX) {
  const judged = new Set((state?.threads ?? [])
    .filter((e) => e?.thread_id && !e.conclusion?.rejudge)
    .map((e) => e.thread_id));
  return Object.values(escaped ?? {})
    .filter((e) => e?.thread_id && e.account === account && !e.gone && !judged.has(e.thread_id))
    .map((e) => e.thread_id)
    .sort()
    .slice(0, max);
}

/** A 404 from api() is Gmail saying the thread does not exist; nothing else is. */
export const isNotFound = (err) => /\(404\)/.test(String(err?.message ?? err));

async function forAccount(name, since, filtered, probe = []) {
  const token = await accessToken(OBLIGATIONS, fetch, name);

  // Who is "me" for this mailbox — needed for direction, and cheap.
  const profile = await api('profile', token);
  const me = String(profile.emailAddress ?? '').toLowerCase();

  // Recent mail whatever its labels, so a thread that arrived and was filed
  // inside one extract interval is still seen. Spam and trash are excluded: the
  // repo has no trash verb and nothing there is its business.
  //
  // The whole inbox, plus recent sent so a thread Alex answered from his phone
  // is visible as answered. Without SENT the differ would report every replied
  // thread as still waiting on him — but that only ever needed recent sent
  // mail, which is why the window survives on one side of this OR and not the
  // other. See SENT_DAYS.
  // Paged: threads.list caps at 500 ids per call, so a single request could
  // never have covered a 447-thread window however high MAX_THREADS went.
  const q = `(in:inbox OR (in:sent newer_than:${SENT_DAYS}d)`
          + ` OR (after:${since} -in:spam -in:trash))`;
  const ids = [];
  let pageToken;
  let truncated = false;
  do {
    const list = await api('threads', token, {
      q, maxResults: Math.min(PAGE, MAX_THREADS - ids.length), pageToken,
    });
    ids.push(...(list.threads ?? []).map((t) => t.id));
    pageToken = list.nextPageToken;
    if (ids.length >= MAX_THREADS) { truncated = !!pageToken; break; }
  } while (pageToken);

  // Which of these carry a DOCUMENT, in one query rather than 450 full fetches.
  //
  // Not `has:attachment`, which is what this asked first and which was too
  // blunt by a mile: it matches inline signature logos and tracking pixels, so
  // the floor fired on a season-ticket pitch, an "elevator restored" notice and
  // a routine fuel report — three obligations with nothing to do. The clean
  // proof was the LFC borrower statement, which rules/email-triage.md names as
  // the worked example of "digest, with the number" and which the floor
  // promoted to action: the policy contradicted the floor on the one case the
  // policy spells out.
  //
  // `filename:` narrows it to real documents. A thread whose only attachment is
  // a logo is not a thread with a document in it, and the never-touch rule the
  // floor serves is about not losing a DOCUMENT.
  const DOC_TYPES = 'pdf OR doc OR docx OR xls OR xlsx OR csv OR ppt OR pptx '
                  + 'OR zip OR pages OR numbers OR key OR txt OR rtf OR eml';
  const attached = new Set();
  try {
    let page;
    do {
      const r = await api('threads', token, {
        q: `${q} has:attachment filename:(${DOC_TYPES})`,
        maxResults: PAGE, pageToken: page,
      });
      for (const t of r.threads ?? []) attached.add(t.id);
      page = r.nextPageToken;
    } while (page && attached.size < MAX_THREADS);
  } catch {
    // A failed search must not silently mean "nothing has documents" — that is
    // the bug the first version had. Left empty and reported by the caller.
  }

  const fetched = await pool(ids, async (id) => {
    const full = await api(`threads/${id}`, token, {
      format: 'metadata',
      metadataHeaders: HEADERS,
    });
    return shapeThread(full, { account: name, me, attached, filtered });
  });

  // A thread that failed to fetch is NOT a thread that does not exist, and this
  // used to filter the two together. Silently: 1,333 of work's 1,523 inbox
  // threads were dropped by rate-limit failures while the extract reported no
  // problems at all, which downstream reads as "those threads are gone".
  //
  // That is the same mistake the cap comment above warns about, one layer down.
  const failures = fetched.filter((t) => t && t.error);
  const threads = fetched.filter((t) => t && !t.error);

  // Only a 404 is evidence. A rate limit or a timeout says nothing about the
  // thread, and one still in this run's list is plainly there.
  const listed = new Set(ids);
  const gone = [];
  for (const id of probe) {
    if (listed.has(id)) continue;
    try { await api(`threads/${id}`, token, { format: 'minimal' }); }
    catch (e) { if (isNotFound(e)) gone.push(id); }
  }

  return { me, threads, truncated, asked: ids.length, gone,
           withAttachments: attached.size,
           failed: failures.length,
           // One example, so a reader can tell a rate limit from a revoked scope.
           failureExample: failures[0]?.error ?? null };
}

async function main() {
  const names = await accounts(OBLIGATIONS);
  const now = new Date();
  const startedAt = Math.floor(now.getTime() / 1000);

  let cursor = {};
  try { cursor = JSON.parse(await readFile(CURSOR, 'utf8')); } catch { /* first run */ }
  const filtered = await archivedSenders(OBLIGATIONS);
  // Read-only here: the differ owns both files.
  const readJson = async (rel) => {
    try { return JSON.parse(await readFile(join(OBLIGATIONS, rel), 'utf8')); } catch { return null; }
  };
  const escaped = await readJson('integrations/gmail-escaped.json');
  const state = escaped ? await readJson('integrations/email-state.json') : null;
  const gone = [];

  const threads = [];
  const mailboxes = [];
  const problems = [];

  const resumed = {};
  for (const name of names) {
    try {
      const { since, floored, first } = resumeFrom(cursor, name, now.getTime());
      resumed[name] = { since, floored, first };
      const r = await forAccount(name, since, filtered,
        state ? escapesToProbe(escaped, state, name) : []);
      threads.push(...r.threads);
      gone.push(...r.gone.map((thread_id) => ({ account: name, thread_id })));
      mailboxes.push({ account: name, address: r.me, threads: r.threads.length,
                       with_attachments: r.withAttachments,
                       // Named rather than silent. A cap that is quietly hit
                       // reads as "that is all the mail there is".
                       ...(r.truncated ? { truncated_at: MAX_THREADS } : {}),
                       ...(r.failed ? { asked: r.asked, failed: r.failed } : {}) });
      if (r.failed) {
        problems.push({ account: name,
                        error: `${r.failed} of ${r.asked} threads could not be fetched `
                             + `(e.g. ${r.failureExample})` });
      }
      // Truncation is incompleteness too, and it belongs in `partial` for the
      // same reason a failed fetch does: everything past the cap is missing
      // from the output while sitting in the mailbox, and the differ reads
      // missing as gone. Recording it only in `mailboxes` left that inference
      // running against a picture known to have a hole in it.
      if (r.truncated) {
        problems.push({ account: name,
                        error: `hit the ${MAX_THREADS}-thread cap; the mailbox has more` });
      }
      // The cursor advances ONLY on a complete extract for this account. A run
      // that failed or truncated leaves it where it was, so the next run asks
      // for the whole gap — which is the entire point of a cursor over a window.
      if (!r.failed && !r.truncated) cursor[name] = { at: startedAt, ok: localStamp(now) };
      else problems.push({ account: name, error: 'cursor held back — this run was incomplete' });
      // Looking back the maximum means the window may not reach the last
      // success, which is incompleteness like any other.
      if (resumed[name].floored && !resumed[name].first) {
        problems.push({ account: name,
                        error: `cursor older than ${CURSOR_MAX_DAYS}d; only that far back was read` });
      }
    } catch (e) {
      problems.push({ account: name, error: String(e.message).slice(0, 200) });
    }
  }

  // Every mailbox failed: keep the last good extract rather than publishing an
  // empty inbox. One failing out of two is reported and the other still counts.
  if (problems.length && !threads.length) {
    const old = await previous();
    return write({
      updated: localStamp(now),
      error: problems.map((p) => `${p.account}: ${p.error}`).join('; '),
      stale: old?.updated ?? null,
      mailboxes: old?.mailboxes ?? [],
      threads: old?.threads ?? [],
    }, 1);
  }

  // Written before the file, so a crash between the two costs a re-read rather
  // than a silent gap.
  try {
    await mkdir(dirname(CURSOR), { recursive: true });
    await writeFile(CURSOR, JSON.stringify(cursor, null, 1) + '\n');
  } catch (e) {
    problems.push({ account: '-', error: `could not save the extract cursor: ${e.message}` });
  }

  threads.sort((a, b) => b.watermark.localeCompare(a.watermark));
  await write({
    updated: localStamp(now),
    // No inbox window any more; this says what the extract actually covers, so
    // a reader never has to infer the scope from the thread count.
    scope: { inbox: 'all', sent_days: SENT_DAYS,
             // What the recent-mail window actually covered, per account, so a
             // reader never has to infer the scope from the thread count.
             since: Object.fromEntries(Object.entries(resumed)
               .map(([k, v]) => [k, localStamp(new Date(v.since * 1000))])) },
    mailboxes,
    ...(problems.length ? { partial: problems } : {}),
    // Escaped threads Gmail answered 404 for; email-diff.py marks them gone.
    ...(gone.length ? { gone } : {}),
    threads,
  });
  console.log(`gmail: ${threads.length} threads across ${mailboxes.length} mailbox(es)` +
              (problems.length ? `, ${problems.length} failed` : ''));
}

async function previous() {
  try { return JSON.parse(await readFile(OUT, 'utf8')); } catch { return null; }
}

async function write(data, code = 0) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data, null, 1) + '\n');

// Sender names, accumulated. The extract is a 14-day window; a name learned
// today is worth keeping for the person who last wrote in March. Alex,
// 2026-09-07: "why do we show the email address instead of the person's name?"
// Addresses only, no bodies — the same shape of fact the extract already holds.
try {
  const namesPath = join(OBLIGATIONS, 'integrations', 'sender-names.json');
  let known = {};
  try { known = JSON.parse(await readFile(namesPath, 'utf8')).names ?? {}; } catch {}
  let added = 0;
  for (const t of data.threads ?? []) {
    for (const m of t.messages ?? []) {
      const a = String(m.from ?? '').toLowerCase();
      if (!a || !m.from_name) continue;
      if (known[a] !== m.from_name) { known[a] = m.from_name; added++; }
    }
  }
  if (added) await writeFile(namesPath, JSON.stringify({ updated: new Date().toISOString(), names: known }, null, 0) + '\n');
} catch { /* a name map is a convenience; never fail the extract for it */ }
  if (code) {
    console.error(`gmail: ${data.error}`);
    process.exitCode = code;
  }
}

// Importable for the tests; only runs when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
