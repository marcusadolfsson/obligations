/**
 * The message triage cache as an obligation source.
 *
 * Unlike the other two, this store is not a file Alex edits — it is what the
 * agent concluded, keyed by thread. Closed entries are returned rather than
 * filtered out: the diff needs to keep seeing them, or it rediscovers the same
 * obligation on the next run and offers it back.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localStamp } from '../time.mjs';
import { resolveHandle, loadContacts } from '../contacts.mjs';

export const SOURCE = 'imessage';

/**
 * The conversation behind an obligation, with handles resolved to names.
 *
 * A summary that cannot be checked has to be taken on trust. Being able to read
 * what someone actually said is what makes "Clara is waiting" a fact rather
 * than a claim.
 */
export async function threadFor(vault, chatId) {
  const [extract, contacts] = await Promise.all([
    readFile(join(vault, 'integrations', 'imessage.json'), 'utf8')
      .then(JSON.parse).catch(() => null),
    loadContacts(vault),
  ]);
  if (!extract) throw new Error('no message extract on this box');

  const t = (extract.threads ?? []).find((x) => x.chat_id === chatId);
  if (!t) throw new Error('thread is not in the current extract');

  const name = (handle) => resolveHandle(contacts, handle) || handle;

  return {
    chat_id: t.chat_id,
    name: t.is_group ? (t.name || 'group') : name(t.participants?.[0] || t.name),
    is_group: !!t.is_group,
    // Only the recent tail: this is for checking a claim, not for re-reading a
    // relationship, and the whole thread would put far more on screen than the
    // question needs.
    messages: (t.messages ?? []).slice(-12).map((m) => ({
      at: m.at, from_me: m.from_me, who: m.from_me ? 'me' : name(m.who), text: m.text,
    })),
    // The handle a reply must go to. Groups have no single recipient, and
    // guessing one would send a private reply to a thread with an audience.
    reply_to: t.is_group ? null : (t.participants?.[0] || null),
  };
}

export async function read(vault) {
  let st;
  try {
    st = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8'));
  } catch {
    return [];
  }

  // Resolved here, at read time, rather than baked into the conclusion when it
  // was written. Contacts arrived after most of these were judged, and a name
  // is a lookup, not a judgement — resolving late means every conclusion ever
  // written gets a name the moment the address book lands, with no re-triage.
  const contacts = await loadContacts(vault);

  return (st.threads ?? [])
    .filter((t) => t.conclusion)
    .map((t) => ({
      ref: t.chat_id,
      who: resolveHandle(contacts, t.conclusion.who) || t.conclusion.who || null,
      title: t.conclusion.title || null,
      what: t.conclusion.what || '',
      since: t.conclusion.since || null,
      // The triage is told to put a deadline here (message-triage/SKILL.md:
      // "belongs in `what` and in `due`") and this threw it away — every
      // message obligation was dateless on /tasks, silently. Review 2026-09-20.
      due: t.conclusion.due ?? null,
      // Set by the triage. Older entries predate the field; treat them as
      // normal rather than dropping them out of a priority sort entirely.
      priority: t.conclusion.priority || 'normal',
      // Which direction the debt runs. Entries written before this field
      // existed are things he owes — that is all the list ever held.
      owed_by: t.conclusion.owed_by === 'them' ? 'them' : 'me',
      /* A message conclusion can carry a tier now, like mail (review item 6,
         2026-09-20). Only `action` — or no tier, which every conclusion written
         before this had — is a debt. An awareness or memory text is recorded so
         the brief can carry it, and must never become a task even if `open`
         slips: the whole point of the tier is that nothing is owed. */
      open: !!t.conclusion.open && (!t.conclusion.tier || t.conclusion.tier === 'action'),
      // When this evidence was last judged — see obligation-state.mjs.
      at: t.reviewed ?? t.watermark ?? null,
      // The newest message, not the newest reading of it — see sources/email.mjs.
      evidence_at: t.watermark ?? null,
      // What would discharge it, in the triage's words — displayed beside the
      // task, and now readable on a text as well as a mail.
      closes: t.conclusion.closes ?? null,
      closes_when: Array.isArray(t.conclusion.closes_when) && t.conclusion.closes_when.length ? t.conclusion.closes_when : null,
      confidence: t.conclusion.confidence === 'low' ? 'low' : null,
      handed_to: t.conclusion.handed_to || null,
      detail: {
        tier: t.conclusion.tier ?? null,
        surfaced_for: t.conclusion.surfaced_for ?? null,
        // What he told someone he would do, and when he said it. The brief leads
        // with these: they are his own words to another person, not a task he set
        // himself. Alex, 2026-09-08, on a promise four days quiet.
        promised: t.conclusion.promised ?? null,
        // The windows the other side offered, as data: deploy/drafts.mjs reads them
        // against his calendar and writes the reply that answers them.
        offer: t.conclusion.offer ?? null,
        chat_id: t.chat_id,
        closed_at: t.conclusion.closed_at ?? null,
        closed_by: t.conclusion.closed_by ?? null,
        outcome: t.conclusion.outcome ?? null,
      },
    }));
}

/**
 * Mark one closed. Never deletes the entry: the triage needs to still see the
 * thread so it does not rediscover the same obligation on the next run and
 * offer it back, and `closed_at` is the record of a decision Alex made.
 *
 * `closed_watermark` is the newest message that existed when he closed it. It
 * is what makes "don't bring this back" checkable rather than a matter of the
 * agent's mood: the item returns only if a message arrived *after* the close.
 * Nothing else — not age, not a re-read, not a periodic review — reopens it.
 */
/** A deadline moved by hand on a judged thread. The conclusion's `due` is the one field a due edit touches. */
export async function setDue(vault, ref, due) {
  const d = String(due ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(d) || Number.isNaN(Date.parse(d.replace(' ', 'T')))) throw new Error('due must be YYYY-MM-DD or YYYY-MM-DD HH:MM');
  const path = join(vault, 'integrations', 'imessage-state.json');
  const st = JSON.parse(await readFile(path, 'utf8'));
  const t = (st.threads ?? []).find((x) => x.chat_id === ref);
  if (!t?.conclusion) throw new Error('no judged thread with that id');
  const was = t.conclusion.due ?? null;
  t.conclusion.due = d;
  await writeFile(path, JSON.stringify(st, null, 1) + '\n');
  return { ref, was, due: d };
}

export async function close(vault, ref, who, outcome = null) {
  const path = join(vault, 'integrations', 'imessage-state.json');
  const st = JSON.parse(await readFile(path, 'utf8'));

  const t = (st.threads ?? []).find((x) => x.chat_id === ref);
  if (!t) throw new Error('no such thread in the triage cache');
  if (!t.conclusion?.open) return { ref, alreadyClosed: true };

  t.conclusion.open = false;
  t.conclusion.closed_at = localStamp();
  // `agent:unknown`, never `manual`. The differs read a closed_by with no
  // `agent:` prefix as a decision of his and never re-offer it — so a close
  // that arrived with no identity used to become permanent, which is the
  // wrong way to fail. Unknown gets the agent's treatment: one second look.
  t.conclusion.closed_by = who || 'agent:unknown';
  // The outcome, on the conclusion — the differ's second look shows the triage
  // the conclusion, and until 2026-09-20 this signature dropped it.
  if (outcome) t.conclusion.outcome = String(outcome).slice(0, 300);
  t.conclusion.closed_watermark = t.watermark ?? null;
  st.updated = localStamp();

  await writeFile(path, JSON.stringify(st, null, 1) + '\n');
  return { ref, closed: true, at: t.conclusion.closed_at };
}
