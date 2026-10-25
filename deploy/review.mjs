#!/usr/bin/env node
/**
 * `node deploy/review.mjs` — is what the assistant believes still true?
 *
 * ## Why this exists
 *
 * Alex, 2026-09-20, after the Pinecrest lodging task spent six days insisting he
 * had no room while `reference/bookings.md` held the Summit Lodge confirmation:
 * "some layer needs to take a wholistic view on all the todos. Maybe we need a
 * cleaner model since we keep running into these basic issues."
 *
 * The basic issue, stated once: **an obligation is created by one evidence
 * stream, and forever after only that stream can change it.** The triage
 * re-reads the thread; if the thread has not moved, the conclusion is
 * re-confirmed exactly as written. Nothing ever asks whether the rest of the
 * repo now contradicts it. So these two sat side by side for six days:
 *
 *   "nothing in reference/bookings.md records lodging for him"   imessage-state
 *   "Summit Lodge Pinecrest, 09-24 → 09-29, conf CX7QZRTA"             bookings.md
 *
 * The answer to each such failure had been a bridge between two named sources —
 * `open_elsewhere`, `contact.mjs` twice, `similar.mjs`, the drafts dealt-with
 * check, `lint.mjs`. Six in ten days. There are about eight sources, so
 * twenty-eight possible pairs, and every new failure bought one more bridge.
 *
 * This is the other shape: one pass that reads the derived layer **as a whole**
 * and asks one question of every open obligation. It is bounded by what he owes
 * (~233), not by what arrives, so it costs the same on a loud day as a quiet
 * one.
 *
 * ## What it is not
 *
 * It does not replace the bridges that **gate an outward action**. `contact.mjs`
 * in the chase path stops an email leaving; a nightly review would find a chase
 * already sent. Prevention at the point of action and reconciliation over the
 * whole state are different jobs and both are needed. What this replaces is the
 * habit of adding a seventh bridge — and it **consumes** the existing readers
 * (`trips`, `parseBookings`, `listOpen`) rather than reimplementing them, so
 * there is still one parser per fact.
 *
 * ## Arithmetic here, judgement in the job
 *
 * Every check below is a date against a date or a string against a file. None
 * of them decides what the corrected sentence should say — that is judgement,
 * and it belongs to a model reading the evidence. So this finds and reports;
 * `--correct` is the door the job writes through, and it records every change
 * in `integrations/obligation-changes.jsonl` so the next brief can say what
 * moved. An obligation whose facts change without a word is the assistant deciding
 * behind his back, the same objection as a draft that vanishes.
 *
 * ## False positives are the failure mode
 *
 * `lint.mjs` learned this the hard way — it called his own home four rare
 * places and declared three live vendors dead. A finding here causes a model
 * to rewrite something he relies on, so each check is deliberately narrow and
 * would rather miss than guess. The tests are mostly about what it refuses.
 */
import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOpen } from './agent-service/obligations.mjs';
import { entries as whatEntries } from './agent-service/web/what.mjs';
import { whenMet } from './closes.mjs';
import { loadContext, distinctive, mentions } from './context.mjs';
import { localStamp } from './agent-service/time.mjs';
import { readAutopay, autopayFor, paymentFailed } from './agent-service/autopay.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGES = ['integrations', 'obligation-changes.jsonl'];

/* ------------------------------------------------------------ matching */

/* The tokeniser and the trip match live in context.mjs, which is the one place
   that knows how an obligation joins to anything else. Re-exported because the
   tests address them here and because a caller reaching for them from the pass
   that uses them is the readable direction. */
export { distinctive, mentions };

/* -------------------------------------------------------------- claims */

/** `09-22 to 09-27`, `2026-09-22 → 2026-09-27`, `09-22 – 09-27`. */
const RANGE = /(\d{4}-)?(\d{2})-(\d{2})\s*(?:to|through|→|->|—|–)\s*(\d{4}-)?(\d{2})-(\d{2})/g;

/** Date ranges the text asserts, as `MM-DD` pairs. */
export function ranges(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(RANGE)) {
    out.push({ from: `${m[2]}-${m[3]}`, to: `${m[5]}-${m[6]}`, said: m[0] });
  }
  return out;
}

/**
 * A claim that nothing is on file.
 *
 * Narrow on purpose. The first pattern names the file, which is as explicit as
 * a claim gets; the others are the ways the triage says "he has nowhere to
 * stay", which is the claim the bookings file can actually answer.
 */
const ABSENT = [
  /nothing in reference\/bookings\.md/i,
  /no(?:thing)? (?:lodging|room|hotel|accommodation)[^.]{0,40}(?:record|book|on file|for him)/i,
  /(?:lodging|room|hotel) (?:is )?(?:still )?(?:not |un)(?:booked|recorded|sorted)/i,
];
export const claimsAbsent = (text) => ABSENT.some((re) => re.test(String(text ?? '')));

/**
 * A bullet that is somewhere to sleep, rather than a car or a shuttle.
 *
 * Every alternative is word-bounded, including the ones that look safe. The
 * first cut had a bare `check-?in`, which matched "checkin" inside a URL in a
 * shuttle booking and reported a bus as lodging — a false positive in the one
 * check that tells a model an obligation is discharged.
 */
const LODGING = /\bcheck-?in\b|\bnightly\b|\bresort fee\b|\bhotel\b|\bresort\b|\binn\b|\blodge\b|\bviceroy\b|\bmarriott\b|\bhyatt\b|\britz\b|\bsuite\b/i;

/* ------------------------------------------------------------- spinning */

/**
 * An entry that reports nothing happened — judged on its OPENING CLAUSE.
 *
 * The first cut tested the whole body, and over-counted badly: a run that found
 * a genuinely new call still ends its paragraph with "still unanswered", so
 * every real update was scored as a no-op and NC2F read as 38 dead runs when
 * two of them were real. These entries all lead with what the run found, so the
 * opening clause is the honest place to look.
 */
const NO_CHANGE = /^(?:re-?checked|re-?confirmed|re-?flagged|re-?offered|unchanged|no new\b|nothing (?:new|has changed))/i;

/** Strip `UPDATE 2026-09-16 (15:47 run):` and take what the run says it found. */
const opening = (body) => String(body ?? '')
  .replace(/^UPDATE\s+\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?(?:\s*\([^)\n]{0,60}\))?\s*:\s*/i, '')
  .split(/[.;—]/)[0].trim();

/** How recent an entry is, in days. */
const daysBetween = (a, b) => Math.round((b - Date.parse(`${a}T12:00:00`)) / 86400000);

/**
 * A loop that is still going round.
 *
 * Alex, 2026-09-20, of NC2F carrying forty entries: "Why does it keep running
 * if there is no new info? Maybe it should have some follow up but not that
 * frequently."
 *
 * The honest answer for that one is that it STOPPED. `spoke_since` in
 * imessage-diff.py compared a connected call against the obligation's own start
 * rather than against the last time the triage looked, so once he had rung
 * someone the thread was re-flagged on every run until it closed — 18 entries
 * on 09-15 and 15 on 09-16. That was fixed on 2026-09-16 and the cadence since
 * is one entry on 09-17 (a real call) and one on 09-18 (a real text).
 *
 * So the run has to be CURRENT to be a finding. A pile that stopped four days
 * ago is a dirty record, not a machine going round, and nothing in the machine
 * needs changing — the fold already keeps it off his screen. Flagging it would
 * send a model to fix something that is not broken, which is the failure mode
 * this whole file is careful about.
 */
export function spinning(what, { now = new Date(), staleAfter = 2 } = {}) {
  const all = whatEntries(what).filter((e) => e.date);
  let n = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const head = opening(all[i].body);
    // "No new messages, but he paid the invoice" opens like a no-op and is
    // not one; the clause that turns is the one that mattered.
    if (!NO_CHANGE.test(head) || /\b(?:but|however|except|although)\b/i.test(head)) break;
    n += 1;
  }
  const last = all[all.length - 1]?.date ?? null;
  const age = last ? daysBetween(last, now.getTime()) : null;
  return { runs: n, total: all.length, last, age, live: n > 0 && age != null && age <= staleAfter };
}

/**
 * A relative date in a headline is wrong by tomorrow.
 *
 * Caught on the very first live correction, 2026-09-20. The model fixed the
 * Pinecrest window from 09-22 to 09-24 and carried the next clause through
 * untouched: "and the trip begins in two days." True when it was written
 * against the old date, wrong the moment it was written against the new one —
 * the trip was four days out.
 *
 * The headline is written once and read for weeks, so ANY relative expression
 * in it is a fact with a shelf life of a day. This is not a contradiction with
 * another source; it is a claim that cannot stay true, which makes it the
 * cheapest thing here to check and the easiest to get right: say the date.
 *
 * **The headline only.** Inside the `UPDATE` log "today" is unambiguous — the
 * entry carries its own date — and flagging those would be flagging the audit
 * trail for being an audit trail.
 */
const RELATIVE = /\b(?:in|within)\s+(?:a|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:more\s+)?(?:days?|weeks?|months?)\b|\b(?:a|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:more\s+)?(?:days?|weeks?)\s+(?:out|away|from now)\b|\b(?:today|tomorrow|yesterday|this (?:morning|afternoon|evening)|next week)\b/i;

/** The current statement — everything before the first dated entry. */
export const headline = (what) => (whatEntries(what)[0]?.body ?? '');

export function relativeDate(what) {
  const head = headline(what);
  const m = RELATIVE.exec(head);
  if (!m) return null;
  /* NOT WHEN THE REAL DATE IS RIGHT THERE. "Mia's birthday is 2027-09-04 (two
     weeks out)" goes stale in the parenthesis and nowhere else — he can still
     read the date. Redundant is a style note; misleading is a finding, and only
     the second is worth sending a model to fix. */
  const near = head.slice(Math.max(0, m.index - 45), m.index + m[0].length + 45);
  if (/\d{4}-\d{2}-\d{2}|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(near)) return null;
  return m[0];
}

/** The checks worth a model's attention in a triage prompt. The rest —
 *  `relative-date`, `spinning`, `duplicate` — reach him on /todo and in the
 *  brief and are not a triage's to act on; `auto` findings are closed by
 *  `apply()` before the prompt is built. */
// `closes-met` is here for the bare-reply-from case above, which is a question
// rather than a close; the ones that close themselves never reach a prompt.
export const PROMPT_CHECKS = new Set(['closes-met', 'closes-met-stale', 'closed-in-logbook', 'already-filed', 'paid-on-file', 'they-replied', 'dead-window', 'sent-from-outbox', 'on-the-calendar']);

/** Findings for a prompt: the checks above, not auto, and — given the keys of
 *  the threads this run is judging — only those about one of them. */
export function forPrompt(findings, keys = null) {
  return findings.filter((f) => PROMPT_CHECKS.has(f.check) && !f.auto && (!keys || (f.threads ?? []).some((k) => keys.has(k))));
}

/* -------------------------------------------------------------- the pass */

const SPIN_AT = 5;
/** A low-confidence obligation nothing has confirmed for this long is closed
 *  as never confirmed. Review item 3, 2026-09-20: doubt should not accrue. */
export const DOUBT_DAYS = 14;
const dayDiff = (a, b) => Math.floor((b - a) / 86400000);

/**
 * When each obligation was last reopened, from the change log — every door
 * writes one there (the page, close.mjs --reopen, a job, newer evidence).
 * `at` is a local "YYYY-MM-DD HH:MM" stamp written on this machine, as is
 * every evidence stamp it is compared with; the comparison is of strings in
 * one format from one clock, and nothing here parses either.
 */
async function lastReopens(vault) {
  const out = new Map();
  let text = '';
  try { text = await readFile(join(vault, ...CHANGES), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('"reopened"')) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row?.action !== 'reopened' || !row.id || !row.at) continue;
    const prev = out.get(row.id);
    if (!prev || String(row.at) > String(prev.at)) out.set(row.id, { at: String(row.at), by: row.by ?? null });
  }
  return out;
}

/** "2026-09-26 18:34", "2026-09-26T18:34:00", "2026-09-26" → one sortable form. */
const sortableStamp = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(String(v ?? ''));
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : '';
};

export async function review(vault = OBLIGATIONS, { now = new Date(), open = null } = {}) {
  /* ONE LOADER. This pass used to read obligations, trips and bookings itself,
     and the drafts pass read contacts itself, and neither could see the other's
     half — which is the shape Alex asked to be rid of. context.mjs loads all
     of it once; what is left here is only the judging. */
  const ctx = await loadContext(vault, { now: now.getTime(), open });
  const { blind, obligations } = ctx;

  const findings = [];
  const autopay = await readAutopay(vault);
  const reopens = await lastReopens(vault);

  for (const o of obligations) {
    const text = `${o.title ?? ''} ${o.what ?? ''}`;
    const known = await ctx.about(o);

    /* WHAT THE TRIAGE SAID WOULD CLOSE IT HAS HAPPENED. Review item 1,
       2026-09-20. `closes_when` on the conclusion is the triage's own test,
       as data; when the record passes it, `apply()` below closes with the
       evidence as the outcome. */
    const met = await whenMet(o, known, { now }).catch(() => null);
    /* EVIDENCE OLDER THAN THE REOPEN CANNOT CLOSE IT AGAIN. Alex,
       2026-10-02, of "Review Nate's 15yr inspection quote": "why does that
       keep closing?" Fifteen closes and twelve reopens in five days, every
       close on the same email of 2026-09-26 — two days older than the
       $89,911.77 work order the task had become about. Its closes_when,
       "sent-by-me on this thread", was right when the task was "ask Grant who
       to talk to", and stayed after the task changed under it; each brief
       reopened it with the right reason, and the next pass closed it again,
       once within the minute.

       The other direction was already a rule: only evidence newer than a
       close reopens it. This is the mirror. A reopen is a judgement that the
       record so far does not settle it — so the record so far cannot be what
       closes it next. The finding still goes to the triage, as a question:
       the closes_when itself is stale and has to be rewritten to what would
       settle it now, or the same evidence will keep matching. Undated
       evidence is treated as old: it cannot be shown to be newer. */
    const reopened = met ? reopens.get(o.id) : null;
    if (met && reopened && !(sortableStamp(met.at) > reopened.at)) {
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'closes-met-stale', auto: false,
        claim: `closes_when ("${met.spec.kind}${met.spec.words ? ` (${met.spec.words.join(', ')})` : ''}") is met only by evidence from before it was reopened on ${reopened.at}${reopened.by ? ` by ${reopened.by}` : ''} — ${met.evidence}`,
        evidence: [`closes_when: ${JSON.stringify(o.closes_when)}`, `reopened ${reopened.at}`],
        why: 'It was reopened after that evidence, so that evidence is not what settles it now — and while closes_when still matches it, the review pass would close it again on every run. Read the thread: rewrite closes_when to what would settle it NOW (words, a reply from whoever owes the next move, or a different kind), and say in an UPDATE what still stands.',
      });
    } else if (met) {
      /* A BARE reply-from IS A QUESTION, NOT A CLOSE. Alex, 2026-09-22:
         "Why did KWW6 close. That was a task unrelated to Brokerly." It closed
         on Lena Ortiz writing to him — about a delivery robot, on another
         thread entirely — because its closes_when was `reply-from` with no
         words, and reply-from is by definition about a conversation that is
         NOT this one. So a bare one closes on evidence tied to the person and
         to nothing else. CLAUDE.md already says to write it only when any
         reply would settle it; this stops a triage that gets that wrong from
         making the debt disappear. With `words` it still closes itself: then
         the evidence is about this debt. */
      const bare = met.spec.kind === 'reply-from' && !(met.spec.words ?? []).length;
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'closes-met', auto: !bare,
        claim: `closes_when says "${met.spec.kind}${met.spec.who ? ` ${met.spec.who}` : ''}${met.spec.words ? ` (${met.spec.words.join(', ')})` : ''}" — and ${met.evidence}`,
        evidence: [`closes_when: ${JSON.stringify(o.closes_when)}`],
        outcome: `closes_when met: ${met.evidence}`,
        why: bare
          ? 'Its closes_when is a bare reply-from, which is satisfied by them writing to him about ANYTHING, on any thread. Read what they actually said: if it settles this, close it with that as the outcome; if it does not, rewrite closes_when to name what would (words, or a different kind) and say in an UPDATE why this still stands.'
          : 'The obligation carries its own test and the record passes it. The review pass closes this itself (agent:review, the evidence as the outcome); if you are re-reading the thread and it is NOT settled, say what still stands in an UPDATE and rewrite closes_when to what would.',
      });
    }

    /* IT PAYS ITSELF. Alex, 2026-09-30, of a Power Co bill: "is on
       autopay. I only want to be a task if autopay fails." A bill he owes
       from a vendor on his autopay list (integrations/autopay.json) closes
       here on every pass — the net under the triage, which is told the same
       thing through the differ's signal. Not when the mail says the payment
       failed: that is the one case that is his. */
    const ap = (o.owed_by ?? 'me') !== 'them' ? autopayFor(o, autopay) : null;
    if (ap && !paymentFailed(o)) {
      const which = `${ap.name ?? ap.key}${ap.account ? ` (account ending ${ap.account})` : ''}`;
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'autopay', auto: true,
        claim: `${which} is on his autopay list, and nothing here says the payment failed`,
        evidence: [`integrations/autopay.json: ${ap.key}${ap.accounts ? ` accounts ${ap.accounts.join(', ')}` : ' (every account)'}, since ${ap.since ?? '?'}`],
        outcome: `on autopay — ${which} pays itself; only a failed payment is a task`,
        why: 'The review pass closes this itself. If the mail does say the payment failed or was declined, it should not have matched — say so in an UPDATE and keep it open.',
      });
    }

    /* OPENED ON DOUBT, AND NOTHING CAME. The triage may open an item it is
       not sure of — the skills tell it to keep the fact when two tiers are
       close — and mark it `confidence: low`. Doubt is allowed; doubt that
       accrues is not: fourteen quiet days (no new mail on the thread, no word
       from them anywhere, no update to the conclusion) and it closes as
       never confirmed, named in the evening brief like any agent close. */
    if (o.confidence === 'low' && o.since) {
      const stamps = [o.since, ...(o.evidence ?? []).map((e) => e.at), ...whatEntries(o.what).map((e) => e.date)]
        .filter(Boolean).map(String);
      const theirs = (known.inTouch?.all ?? []).filter((x) => x.from !== 'you').map((x) => String(x.at));
      const last = [...stamps, ...theirs].sort().pop();
      const lastMs = Date.parse(String(last).replace(' ', 'T'));
      const quiet = Number.isNaN(lastMs) ? 0 : dayDiff(lastMs, now.getTime());
      if (quiet >= DOUBT_DAYS) {
        findings.push({
          id: o.id, code: o.code, title: o.title, check: 'doubt-expired', auto: true,
          claim: `opened on doubt (confidence: low) and nothing has confirmed it in ${quiet} days — no new mail, no word from ${o.who ?? 'them'}, no update since ${String(last).slice(0, 10)}`,
          evidence: [`since ${o.since}`, known.inTouch?.seen ? 'nothing from them on any channel' : 'contact could not be checked (no address book)'],
          outcome: `opened on doubt on ${String(o.since).slice(0, 10)}; nothing confirmed it in ${quiet} quiet days`,
          why: 'The review pass closes this itself as never confirmed. If you are re-reading the thread and it IS real, raise the confidence in the conclusion and say what confirmed it.',
        });
      }
    }

    /* TWO ROWS FOR ONE THING, and now where the triage can see it. similar.mjs
       has proposed these since 2026-09-18 on /todo and nowhere else, so the
       only surface that could act on a duplicate was the one he had to open —
       while the triage, already re-reading one of the two threads, never heard.
       It PROPOSES: a duplicate in the list is visible and annoying, a wrong
       merge hides one of two real debts for ever. */
    if (known.twin) {
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'duplicate',
        claim: `looks like the same thing as "${known.twin.title}"`,
        evidence: [`the other is \`${known.twin.id}\``, known.twin.why].filter(Boolean),
        why: 'PROPOSE, never merge — a duplicate in the list is visible and annoying, a wrong merge hides one of two real debts for ever. If this run makes it certain, link them; otherwise leave it for him on /todo, where it is already offered.',
      });
    }

    /* A LOOP THAT IS NOT GOING ANYWHERE. Checked first because it needs no
       other source, and because it is the finding that explains the others:
       a conclusion re-confirmed twenty times is one nobody has re-read. */
    const spin = spinning(o.what, { now });
    if (spin.runs >= SPIN_AT && spin.live) {
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'spinning',
        claim: `${spin.runs} updates in a row report nothing changed, the last ${spin.age === 0 ? 'today' : `${spin.age}d ago`}`,
        evidence: [`${spin.total} dated entries on this conclusion, newest ${spin.last}`],
        why: 'Each run appended a no-op instead of leaving it alone. The conclusion is as true as it was; the record around it is noise, and the headline nobody has revisited may no longer be.',
      });
    }

    /* A claim with a shelf life of a day, in the sentence he reads first. */
    /* Only where --correct can act. It rewrites a mail or message conclusion
       and throws for a todo, a reminder, an Apple item — so a finding there
       was an instruction that could not execute, and a todo line he typed
       himself is not the assistant's claim to correct anyway. */
    const correctable = (o.evidence ?? []).some((e) => e.source === 'imessage' || e.source === 'email');
    const rel = correctable ? relativeDate(o.what) : null;
    if (rel) {
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'relative-date',
        claim: `the headline says "${rel}"`,
        evidence: ['a headline is written once and read for weeks'],
        why: 'Replace it with the date it means. This one was true when it was written and cannot stay true — the first live correction of an obligation fixed a trip window and carried "the trip begins in two days" through, four days out.',
      });
    }

    /* HE SENT SOMETHING ON THIS, FROM THE OUTBOX. A kept PROMISE closes on
       its own in the drafts pass; this is the other case — no promised date,
       a send on the obligation's own thread after it began — where whether
       the send WAS the discharge is judgement. The Ari text was; a mail on
       the Quikr thread was not the decision about Quikr's quote. So it is put
       in front of the triage as a question with the words he sent. */
    const promised = (o.evidence ?? []).some((e) => e.detail?.promised);
    if ((o.owed_by ?? 'me') === 'me' && !promised && known.sent.length) {
      const last = known.sent[known.sent.length - 1];
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'sent-from-outbox',
        claim: `you sent a ${last.kind === 'mail' ? 'email' : 'text'} to ${last.to} on this thread from the Outbox on ${last.sentAt}: "${String(last.text).replace(/\s+/g, ' ').slice(0, 90)}"`,
        evidence: [`outbox/${last.id}`],
        why: 'If that was the reply this obligation was waiting for, close it with close.mjs — the send is the outcome. If it was about something else on the same conversation, leave it open and say so in an UPDATE, so this is not asked again.',
      });
    }

    /* Review item 3, 2026-09-20 — the three sources the close-path audit
       named that this pass did not read. All three are questions for the
       triage: the evidence is certain, whether it discharges THIS debt is not. */
    if (known.logged) {
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'closed-in-logbook',
        claim: known.logged.invoice
          ? `the logbook says invoice ${known.logged.invoice} closed on ${known.logged.at} by ${known.logged.who} as another item${known.logged.outcome ? `: "${known.logged.outcome.slice(0, 100)}"` : ''} — and this one about it is open`
          : `the logbook says this closed on ${known.logged.at} by ${known.logged.who}${known.logged.outcome ? `: "${known.logged.outcome.slice(0, 100)}"` : ''} — and it is open`,
        evidence: [`logbook.md · ${known.logged.id}`],
        why: known.logged.invoice
          ? 'A vendor reminder or a second copy of an invoice already settled. If that close paid this invoice, close this one with the same outcome; if it is a separate charge, say what it is in an UPDATE.'
          : 'A source is re-reporting it open after a close — a reminder un-ticked, a todo line reworded, an Apple item the Mac never completed. If the logbook is right, close it again with the same outcome; if it genuinely reopened, say what reopened it in an UPDATE.',
      });
    }
    if (known.onCalendar.length && /^(schedule|book|set up|arrange|confirm|reserve|plan)\b/i.test(o.title ?? '')) {
      const ev = known.onCalendar[0];
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'on-the-calendar',
        claim: `an event matching this is on his calendar: "${ev.summary}" on ${ev.startsOn}${ev.startsAt ? ' ' + ev.startsAt : ''}`,
        evidence: known.onCalendar.slice(0, 3).map((e) => `calendar · ${e.startsOn} · ${e.summary}`),
        why: 'If that event IS the thing this asked him to arrange, the arranging is done: close it, outcome the event. If the event is something else with the same words, leave it open.',
      });
    }
    if ((o.owed_by ?? 'me') === 'them' && known.elsewhere.length) {
      const last = known.elsewhere[known.elsewhere.length - 1];
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'they-replied',
        claim: `they wrote on another conversation since this began — ${last.channel} on ${last.at}${last.detail ? `: "${String(last.detail).slice(0, 90)}"` : ''}`,
        evidence: known.elsewhere.slice(-3).map((x) => `${x.channel} ${x.at}${x.thread ? ` · ${x.thread}` : ''}`),
        why: 'Something they owe, and they have written to him elsewhere. Read what they said: if it is the answer, close it on that evidence; if it is about something else, leave it open and note that you checked, so this is not asked again.',
      });
    }

    if (known.paidOnFile.length && /^(?:pay|settle|wire|send .{0,30}payment|put .{0,40}in for payment)\b/i.test(o.title ?? '')) {
      const st = known.paidOnFile[known.paidOnFile.length - 1];
      findings.push({
        id: o.id, code: o.code, title: o.title, check: 'paid-on-file',
        claim: `a receipt was filed on ${st.date}: "${st.title}" from ${st.sender}`,
        evidence: known.paidOnFile.slice(-3).map((x) => `reference/statements.md · ${x.date} · ${x.title}`),
        why: 'If that receipt is THIS invoice paid, close it — the receipt is the outcome. If it is a different charge from the same vendor, leave it open and say so in an UPDATE.',
      });
    }

    const t = known.trip;
    if (t) {
      const mine = known.bookings;

      /* A DATE THE FILE HAS MOVED ON FROM. Only a RANGE counts: a single date
         in a conclusion is usually a fact about the past ("he confirmed on
         2026-09-03"), and treating those as trip claims would flag almost
         everything. A range reads as "the trip is X to Y" and is checkable. */
      for (const r of ranges(text)) {
        const from = t.from?.slice(5), to = t.to?.slice(5);
        if (!from || !to) continue;
        if (r.from === from) continue;                       // agrees, or close enough
        findings.push({
          id: o.id, code: o.code, title: o.title, check: 'dead-window',
          claim: `says "${r.said}"`,
          evidence: [`reference/bookings.md: ## ${t.name} · ${t.from} → ${t.to}`],
          why: `The trip's own heading gives ${from} → ${to}. A conclusion that names the wrong window makes every "N days out" sentence under it wrong too.`,
        });
        break;                                               // one per obligation is enough
      }

      /* SAYS NOTHING IS BOOKED, WHILE SOMETHING IS. The claim has to be about
         lodging and the file has to hold lodging — a hire car on file does not
         contradict "no room". */
      if (claimsAbsent(text)) {
        const rooms = mine.filter((b) => LODGING.test(`${b.title} ${b.description ?? ''}`));
        if (rooms.length) {
          findings.push({
            id: o.id, code: o.code, title: o.title, check: 'already-filed',
            claim: 'says nothing is on file for this trip',
            evidence: rooms.slice(0, 3).map((b) => `reference/bookings.md · ${b.date} · ${b.title}`),
            why: `It is on file under "${t.name}", and has been since it was filed. The half of this obligation that was about finding somewhere to stay is discharged; whatever else it asks for may still be open.`,
          });
        }
      }
    }
  }

  /* WORST FIRST, because the list goes into a prompt and a prompt has a budget.
     A contradiction with the record is something he is being told wrongly; a
     relative date is something that will read oddly. Sorting here rather than
     at the caller keeps every reader in the same order. */
  /* WHICH THREADS EACH FINDING IS ABOUT, so a triage prompt can carry only
     the findings on the threads that run is judging. Twelve runs of the whole
     worst-first list produced no action at all: the model saw the same twelve
     findings about other people's threads and, as instructed, left them. */
  const keysOf = new Map(obligations.map((o) => [o.id, [o.chat_id, ...(o.evidence ?? []).flatMap((e) => [e.detail?.thread_id, e.detail?.chat_id])].filter(Boolean)]));
  for (const f of findings) f.threads = keysOf.get(f.id) ?? [];
  const RANK = { 'closes-met': -1, 'doubt-expired': -1, autopay: -1, 'closed-in-logbook': 0, 'already-filed': 1, 'paid-on-file': 2, 'they-replied': 3, 'dead-window': 4, 'sent-from-outbox': 5, 'on-the-calendar': 6, duplicate: 7, spinning: 8, 'relative-date': 9 };
  findings.sort((a, b) => (RANK[a.check] ?? 9) - (RANK[b.check] ?? 9));
  return { generated_at: localStamp(now), checked: obligations.length, trips: ctx.trips.length, findings, blind };
}

/* --------------------------------------------------------------- closing */

/** How many the pass may close in one run. A cap is a tripwire: five closes
 *  at once is a day's worth; fifty is a bug in a matcher. */
export const APPLY_CAP = 5;

/**
 * Close every open obligation the pass is CERTAIN about — a finding marked
 * `auto`: an explicit `closes_when` met, or doubt that has expired. The triage
 * wrote the test; the record passes it; the close is the arithmetic following
 * through, with `agent:review` on it — so it expires like any agent close,
 * shows under "closed today" that evening, and can be reopened. Parsed prose
 * never closes here; it is a finding for the triage.
 */
export async function apply(vault = OBLIGATIONS, { now = new Date(), open = null, write = true, cap = APPLY_CAP } = {}) {
  const r = await review(vault, { now, open });
  const due = r.findings.filter((f) => f.auto && f.outcome);
  const closed = [], failed = [];
  const { closeObligation } = await import('./agent-service/obligations.mjs');
  for (const f of due.slice(0, cap)) {
    const outcome = f.outcome;
    if (!write) { closed.push({ id: f.id, code: f.code, title: f.title, outcome, dry: true }); continue; }
    try {
      const c = await closeObligation(vault, f.id, 'agent:review', outcome.slice(0, 300));
      closed.push({ id: f.id, code: f.code, title: f.title, check: f.check, outcome, partial: c.partial, failed: c.failed });
    } catch (err) { failed.push({ id: f.id, error: String(err?.message ?? err) }); }
  }
  return { closed, failed, held: Math.max(0, due.length - cap), blind: r.blind };
}

/* ------------------------------------------------------------ correcting */

/** Where a conclusion lives, by the obligation's own evidence. */
const SOURCES = {
  imessage: { file: ['integrations', 'imessage-state.json'], key: 'chat_id' },
  email: { file: ['integrations', 'email-state.json'], key: 'thread_id' },
};

/**
 * Replace the headline of a conclusion — everything before its first `UPDATE` —
 * and record that it happened.
 *
 * **The headline is the only revisable part.** The `UPDATE` log below it stays
 * append-only, because it is the audit trail and CLAUDE.md's rule about the
 * journal applies in spirit: a correction is another line, never an erasure.
 * But the headline is a statement of what is true *now*, and leaving a false
 * one at the top for ever — which is what "append-only in practice" meant —
 * is how the Pinecrest task told him for six days that he had no room.
 */
export async function correct(vault, id, headline, why, { now = new Date(), open = null } = {}) {
  if (!headline || headline.trim().length < 20) throw new Error('a correction needs a headline sentence');
  if (!why) throw new Error('a correction needs its evidence (--why)');
  /* `open` is injectable so the file surgery can be tested without a whole
     repo behind it — `listOpen` is the real merge over five sources. Same seam
     the mail cache needed, and for the same reason: a test must not have to
     build the world to check one write. */
  const candidates = open ?? await listOpen(vault);
  const ob = candidates.find((o) => o.id === id || o.code === id);
  if (!ob) throw new Error(`no open obligation ${id}`);

  const ev = (ob.evidence ?? []).find((e) => SOURCES[e.source]);
  if (!ev) throw new Error(`${ob.id} has no conclusion this can rewrite (sources: ${(ob.evidence ?? []).map((e) => e.source).join(', ') || 'none'})`);
  const src = SOURCES[ev.source];
  const path = join(vault, ...src.file);
  const state = JSON.parse(await readFile(path, 'utf8'));
  const rec = (state.threads ?? []).find((t) => t[src.key] === ev.detail?.[src.key] || t[src.key] === ev.ref);
  if (!rec?.conclusion) throw new Error(`${ob.id}: no record in ${src.file.join('/')}`);

  const was = String(rec.conclusion.what ?? '');
  const all = whatEntries(was);
  const rest = all.slice(1).map((e) => e.body).join(' ');
  const stamp = localStamp(now).slice(0, 10);
  const note = `UPDATE ${stamp}: corrected against the record — ${why}`;
  rec.conclusion.what = [headline.trim(), rest, note].filter(Boolean).join(' ');

  await writeFile(path, JSON.stringify(state, null, 1) + '\n');
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await appendFile(join(vault, ...CHANGES), JSON.stringify({
    at: localStamp(now), id: ob.id, code: ob.code, title: ob.title,
    was: all[0]?.body ?? '', now: headline.trim(), why,
  }) + '\n');
  return { ok: true, id: ob.id, code: ob.code, kept: all.length - 1 };
}

/**
 * Record that the counterparty handed this thread to a colleague.
 *
 * Alex, 2026-09-21, on a chase that went to Amy at Quality Cabinets Co: "I don't
 * want Amy G chase to fire after I respond to nina. Amy handed me off to
 * nina at one point."
 *
 * A handoff is permanent and it is a fact about WHO, not about what is owed.
 * The debt stands — Quality Cabinets Co still owes a millwork number — but the
 * person who passed the thread along is not the person to ask, and no amount
 * of waiting changes that. `drafts.mjs` reads the field and never chases whoever
 * handed off; it reports the pair instead, because which thread the colleague
 * should be chased on is a judgement and a chase goes out over his name.
 *
 * `who` is deliberately NOT repointed. The thread is still the one Amy wrote
 * on, and a mail chase replies to the thread — addressing Nina on a
 * conversation she was never part of is a worse failure than not sending.
 */
export async function handoff(vault, id, to, why, { now = new Date(), open = null } = {}) {
  const person = String(to ?? '').trim();
  if (!person) throw new Error('a handoff needs the person it went to (--to)');
  if (!why?.trim()) throw new Error('a handoff needs its evidence (--why)');
  const candidates = open ?? await listOpen(vault);
  const ob = candidates.find((o) => o.id === id || o.code === id);
  if (!ob) throw new Error(`no open obligation ${id}`);
  const ev = (ob.evidence ?? []).find((e) => SOURCES[e.source]);
  if (!ev) throw new Error(`${ob.id} has no conclusion to mark (sources: ${(ob.evidence ?? []).map((e) => e.source).join(', ') || 'none'})`);
  const src = SOURCES[ev.source];
  const path = join(vault, ...src.file);
  const state = JSON.parse(await readFile(path, 'utf8'));
  const rec = (state.threads ?? []).find((t) => t[src.key] === ev.detail?.[src.key] || t[src.key] === ev.ref);
  if (!rec?.conclusion) throw new Error(`${ob.id}: no record in ${src.file.join('/')}`);

  const stamp = localStamp(now).slice(0, 10);
  rec.conclusion.handed_to = person;
  rec.conclusion.what = `${String(rec.conclusion.what ?? '').trim()} UPDATE ${stamp}: handed off to ${person} — ${why.trim()}`.trim();
  await writeFile(path, JSON.stringify(state, null, 1) + '\n');
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await appendFile(join(vault, ...CHANGES), JSON.stringify({
    at: localStamp(now), action: 'handed_off', id: ob.id, code: ob.code, title: ob.title,
    from: ob.who ?? null, to: person, why: why.trim(),
  }) + '\n');
  return { ok: true, id: ob.id, code: ob.code, from: ob.who ?? null, to: person };
}

/** Corrections since a stamp, for the brief to lead with. */
export async function changesSince(vault, since) {
  let raw = '';
  try { raw = await readFile(join(vault, ...CHANGES), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((c) => c && (!since || c.at > since));
}

/* ------------------------------------------------------------------ CLI */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1] ?? null; };

  if (argv.includes('--handoff')) {
    const r = await handoff(OBLIGATIONS, flag('handoff'), flag('to'), flag('why'));
    console.log(`${r.code ?? r.id}: ${r.from ?? 'they'} handed it to ${r.to} — it will not be chased again`);
    process.exit(0);
  }

  if (argv.includes('--correct')) {
    const r = await correct(OBLIGATIONS, flag('correct'), flag('headline'), flag('why'));
    console.log(`corrected ${r.code} (${r.id}); ${r.kept} update(s) kept`);
    process.exit(0);
  }

  if (argv.includes('--apply')) {
    const a = await apply(OBLIGATIONS, { write: !argv.includes('--dry') });
    for (const c of a.closed) console.log(`${c.dry ? 'would close' : 'closed'} ${c.code} ${c.title}\n    ${c.outcome}${c.partial ? `\n    did NOT reach: ${c.failed.join('; ')}` : ''}`);
    for (const f of a.failed) console.log(`could not close ${f.id}: ${f.error}`);
    console.log(`${a.closed.length} closed, ${a.held} held over the cap`);
    process.exit(0);
  }

  const r = await review(OBLIGATIONS);
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  console.log(`${r.findings.length} finding(s) over ${r.checked} open obligations and ${r.trips} trips — ${r.generated_at}`);
  for (const f of r.blind) console.log(`  blind: ${f}`);
  for (const f of r.findings) {
    console.log(`\n  ${f.code ?? f.id}  [${f.check}]  ${f.title}`);
    console.log(`    ${f.claim}`);
    for (const e of f.evidence) console.log(`    vs  ${e}`);
    console.log(`    ${f.why}`);
  }
}
