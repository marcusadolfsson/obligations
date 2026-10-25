#!/usr/bin/env node
/**
 * Follow-through: what has gone quiet, and who to nudge.
 *
 * Alex, 2026-09-05, from the chief-of-staff audit: "It never chases anyone on
 * your behalf — 'waiting on others' is a list, not an action, even though the
 * outbox and approval machinery now exist to propose a nudge you tap once."
 *
 * This finds the candidates. It does not write a draft — that is judgement
 * (what to say, in his voice, to this person) and belongs to the evening job,
 * which reads this and proposes. What IS arithmetic is who has been quiet for
 * how long and by which channel they are reachable, and that is all this does.
 *
 * Two lists:
 *
 *   THEM   waiting on someone else for QUIET_DAYS or more. A nudge from him.
 *   YOU    owed by him, with a counterparty, and due within SOON_DAYS or
 *          overdue. A holding reply ("comparing bids, back by Friday") costs
 *          nothing and stops their follow-ups — Crestline had chased twice.
 *
 * The channel comes from the evidence: a mail obligation is nudged by mail, an
 * iMessage one by text. A draft in the wrong channel is a draft he deletes.
 *
 *   node deploy/stale.mjs             # both lists
 *   node deploy/stale.mjs --json
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOpen } from './agent-service/obligations.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const QUIET_DAYS = 5;
export const SOON_DAYS = 2;

const channelOf = (o) => {
  const srcs = new Set((o.evidence ?? []).map((e) => e.source));
  if (srcs.has('imessage')) return 'imessage';
  if (srcs.has('email')) return 'mail';
  return null;                        // a todo or a reminder: nobody to nudge
};

/** The two lists. Pure, given the open obligations. Exported for tests. */
export function staleFrom(open, { quietDays = QUIET_DAYS, soonDays = SOON_DAYS } = {}) {
  const row = (o) => ({
    id: o.id, title: o.title, who: o.who ?? null, days: o.days ?? 0,
    due: o.due ?? null, overdue: !!o.overdue, channel: channelOf(o),
    // What it belongs to and how loud it is. Both ride along so the chase
    // ranking can put the project he is for before the thing that is merely
    // old — see rankChases in drafts.mjs.
    tags: o.tags ?? [], priority: o.priority ?? 'normal', lead_days: o.lead_days ?? null,
    // When the waiting started, so a chase can ask whether they have answered
    // since — on any channel, not only the one it was asked on.
    since: o.since ?? null,
    what: o.what ?? null,
    // Never chase the person who handed the thread on. See drafts.mjs.
    handed_to: o.handed_to ?? null,
    owed_by: o.owed_by ?? 'me',
    // The thread to reply on, so a mail nudge is a reply and not a new thread.
    thread: (o.evidence ?? []).find((e) => e.source === 'email')?.detail?.thread_id ?? null,
    // NOT the subject: a conclusion's `subject` is the triage's own label. The
    // real one, which a follow-up quotes, is looked up from the mail (drafts.mjs).
    // Which mailbox it arrived in. Without this a chase cannot be drafted at
    // all: mail-draft.mjs needs the account to pick the right credentials, and
    // he has two. Taken from the ref (`mail:<account>:<thread>`) when the
    // detail does not carry it.
    account: (() => {
      const e = (o.evidence ?? []).find((x) => x.source === 'email');
      return e?.detail?.account ?? (String(e?.ref ?? '').split(':')[1] || null);
    })(),
    chat: o.chat_id ?? null,
    // What context.about() joins on, and when the triage last looked — so a
    // chase can be held while a reply they sent elsewhere is still unjudged.
    chat_id: o.chat_id ?? null,
    evidence: o.evidence ?? [],
    reviewed: (o.evidence ?? []).map((e) => e.at).filter(Boolean).map(String).sort().pop() ?? null,
  });

  const them = open
    .filter((o) => o.owed_by === 'them' && (o.days ?? 0) >= quietDays && o.who && channelOf(o))
    .map(row)
    .sort((a, b) => b.days - a.days);

  const you = open
    .filter((o) => o.owed_by === 'me' && o.who && channelOf(o))
    .filter((o) => o.overdue || (o.lead_days !== null && o.lead_days !== undefined && o.lead_days <= soonDays))
    .map(row)
    .sort((a, b) => (a.overdue === b.overdue ? (a.due ?? '').localeCompare(b.due ?? '') : a.overdue ? -1 : 1));

  return { them, you };
}

export async function stale(vault = OBLIGATIONS, opts = {}) {
  let open;
  try { open = await listOpen(vault); }
  catch (err) { return { them: [], you: [], error: String(err?.message ?? err) }; }
  return { ...staleFrom(open, opts), error: null,
           counts: { open: open.length, quietDays: opts.quietDays ?? QUIET_DAYS } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await stale();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  if (out.error) { console.log(`could not read obligations: ${out.error}`); process.exit(0); }
  console.log(`WAITING ON THEM — quiet ${QUIET_DAYS}+ days (${out.them.length})`);
  for (const r of out.them) console.log(`  ${String(r.days).padStart(3)}d  ${r.who}  [${r.channel}]\n       ${r.title}`);
  console.log(`\nOWED BY YOU — due within ${SOON_DAYS} days or overdue, with someone to tell (${out.you.length})`);
  for (const r of out.you) console.log(`  ${r.overdue ? 'OVERDUE' : 'due ' + String(r.due).slice(0, 10)}  ${r.who}  [${r.channel}]\n       ${r.title}`);
}
