/**
 * What the rest of the assistant knows about one obligation.
 *
 * Alex, 2026-09-20, looking at seven joins on five different cadences:
 * "should we streamline them so they are one in flow?"
 *
 * **Not one schedule — one answer.** The cadences are load-bearing and must not
 * be unified: `contact.mjs` in the chase path has to run before the email
 * leaves, and `open_elsewhere` has to be in the work list before the triage
 * judges, or the duplicate is created rather than reconciled. That is the
 * prevent/reconcile split in `deploy/PIPELINE.md`, and collapsing it costs
 * exactly what each join was built for.
 *
 * What was worth merging is that four places each assembled their own slice of
 * the same question, and none could see the others':
 *
 *   drafts.mjs      has this person been in touch, so the chase should hold?
 *   drafts.mjs      has this draft been dealt with?
 *   brief-input.mjs have you been in touch, so the brief should ask not assert?
 *   review.mjs      does the record contradict this?
 *
 * So: one loader for the shared sources, one `about(o)` that answers every
 * question about one obligation, and **each caller keeps its own moment and its
 * own decision.** This file knows things; it decides nothing. A chase being
 * held, a draft being discarded and a headline being rewritten are three
 * different acts with three different costs of being wrong, and they stay with
 * the passes that own them.
 *
 * ## The one thing it does unify
 *
 * "Recently in touch" had three implementations and would have grown a fourth.
 * `RECENT_DAYS` is the single answer now, and the reasoning behind the number
 * belongs to the case that set it: Alex, 2026-09-18, on a chase about to go
 * to Dana for something she had answered the day before on another thread.
 * Three days, not "ever" — contact is not the same as an answer, and no flag in
 * the extract tells them apart. The test is whether a follow-up sent now would
 * read as not having noticed them.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOpen } from './agent-service/obligations.mjs';
import { contactSince, loadContactFiles } from './agent-service/contact.mjs';
import { loadContacts } from './agent-service/contacts.mjs';
import { twins, capsOf, words } from './agent-service/similar.mjs';
import { trips } from './conflicts.mjs';
import { parseBookings } from './bookings-parse.mjs';
import { listOutbox } from './agent-service/outbox.mjs';
import { readCloses } from './agent-service/logbook.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How recent counts as "they have been in touch".
 *
 * One number, one reason, one place to argue with it. It was three separately
 * written rules before, which is how a chase gate and a brief could disagree
 * about whether someone had replied.
 */
export const RECENT_DAYS = 3;

/* IDENTICAL TO drafts.mjs's, deliberately — floored, and signed rather than
   absolute. The first cut here used Math.abs and no floor, which sounds like
   the same thing and is not: a reply 3.7 days old holds a chase under `floor`
   and does not under plain division, so the two would have disagreed about
   whether to email somebody. That is precisely the silent divergence this file
   exists to remove, and it appeared while writing the file that removes it. */
const days = (from, now) => (from ? Math.floor((now - Date.parse(String(from).replace(' ', 'T'))) / 86400000) : 0);
export { days as daysForTest };
/** Is this handle or name the same person as that one — see personIs. */
export const samePerson = (a, b, book) => personIs(a, b, book);

/** The imperative that opens an arranging or paying obligation. Stripped before
 *  any word of the title is treated as a name: `capsOf` keeps the first word of
 *  a string, so "Wire the Pinecrest funds" read "wire" as a vendor. */
export const VERB = /^(?:schedule|book|set up|arrange|confirm|reserve|plan|pay|settle|wire|send|put|chase|answer|reply to|get|give|tell|ask)\s+(?:the\s+|a\s+|an\s+|him\s+|her\s+|them\s+)?/i;

/** Trip-specific dull words — `similar.mjs` owns what a distinctive word is. */
const DULL = new Set(['trip', 'travel', 'hotel', 'flight', 'weekend', 'meeting',
  'dates', 'not', 'yet', 'chosen', 'announced', 'recorded', 'the', 'and', 'for']);
/* A consumer or service domain says nothing about who the counterparty is.
   Kept identical to NOISE_ORGS in deploy/integrations/email-diff.py — the two
   answer the same question on two channels, and a test pins them equal. */
export const NOISE_ORGS = new Set([
  'gmail', 'googlemail', 'google', 'apple', 'icloud', 'me', 'mac', 'yahoo',
  'hotmail', 'outlook', 'live', 'msn', 'aol', 'protonmail', 'proton', 'comcast',
  'amazon', 'paypal', 'stripe', 'docusign', 'linkedin', 'substack', 'beehiiv',
  'mailchimp', 'sendgrid', 'ccsend', 'hubspot', 'salesforce', 'intuit',
  'quickbooks', 'zoom', 'calendly', 'superhuman',
]);

/**
 * Who a handle is WITH, as a coarse organisation key — or '' when it says
 * nothing. The first label of the domain, so `amyr@citycab.example` and
 * `ninac@citycab.example` are both `quality-cab`, exactly as the mail differ
 * already treats `eecreportinghours@northwind-aero.example` and
 * `accounts.receivable@northwind-aero.example.br` as one counterparty.
 *
 * His own domains are dropped for the reason the differ records: a surname is
 * not a piece of business, and on the first live run that linked his brother's
 * utility bill to a K-1 chase. A bare name gives '' — it has no domain, so it
 * cannot be joined this way, and failing to a chase is the safe direction.
 */
export function orgOf(handle, own = new Set()) {
  const s = String(handle ?? '').trim().toLowerCase().replace(/^.*<|>$/g, '');
  if (!s.includes('@')) return '';
  const dom = s.split('@').pop().trim();
  const first = dom.split('.')[0];
  if (!first || NOISE_ORGS.has(first) || own.has(dom)) return '';
  return first;
}

/** His own mail domains, so a thread with himself is never a counterparty. */
export async function ownDomains(vault = OBLIGATIONS) {
  try {
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'gmail.json'), 'utf8'));
    return new Set((d.mailboxes ?? []).map((m) => String(m.address ?? '').toLowerCase().split('@').pop()).filter(Boolean));
  } catch { return new Set(); }
}

export function distinctive(name) {
  return [...capsOf(name)].filter((w) => w.length >= 4 && !DULL.has(w));
}
/* An invoice number, normalised so "INV00100003", "INV-00192314" and
   "invoice #00192314" are one key. Digits only after the prefix, five or more,
   so "invoice 2026" in prose is not a number. */
const INVOICE = /\bINV[-#\s]?(\d{5,})\b|\binvoice\s*(?:#|no\.?|number)\s*(\d{5,})\b/gi;
export const invoiceNumbers = (text) => [...String(text ?? '').matchAll(INVOICE)].map((m) => `INV${m[1] ?? m[2]}`);

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this handle the same person as that one — the same address, the same
 *  ten digits, or the same name in the address book. */
function personIs(a, b, book) {
  const norm = (h) => { const s = String(h ?? '').trim().toLowerCase().replace(/^.*<|>$/g, ''); const d = s.replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : s; };
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const idx = book?.index ?? {};
  const name = (k) => String(idx[k] ?? '').trim().toLowerCase();
  /* A side that is already a NAME — which is what every source writes as
     `who` once the address book can name the handle — is its own label. Until
     2026-09-20 only index lookups counted, so "dana@x.com" vs "Dana" was
     never the same person and the they-replied check was blind to exactly the
     obligations the book could name. Found building closes_when. */
  const bare = (h) => { const s = String(h ?? '').trim().toLowerCase().replace(/\s*\(.*\)\s*$/, ''); return /^[^@<>]+$/.test(s) && /[a-z]/.test(s) && !/\d{7,}/.test(s) ? s : ''; };
  const la = name(na) || bare(a), lb = name(nb) || bare(b);
  return !!la && la === lb;
}
export function mentions(text, tripName) {
  const words = distinctive(tripName);
  if (!words.length) return false;
  const hay = String(text ?? '').toLowerCase();
  return words.some((w) => new RegExp(`\\b${escape(w)}\\b`).test(hay));
}

/**
 * Load every shared source once, and hand back a reader over them.
 *
 * `open` may be passed in by a caller that already has the merged list — the
 * drafts pass does — so the same list is never merged twice in one tick.
 *
 * Nothing here throws. A source that cannot be read is named in `blind` and the
 * questions that needed it answer "I do not know" rather than "no", because a
 * silence that reads as an absence is how a chase gets sent to somebody who
 * already replied.
 */
export async function loadContext(vault = OBLIGATIONS, { now = Date.now(), open = null } = {}) {
  const blind = [];
  const catchTo = (label, fallback) => (err) => { blind.push(`${label}: ${err?.message ?? err}`); return fallback; };

  const [obligations, book, files, tripList, bookingText, outbox, logbook, calendarFile, statementsText, mailState] = await Promise.all([
    open ? Promise.resolve(open) : listOpen(vault).catch(catchTo('obligations', [])),
    loadContacts(vault).catch(catchTo('contacts', null)),
    loadContactFiles(vault).catch(catchTo('contact files', null)),
    trips(vault).catch(catchTo('trips', [])),
    readFile(join(vault, 'reference', 'bookings.md'), 'utf8').catch(catchTo('bookings.md', '')),
    listOutbox(join(vault, 'outbox')).catch(catchTo('outbox', [])),
    readCloses(vault).catch(catchTo('logbook', new Map())),
    readFile(join(vault, 'integrations', 'calendar.json'), 'utf8').then(JSON.parse).catch(catchTo('calendar', null)),
    readFile(join(vault, 'reference', 'statements.md'), 'utf8').catch(catchTo('statements.md', '')),
    readFile(join(vault, 'integrations', 'email-state.json'), 'utf8').then(JSON.parse).catch(catchTo('email-state', null)),
  ]);

  /* THE LOGBOOK BY INVOICE NUMBER. Newest close per number, every id that
     closed it kept so an obligation is never matched by its own line. */
  const closedInvoices = new Map();
  for (const l of logbook.values()) {
    for (const n of new Set(invoiceNumbers(`${l.what} ${l.outcome ?? ''}`))) {
      const had = closedInvoices.get(n) ?? [];
      had.push(l);
      closedInvoices.set(n, had);
    }
  }

  /* EVERY THREAD THE MAIL JOB HAS JUDGED, kept after it is archived.
   *
   * Alex, 2026-09-22, of a to-do chasing Wendy Fuller for a flood
   * declaration page: "she did follow up." She had, on 2026-08-31 — on a NEW
   * thread, which the mail job judged as a receipt and archived. Archiving is
   * what removes a thread from the live extract, and the live extract was the
   * only mail `contactSince` reads, so the answer vanished from the one check
   * built to find it ("they wrote on another conversation since") the moment
   * it was filed. By the time the reconciliation existed, 2026-09-20, there was
   * nothing left for it to see, and it chased her for three weeks.
   *
   * The state file is the durable record: who each judged thread was with,
   * and when its last message landed. Newest record per thread, the same rule
   * sources/email.mjs reads by. */
  const judgedMail = [];
  {
    const newest = new Map();
    for (const t of mailState?.threads ?? []) {
      if (!t?.thread_id || !t.conclusion?.who) continue;
      const k = `${t.account || 'gmail'}:${t.thread_id}`;
      const had = newest.get(k);
      if (!had || String(t.reviewed ?? '') >= String(had.reviewed ?? '')) newest.set(k, t);
    }
    for (const t of newest.values()) {
      const at = String(t.watermark ?? t.conclusion.since ?? '').slice(0, 16);
      if (!at) continue;
      judgedMail.push({ at, channel: 'email', from: 'them', thread: t.thread_id, sender: t.conclusion.who,
                        detail: t.conclusion.subject || t.conclusion.title || '', judged: true });
    }
  }
  /* The documents filed to Drive, one line each: `- DATE — **Title** from
     SENDER · [file](link) · …`. The same line shape /reference parses. */
  const statements = statementsText.split('\n').map((l) => {
    const m = l.match(/^- (\d{4}-\d{2}-\d{2}) — \*\*(.*?)\*\* from (.+?) · \[/);
    return m ? { date: m[1], title: m[2], sender: m[3] } : null;
  }).filter(Boolean);
  // Today and the fortnight ahead, already shaped by the extractor — the same
  // two lists conflicts.mjs reads. Nothing here re-parses Google's records.
  const calendar = [...(calendarFile?.today ?? []), ...(calendarFile?.upcoming ?? [])];

  let booked = [];
  try { booked = parseBookings(bookingText); } catch (err) { blind.push(`bookings parse: ${err?.message ?? err}`); }

  // Quadratic, so once for the whole list rather than once per row — the same
  // reason /api/obligations hoists it out of the row loop.
  const twinOf = new Map();
  try { for (const t of twins(obligations)) twinOf.set(t.id, t.twin); } catch (err) { blind.push(`twins: ${err?.message ?? err}`); }

  /* "COULD ANYBODY LOOK" IS NOT "DID loadContacts THROW".
   *
   * It never throws: a missing or unsynced contacts.json comes back as
   * `{ index: {} }`, which is honest for its own purpose — handles stay as
   * handles rather than being given invented names. But an empty address book
   * means no handle resolves to a person, so `contactSince` can only ever
   * return nothing, and reading that as "they have not written" is precisely
   * how a chase goes to somebody who already replied.
   *
   * So the test is whether the book has anybody in it, and an empty one is
   * named in `blind` — a source that cannot answer must not look like a source
   * answering no. */
  const canSeeContact = Object.keys(book?.index ?? {}).length > 0;
  if (!canSeeContact) blind.push('contacts: no address book (integrations/contacts.json missing or empty) — nobody can be matched, so "in touch" cannot be answered either way');

  /**
   * Everything known about one obligation from OUTSIDE its own thread.
   *
   * `inTouch` is deliberately two lists. `recent` is what a chase must hold on;
   * `all` is everything since, which the brief uses to ask rather than assert.
   * The chase's own extra rule — not on the thread this is about — stays in the
   * chase, because it is about that act and not about this person.
   */
  async function about(o) {
    const text = `${o?.title ?? ''} ${o?.what ?? ''}`;
    const trip = tripList.find((t) => mentions(text, t.name)) ?? null;

    let all = [];
    /* Per obligation, not per book. The re-audit, 2026-09-20: `seen` was the
       global "is the index non-empty", so an item with no `who` or no `since`
       — every Apple reminder — got `all = []` with `seen: true`: "nobody could
       look" reported as "they have not written", for exactly the class the
       flag was meant to protect. */
    let seen = canSeeContact && !!o?.who && !!o?.since;
    if (seen) {
      all = await contactSince(vault, o.who, o.since, { contacts: book, files, direction: 'both' })
        .catch(() => { seen = false; return []; });
    }
    const recent = all.filter((x) => days(x.at, now) <= RECENT_DAYS);

    /* WHAT HE SENT ON THIS OBLIGATION'S OWN CONVERSATIONS. Exact only — a
       shared chat or thread id — never a handle: a text to Pete about a $4k
       check is not the answer to the Tahoe item on Pete's thread. After
       `since`, so a message from before the debt existed is not its
       discharge. Review item 2, 2026-09-20. */
    const evChats = new Set([o?.chat_id, ...(o?.evidence ?? []).map((e) => e.detail?.chat_id)].filter(Boolean));
    const evThreads = new Set((o?.evidence ?? []).map((e) => e.detail?.thread_id).filter(Boolean));
    const sent = outbox.filter((d) => d.status === 'sent' && d.sentAt
      && (!o?.since || String(d.sentAt) > String(o.since))
      && ((d.chatId && evChats.has(d.chatId)) || (d.threadId && evThreads.has(d.threadId))));

    /* THE LOGBOOK SAYS IT CLOSED. Every close writes a line keyed by the
       obligation id; only `recurring` and `birthday` ever read them back, so a
       line for a mail or message id has no effect on whether that item is
       open — and a source re-reporting open after a close (the Apple bug,
       a reworded todo line) leaves the logbook saying closed while the list
       says open. Exact id only, and only a line dated after the debt began. */
    const ids = [o?.id, ...(o?.evidence ?? []).map((e) => e.id)].filter(Boolean);
    // Only with a `since` to compare against: an item with none (an Apple
    // reminder whose extract carried no created date) would match ANY
    // historical close of a re-created id.
    let logged = o?.since ? (ids.map((i) => logbook.get(i)).filter((l) => l && String(l.at) > String(o.since))[0] ?? null) : null;
    /* THE SAME INVOICE, CLOSED ON ANOTHER THREAD. Carta INV00100003, 2026-10:
       paid by wire on 10-15 and closed in the logbook on its own thread; on
       10-16 Carta's automatic "due today" reminder arrived on a NEW thread
       and became a new item, which the exact-id rule above cannot see. An
       invoice number is as exact as an id, so here the line may be from
       BEFORE `since` — the payment came first and the dunning mail after it
       is precisely the case. Another obligation's line only; a question for
       the triage, never a close. */
    if (!logged) {
      const own = new Set(ids);
      for (const n of new Set(invoiceNumbers(text))) {
        const l = (closedInvoices.get(n) ?? []).filter((x) => !own.has(x.id)).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
        if (l) { logged = { ...l, invoice: n }; break; }
      }
    }

    /* IT IS ON HIS CALENDAR. For an obligation about arranging something —
       schedule, book, confirm — an event after the debt began whose title
       shares its distinctive words. Two shared words, or one that is not a
       generic verb: "Schedule the N200BB 60-month inspection" ↔ "N200BB
       inspection" is a match; "Confirm the wire" ↔ "Wire transfer training"
       is not, because "wire" alone is not enough. */
    /* `words()` and not `capsOf()`: an event title is lower-case prose —
       "N200BB 60-month inspection at Cypress" — and the word that joins it to
       "Schedule the N200BB 60-month inspection" is "inspection", which no
       capital-letter rule keeps. The arranging verb is stripped first so that
       "Confirm" cannot be one of the two matches. */
    const tw = [...words(String(o?.title ?? '').replace(VERB, ''))];
    const onCalendar = tw.length ? calendar.filter((ev) => {
      if (o?.since && String(ev.startsOn ?? '') < String(o.since).slice(0, 10)) return false;
      // A hold the assistant made itself is the thing he has to confirm, not
      // evidence he did; and it is the system's, not his.
      if (ev.obligations) return false;
      const sw = words(ev.summary ?? '');
      const hits = tw.filter((w) => sw.has(w));
      return hits.length >= 2 || (hits.length === 1 && tw.length === 1);
    }) : [];

    /* THEY WROTE BACK, SOMEWHERE ELSE. For something they owe: anything from
       them since the debt began on a conversation that is NOT this one — the
       obligation's own thread the triage has already read. Dana's answer to
       the leak question arrived on the utility-bill thread, and the chase was
       about to go out. Not recency-bounded like the chase hold: a reply ten
       days ago that nobody judged is still the answer. (Until 2026-09-22 this
       sentence was only half true: the live extract it read IS bounded, by
       archiving — see judgedMail, which is what makes it true now.) */
    /* A RECEIPT ON FILE. For something he owes money on: a document filed
       AFTER the debt began whose title says it is a receipt or a payment,
       from a sender sharing a distinctive word with the obligation. Narrow on
       purpose — the invoice itself is filed the moment the obligation is
       created, so "a document from this vendor" is not evidence of anything;
       only a later one that says paid is. Review 2026-09-20, remaining item. */
    const PAID = /\breceipt\b|\bpaid\b|payment (?:confirmation|received|posted|receipt)|thank you for your payment|\bpayment\b.*\bconfirm/i;
    const vendor = distinctive(String(o?.title ?? '').replace(VERB, ''));
    const paidOnFile = vendor.length ? statements.filter((st) => {
      if (o?.since && st.date < String(o.since).slice(0, 10)) return false;
      if (!PAID.test(st.title)) return false;
      const hay = `${st.title} ${st.sender}`.toLowerCase();
      return vendor.some((w) => new RegExp(`\\b${escape(w)}\\b`).test(hay));
    }) : [];

    const own = new Set([...evChats, ...evThreads]);
    /* An invitation, an acceptance, a cancellation, a bounce is machine-made
       and says nothing about the debt. The first cut flagged "Chase the ONE
       team on the Wallet key test" because they had sent an "Updated
       invitation" — the Dana lesson. `Re:`/`Fwd:` are stripped first so a
       forwarded notice is still a notice. */
    const strip = (t) => String(t ?? '').replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, '');
    const machine = (x) => /^(?:updated |new )?invitation\b|^(?:accepted|declined|tentative(?:ly accepted)?|cancell?ed(?: event)?|notification|reminder):|^automatic reply|^out of office|^undeliverable|mailer-daemon/i.test(strip(x.detail));
    /* ONLY FOR AN OBLIGATION THAT HAS A CONVERSATION. A todo line or an Apple
       reminder has no chat and no thread, so "not on this one" was true of
       every message the person ever sent — "Chase Dana on X" typed into
       todo.md fired on her daily texts, every run. And where the extract
       names a sender, a third party's reply on a thread she is cc'd on is
       not her replying. */
    const theirs = (x) => x.from !== 'you' && (!x.sender || personIs(x.sender, o?.who, book));
    const live = own.size ? all.filter((x) => theirs(x) && (!x.thread || !own.has(x.thread)) && !machine(x)) : [];
    /* Plus what the mail job judged and then archived — see judgedMail. Only
       where the live extract does not already carry the thread, only since the
       debt began, and only a thread with THEM: a judged thread's `who` is its
       counterparty, and the same person test as everything else applies. */
    const liveThreads = new Set(live.map((x) => x.thread).filter(Boolean));
    const filed = own.size && o?.who && o?.since
      ? judgedMail.filter((x) => !own.has(x.thread) && !liveThreads.has(x.thread)
          && x.at >= String(o.since).slice(0, 16) && personIs(x.sender, o.who, book) && !machine(x))
      : [];
    const elsewhere = [...live, ...filed].sort((a, b) => String(a.at).localeCompare(String(b.at)));

    /* WHAT HE WROTE ON THIS OBLIGATION'S OWN CONVERSATIONS, from the extracts
       rather than the outbox: a reply he typed in Gmail or on his phone. The
       `sent-by-me` kind in closes.mjs reads both. */
    const mineOnThread = own.size ? all.filter((x) => x.from === 'you' && x.thread && own.has(x.thread)) : [];

    return {
      trip,
      bookings: trip ? booked.filter((b) => b.trip?.name === trip.name) : [],
      sent, logged, onCalendar, elsewhere, paidOnFile, mineOnThread,
      /* For a `reply-from` naming someone other than the counterparty —
         "Theo completes the device check" on a thread with Tara. Same join
         as `elsewhere`, for that person, not on this obligation's own thread. */
      from: async (who) => {
        if (!canSeeContact || !o?.since) return [];
        const rows = await contactSince(vault, who, o.since, { contacts: book, files, direction: 'theirs' }).catch(() => []);
        return rows.filter((x) => (!x.thread || !own.has(x.thread)) && !machine(x) && (!x.sender || personIs(x.sender, who, book)));
      },
      samePerson: (a, b) => personIs(a, b, book),
      twin: twinOf.get(o?.id) ?? null,
      // `seen: false` means nobody could look, which is not the same as nobody
      // wrote. Every caller must tell those apart or it will act on a silence.
      inTouch: { seen, all, recent, theirs: recent.filter((x) => x.from !== 'you'), mine: recent.filter((x) => x.from === 'you') },
    };
  }

  return { about, obligations, trips: tripList, bookings: booked, outbox, logbook, calendar, statements, book, files, blind, now };
}
