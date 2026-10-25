/**
 * The one switch that stops the assistant spending a model call.
 *
 * Alex, 2026-09-21: "I am about to run out of claude credits for the week. I
 * want to build a 'Model Enabled' toggle, where we can turn on and off anything
 * that requires a claude model."
 *
 * ## What it covers, and what it deliberately does not
 *
 * Four things in this service call a model, and all four ask here first:
 * the mail triage, the message triage, the three briefs, the digest writer and
 * the urgency classifier. Everything else in the assistant is arithmetic — the
 * minute dispatcher, both differs, the drafts pass, the reconciliation's own
 * closes, conflicts, prep, the calendar doors — and **none of it stops**. That
 * is the point of the switch rather than stopping the service: mail still
 * arrives and is still diffed, reminders still push, what is already judged
 * still closes itself. What pauses is judgement.
 *
 * **The chat is not gated.** He is sitting in front of it, every turn is his
 * own deliberate spend, and it is how he would ask what state this is in. A
 * switch that could lock him out of the room it lives in is the wrong switch.
 * The drawer says the state instead.
 *
 * ## Refusing must not consume the work
 *
 * A gated run returns before the job starts and touches no cursor, watermark or
 * state file. The threads stay waiting, the gates stay due, and when the switch
 * goes back on the next tick judges the backlog. A gate that let the work be
 * marked handled would turn a saved dollar into a lost thread.
 *
 * ## And it must never look like a quiet week
 *
 * `rules` here is the repo's own: a silence must never be indistinguishable
 * from a success. So every refusal is logged with what was skipped, the file
 * counts them, and `statusLine()` is what the pages and the brief put in front
 * of him — "model runs are off since Monday 14:20; 9 runs skipped, 31 threads
 * waiting". Off and idle must not render the same.
 *
 * ## `until` is the feature, not a nicety
 *
 * His credits reset weekly, which is exactly the shape of "off until Monday".
 * A switch he has to remember to turn back on is one that stays off for a week
 * after the money returns. `until` is checked on every read, so the assistant wakes
 * itself up with no scheduler and no job.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { localStamp } from './time.mjs';

const FILE = (vault) => join(vault, 'integrations', 'model-enabled.json');

/** Every run in this service that costs money, and what it is called on a page. */
export const SPENDERS = {
  mail: 'the mail triage',
  messages: 'the message triage',
  morning: 'the 07:00 brief',
  evening: 'the 18:00 journal and housekeeping',
  digest: 'the mail digest',
  urgency: 'the urgency check',
  reply: 'the reply drafts you ask for on a task',
  prepare: 'the drafts and notes readied when you start a session',
  rank: "today's order — the daily ranking of your top ten",
};

const stampMs = (s) => {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
};

/**
 * The state as it stands right now.
 *
 * Absent means ON. A repo with no file has never been switched off, and a file
 * that cannot be read must not silently stop the week's judgement — the failure
 * direction here is "keep working and say so", because the other one is a
 * mailbox nobody reads piling up behind a parse error.
 */
export async function readGate(vault, { now = new Date() } = {}) {
  let d = null;
  try { d = JSON.parse(await readFile(FILE(vault), 'utf8')); }
  catch (err) {
    if (err?.code === 'ENOENT') return { enabled: true, reason: null, unreadable: false };
    return { enabled: true, reason: null, unreadable: String(err?.message ?? err) };
  }
  const enabled = d?.enabled !== false;
  if (enabled) return { ...d, enabled: true, reason: null, unreadable: false };

  /* IT TURNS ITSELF BACK ON. Checked on read rather than by a timer, so it is
     true the moment it is true and no job has to fire for it to happen. */
  const until = stampMs(d?.until);
  if (until && now.getTime() >= until) {
    return { ...d, enabled: true, expired: true, reason: null, unreadable: false };
  }
  return { ...d, enabled: false, unreadable: false, reason: d?.why || 'switched off' };
}

/**
 * May this run spend? The one question every caller asks.
 *
 * `what` is a key of SPENDERS. An unknown one is still gated — a new model call
 * that forgot to add itself to the list should fail closed, not bill him.
 */
export async function mayRun(vault, what, { now = new Date() } = {}) {
  const g = await readGate(vault, { now });
  if (g.enabled) return { ok: true, gate: g };
  return {
    ok: false,
    gate: g,
    what,
    label: SPENDERS[what] ?? what,
    why: g.reason,
    since: g.since ?? null,
    until: g.until ?? null,
  };
}

/**
 * Flip it. Only from the page, with his identity, or from the chat when he asks.
 *
 * `why` is required when switching OFF, for the same reason an outcome is
 * required on a close: a state nobody can audit is not a record, and in a week
 * he will want to know whether this was the credits or a test.
 */
export async function setGate(vault, { enabled, why, until = null, by = null, now = new Date() } = {}) {
  const on = enabled !== false;
  if (!on && !String(why ?? '').trim()) throw new Error('turning model runs off needs a reason');
  if (until && !stampMs(until)) throw new Error(`until is not a YYYY-MM-DD HH:MM stamp: ${until}`);
  const prev = await readGate(vault, { now }).catch(() => null);
  const at = localStamp(now);
  const d = {
    enabled: on,
    since: at,
    by: by || null,
    why: on ? null : String(why).trim().slice(0, 300),
    until: on ? null : (until || null),
    // Kept while it stays off, cleared when it comes back on: the count is
    // about this pause, and a fresh pause starts from nothing.
    skipped: on ? {} : (prev?.skipped ?? {}),
    $comment: 'Alex\'s switch. `enabled: false` stops every model run except the chat. '
      + 'The page writes it; the agent reads it and flips it only when he asks in chat.',
  };
  await mkdir(dirname(FILE(vault)), { recursive: true });
  await writeFile(FILE(vault), JSON.stringify(d, null, 1) + '\n');
  return { enabled: on, since: at, until: d.until, why: d.why, was: prev?.enabled !== false };
}

/**
 * Count a refusal.
 *
 * Best-effort on purpose: this is bookkeeping about a run that is not
 * happening, and it must never be the thing that throws inside a gate check.
 */
export async function countSkip(vault, what) {
  try {
    const d = JSON.parse(await readFile(FILE(vault), 'utf8'));
    if (d?.enabled !== false) return;
    d.skipped = { ...(d.skipped ?? {}), [what]: (d.skipped?.[what] ?? 0) + 1 };
    d.skipped_last = localStamp();
    await writeFile(FILE(vault), JSON.stringify(d, null, 1) + '\n');
  } catch {}
}

/** Total refusals since it went off, and the worst offender. */
export function skipTotal(gate) {
  const s = gate?.skipped ?? {};
  return Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0);
}

/**
 * The sentence the pages and the brief show.
 *
 * Never "" when it is off. An empty banner and a working repo look the same,
 * and the whole risk of a switch like this is forgetting it is thrown.
 */
export function statusLine(gate, { waiting = null } = {}) {
  if (!gate || gate.enabled) return null;
  const n = skipTotal(gate);
  const bits = [`Model runs are off since ${gate.since ?? 'some point'}`];
  if (gate.why) bits.push(gate.why);
  const tail = [];
  if (n) tail.push(`${n} run${n === 1 ? '' : 's'} skipped`);
  if (Number.isFinite(waiting) && waiting > 0) tail.push(`${waiting} thread${waiting === 1 ? '' : 's'} waiting to be judged`);
  let s = bits.join(' — ');
  if (tail.length) s += `. ${tail.join(', ')}`;
  s += gate.until ? `. Back on by itself at ${gate.until}.` : '. It stays off until you turn it back on.';
  return s;
}
