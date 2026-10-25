/**
 * Apple Reminders as a source — what he put there himself.
 *
 * Alex, 2026-09-18: "can we tie it in Apple Reminders through the mac
 * bridge?" Reminders is the one list that is already on his wrist, in his car
 * and behind "Hey Siri", and until now anything he said into it was invisible
 * here. The Mac reads it with EventKit and pushes
 * `integrations/reminders-apple.json` the same way it pushes the message and
 * call extracts; this turns the half he wrote into obligations.
 *
 * **Only the lists that are his.** Everything the assistant mirrors lives in one
 * list (`Obligations`, see `deploy/reminders-bridge.mjs`), and reading those back as
 * obligations would make every mirrored debt a second debt. A mirrored item is
 * recognisable without trusting the list name: it carries the obligation's id.
 *
 * A ticked reminder of HIS is done, so it is not read at all — the same rule as
 * a ticked `todo.md` line. A ticked MIRROR is different and is not handled here:
 * it is evidence about somebody else's obligation, and the bridge closes that.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SOURCE = 'apple';
export const FILE = 'integrations/reminders-apple.json';
export const LISTS = 'integrations/reminders-lists.json';
// The one list the assistant writes. Named here rather than in the bridge because
// the reader needs it too: see the note about a task he types into it himself.
export const MIRROR_LIST = 'Obligations';

/**
 * Which of his lists are task lists.
 *
 * The first real extract, 2026-09-18, carried three lists: Reminders, Family,
 * and Shows & Movies — and "Thank you for Smoking", put there in 2024, became
 * an obligation due nothing. A watchlist is not a debt. Alex, asked the same
 * morning: the default list only.
 *
 * His file, like the ignore list: the agent reads it and never writes it. The
 * lists left out are still counted (see `skipped`), because "seen, not read" and
 * "there was nothing there" must not look the same.
 */
const DEFAULT_LISTS = ['Reminders'];

async function taskLists(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, LISTS), 'utf8'));
    const rows = Array.isArray(d?.lists) ? d.lists : null;
    if (rows?.length) return rows.map((x) => String(x).trim().toLowerCase());
  } catch { /* absent or unreadable: the default, which is the narrow one */ }
  return DEFAULT_LISTS.map((x) => x.toLowerCase());
}

/** What was seen and deliberately not read, per list. For the report. */
export async function skipped(vault) {
  const d = await load(vault);
  const want = new Set(await taskLists(vault));
  const out = {};
  for (const r of d?.reminders ?? []) {
    const list = String(r?.list ?? '').trim();
    if (!list || want.has(list.toLowerCase()) || list === MIRROR_LIST || r.completed || mirrorOf(r)) continue;
    out[list] = (out[list] ?? 0) + 1;
  }
  return out;
}

/** The id the rest of the system uses for one of his reminders. */
export const appleId = (uid) => `apple:${String(uid ?? '').trim()}`;

/**
 * The mirror marker: the obligation this reminder is a copy of, or null.
 *
 * Three places, because EventKit has no custom fields and the Mac session
 * (2026-09-18) was right to ask which one is authoritative: whichever survives.
 *
 *   1. `obligations_id` on the pushed record — what the Mac should set if it can;
 *   2. the reminder's `url`, which is also the tap back into the page;
 *   3. a trailing `obligations:<id>` line in the notes, for when neither survives
 *      iCloud or his own editing.
 *
 * Any one of them is enough. Writing all three costs nothing and means a
 * mirrored item can never be mistaken for a task he wrote — which is the
 * failure that would turn one debt into two.
 */
export function mirrorOf(r) {
  const direct = String(r?.obligations_id ?? '').trim();
  if (direct) return direct;
  const m = /\/todo#pane=([^\s)]+)/.exec(String(r?.url ?? ''));
  if (m) return decodeURIComponent(m[1]);
  const n = /(?:^|\n)\s*obligations:\s*(\S+)\s*$/.exec(String(r?.notes ?? ''));
  return n ? n[1] : null;
}

async function load(vault) {
  try { return JSON.parse(await readFile(join(vault, FILE), 'utf8')); } catch { return null; }
}

export async function read(vault) {
  const d = await load(vault);
  const want = new Set(await taskLists(vault));
  // Closed here, not yet ticked there. Without this the obligation springs back
  // open on the next read — the phone still shows the reminder, because the Mac
  // has not run yet — and a merged pair would be uncloseable from this side.
  const pending = await ticked(vault);
  const out = [];
  for (const r of d?.reminders ?? []) {
    if (!r?.id || mirrorOf(r)) continue;                 // a mirror is not his
    // A list he does not keep tasks in. Read, counted, and not turned into a
    // debt — `skipped()` is what stops that being a silence.
    //
    // The exception is the assistant's own list. Alex, 2026-09-18: "should I put
    // new ones in the Obligations category?" He should not need to think about it,
    // and an item there with no marker cannot be anything but his — the writer
    // never creates one without one. Silently swallowing a task he typed into
    // the list the assistant put on his phone would be the worst of both.
    const list = String(r.list ?? '').trim();
    if (!want.has(list.toLowerCase()) && list !== MIRROR_LIST) continue;
    if (r.completed) continue;                            // ticked is done
    if (pending[r.id]) continue;                          // closed here, waiting for the Mac
    const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    out.push({
      ref: appleId(r.id),
      who: null,
      what: title,
      // Reminders has no "since"; the creation stamp is the honest answer and
      // the extractor carries it. Without one the age is unknown rather than 0.
      since: r.created ?? null,
      // When he dictated it. A reminder made after a close reopens the
      // obligation — it is his decision, said out loud. See obligation-state.mjs.
      at: r.created ?? null,
      due: r.due ?? null,
      // His own flag, not a judgement of ours. Reminders' own high/medium/low.
      priority: r.priority === 'high' ? 'high' : r.priority === 'low' ? 'low' : 'normal',
      owed_by: 'me',
      open: true,
      closes: null,
      detail: { list: r.list ?? null, notes: r.notes ?? null, url: r.url ?? null },
    });
  }
  return out;
}

export const TICKED = ['.log', 'reminders-ticked.json'];

/** The reminders of his that have been closed here and not yet ticked there. */
export async function ticked(vault) {
  try { return JSON.parse(await readFile(join(vault, ...TICKED), 'utf8')); } catch { return {}; }
}

/**
 * Closing one from here.
 *
 * The assistant cannot reach into Reminders — there is no inbound path to the Mac,
 * by design — so this records the intent and the next mirror asks the Mac to
 * complete that reminder. `.log/reminders-ticked.json` is the queue.
 *
 * **Who closed it decides whether the Mac is asked at all.** Alex,
 * 2026-09-18: "so once they are linked, closing one closes both?" It has to be
 * yes, or linking is a label rather than a join — but only his own hand reaches
 * into his own list. An agent close records nothing here: the reminder stays on
 * his phone, he ticks it when he agrees, and that tick is what closes it. The
 * asymmetry is the same one closes have everywhere in this repo — being wrong
 * is allowed, staying wrong is not, and an agent close that silently ticked a
 * reminder off his phone would be a wrong one he could never see.
 */
export async function close(vault, ref, who = null) {
  const uid = String(ref).replace(/^apple:/, '');
  const byHim = !String(who ?? '').startsWith('agent:');
  /* THROW, do not report success. The policy is unchanged — an agent close
     does not tick his own list — but this used to return `closed: true`
     while writing nothing, so close.mjs printed "closed apple", `read()`
     kept seeing the reminder incomplete, and the merge (open if ANY member
     is) had the obligation open again seconds later. A close that will not
     stick is a failure, and closeObligation already knows how to report one:
     the other evidence still closes, this half is named as not closed, and
     the item stays on his list until HE ticks it. Review 2026-09-20. */
  if (!byHim) throw new Error('his reminder is left alone — an agent close does not tick his own list; it stays open until he ticks it');
  const path = join(vault, ...TICKED);
  const q = await ticked(vault);
  q[uid] = { at: new Date().toISOString().slice(0, 16).replace('T', ' '), by: who ?? 'alex' };
  await writeFile(path, JSON.stringify(q, null, 1));
  return { ref, closed: true, pending: 'the Mac completes it on its next pass' };
}
