/**
 * Mail as an obligation source.
 *
 * Same shape as `imessage.mjs` on purpose: the triage writes conclusions into a
 * state file, this reads them, and `obligations.mjs` merges them with everything
 * else. An email asking for the flight dates and a text asking for the flight
 * dates become one item on `/tasks`, which is the whole reason the obligation
 * model exists.
 *
 * ## The ref is a thread, not a message
 *
 * `mail:<account>:<threadId>`. A chase-up arriving in the same conversation must
 * not create a second open item — that is the failure the model was built to
 * stop, and keying by message id would reintroduce it. The Gmail `threadId` is
 * stable across new messages joining, label changes and archiving.
 *
 * Self-prefixed like `todo:` and `rem:`, so `idFor()` in `obligations.mjs` needs
 * no change. The account is in the ref because `install-gmail.sh --account=NAME`
 * already anticipates a second mailbox and Gmail thread ids are account-scoped —
 * two mailboxes would otherwise produce refs that could collide.
 *
 * ## Closing does not archive
 *
 * `close()` marks the conclusion closed and sets `archive_pending`. The next
 * triage pass does the archiving, through `batch_modify_emails`.
 *
 * That is deliberate and worth defending, because archiving inline is the
 * obvious thing. `closeObligation()` runs from a button press, synchronously,
 * **under the repo lock** that the host dispatcher contends for every minute. An
 * inline archive would mean a network round trip while holding it, a Gmail 429
 * turning a local always-works operation into a half-failure, and — worst — a
 * second archiving path. The whole `.mcp.json` posture is that mail is modified
 * through one deliberate door: rate-limited, audit-logged, with the destructive
 * verbs denied by name. Reaching Gmail from here through raw REST would bypass
 * all three.
 *
 * The cost is that the inbox empties at the next triage rather than the instant
 * he presses Done. For someone who never opens his mailbox that latency is free.
 * The invariant is not.
 *
 * **There is a test asserting this file contains no `fetch(`.** If that ever
 * fails, read the paragraph above before deleting it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localStamp } from '../time.mjs';
import { loadContacts, resolveHandle } from '../contacts.mjs';

export const SOURCE = 'email';

const STATE = ['integrations', 'email-state.json'];

/** `mail:<account>:<threadId>` — see the header for why the thread and not the message. */
export function mailRef(threadId, account = 'gmail') {
  return `mail:${account}:${threadId}`;
}

/**
 * A link that opens the thread in Gmail, in the right account.
 *
 * This is what makes archiving safe. Alex, 2026-09-02: "as long as we
 * captured the Obligation we can archive it." The inbox stops being the store —
 * `/tasks` is the list, the mail is evidence — and evidence you cannot get back
 * to is not evidence. Without a link, archiving an obligation's only source
 * means answering "what did they actually say" with a search.
 *
 * `authuser=<address>` rather than `u/0`: the index is a per-browser ordering
 * of signed-in accounts, so `u/0` opens whichever account happens to be first
 * and silently shows the wrong mailbox — or nothing. The address is unambiguous
 * with two accounts signed in, which is the case here.
 *
 * `#all/` rather than `#inbox/`: the whole point is that the thread has been
 * archived, and `#inbox/` on an archived thread finds nothing.
 */
function threadLink(address, threadId) {
  if (!address || !threadId) return null;
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(address)}`
       + `#all/${threadId}`;
}

/** account → address, from the extract. Absent is fine; the link is then null. */
async function addresses(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'gmail.json'), 'utf8'));
    return Object.fromEntries((d.mailboxes ?? [])
      .filter((m) => m.account && m.address)
      .map((m) => [m.account, m.address]));
  } catch {
    return {};
  }
}

export async function read(vault) {
  let st;
  try {
    st = JSON.parse(await readFile(join(vault, ...STATE), 'utf8'));
  } catch {
    // Not set up, or the triage has never run. An empty list is honest; a throw
    // here would take the whole tasks page down with it.
    return [];
  }

  // Resolved late, like the iMessage adapter: a name is a lookup, not a
  // judgement, so every conclusion ever written gets one the moment contacts
  // land, with no re-triage.
  const contacts = await loadContacts(vault);
  const byAccount = await addresses(vault);

  /* ONE RECORD PER THREAD, THE NEWEST. Alex, 2026-09-21, of an Northwind task:
     "why can't I see the latest email thread." Its evidence was listed four
     times — `integrations/email-state.json` held four records for that one
     thread, and 41 threads had duplicates between them, 55 extra records in
     all. The triage is meant to update a thread's record in place and had
     been appending a second one instead.

     Taking the newest by `reviewed` is the honest read: the last judgement is
     the current one, and an older copy of the same thread is not a second
     piece of evidence. It also stops a stale duplicate keeping something
     open after a close; `close()` below now writes to every copy. */
  const newest = new Map();
  for (const t of st.threads ?? []) {
    if (!t.conclusion || !t.thread_id) continue;
    const key = `${t.account || 'gmail'}:${t.thread_id}`;
    const had = newest.get(key);
    if (!had || String(t.reviewed ?? t.watermark ?? '') >= String(had.reviewed ?? had.watermark ?? '')) newest.set(key, t);
  }

  return [...newest.values()]
    .map((t) => {
      const c = t.conclusion;
      return {
        ref: mailRef(t.thread_id, t.account),
        who: resolveHandle(contacts, c.who) || c.who || null,
        // The short imperative headline. `what` stays the full paragraph; a
        // list you have to read a paragraph of per row is a list you skim.
        title: c.title || null,
        what: c.what || '',
        // The subject line is a weak title, but it is a real one written by a
        // human, so it beats a machine-truncated paragraph when the triage
        // wrote no title of its own.
        subject: c.subject || null,
        since: c.since || null,
        // A deadline the triage read out of the mail — a form due before a
        // visit, a payment date. Distinct from `since`, which is when the
        // obligation started.
        due: c.due || null,
        priority: c.priority || 'normal',
        owed_by: c.owed_by === 'them' ? 'them' : 'me',
        open: !!c.open,
        // When this evidence was last judged — what lets a dated close be
        // outvoted only by a NEWER conclusion. See obligation-state.mjs.
        at: t.reviewed ?? t.watermark ?? null,
        // When the newest MESSAGE on the thread arrived — what may reopen a
        // close. `at` moves every time the thread is re-read; this moves only
        // when somebody writes. See fold() in obligations.mjs.
        evidence_at: t.watermark ?? null,
        // What discharge looks like. The triage writes it; `/tasks` shows it.
        closes: c.closes || null,
        // The same, as data the review pass can test. See deploy/closes.mjs.
        closes_when: Array.isArray(c.closes_when) && c.closes_when.length ? c.closes_when : null,
        // `low` when the triage opened it on doubt. Doubt expires: review.mjs
        // closes a low-confidence item nothing has confirmed in 14 quiet days.
        confidence: c.confidence === 'low' ? 'low' : null,
        // The counterparty handed this thread to a colleague. The chase reads
        // it and never writes to the person who handed off. See drafts.mjs.
        handed_to: c.handed_to || null,
        detail: {
          // What he told someone he would do, and when he said it. The brief leads
          // with these: they are his own words to another person, not a task he set
          // himself. Alex, 2026-09-08, on a promise four days quiet.
          promised: c.promised ?? null,
          // The windows the other side offered, as data: deploy/drafts.mjs reads them
          // against his calendar and writes the reply that answers them.
          offer: c.offer ?? null,
          thread_id: t.thread_id,
          account: t.account || 'gmail',
          // The assistant's own copy first: /thread/<account>/<id> renders the
          // cached text in the dashboard, so reading the evidence for a task
          // does not mean leaving the page. Gmail stays as the second link,
          // because the cache holds only what has been judged and only while
          // it lasts.
          link: `/thread/${t.account || 'gmail'}/${t.thread_id}`,
          gmail: threadLink(byAccount[t.account || 'gmail'], t.thread_id),
          // The RFC822 Message-ID of the mail that created the obligation. It
          // is the only identifier that survives across mailboxes, and it is
          // what a reply's `References:` header points at — so a reply sent
          // from another client, landing in a different Gmail thread, is still
          // recognisable as discharging this.
          message_id: c.message_id ?? null,
          subject: c.subject ?? null,
          closed_at: c.closed_at ?? null,
          closed_by: c.closed_by ?? null,
          outcome: c.outcome ?? null,
          archive_pending: !!c.archive_pending,
        },
      };
    });
}

/**
 * Mark one closed. Never deletes the entry: the differ needs to keep seeing the
 * thread or it rediscovers the same obligation on the next run.
 *
 * `closed_by` is the discriminator the differ uses to tell a decision from a
 * judgement — present means a human closed it and it is permanent; absent means
 * the agent did and it may be revisited. Do not set it for an agent close.
 */
/** A deadline moved by hand on a judged thread. The conclusion's `due` is the one field a due edit touches. */
export async function setDue(vault, ref, due) {
  const d = String(due ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(d) || Number.isNaN(Date.parse(d.replace(' ', 'T')))) throw new Error('due must be YYYY-MM-DD or YYYY-MM-DD HH:MM');
  const path = join(vault, ...STATE);
  const st = JSON.parse(await readFile(path, 'utf8'));
  /* EVERY COPY, like close(). `read()` takes the newest of a thread's
     duplicates and this took the first — so on one of the 41 threads that had
     more than one record, setting a date wrote to a copy nothing reads and the
     to-do would have shown the old date back. Same bug, same file, found the
     same day. */
  const dupes = (st.threads ?? []).filter((x) => mailRef(x.thread_id, x.account) === ref && x.conclusion);
  if (!dupes.length) throw new Error('no judged thread with that id');
  const was = dupes[0].conclusion.due ?? null;
  for (const t of dupes) t.conclusion.due = d;
  await writeFile(path, JSON.stringify(st, null, 1) + '\n');
  return { ref, was, due: d, records: dupes.length };
}

export async function close(vault, ref, who, outcome) {
  const path = join(vault, ...STATE);
  let st;
  try {
    st = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('no email triage state on this box');
  }

  /* EVERY RECORD FOR THE THREAD, NOT THE FIRST. `read()` above takes the
     newest of a thread's duplicates; this used to take the first. When those
     were not the same record — 41 threads on 2026-09-21 — a close wrote to a
     copy nothing read, and the obligation stayed open with a logbook line
     saying it had closed. Closing all of them cannot be wrong: they are the
     same thread, and a record the reader ignores is not a second debt. */
  const dupes = (st.threads ?? []).filter((x) => mailRef(x.thread_id, x.account) === ref);
  if (!dupes.length) throw new Error('no such thread in the email triage state');
  if (!dupes.some((x) => x.conclusion?.open)) return { ref, alreadyClosed: true };

  const at = localStamp();
  for (const t of dupes) {
    if (!t.conclusion) continue;
    t.conclusion.open = false;
    t.conclusion.closed_at = at;
    // `agent:unknown`, never `manual`. The differs read a closed_by with no
    // `agent:` prefix as a decision of his and never re-offer it — so a close
    // that arrived with no identity used to become permanent, which is the
    // wrong way to fail. Unknown gets the agent's treatment: one second look.
    t.conclusion.closed_by = who || 'agent:unknown';
    t.conclusion.closed_watermark = t.watermark ?? null;
    if (outcome) t.conclusion.outcome = String(outcome).slice(0, 300);
    // The next triage pass archives it and clears this. See the header.
    t.conclusion.archive_pending = true;
  }
  st.updated = at;

  await writeFile(path, JSON.stringify(st, null, 1) + '\n');
  return { ref, closed: true, at, archivePending: true, records: dupes.length };
}
