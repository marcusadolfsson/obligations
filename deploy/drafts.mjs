#!/usr/bin/env node
/**
 * Two questions about the things waiting to go out as him.
 *
 * Alex, 2026-09-08: "So the chat bot handled it on request, but I want it
 * more proactive", and after a text written on Sunday sent itself on Tuesday
 * morning saying "out tomorrow": can a draft be modified or deleted.
 *
 *   OWED   a promise he made with no draft behind it — and, where the other
 *          side offered times, the draft written for him on the spot
 *   STALE  a draft whose words have stopped being true: it says "tomorrow" and
 *          was written two days ago, it names a day that has passed, or the
 *          other person has written since
 *
 * Both are arithmetic over what the triage already concluded. Nothing here
 * sends or approves: a draft it writes is `status: draft`. It writes the reply
 * to times someone offered and the follow-up to someone gone quiet, because
 * the pick is a calendar lookup and the sentence is a template.
 *
 *   TIDY   since 2026-09-15 it also keeps one waiting text per person, rewriting
 *          rather than adding, and throws away a draft once he has dealt with
 *          the matter — never one he edited, never one he approved, never a
 *          Gmail draft the assistant did not write. Each change is recorded and
 *          named in the next brief. A draft that is merely stale is still only
 *          reported: stale words are his to fix, dealt-with ones are not.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOpen } from './agent-service/obligations.mjs';
import { listOutbox } from './agent-service/outbox.mjs';
import { suggest } from './scheduling.mjs';
import { localStamp } from './agent-service/time.mjs';
import { OWNER_FIRST } from './agent-service/owner.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_WORDS = /\b(today|tonight|tomorrow|this (?:morning|afternoon|evening)|later today)\b/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ms = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isNaN(t) ? 0 : t; };
export const days = (from, now) => (from ? Math.floor((now - ms(from)) / 86400000) : 0);

/**
 * Why a draft has stopped being true. Pure, so the rules are testable and the
 * same rules can run over a Gmail draft or an outbox one.
 */
export function staleness(draft, { now = Date.now(), threadLast = null } = {}) {
  const why = [];
  const age = days(draft.created, now);
  const text = String(draft.text ?? '');
  // The Owen case: written Sunday, sent Tuesday, still saying "tomorrow".
  if (DAY_WORDS.test(text) && age >= 1) why.push(`it says "${(text.match(DAY_WORDS) ?? [])[0]}" and was written ${age} day${age === 1 ? '' : 's'} ago`);
  // A weekday it names that has since gone by.
  const today = new Date(now);
  for (const m of text.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    const named = WEEKDAYS.indexOf(m[1].toLowerCase());
    const wrote = new Date(ms(draft.created) || now);
    const daysAhead = (named - wrote.getDay() + 7) % 7 || 7;      // the next such day after writing
    const meant = new Date(wrote.getTime() + daysAhead * 86400000);
    if (meant < today) why.push(`it names ${m[1]}, which meant ${meant.toISOString().slice(0, 10)} when it was written — that has passed`);
  }
  // A date it names outright.
  for (const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    if (ms(m[1]) && ms(m[1]) + 86400000 < now) why.push(`it names ${m[1]}, which has passed`);
  }
  // The other side has spoken since.
  if (threadLast && ms(threadLast) > ms(draft.created)) why.push(`they have written since (${threadLast})`);
  // Approved and still sitting: the one state that sends itself later.
  if (draft.status === 'approved' && age >= 1) why.push(`approved ${age} day${age === 1 ? '' : 's'} ago and still not sent — it will go the moment the Mac wakes`);
  else if (draft.status === 'draft' && age >= 3) why.push(`waiting for your tap for ${age} days`);
  return why;
}

/** The last inbound stamp per chat, for the "they have written since" rule. */
async function threadLasts(vault) {
  const out = new Map();
  try {
    const ex = JSON.parse(await readFile(join(vault, 'integrations', 'imessage.json'), 'utf8'));
    for (const t of ex.threads ?? []) {
      const last = (t.messages ?? []).filter((m) => !m.from_me).map((m) => m.at).sort().pop();
      if (last) out.set(t.chat_id, last);
    }
  } catch { /* no extract: that rule simply does not fire */ }
  return out;
}

/** Every draft waiting, with why it may have gone stale. */
export async function stale(vault = OBLIGATIONS, { now = Date.now() } = {}) {
  const lasts = await threadLasts(vault);
  const all = await listOutbox(join(vault, 'outbox'));
  const waiting = all.filter((d) => ['draft', 'approved'].includes(d.status));
  // Who each draft is for, so the two rules below can reason about a person
  // rather than a thread. Alex, 2026-09-08, looking at two drafts to Carl
  // proposing 09:00 after 11:00 had been agreed and sent: "I am confused about
  // these drafts." Both were about one conversation; neither knew of the other.
  const whoFor = (d) => String(d.to ?? '').trim() || handleOf(d.chatId) || d.id;
  const rows = [];
  for (const d of waiting) {
    const why = staleness(d, { now, threadLast: d.chatId ? lasts.get(d.chatId) : null });

    // Another draft is waiting for the same person. Sending both says two
    // different things to one person, and he has to work out which is current.
    const siblings = waiting.filter((x) => x.id !== d.id && whoFor(x) === whoFor(d));
    if (siblings.length) {
      why.push(`${siblings.length} other draft${siblings.length === 1 ? '' : 's'} to the same person `
        + `${siblings.length === 1 ? 'is' : 'are'} also waiting (${siblings.map((s) => s.id).join(', ')}) `
        + '— only one of them can be the current answer');
    }

    // Something already went to this person after this was written. Whatever
    // this draft was going to say, the conversation has moved past it.
    const after = all.filter((x) => x.status === 'sent' && whoFor(x) === whoFor(d)
      && ms(x.sentAt || x.approvedAt || x.created) > ms(d.created));
    if (after.length) why.push(`you have already sent ${whoFor(d)} something since this was written`);

    if (why.length) rows.push({ id: d.id, kind: d.kind ?? 'text', to: d.toName || d.to, status: d.status, created: d.created, why });
  }
  return rows;
}

/**
 * The handle at the end of a chat id — `any;-;+15552000017` is a conversation
 * with `+15552000017`. One person reaches him on several threads (a direct
 * number and a group), and an answer on any of them answers all of them.
 */
const handleOf = (chatId) => String(chatId ?? '').split(';').pop() || null;

/** Places he stopped at, since a date, that are not his usual ones. */
async function placesSince(vault, since, now) {
  const { unusualStays } = await import('./agent-service/location.mjs');
  // A promise is dated, not timed, so the window opens at the start of that day.
  return unusualStays(vault, { since: `${String(since).slice(0, 10)} 00:00`, now });
}

/**
 * Promises with nothing behind them — and, where the conclusion recorded the
 * times the other side offered, the draft to answer with.
 */
export async function owed(vault = OBLIGATIONS, { now = Date.now() } = {}) {
  const open = await listOpen(vault);
  const outbox = await listOutbox(join(vault, 'outbox'));
  const rows = [];
  for (const o of open) {
    if ((o.owed_by ?? 'me') === 'them') continue;
    const ev = (o.evidence ?? []).map((e) => e.detail ?? {});
    const promised = ev.map((d) => d.promised).find(Boolean);
    if (!promised) continue;
    // EVERY thread on the obligation, not the first one.
    //
    // Alex, 2026-09-08: this wrote a second reply to Carl at 10:59 proposing
    // 09:00, forty-four minutes after he had agreed 11:00 and the reply had
    // gone out. Two defects in one line. It read `.find(Boolean)` — the first
    // chat id — and the Brava obligation has two, the direct number and the
    // group; the answer went out on the one it was not looking at. And it
    // counted only `status: draft`, so a reply already SENT did not register
    // as the promise being kept. Both halves had to be wrong for a duplicate
    // to appear, and both were.
    const threads = [...new Set(ev.map((d) => d.chat_id).filter(Boolean))];
    const handles = new Set(threads.map(handleOf).filter(Boolean));
    const offer = ev.map((d) => d.offer).find(Boolean) ?? null;
    // Anything that reaches this person and has not been thrown away: a draft
    // waiting, an approved one on its way, or one already sent. A discarded
    // draft is the one state that means "this is NOT the answer".
    const answers = outbox.filter((d) => d.status !== 'discarded'
      && (threads.includes(d.chatId) || handles.has(String(d.to ?? '').trim())
          || handles.has(handleOf(d.chatId))));
    const sent = answers.filter((d) => d.status === 'sent');
    /* EXACT, for the close. `answers` allows a handle match — right for "is
       something already waiting for this person" — but a text to Pete about a
       $4k check must not close the Tahoe item on Pete's thread. A close needs
       the send to be ON one of this obligation's own conversations. */
    const evThreads = ev.map((d) => d.thread_id).filter(Boolean);
    /* AND AFTER THE PROMISE, AND AFTER ANY PREVIOUS CLOSE. The re-audit,
       2026-09-20: the first cut had no date bound at all, so any sent record
       on that chat — from months before he made the promise — closed it on
       the next hourly pass, with an outcome quoting an unrelated old text. And
       a promise the triage had REOPENED (new message after the close, or the
       close's one second look) was re-closed by the same stale send, with no
       new evidence. A send can only keep a promise made before it, and only
       once: it has to be later than the promise and later than the last time
       this was closed. */
    const lastClosed = ev.map((d) => d.closed_at).filter(Boolean).sort().pop() ?? '';
    const floor = [String(promised), String(lastClosed)].sort().pop();
    const sentExact = sent.filter((d) => d.sentAt && String(d.sentAt) > floor
      && (threads.includes(d.chatId) || (d.threadId && evThreads.includes(d.threadId))));
    // Where he went after promising it. Alex, 2026-09-10, having been told he
    // had not run the Icon keys down when he had: "maybe not a conclusion but
    // a proactive prompt." It never closes anything — standing at an airport
    // is not handing over keys — but "you promised this on Tuesday and you
    // were at City Airport Airport at 14:54" is a question worth putting to
    // him, and it is the one fact a brief cannot otherwise have.
    const went = (await placesSince(vault, promised, now).catch(() => []))
      .filter((v) => v.minutes >= 5).slice(0, 3);
    rows.push({ id: o.id, title: o.title, who: o.who, promised, days: days(promised, now), went,
                chatId: threads[0] ?? null, threads, offer,
                hasDraft: answers.length > 0,
                answered: sent.length > 0,
                // The send that KEPT the promise, if one did. Read by pass().
                sentExact,
                waiting: answers.filter((d) => d.status === 'draft').map((d) => d.id) });
  }
  return rows.sort((a, b) => b.days - a.days);
}

/**
 * A meeting he agreed to, on his calendar as a hold, that nobody has been
 * invited to.
 *
 * Alex, 2026-09-08, after adding Carl to the Brava hold by hand: "what is a
 * good way to automate that?" The hold was already right — the assistant had put
 * 11:00 on Wednesday in his diary the moment the time was settled. What was
 * missing was the half that reaches the other person, because that half mails
 * a third party in his name and so cannot happen without his tap.
 *
 * So this prepares it and never sends it. Both tests are arithmetic: does the
 * conclusion carry an address to invite, and does the event still have nobody
 * on it. Whether a time was truly agreed, and what the address is, stay with
 * the triage, which read the conversation.
 */
export async function uninvited(vault = OBLIGATIONS, { now = Date.now() } = {}) {
  let events = [];
  try {
    const cal = JSON.parse(await readFile(join(vault, 'integrations/calendar.json'), 'utf8'));
    events = [...(cal.today ?? []), ...(cal.upcoming ?? [])];
  } catch { return []; }
  const outbox = await listOutbox(join(vault, 'outbox'));
  const rows = [];
  for (const o of await listOpen(vault)) {
    if ((o.owed_by ?? 'me') === 'them') continue;
    const inv = (o.evidence ?? []).map((e) => e.detail?.invite).find(Boolean);
    if (!inv?.to || !inv?.when) continue;
    const [day, at] = String(inv.when).split(' ');
    // His own hold, at the agreed time, still with nobody on it. `obligations` marks
    // an event this system made, so it never proposes inviting people to
    // something he set up himself for reasons it cannot see.
    const ev = events.find((e) => e.obligations && e.mine && !e.allDay
      && e.startsOn === day && String(e.startsAt) === String(at)
      && !(e.attendees ?? []).some((a) => !a.self));
    if (!ev) continue;
    // One invite per event, whatever became of the last one — a second card
    // for a meeting he already invited someone to is the duplicate problem in
    // a new costume.
    if (outbox.some((d) => d.kind === 'invite' && d.eventId === ev.id && d.status !== 'discarded')) continue;
    rows.push({ id: o.id, title: o.title, who: o.who, to: inv.to, eventId: ev.id,
                summary: ev.summary, when: `${day} ${at}–${ev.endsAt}`,
                conference: inv.conference !== false && !ev.conference });
  }
  return rows;
}

/** Put an invite in the outbox for his tap. Writes a record, sends nothing. */
export async function draftInvite(vault, row, { now = Date.now() } = {}) {
  const at = localStamp(new Date(now));
  const name = `${at.slice(0, 10)}-${at.slice(11, 13)}${at.slice(14, 16)}-invite-`
    + `${String(row.who ?? 'guest').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}.md`;
  const body = `---\ntype: outbox-invite\nto: ${row.to}\nevent_id: ${row.eventId}\n`
    + `attendees: ${row.to}\nconference: ${row.conference ? 'yes' : 'no'}\nwhen: ${row.when}\n`
    + `status: draft\ncreated: ${at}\napproved_at: -\nsent_at: -\nerror: -\n---\n\n`
    + `${row.summary}\n`;
  await writeFile(join(vault, 'outbox', name), body, { flag: 'wx' });
  return { file: name, to: row.to, when: row.when, eventId: row.eventId };
}

/**
 * The subject of a chase, taken out of the title without echoing the
 * instruction back at the person.
 *
 * Every title on the task list is imperative and written from HIS side —
 * "Chase Megan Shaw on the PHOA content pages". Pasting that into a
 * message tells Megan she is being chased, which is both rude and a
 * disclosure of how he keeps his lists. So: strip the verb and the name, keep
 * the thing, and when the shape is not recognised return null and let the
 * sentence say "this". A chase is a reply on a thread whose subject already
 * says what it is about, so "this" is honest rather than vague.
 */
export function topicOf(title) {
  const t = String(title ?? '').trim();
  // Deliberately few, and none of them clever. "Confirm the Frankel
  // membership renewal now posts" has no noun phrase that survives being
  // lifted out — it became "following up on the Frankel membership renewal
  // now posts" — so shapes like that get no pattern and fall through to
  // "this". A slightly generic chase is fine; a garbled one is not, and it
  // goes out over his name.
  const pats = [
    /^chase\s+(the\s+.+)$/i,                              // Chase the OPOA forum history…
    /^chase\s+.+?\s+(?:on|for|about)\s+(.+)$/i,           // Chase Megan Shaw on …
    /^hear back from\s+.+?\s+(?:on|about)\s+(.+)$/i,      // Hear back from Mike Hale on …
    /^nail down\s+(.+?)(?:\s+with\s+.+)?$/i,              // Nail down the … call with X
    /* "Get the …" is how most things they owe are titled. Alex, 2026-09-23,
       of VZ7L: "it is an odd followup" — "Hi Anton — following up on this"
       on a month-old thread about collar trade details, when what is owed is
       the Business Online password reset. Only "get THE …": "Get Gail's
       answer" would come out as her own name, in the third person, to her. */
    /^get\s+(the\s+.+)$/i,                                // Get the Bank Business Online password reset
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m?.[1] && m[1].length > 3) return m[1].replace(/\.$/, '');
  }
  return null;
}

/** The first name to open with, or null when `who` is an address or a company. */
export function firstNameOf(who) {
  const w = String(who ?? '').trim();
  if (!w) return null;
  /* first.last@ — "frank.mason" is Frank. Only that exact shape, and never a
     role mailbox: "Hello," is better than "Hi Info," (2026-10-01). */
  if (w.includes('@')) {
    const local = (w.match(/<([^>]+)>/)?.[1] ?? w).split('@')[0].toLowerCase();
    const m = /^([a-z]{2,15})\.([a-z]{2,20})$/.exec(local);
    const ROLE = /^(info|sales|support|billing|admin|contact|hello|team|accounts?|office|help|noreply|no-reply|service|customer|orders?|news|mail)$/;
    return m && !ROLE.test(m[1]) && !ROLE.test(m[2]) ? m[1][0].toUpperCase() + m[1].slice(1) : null;
  }
  const first = w.split(/[\s,(]/)[0];
  return /^[A-Z][a-z'-]{1,}$/.test(first) ? first : null;
}

/** The chase itself. Two sentences, no more, and never a deadline he did not set. */
/* PROPER SENTENCES, AND WHAT IT IS ABOUT. Alex, 2026-10-01: "for the
   Follow up emails 1) Capitalize the sentences better 2) add more context to
   the follow up." It was "Hi Anton — following up on this. Any update?",
   lower case without a name, and nothing to say when he asked or which mail
   it was. Now: when the waiting started, and the subject he would know the
   thread by — facts from the record, never a line of the assistant's own notes,
   which were not written for the other person. A mail is a short letter with
   a greeting and his name; a text stays one line. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayOf = (stamp) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp ?? ''));
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : null;
};
/* The subject as it stands on the mail, by thread — never the triage's label
   for it, which on the first rewrite read "Citi mortgage application on the
   combined condo" for a thread called "Rivera, mortgage app pending". */
export async function realSubjects(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'gmail.json'), 'utf8'));
    return new Map((d.threads ?? []).filter((t) => t.thread_id && t.subject).map((t) => [t.thread_id, t.subject]));
  } catch { return new Map(); }
}
const cleanSubject = (s) => String(s ?? '').replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().slice(0, 90);

export function chaseText(row) {
  const name = firstNameOf(row.who);
  const topic = topicOf(row.title);
  const when = dayOf(row.since);
  const subject = cleanSubject(row.subject);
  if (row.channel !== 'mail') {
    const what = topic ?? (subject ? `"${subject}"` : 'our conversation');
    const line = `following up on ${what}${when ? ` from ${when}` : ''}. Any update?`;
    return name ? `Hi ${name}, ${line}` : line.charAt(0).toUpperCase() + line.slice(1);
  }
  const about = topic ?? (subject ? `"${subject}"` : when ? 'my note' : 'my earlier note');
  const where = [when ? `from our exchange on ${when}` : null, topic && subject ? `("${subject}")` : null].filter(Boolean).join(' ');
  const body = `Following up on ${about}${where ? `, ${where}` : ''}. Any update?`;
  return `${name ? `Hi ${name},` : 'Hello,'}\n\n${body}\n\nThanks,\n${OWNER_FIRST}`;
}

/**
 * Waiting on someone else, long enough, with nobody having chased them.
 *
 * Alex, 2026-09-08: "if we wait on others, it would be good to auto-draft a
 * follow up after a certain amount of time."
 *
 * `stale.mjs` has found these since 2026-09-05 and the evening job was told to
 * draft them, capped at five a night. It never did once — the log holds no
 * mail-draft call at all, while the briefs listed the same quiet threads every
 * morning for weeks, some of them now 32 days old. That is the same lesson as
 * the promise drafting: judgement that has to happen every night, in a job with
 * fifteen other steps, does not happen. So the sentence becomes a template and
 * the selection becomes arithmetic, and the only thing left to a human is the
 * tap that sends it.
 *
 * Three things keep it from becoming a nuisance. A ledger, so a chase drafted
 * once is not drafted again for `rechaseDays` even if he discards it. A daily
 * cap, because the pass runs hourly and a cap per run would be no cap at all.
 * And machine addresses are refused by the draft door itself.
 */
export const CHASE_AFTER = 5;
export const RECHASE_AFTER = 7;
/* ONE CHASE PER PERSON PER WEEK is the policy; the daily number is a tripwire.
   Review item 5, 2026-09-20. "Three a day" was a budget on his attention,
   not on theirs: it let the same person be nudged on Monday about the K-1 and
   Tuesday about the invoice, while a third person with one old debt waited a
   fortnight for a slot. The unit of a chase is the relationship — a person
   hears from him about what is outstanding at most once a week, the ranked
   item first — and ten in a day is a matcher gone wrong, not a busy day. */
export const PERSON_EVERY = 7;
export const CHASES_A_DAY = 10;
// How recently they must have written elsewhere for a chase to be held. Long
// enough that a follow-up would look like it had not noticed them; short enough
// that a fortnight-old calendar invitation does not silence a real chase.
export const REPLY_RECENT = 3;

/**
 * Which three, when eleven are eligible.
 *
 * Alex, 2026-09-17, on the follow-ups: "from my perspective they appear very
 * adhoc." Half of that was a bug (a name where an address belonged, failing
 * silently). The other half was real: the order was days-quiet and nothing
 * else, so a $16,717 invoice and a cabinetry proposal were the same thing and
 * the three that went out were the three that were oldest.
 *
 * Three keys, in this order. Each is a fact already on the obligation — nothing
 * here is a judgement about importance, which is his:
 *
 *   1. **a project he is for** — a focus tag, in his own order from the project
 *      files. #one before #phoa because he put them that way.
 *   2. **a deadline** — overdue first, then due within a week. A quiet thread
 *      with a date on it costs something on a day he can name.
 *   3. **how long it has been quiet**, which is where it started.
 *
 * `why` comes back on every row so the report can say what decided it. Pure,
 * so the order is testable and does not drift with the mailbox.
 */
/**
 * How long it has ACTUALLY been quiet — the gap since they last wrote.
 *
 * Alex, 2026-09-21, of a chase to the One Springfield manager:
 * "manager@harborview-condo.example email me on Sep 18th. it has not been 11 days
 * quiet." It had not. The 11 was the obligation's AGE — `days` is
 * `daysSince(since)`, the day the waiting started — and every surface that
 * said "days quiet" was reading it. Lena had answered three days earlier.
 *
 * Two things were wrong and both had to be, for the chase to go:
 *
 *  - The number in the sentence was never a measure of silence. An item
 *    opened on 09-10 reads as 11 days quiet on 09-21 however much was said in
 *    between, so the threshold "five days quiet" was really "five days old".
 *  - The recency hold that should have caught it **excludes the chase's own
 *    thread**, on the reasoning that a reply there would have closed the item.
 *    It does not: the triage read her 09-18 message, and correctly kept the
 *    obligation open because the Brokerly proposal still had not arrived.
 *    Answering is not the same as discharging, and a live conversation is the
 *    last thing that should be chased.
 *
 * So quiet is the gap since the newest message FROM THEM on any channel, this
 * thread included, and it falls back to when the waiting started when nothing
 * from them is on file — which is the honest reading of "they have never
 * answered".
 */
export function quietFor(said, { since = null, now = Date.now() } = {}) {
  const theirs = (said ?? [])
    .filter((x) => x?.from === 'them' && x?.at)
    .map((x) => String(x.at))
    .sort();
  const last = theirs[theirs.length - 1] ?? since;
  return last ? days(last, now) : null;
}

/**
 * The first sentence or two of an obligation's `what` — its headline, before
 * any dated UPDATE — cut at a sentence boundary. What a note needs to say what
 * a chase is about, in the triage's own words rather than a second summary.
 */
export function headlineOf(what, max = 280) {
  const head = String(what ?? '').split(/\n+UPDATE\b/)[0].replace(/\s+/g, ' ').trim();
  if (head.length <= max) return head;
  const cut = head.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  // Any real sentence end is a better place to stop than mid-word.
  return end > 20 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

export function rankChases(rows, { focusRank = new Map(), now = Date.now() } = {}) {
  const key = (r) => {
    const tags = (r.tags ?? []).map((t) => String(t).toLowerCase());
    const hit = tags.map((t) => focusRank.get(t)).filter((n) => n != null).sort((a, b) => a - b)[0] ?? null;
    const soon = r.overdue ? 0 : (r.lead_days != null && r.lead_days <= 7 ? 1 : 2);
    return { focus: hit ?? 99, tag: hit != null ? tags.find((t) => focusRank.get(t) === hit) : null, soon };
  };
  return [...rows]
    .map((r) => ({ r, k: key(r) }))
    .sort((a, b) => a.k.focus - b.k.focus || a.k.soon - b.k.soon
                 || (b.r.quiet ?? b.r.days ?? 0) - (a.r.quiet ?? a.r.days ?? 0))
    .map(({ r, k }) => ({
      ...r,
      why: [k.tag ? `#${k.tag}` : null,
            r.overdue ? 'overdue' : (r.lead_days != null && r.lead_days <= 7 ? `due in ${r.lead_days}d` : null),
            // `quiet` when the pass has measured it; `days` is the item's age
            // and is only a stand-in before that. See quietFor.
            `${r.quiet ?? r.days ?? 0} days quiet`].filter(Boolean).join(', '),
    }));
}

export async function chases(vault = OBLIGATIONS, { now = Date.now(), quietDays = CHASE_AFTER,
                                              rechaseDays = RECHASE_AFTER, perDay = CHASES_A_DAY,
                                              personEvery = PERSON_EVERY } = {}) {
  const { stale: staleList } = await import('./stale.mjs');
  const { them } = await staleList(vault, { quietDays });
  const { readObligationState } = await import('./agent-service/obligation-state.mjs');
  const ledger = (await readObligationState(vault)).chased;
  const today = localStamp(new Date(now)).slice(0, 10);
  const doneToday = Object.values(ledger).filter((v) => String(v.at ?? '').startsWith(today)).length;
  const outbox = await listOutbox(join(vault, 'outbox'));

  const { isMachine } = await import('./agent-service/handles.mjs');
  // His order, from the `focus:` lines in projects/. Unreadable means no
  // ranking by project rather than a guessed one — the rest of the order still
  // holds.
  const { focusProjects } = await import('./agent-service/projects.mjs');
  const focusRank = new Map((await focusProjects(vault).catch(() => []))
    .filter((p) => p.tag).map((p) => [p.tag, p.focus]));
  // Have they answered somewhere else? Alex, 2026-09-18, on a four-day-old
  // "Chase Dana on the Elmwood water leak check": "She did respond via email."
  // She had — the day before, on a utility-bill thread, saying the city had
  // found the usage and her landscaper was on it. The text thread he asked on
  // was silent, so this would have sent Dana a follow-up about something she
  // had already dealt with. A chase goes out over his name; the cost of
  // holding one that was not needed is a day, and the cost of sending one is
  // his word.
  /* ONE LOADER. This used to pull the address book and the contact files
     itself, while review.mjs pulled obligations and trips, and neither could
     see the other's half — four places each assembling their own slice of the
     same question. context.mjs loads all of it once and answers `about(o)`;
     the DECISION below is unchanged and stays here, because holding a chase
     and rewriting a headline have different costs of being wrong. */
  const { loadContext } = await import('./context.mjs');
  const ctx = await loadContext(vault, { now });
  const subjects = await realSubjects(vault);
  const book = ctx.book;
  const answered = [];
  const held = [];
  const { samePerson, orgOf, ownDomains } = await import('./context.mjs');
  const own = await ownDomains(vault).catch(() => new Set());
  /* WHAT HE OWES THE SAME COMPANY. Alex, 2026-09-21, on a chase that went to
     Amy at Quality Cabinets Co: "there are other people in the same company I have
     talked to about this project."
     
     It was right about the thread — 38 days, nothing back — and blind to the
     rest of the firm: a colleague had written thirteen days earlier, and the
     obligation with her was one HE owed. Chasing a vendor for a number while
     owing that vendor a decision is wrong however quiet their thread is, and
     it is arithmetic: same organisation, open, owed by him. The organisation
     rule is the differ's own, so the two cannot drift. */
  const owedToOrg = new Map();
  for (const o of ctx.obligations ?? []) {
    if (!o.open || (o.owed_by ?? 'me') !== 'me') continue;
    const org = orgOf(o.who, own);
    if (org && !owedToOrg.has(org)) owedToOrg.set(org, o);
  }

  /* HOW LONG EACH HAS ACTUALLY BEEN QUIET, before anything is ranked or
     written. Alex, 2026-09-21: "manager@harborview-condo.example email me on Sep
     18th. it has not been 11 days quiet." The ranking sorts by it and the
     sentence quotes it, so it has to be known first — measured in the loop, it
     arrived after rankChases had already written the age into `why`. */
  const measured = [];
  for (const r of them) {
    const known = r.since && book ? await ctx.about(r).catch(() => null) : null;
    measured.push({ ...r, quiet: quietFor(known?.inTouch?.all, { since: r.since, now }) });
  }

  const rows = [];
  for (const r of rankChases(measured, { focusRank, now })) {
    /* HE HANDED IT ON. Alex, 2026-09-21: "I don't want Amy G chase to fire
       after I respond to nina. Amy handed me off to nina at one
       point." A handoff is permanent — the person who passed the thread along
       is not the person who owes the answer, and waiting for him to clear the
       other obligation would only delay the wrong mail rather than stop it.
       Reported, never sent: which thread the colleague should be chased on is
       a judgement, and a chase goes out over his name. */
    if (r.handed_to) {
      held.push({ ...r, why: `${r.who} handed this to ${r.handed_to} — chase them on their own thread, or merge the two items` });
      continue;
    }
    /* OWED THE SAME COMPANY. Held rather than dropped: when he answers them,
       the chase is fair again. */
    const org = orgOf(r.who, own);
    const owe = org ? owedToOrg.get(org) : null;
    if (owe && owe.id !== r.id) {
      const same = samePerson(owe.who, r.who, ctx.book);
      held.push({ ...r, owes: owe.id,
        why: same
          ? `you owe them an answer first — "${owe.title}" is open and yours`
          : `you owe ${owe.who ?? 'a colleague'} an answer first — "${owe.title}" is open and yours, at the same company` });
      continue;
    }
    // A noreply, a mailer-daemon, a Superhuman bounce. The draft door refuses
    // these too, but refusing here means the daily cap is not spent on one and
    // the report says why rather than showing a failure.
    if (isMachine(r.who)) continue;
    if (r.channel === 'mail' && (!r.thread || !r.account)) continue;
    const last = ledger[r.id]?.at;
    if (last && days(last, now) < rechaseDays) continue;
    // The PERSON, not the obligation: anything put in front of him for this
    // person in the last week — on any of their debts, including one drafted
    // a moment ago in this same pass — holds the rest. `ledger` keys are
    // obligation ids and each entry names who it went to.
    const same = (v) => v?.who && (ctx.book ? samePerson(v.who, r.who, ctx.book) : String(v.who).trim() === String(r.who).trim());
    const toPerson = [...Object.entries(ledger).filter(([id, v]) => id !== r.id && same(v)).map(([id, v]) => ({ id, at: v.at })),
                      ...rows.filter((x) => same(x)).map((x) => ({ id: x.id, at: localStamp(new Date(now)) }))]
      .filter((x) => x.at && days(x.at, now) < personEvery).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (toPerson.length) {
      const l = toPerson[toPerson.length - 1];
      held.push({ ...r, why: `${r.who} was chased ${days(l.at, now) === 0 ? 'today' : `${days(l.at, now)}d ago`} about something else (${l.id}); one a week per person` });
      continue;
    }
    // Something already waiting for this person answers the same question.
    const handle = String(r.who ?? '').trim();
    if (outbox.some((d) => d.status === 'draft' && String(d.to ?? '').trim() === handle)) continue;
    if (r.since && book) {
      // BOTH directions. Alex, 2026-09-19, of a chase drafted at 00:05 to
      // Noah & Co: "since I sent several emails to her yesterday, I don't
      // think that follow up is necessary?" He had written to her three times
      // the previous afternoon — on the IOTA returns and his personal tax, not
      // on the thread this chase was about. "Following up on this. Any update?"
      // arriving the next morning reads as not having noticed his own emails.
      //
      // His own recent writing counts for the same reason theirs does: the
      // question a chase asks is "has this gone quiet between us", and it has
      // not gone quiet if either of them spoke yesterday.
      /* From the shared context — one loader, one recency rule. Alex,
         2026-09-20: "should we streamline them so they are one in flow?" The
         answer for the CADENCE is no (this has to run before the email leaves,
         which a nightly pass cannot), but "have they been in touch" had three
         implementations and this is now the only one. `REPLY_RECENT` and
         `RECENT_DAYS` are the same number and a test pins that they stay it. */
      const known = await ctx.about(r);
      const said = known.inTouch.all;
      /* THEY WROTE ELSEWHERE AND NOBODY HAS READ IT YET. Beyond the three-day
         window a reply is not silenced for ever — but while the review has a
         `they-replied` finding open on this item (their message is newer than
         the triage's last look at the thread), sending "any update?" would be
         chasing an answer that is sitting in the record. Once the triage has
         looked since and kept the item open, the message was not the answer,
         and the chase goes. Review item 5, 2026-09-20. */
      const unjudged = (known.elsewhere ?? []).filter((x) => !r.reviewed || String(x.at) > String(r.reviewed));
      if (unjudged.length) {
        const x = unjudged[unjudged.length - 1];
        answered.push({ ...r, replied: unjudged.slice(-3),
          why: `they wrote elsewhere on ${String(x.at).slice(5, 16)} (${x.channel}${x.detail ? `: ${x.detail}` : ''}) and the triage has not looked at this since — it has been asked whether that was the answer` });
        continue;
      }
      // Not on the thread this is about — that would already have moved the
      // watermark and closed it.
      //
      // And RECENT. Contact is not the same as an answer, and the extract
      // cannot tell them apart: Dana's utility-bill reply was the answer, a
      // calendar invitation from Talia two weeks ago was not, and both are
      // "they wrote since" to a machine. So the test is whether a follow-up
      // sent now would read as not having noticed them — three days. Anything
      // older is reported and chased anyway, the same division the draft tidy
      // settled on: act on what is unambiguous, ask about the rest.
      const elsewhere = said.filter((x) => (!x.thread || x.thread !== r.thread)
        && days(x.at, now) <= REPLY_RECENT);
      if (elsewhere.length) {
        const mine = elsewhere.some((x) => x.from === 'you');
        const who = mine && elsewhere.every((x) => x.from === 'you') ? 'you have written to them'
          : mine ? 'you have both written' : 'they have written';
        answered.push({ ...r, replied: elsewhere.slice(-3),
          why: `${who} since, elsewhere: ${elsewhere.slice(-3).map((x) => `${x.from === 'you' ? 'you, ' : ''}${x.channel} ${String(x.at).slice(5, 16)}${x.detail ? ` (${x.detail})` : ''}`).join('; ')}` });
        continue;
      }

      /* HE WROTE IT HIMSELF, ON THIS VERY THREAD. Alex, 2026-09-23, of a
         12:43 chase to Gail Quinn: "I already send Tess an email today
         before this drafted." He had — twice, at 11:17 and 11:53, on the
         thread the chase was about, laying out the two threshold-engineer
         paths and asking her to pick one. "Following up on this. Any update?"
         went out an hour later.

         Neither check above could see it. `elsewhere` skips this thread on
         purpose, and `quiet` measures the silence from THEM, which is right
         for the threshold and blind to everything he says. So his own writing
         counted everywhere except the one place a chase is actually sent.

         Same reasoning as the Noah & Co hold: the question is whether this
         has gone quiet BETWEEN them, and a follow-up that ignores his own mail
         from an hour ago is the worst version of the failure, not a lesser
         one. Any channel, because he answers on whichever is to hand. */
      const his = said.filter((x) => x.from === 'you' && days(x.at, now) <= REPLY_RECENT);
      if (his.length) {
        const x = his[his.length - 1];
        held.push({ ...r, why: `you wrote to ${r.who} yourself ${days(x.at, now) === 0 ? 'today' : `${days(x.at, now)}d ago`} (${x.channel} ${String(x.at).slice(5, 16)}${x.detail ? `: ${x.detail}` : ''}) — a chase now reads as not having noticed your own` });
        continue;
      }

      /* STILL TALKING, ON THIS THREAD. Alex, 2026-09-21:
         "manager@harborview-condo.example email me on Sep 18th. it has not been 11
         days quiet." The two checks above look everywhere EXCEPT the thread
         the chase is about, on the reasoning that a reply there would have
         closed the item. It does not: the triage read Lena's 09-18 message
         and correctly kept the obligation open, because the proposal he is
         waiting for still had not arrived. Answering is not discharging.

         Last, so the two above keep their better answer — they can say where
         they wrote and what they said, and this one only knows the gap. Held,
         not dropped: when it really does go quiet the chase goes, with a true
         number on it. */
      if (r.quiet != null && r.quiet < quietDays) {
        held.push({ ...r, why: `not quiet — they wrote ${r.quiet === 0 ? 'today' : `${r.quiet}d ago`}` });
        continue;
      }
    }
    rows.push({ ...r, subject: subjects.get(r.thread) ?? null, text: chaseText({ ...r, subject: subjects.get(r.thread) ?? null }), lastChased: last ?? null,
                blocked: rows.length + doneToday >= perDay ? 'over the daily cap' : null });
  }
  return { rows: rows.filter((r) => !r.blocked), held: rows.filter((r) => r.blocked).length + held.length,
           // Why each was held: the person was chased this week, or the cap.
           heldRows: [...held, ...rows.filter((r) => r.blocked).map((r) => ({ ...r, why: r.blocked }))],
           answered, doneToday, considered: them.length };
}

/**
 * One obligation, on demand, whatever its age.
 *
 * Alex, 2026-09-08: a Draft Follow-up button beside Close on the To Do page.
 * `chases()` is the unattended half and is deliberately conservative — five
 * days quiet, three a day, oldest first — because nobody is watching it. When
 * he asks for one by name none of that applies: he can see the item, he chose
 * it, and the cap exists to stop a machine flooding him rather than to stop
 * him. So this shares the sentence and the ledger and skips the gate.
 */
export async function followUpRow(vault = OBLIGATIONS, id) {
  const { staleFrom } = await import('./stale.mjs');
  const open = await listOpen(vault);
  const o = open.find((x) => x.id === id);
  if (!o) throw new Error(`no open obligation called ${id}`);
  // Which way the debt runs decides whether a template can be honest at all.
  //
  // "Following up — any update?" is the right sentence when THEY owe him and a
  // wrong one when he owes them: chasing Holly Dorsey about a decision that is
  // his would be worse than silence. A holding reply needs a reason and a date
  // that only he knows, so the button hands those to the chat rather than
  // inventing them. Alex, 2026-09-08.
  if ((o.owed_by ?? 'me') !== 'them') {
    const err = new Error('this one is yours to answer, not theirs — a follow-up would be chasing them '
      + 'about your own decision. Say what you want to tell them and I will draft it.');
    err.code = 'OWED_BY_YOU';
    throw err;
  }
  // Borrow the row builder rather than rebuilding it, so a follow-up he asks
  // for and one the pass writes can never disagree about who to write to.
  const both = staleFrom([{ ...o, days: o.days ?? 999 }], { quietDays: 0 });
  const row = both.them[0];
  if (!row) throw new Error('nobody to follow up with — this item has no person and no channel');
  if (row.channel === 'mail' && (!row.thread || !row.account)) {
    throw new Error('no mail thread to reply on — follow up by hand');
  }
  const { isMachine } = await import('./agent-service/handles.mjs');
  if (isMachine(row.who)) throw new Error(`${row.who} is a machine address, not a person`);
  const subject = (await realSubjects(vault)).get(row.thread) ?? null;
  return { ...row, subject, title: o.title ?? row.title, text: chaseText({ ...row, subject, title: o.title ?? row.title }) };
}

/**
 * Put a text in front of him: rewrite the one already waiting for that person,
 * or write a new one if there is none.
 *
 * Alex, 2026-09-15, looking at two texts to Ari and three replies on one
 * Miles thread: "If there is new information, rewrite a pending unsent
 * message rather than adding new ones." Two drafts to one person is never two
 * answers — he can send only one, and whichever he leaves reads as unanswered.
 *
 * The person, not the file: a draft to the number and a draft to the group
 * thread with that number in it both count, through the address book.
 *
 * One exception, and it holds the other way: a draft HE has edited is his
 * sentence now. It is not overwritten and no rival is written beside it; the
 * caller is told it was held, and says so.
 */
export async function putText(vault, { to, chatId = null, text, slug, now = Date.now() }) {
  const { handlesFor } = await import('./agent-service/contact.mjs');
  const { loadContacts } = await import('./agent-service/contacts.mjs');
  const { setText } = await import('./agent-service/outbox.mjs');
  const box = join(vault, 'outbox');
  const book = await loadContacts(vault).catch(() => null);
  const want = handlesFor(book, chatId ?? to);
  const same = (d) => {
    if (chatId && d.chatId === chatId) return true;
    const theirs = handlesFor(book, d.chatId ?? d.to);
    return [...want].some((k) => theirs.has(k));
  };
  const waiting = (await listOutbox(box))
    .filter((d) => d.kind === 'text' && d.status === 'draft' && same(d))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const his = waiting.find((d) => d.editedAt && !/\bby agent:/.test(d.editedAt));
  if (his) return { held: true, file: his.id, why: `you edited the draft already waiting (${his.id}), so it was left as you wrote it` };
  if (waiting.length) {
    await setText(box, waiting[0].id, text, 'agent:drafts');
    await recordDraftChange(vault, { action: 'rewrote', kind: 'text', id: waiting[0].id, to: waiting[0].toName || waiting[0].to,
                                     was: waiting[0].text, text: String(text).trim(), why: 'newer words for the same person' });
    return { file: waiting[0].id, rewrote: true, was: waiting[0].text };
  }
  const at = localStamp(new Date(now));
  const name = `${at.slice(0, 10)}-${at.slice(11, 13)}${at.slice(14, 16)}-${slug}.md`;
  await writeFile(join(box, name),
    `---\ntype: outbox\nto: ${to}\nchat_id: ${chatId ?? '-'}\nstatus: draft\ncreated: ${at}\napproved_at: -\nsent_at: -\nerror: -\n---\n\n`
    + `${String(text).trim()}\n`, { flag: 'wx' });
  return { file: name };
}

/** Write one chase where it can be sent with one tap. Never sends. */
export async function draftChase(vault, row, { now = Date.now() } = {}) {
  const at = localStamp(new Date(now));
  let wrote = null;
  if (row.channel === 'mail') {
    // The one door for a Gmail draft. It refuses a machine address itself, so
    // a noreply that reached this far is stopped there rather than here.
    const { draftReply } = await import('./integrations/mail-draft.mjs');
    // `who` is a name as often as an address; the door treats a name as absent
    // and replies to the thread, but sending it a name at all is misleading.
    wrote = await draftReply(vault, row.account, row.thread, row.text,
                             { to: /@/.test(String(row.who ?? '')) ? row.who : null });
    if (wrote?.rewrote) {
      await recordDraftChange(vault, { action: 'rewrote', kind: 'mail', id: wrote.draftId ?? null, account: row.account,
                                       to: row.who, text: row.text, why: 'the draft already on that thread now says this instead' });
    }
  } else {
    wrote = await putText(vault, {
      to: row.chat ? String(row.chat).split(';').pop() : row.who, chatId: row.chat ?? null, text: row.text, now,
      slug: `chase-${String(row.who ?? 'them').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`,
    });
    // Held behind his own edit: nothing new was put in front of him, so the
    // ledger must not say a chase was.
    if (wrote.held) return { ...wrote, to: row.who, channel: row.channel, text: row.text };
  }
  // Recorded whether or not he ever sends it: the question this answers is
  // "have we already put a chase in front of him", not "did he send one".
  const { updateState } = await import('./agent-service/obligation-state.mjs');
  await updateState(vault, (d) => { d.chased[row.id] = { at, who: row.who, channel: row.channel, text: row.text }; });
  return { ...wrote, to: row.who, channel: row.channel, text: row.text };
}

/** Write the outbox draft that answers offered times. Returns what it wrote. */
export async function draftFromOffer(vault, row, { now = Date.now() } = {}) {
  if (!row.offer?.windows?.length || !row.chatId) return null;
  const to = String(row.chatId).split(';').pop();
  const r = await suggest(vault, row.offer.windows, { len: row.offer.len ?? 30, who: (row.who ?? '').split(/[,(]/)[0].trim() || null, what: row.offer.for ?? 'the call' });
  if (!r.slot || r.slot.none) return { none: true, tried: r.slot?.tried ?? [] };
  const made = await putText(vault, {
    to, chatId: row.chatId, text: r.text, now,
    slug: String(row.who ?? 'reply').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24),
  });
  return { ...made, text: r.text, slot: r.slot };
}

/* ------------------------------------------------------------- tidying */

/**
 * Discard a draft once he has dealt with the matter, and keep one per person.
 *
 * Alex, 2026-09-15, three screenshots in one morning: two mail drafts to
 * Miles Hale on the same thread, each promising a different day; two texts
 * to Ari; and a text to Henry Pike promising "the new plan set … before we sit
 * down Tuesday" when he had emailed Henry the drawings the afternoon before and
 * Henry had answered "Looks good to me". Then: "if there is new information,
 * rewrite a pending unsent message rather than adding new ones" and "auto
 * discard drafts if I dealt with the issue."
 *
 * Dealt with means he has been in touch with that person since the draft was
 * written — a text, an email or a connected call, on ANY channel, joined on the
 * person through the address book (contact.mjs). The Henry draft was a text and
 * he dealt with it by email, which is exactly what a check on one thread misses.
 *
 * What may be removed, and how:
 *   - a TEXT draft is marked discarded — the file stays, so it is undone by
 *     editing one word of frontmatter;
 *   - a GMAIL draft is deleted only if the assistant wrote it and he has not edited
 *     it (isObligationsDraft). His own drafts, and ones he has changed, are reported
 *     and never touched;
 *   - an APPROVED text is never touched — approving it was his decision.
 * Every removal is a line in integrations/draft-changes.jsonl carrying the full
 * text, so nothing written is lost, and the next brief names each one.
 */
export const DRAFT_CHANGES = 'integrations/draft-changes.jsonl';

async function recordDraftChange(vault, row) {
  const { appendFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await appendFile(join(vault, DRAFT_CHANGES), JSON.stringify({ at: localStamp(), ...row }) + '\n');
}

export async function readDraftChanges(vault = OBLIGATIONS) {
  try {
    return (await readFile(join(vault, DRAFT_CHANGES), 'utf8')).split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Would this follow-up be written now? If not, say why.
 *
 * Alex, 2026-09-21, looking at the Outbox: "there are several drafts that
 * don't seem relevant." Seven of eight were chases this pass had written over
 * three nights, and five were to people it would now refuse to write to — the
 * person who handed a thread to a colleague, or a firm he owes an answer. A
 * rule that governs only NEW drafts leaves the old ones waiting for a tap, in
 * the one queue where not looking is the whole failure.
 *
 * Two fences, both the same as every other tidy rule: the assistant must have
 * written it, and it must still be on the thread the hold is about.
 */
export function noLongerWritten(draft, held = []) {
  if (!draft?.obligations || !draft.threadId) return null;
  const hit = held.find((h) => h?.thread && h.thread === draft.threadId && h.why);
  return hit ? hit.why : null;
}

export async function tidy(vault = OBLIGATIONS, { write = false, mail = true, held = [] } = {}) {
  const { contactSince, handlesFor, describeContact, loadContactFiles } = await import('./agent-service/contact.mjs');
  const { loadContacts } = await import('./agent-service/contacts.mjs');
  const { setStatus } = await import('./agent-service/outbox.mjs');
  const book = await loadContacts(vault);
  const files = await loadContactFiles(vault);
  const out = { removed: [], reported: [], blind: [] };
  const box = join(vault, 'outbox');

  const remove = async (row, act) => {
    if (write) { await act(); await recordDraftChange(vault, { action: 'discarded', ...row }); }
    out.removed.push(row);
  };

  // What "dealt with" is allowed to mean. Two things, both specific to THIS
  // draft rather than to the person:
  //   1. he sent something on the same thread after the draft was written, or
  //   2. the obligation the draft belongs to has closed since.
  // Contact with the person on some other thread or channel is NOT enough on
  // its own. The first version took it as enough, and on a dry run it would
  // have deleted the Hank draft about the Morgan evening because he had emailed
  // Hank about the Membership Board — for someone he writes to every day,
  // "in touch" says nothing about this particular reply. That kind of contact
  // is reported instead, as a question: still needed?
  //
  // The Henry text is caught by the second rule, which is the point of joining
  // across channels: he answered a text with an email, the obligation closed on
  // it, and the text draft promising the same thing is what is left over.
  const { listObligations } = await import('./agent-service/obligations.mjs');
  const all = await listObligations(vault).catch(() => []);
  const closedSince = (ref, stamp) => {
    const o = all.find((x) => !x.open && (x.id === ref || (x.evidence ?? []).some((e) => e.ref === ref || `${e.source}:${e.ref}` === ref)));
    // The close time is on the evidence, not the merged obligation — a merged
    // item has no single close of its own. The newest evidence close is when
    // it was done. (The first version read `o.closed_at`, which never exists,
    // so this rule could not fire and the Henry draft survived a dry run.)
    const at = o ? (o.evidence ?? []).map((e) => e.detail?.closed_at).filter(Boolean).sort().pop() ?? null : null;
    return o && at && String(at) >= String(stamp) ? { ...o, closed_at: at } : null;
  };
  const verdictFor = async (who, since, thread, ref) => {
    const rows = await contactSince(vault, who, since, { contacts: book, files }).catch(() => []);
    const same = rows.filter((r) => r.thread && r.thread === thread);
    if (same.length) return { remove: true, why: `you replied on the same thread since: ${describeContact(same)}` };
    const closed = ref ? closedSince(ref, since) : null;
    if (closed) {
      return { remove: true, why: `what it was about is done — "${closed.title}" closed ${String(closed.closed_at ?? closed.closedAt).slice(5, 16)}`
        + (rows.length ? `, after you were in touch: ${describeContact(rows)}` : '') };
    }
    if (rows.length) return { remove: false, why: `you have been in touch since, elsewhere: ${describeContact(rows)} — is this draft still needed?` };
    return null;
  };

  // Texts: dealt with first, then one per person among what is left.
  const texts = (await listOutbox(box)).filter((d) => d.status === 'draft' && d.kind === 'text');
  const live = [];
  for (const d of texts) {
    const v = await verdictFor(d.to || d.chatId, d.created, d.chatId, d.chatId ? `im:${d.chatId}` : null);
    if (v?.remove) {
      await remove({ kind: 'text', id: d.id, to: d.toName || d.to, text: d.text, why: v.why },
                   () => setStatus(box, d.id, 'discarded', 'agent:drafts'));
      continue;
    }
    if (v) out.reported.push({ kind: 'text', id: d.id, to: d.toName || d.to, why: v.why });
    live.push(d);
  }
  const byPerson = new Map();
  for (const d of live) {
    const k = [...handlesFor(book, d.to || d.chatId)].sort()[0] ?? String(d.to);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(d);
  }
  for (const group of byPerson.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    for (const old of group.slice(1)) {
      const why = `superseded by the newer draft to the same person (${group[0].id})`;
      // His edit makes it his sentence; two of them waiting is a question for him.
      if (old.editedAt && !/\bby agent:/.test(old.editedAt)) {
        out.reported.push({ kind: 'text', id: old.id, to: old.toName || old.to, why: `${why} — you edited this one, so it was left alone` });
        continue;
      }
      await remove({ kind: 'text', id: old.id, to: old.toName || old.to, text: old.text, why },
                   () => setStatus(box, old.id, 'discarded', 'agent:drafts'));
    }
  }

  // Gmail drafts, both accounts.
  if (mail) {
    try {
      const { accountsWith } = await import('./mcp/google-auth.mjs');
      const { listDrafts } = await import('./integrations/mail-drafts.mjs');
      const { deleteDraft } = await import('./integrations/mail-draft.mjs');
      for (const account of await accountsWith('mail', vault)) {
        // Per mailbox: one account refusing a read must not leave the other
        // untidied and reported as if nothing were there.
        let drafts;
        try { drafts = await listDrafts(vault, account, { fresh: true }); }
        catch (err) { out.blind.push(`${account} drafts: ${String(err?.message ?? err).split('\n')[0].slice(0, 100)}`); continue; }
        /* A CHASE THE PASS WOULD NO LONGER WRITE. Alex, 2026-09-21, looking
           at the Outbox: "there are several drafts that don't seem relevant."
           Seven of the eight were follow-ups this pass had written over the
           previous three nights — and five of them were to people it would now
           refuse to write to at all: someone who had handed the thread to a
           colleague, or a firm he owes an answer. A rule that only governs new
           drafts leaves the old ones sitting in his Outbox waiting for a tap,
           which is the one queue where not looking is the whole failure.

           Only a draft the assistant wrote and he has not touched — the same fence
           every other tidy rule has. */
        const survivors = [];
        for (const d of drafts) {
          const noLonger = noLongerWritten(d, held);
          if (noLonger) {
            await remove({ kind: 'mail', id: d.id, account, to: d.to, subject: d.subject, text: d.text,
                           why: `withdrawn — the follow-up would not be written now: ${noLonger}` },
                         () => deleteDraft(vault, account, d.id));
            continue;
          }
          const stamp = d.updatedMs ? localStamp(new Date(d.updatedMs)) : null;
          const v = stamp ? await verdictFor(d.to, stamp, d.threadId, d.threadId ? `mail:${account}:${d.threadId}` : null) : null;
          const row = { kind: 'mail', id: d.id, account, to: d.to, subject: d.subject, text: d.text, why: v?.why };
          if (!v?.remove) {
            if (v) out.reported.push(row);
            survivors.push(d);
            continue;
          }
          if (d.obligations) await remove(row, () => deleteDraft(vault, account, d.id));
          else out.reported.push({ ...row, why: `${row.why} — it is your own draft, so it was left alone` });
        }
        const byThread = new Map();
        for (const d of survivors) {
          if (!d.threadId) continue;
          if (!byThread.has(d.threadId)) byThread.set(d.threadId, []);
          byThread.get(d.threadId).push(d);
        }
        for (const group of byThread.values()) {
          if (group.length < 2) continue;
          group.sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0));
          for (const old of group.slice(1)) {
            const row = { kind: 'mail', id: old.id, account, to: old.to, subject: old.subject, text: old.text,
                          why: `superseded by the newer draft on the same thread (${group[0].id})` };
            if (old.obligations) await remove(row, () => deleteDraft(vault, account, old.id));
            else out.reported.push({ ...row, why: `${row.why} — it is your own draft, so it was left alone` });
          }
        }
      }
    } catch (err) {
      // Mail unreadable is said, never taken as "nothing to tidy".
      out.blind.push(`gmail drafts: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return out;
}

/**
 * The note that tells him what the pass put in front of him.
 *
 * One note for the whole pass, however many drafts. Alex, 2026-09-19: "why
 * did only that followup become a note? looks like there were two other outbox
 * created at the same time." The service wrote one file per draft, named by the
 * minute, with `wx` — so the first won and the rest hit EEXIST and were
 * swallowed. Two drafts reached his Outbox with nothing saying so.
 *
 * Pure, so the wording is testable without a service running.
 */
export function draftNote(wrote, closed = []) {
  const rows = (wrote ?? []).filter(Boolean);
  const done = (closed ?? []).filter(Boolean);
  if (!rows.length && !done.length) return null;
  /* A DEBT THAT VANISHED IS TOLD. The re-audit, 2026-09-20: the pass closed a
     kept promise and wrote it to draft-changes for the brief, but the note —
     the thing he sees at once — fired only when a draft was written, and had
     no line for a close. So the one act here that removes something from his
     list was the one he could not see until the next brief. */
  if (!rows.length) {
    return {
      title: done.length > 1 ? `Closed ${done.length} — the replies went out` : `Closed: ${done[0].title ?? 'a promise kept'}`,
      body: ['Kept promises, closed by the drafts pass because the reply he promised went out from the Outbox. Each is on [To Do](/todo) under closed, and named in the next brief.', '',
             ...done.map((c) => `- **${c.title ?? c.id}** — ${c.who ?? ''}, the ${c.kind === 'mail' ? 'email' : 'text'} went out ${c.sentAt}`)].join('\n'),
    };
  }
  /* WHAT IT IS ABOUT, NOT ONLY WHO. Alex, 2026-09-22, of a note reading
     "joelames@gmail.com had gone quiet (34 days quiet). > following up on
     this. Any update?": "that note is practically worthless as presented.
     following up on what? who is matt unger?" The chase text says "this" on
     purpose — it is a reply on a thread whose subject says what it is about —
     but the note is read by HIM, a month later, with no thread in front of
     him. So it leads with the task, linked to where it can be closed or sent,
     and says in a sentence what the thing was before quoting the draft. */
  const line = (w) => {
    const task = w.title ? `**[${w.title}](/todo#pane=${encodeURIComponent(w.id)})**` : null;
    const who = w.who ?? 'them';
    const lead = w.rewrote ? `${task ?? `**${who}**`} — rewrote the draft already waiting for ${who}`
      : w.kind === 'chase' ? `${task ?? `**${who}**`} — a follow-up to ${who}, who has not answered`
      : w.kind === 'invite' ? `${task ?? `**${who}**`} — an invite is ready for ${who}`
      : `${task ?? `**${who}**`} — he told ${who} he would get back to them`;
    const why = w.why ? ` (${w.why})` : '';
    const slot = w.slot ? ` The slot is ${w.slot.label ?? 'the one they offered'}, picked from the windows they offered minus what is already on his calendar.` : '';
    const about = headlineOf(w.what);
    return `${lead}${why}.${slot}${about ? `\n\n${about}` : ''}\n\nThe draft:\n\n> ${String(w.text ?? '').trim()}`;
  };
  const many = rows.length > 1;
  return {
    // The task, not the address: "Drafted a reply to joelames@gmail.com" named
    // the one thing he could not place.
    title: many ? `Drafted ${rows.length} replies`
      : rows[0].title ? `Drafted a follow-up: ${rows[0].title}` : `Drafted a reply to ${rows[0].who ?? 'a thread'}`,
    body: [many ? `${rows.length} drafts are waiting for his tap on [Outbox](/outbox). Nothing was sent.`
                : 'A draft is waiting for his tap on [Outbox](/outbox). Nothing was sent.',
           '', ...rows.map(line),
           ...(done.length ? ['', `Also closed ${done.length} kept promise${done.length === 1 ? '' : 's'}: ${done.map((c) => c.title ?? c.id).join('; ')}.`] : [])].join('\n'),
  };
}

/**
 * Both questions in one call, for the service to run at the moments the answer
 * can change. Alex, 2026-09-08: "it seems like it should be more proactive."
 * A nightly pass meant a promise concluded at 09:12 waited until 18:00 for a
 * draft, and a draft that went stale at midnight was not said to be stale
 * until the next evening — by which time the Mac had woken and sent it.
 *
 * `write` writes only the one draft kind the module is allowed to write on its
 * own: the reply to times somebody offered. Everything else is returned to be
 * reported, and nothing already waiting is touched.
 */
export async function pass(vault = OBLIGATIONS, { now = Date.now(), write = false } = {}) {
  const s = await stale(vault, { now });
  const o = await owed(vault, { now });
  const inv = await uninvited(vault, { now }).catch(() => []);
  const ch = await chases(vault, { now }).catch(() => ({ rows: [], held: 0, heldRows: [], considered: 0 }));
  const wrote = [];
  // Why a draft did not get written. Alex, 2026-09-17, asking what decides
  // the follow-ups: two were eligible all day and the pass reported writing
  // nothing, because every failure here was caught and thrown away. A chase
  // that cannot be written and a chase that was not due look identical in the
  // log, which is the one thing this repo's rules say must never be true.
  const failed = [];
  // Tidy BEFORE writing anything new, so a draft the pass is about to add is
  // judged against a queue that no longer holds the ones he has dealt with.
  // The holds computed above decide the tidy too: a follow-up already in his
  // Outbox that the pass would refuse to write now is withdrawn, not left.
  const tidied = await tidy(vault, { write, held: ch.heldRows ?? [] }).catch((e) => ({ removed: [], reported: [], blind: [String(e?.message ?? e)] }));
  /* A KEPT PROMISE CLOSES. Review item 2, 2026-09-20: `answered` had been
   * computed here since 09-08 — "a reply already SENT registers as the
   * promise being kept" — and nothing in the repo read it. So sending the
   * thing that discharged a debt discharged nothing: the Ari text went out
   * 09-15 with his approval, Ari replied thanking him, and the item sat open
   * eighteen days.
   *
   * Only a PROMISE, and only on its own thread. He said he would do it, the
   * draft was written for it, it went out on that conversation — that is the
   * one shape where a send is the discharge beyond doubt. A send on a thread
   * with some other open item (a mail on the Quikr thread while "decide on
   * Quikr's quote" is open) is NOT closed here; review.mjs puts it in front
   * of the triage as a question. Arithmetic where it is certain, judgement
   * where it is not.
   *
   * Before any new draft is written, so a kept promise is not re-drafted. */
  const closed = [];
  if (write) {
    const { closeObligation } = await import('./agent-service/obligations.mjs');
    for (const r of o) {
      if (!r.sentExact?.length) continue;
      const last = r.sentExact[r.sentExact.length - 1];
      const via = last.kind === 'mail' ? 'email' : 'text';
      try {
        await closeObligation(vault, r.id, 'agent:drafts',
          `the promised ${via} to ${last.to} went out from the Outbox on ${last.sentAt}: "${String(last.text).replace(/\s+/g, ' ').slice(0, 80)}"`);
        closed.push({ id: r.id, title: r.title, who: r.who, sentAt: last.sentAt, kind: last.kind });
        // Named in the next brief, like every other thing this pass does to
        // a draft: a debt that vanishes because a text went out is still a
        // debt that vanished, and he should read why.
        await recordDraftChange(vault, { action: 'closed', kind: last.kind, id: last.id, to: last.to, text: last.text,
          obligation: r.id, title: r.title,
          why: `it was the reply he promised on ${String(r.promised).slice(0, 10)}, and it went out ${last.sentAt}` });
      } catch (e) {
        failed.push({ kind: 'close', id: r.id, who: r.who, why: String(e?.message ?? e).split('\n')[0].slice(0, 160) });
      }
    }
  }
  if (write) {
    for (const r of ch.rows) {
      const made = await draftChase(vault, r, { now })
        .catch((e) => { failed.push({ kind: 'chase', id: r.id, who: r.who, why: String(e?.message ?? e).split('\n')[0].slice(0, 160) }); return null; });
      if (made && !made.held) wrote.push({ id: r.id, who: r.who, kind: 'chase', why: r.why ?? null, title: r.title ?? null, what: r.what ?? null, ...made });
    }
    for (const r of inv) {
      const made = await draftInvite(vault, r, { now })
        .catch((e) => { failed.push({ kind: 'invite', id: r.id, who: r.who, why: String(e?.message ?? e).split('\n')[0].slice(0, 160) }); return null; });
      if (made?.file) wrote.push({ id: r.id, who: r.who, kind: 'invite', title: r.title ?? null, what: r.what ?? null, ...made,
                                   text: `${r.summary} — inviting ${r.to}` });
    }
  }
  if (write) {
    for (const r of o) {
      if (r.hasDraft || !r.offer) continue;
      // A draft written twice for one thread is worse than none: he would
      // approve one and the other would sit looking unanswered. `wx` on the
      // write is the backstop; hasDraft is the check.
      const made = await draftFromOffer(vault, r, { now })
        .catch((e) => { failed.push({ kind: 'offer', id: r.id, who: r.who, why: String(e?.message ?? e).split('\n')[0].slice(0, 160) }); return null; });
      if (made?.file && !made.held) { wrote.push({ id: r.id, who: r.who, title: r.title ?? null, what: r.what ?? null, ...made }); r.hasDraft = true; }
    }
  }
  return { stale: s, owed: o, uninvited: inv, chases: ch, wrote, failed, tidied, closed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  // The door for a job writing a text: one waiting draft per person, rewritten
  // when there is one. `node deploy/drafts.mjs --text <handle> [--chat <chat_id>] "words"`
  if (argv[0] === '--text') {
    const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
    const to = argv[1];
    const chat = flag('--chat');
    const words = argv.slice(2).filter((a, i, xs) => a !== '--chat' && xs[i - 1] !== '--chat').join(' ').trim();
    if (!to || to.startsWith('--') || !words) {
      console.error('usage: drafts.mjs --text <handle> [--chat <chat_id>] "the words"');
      process.exit(1);
    }
    const r = await putText(OBLIGATIONS, { to, chatId: chat, text: words,
      slug: String(to).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'reply' });
    console.log(r.held ? `held: ${r.why}` : r.rewrote ? `rewrote outbox/${r.file} — it said: ${r.was}` : `wrote outbox/${r.file}`);
    process.exit(0);
  }
  const write = argv.includes('--write');
  const s = await stale(OBLIGATIONS);
  const o = await owed(OBLIGATIONS);
  const u = await uninvited(OBLIGATIONS);
  const c = await chases(OBLIGATIONS);
  if (argv.includes('--json')) { console.log(JSON.stringify({ stale: s, owed: o, uninvited: u, chases: c }, null, 1)); process.exit(0); }
  console.log(`${c.rows.length} follow-up(s) to draft — ${c.considered} quiet, ${c.held} held for another day:`);
  for (const r of c.rows) {
    console.log(`  ${String(r.days).padStart(3)}d  ${r.who}  [${r.channel}]  ${r.why ?? ''}\n       ${r.text}`);
    if (write) {
      const made = await draftChase(OBLIGATIONS, r).catch((e) => ({ err: e.message }));
      console.log(made?.err ? `       could not draft: ${made.err}` : `       drafted${made.file ? ' outbox/' + made.file : ' in Gmail'}`);
    }
  }
  console.log();
  console.log(`${u.length} meeting(s) he agreed to with nobody invited:`);
  for (const r of u) {
    console.log(`  ${r.when}  ${r.summary} — invite ${r.to}${r.conference ? ' (+ Meet link)' : ''}`);
    if (write) {
      const made = await draftInvite(OBLIGATIONS, r).catch((e) => ({ err: e.message }));
      console.log(made?.file ? `      wrote outbox/${made.file} — waiting for his tap` : `      ${made?.err ?? 'could not write'}`);
    }
  }
  console.log();
  console.log(`${s.length} draft(s) whose words may have moved on:`);
  for (const d of s) { console.log(`  ${d.id}  → ${d.to}  [${d.status}]`); for (const w of d.why) console.log(`      ${w}`); }
  console.log(`\n${o.length} promise(s) he made:`);
  for (const r of o) {
    const mark = r.hasDraft ? 'drafted' : r.offer ? 'can be drafted now' : 'needs a reply';
    console.log(`  ${r.days}d  ${r.who ?? '?'} — ${r.title}  [${mark}]`);
    if (write && !r.hasDraft && r.offer) {
      const made = await draftFromOffer(OBLIGATIONS, r);
      if (made?.file) console.log(`      wrote outbox/${made.file}: ${made.text}`);
      else if (made?.none) console.log(`      nothing free in the windows they offered`);
    }
  }
}
