/**
 * When the message triage is worth an agent turn.
 *
 * Alex, 2026-09-07, on learning texts were judged once a day at 07:00 and
 * Pete Rourke's gym time would be read the morning after: "Copy the mail model."
 * So messages get what mail has — no slot, a gate over the work list the
 * minute dispatcher already writes, and the same shape of answer: every "no"
 * carries its reason, because "nothing is waiting" and "the Mac is asleep"
 * are opposite facts that must never look alike from outside.
 *
 * One difference from mail, and it is the point of doing this: a text from
 * someone he actually knows does not wait for a batch. The differ already
 * names every participant from Contacts and people/, so "someone he knows" is
 * a fact on the work list rather than a judgement.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const MESSAGES = {
  MIN_GAP_MIN: 30,        // never more often, as with mail
  KNOWN_GAP_MIN: 20,      // …unless someone he knows is waiting
  BATCH_AT: 3,
  MAX_WAIT_MIN: 60,
};
/** A work list older than this means the Mac stopped, not that nobody texted. */
const LIST_MAX_AGE_MIN = 45;

const minutesSince = (stamp) => {
  const t = Date.parse(String(stamp ?? '').replace(' ', 'T'));
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 60000;
};

/** Threads waiting whose participants are named — someone with a file or a contact. */
export function knownWaiting(list) {
  return (list?.needs_judgement ?? []).filter((e) =>
    (e.participants ?? []).some((p) => p?.name) || (e.who && !/^\+?\d[\d\s().-]*$/.test(String(e.who))));
}

/** The newest message the extract actually contains — not when it ran. */
async function newestMessage(vault) {
  try {
    const ex = JSON.parse(await readFile(join(vault, 'integrations', 'imessage.json'), 'utf8'));
    let newest = '';
    for (const t of ex.threads ?? []) for (const m of t.messages ?? []) if (m.at > newest) newest = m.at;
    return newest || null;
  } catch { return null; }
}

export async function messagesDue(vault, now, runs) {
  const listPath = join(vault, 'integrations', 'imessage-changed.json');
  let list, writtenAt;
  try {
    list = JSON.parse(await readFile(listPath, 'utf8'));
    writtenAt = (await stat(listPath)).mtimeMs;
  } catch {
    return { due: false, why: 'no work list — the message pipeline has not run' };
  }
  // mtime, not the stamp inside: the same reasoning as the mail gate. The file
  // is rewritten every minute by the dispatcher, so a stale one means the
  // extract behind it stopped — the Mac asleep, which is exactly the state
  // that hid Pete Rourke's text.
  const listAge = (now.getTime() - writtenAt) / 60000;
  if (listAge > LIST_MAX_AGE_MIN) {
    return { due: false, stale: true, why: `work list is ${Math.round(listAge)}m old — the message pipeline is not refreshing` };
  }
  const extractAge = minutesSince(list.extract_generated_at);
  if (extractAge > 120) {
    return { due: false, stale: true, extractAge: Math.round(extractAge),
             why: `the Mac last exported ${Math.round(extractAge / 60)}h ago — nothing new can be seen until it wakes` };
  }
  // A fresh stamp over stale contents. On 2026-09-08 the Mac woke after 35
  // hours, ran every extractor, and wrote files stamped that minute whose
  // newest message was two days old — so the triage judged the past believing
  // it was the present. The stamp says when the export ran; only the messages
  // say what it saw.
  const newest = await newestMessage(vault);
  if (newest && minutesSince(newest) > 24 * 60) {
    return { due: false, stale: true, newest,
             why: `the export ran ${Math.round(extractAge)}m ago but its newest message is ${newest} — the Mac is reading a stale database, not a quiet phone` };
  }
  const waiting = (list.needs_judgement ?? []).length;
  if (!waiting) return { due: false, why: 'nothing waiting' };
  const known = knownWaiting(list).length;
  const gap = minutesSince(runs.messages?.at);
  const need = known ? MESSAGES.KNOWN_GAP_MIN : MESSAGES.MIN_GAP_MIN;
  if (gap < need) {
    return { due: false, waiting, known, why: `ran ${Math.round(gap)}m ago, waiting ${need}m${known ? ` (${known} from someone he knows)` : ''}` };
  }
  if (known) return { due: true, waiting, known, why: `${known} thread(s) from someone he knows` };
  if (waiting >= MESSAGES.BATCH_AT) return { due: true, waiting, known, why: `${waiting} threads waiting` };
  if (gap >= MESSAGES.MAX_WAIT_MIN) return { due: true, waiting, known, why: `${waiting} waiting, nothing judged for ${Math.round(gap)}m` };
  return { due: false, waiting, known, why: `only ${waiting} waiting from numbers nobody can name, holding for a batch` };
}
