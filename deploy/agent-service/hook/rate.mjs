/**
 * How many times a stranger can make Alex's phone ring.
 *
 * The realtime tier is the first thing in this system where *someone else's
 * action* causes an interrupt. That sentence is the feature and the attack at
 * once: anyone who knows his address and can reach a login form at a service
 * that passes DMARC can cause a push. The sender list is a fast lane rather
 * than a gate — his decision, 2026-08-30 — so the caps below are what stand
 * between that and a phone buzzing all night.
 *
 * ## Deduplication comes before sending, not after
 *
 * `rules/realtime-push.md` records why, from the first live test: the voip.ms
 * API returned success on a send that was retried, and Alex got the same code
 * twice. A code that arrives twice is one he starts distrusting, and the
 * channel is worth nothing once he does. So a message id is marked *before* the
 * send and stays marked whatever the send returns — an ambiguous result is
 * treated as sent.
 *
 * ## The burst is the signal
 *
 * Over the cap, one message goes out — "code pushes suppressed, someone may be
 * trying to sign in as you" — and then silence until the window rolls. Silently
 * dropping would hide an attack in progress; continuing to push would be the
 * attack succeeding. Saying it once is the only option that is neither.
 *
 * ## Ratified senders get a looser budget
 *
 * Being on the list buys the domain-bound autofill line and a bigger share of
 * the hourly allowance. Unratified senders share a tighter pool, so an unlisted
 * service still works while a stranger cannot spend the whole night's budget.
 *
 * State lives in `.log/push-rate.json`, outside the repo: it is a counter, not
 * a decision, and it would be noise in git history.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Everything, ratified or not. The hard ceiling on a night. */
export const GLOBAL_HOUR = 6;
export const GLOBAL_DAY = 12;
/** Unratified senders share this, inside the global cap. */
export const UNRATIFIED_HOUR = 3;
/** One sender cannot occupy the channel by itself. */
export const PER_SENDER_WINDOW_MS = 5 * 60 * 1000;
export const PER_SENDER_HOUR = 3;
/** How long a seen message id is remembered. Longer than any Pub/Sub retry. */
export const SEEN_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const statePath = (vault) => join(vault, '.log', 'push-rate.json');

export async function load(vault) {
  try {
    const s = JSON.parse(await readFile(statePath(vault), 'utf8'));
    return { seen: s.seen ?? {}, pushes: s.pushes ?? [], suppressedAt: s.suppressedAt ?? 0 };
  } catch {
    return { seen: {}, pushes: [], suppressedAt: 0 };
  }
}

export async function save(vault, state) {
  await mkdir(dirname(statePath(vault)), { recursive: true });
  await writeFile(statePath(vault), JSON.stringify(state, null, 1) + '\n');
}

/** Drop anything too old to matter, so the file cannot grow without bound. */
export function prune(state, now = Date.now()) {
  const seen = {};
  for (const [id, at] of Object.entries(state.seen ?? {})) {
    if (now - at < SEEN_MS) seen[id] = at;
  }
  return {
    seen,
    pushes: (state.pushes ?? []).filter((p) => now - p.at < DAY_MS),
    suppressedAt: state.suppressedAt ?? 0,
  };
}

/**
 * May this message be pushed?
 *
 * @returns {{allow: boolean, reason: string, announce?: boolean}}
 *
 * `announce` is set exactly once per suppression window: the one message that
 * tells him pushes are being dropped. Every later refusal in the same window
 * returns `announce: false`, which is what keeps a burst from becoming a
 * different burst.
 */
export function decide(state, { messageId, sender, ratified }, now = Date.now()) {
  // Age-checked, not merely present. `seen` is only pruned when something is
  // recorded, so without this the dedupe window would be "forever, until the
  // next push" rather than the SEEN_MS the constant advertises — two different
  // guarantees that happen to look the same on a busy day.
  //
  // Forgetting after a day is safe because `classify.mjs` independently refuses
  // anything whose internalDate is older than ten minutes: a replayed ancient
  // message id cannot get this far to begin with.
  const seenAt = state.seen?.[messageId];
  if (messageId && seenAt !== undefined && now - seenAt < SEEN_MS) {
    return { allow: false, reason: 'already pushed this message' };
  }

  const pushes = state.pushes ?? [];
  const inHour = pushes.filter((p) => now - p.at < HOUR_MS);
  const inDay = pushes.filter((p) => now - p.at < DAY_MS);

  const overCap = (reason) => {
    // One announcement per hour, then silence. Announcing every refusal would
    // turn a suppressed burst into an unsuppressed one.
    const announce = now - (state.suppressedAt ?? 0) > HOUR_MS;
    return { allow: false, reason, announce, suppressed: inHour.length };
  };

  if (inDay.length >= GLOBAL_DAY) return overCap(`${GLOBAL_DAY} pushes today`);
  if (inHour.length >= GLOBAL_HOUR) return overCap(`${GLOBAL_HOUR} pushes this hour`);

  if (!ratified) {
    const unratified = inHour.filter((p) => !p.ratified);
    if (unratified.length >= UNRATIFIED_HOUR) {
      return overCap(`${UNRATIFIED_HOUR} pushes this hour from unratified senders`);
    }
  }

  if (sender) {
    const mine = pushes.filter((p) => p.sender === sender);
    if (mine.some((p) => now - p.at < PER_SENDER_WINDOW_MS)) {
      return { allow: false, reason: `${sender} pushed within the last 5 minutes` };
    }
    if (mine.filter((p) => now - p.at < HOUR_MS).length >= PER_SENDER_HOUR) {
      return { allow: false, reason: `${sender} has pushed ${PER_SENDER_HOUR} times this hour` };
    }
  }

  return { allow: true, reason: 'within every cap' };
}

/**
 * Mark a message as pushed. **Called before the send, not after.**
 *
 * The ordering is the whole point — see the header. A send that fails after
 * this leaves a code unsent, which costs Alex a trip to his mail. A send that
 * succeeds without this leaves a code that can be sent twice, which costs the
 * channel.
 */
export function record(state, { messageId, sender, ratified }, now = Date.now()) {
  const next = prune(state, now);
  if (messageId) next.seen[messageId] = now;
  next.pushes.push({ at: now, sender: sender ?? null, ratified: !!ratified });
  return next;
}

/** Remember that the suppression notice has gone out, so it goes out once. */
export function markSuppressed(state, now = Date.now()) {
  return { ...state, suppressedAt: now };
}

export function suppressionMessage(count) {
  return `${count} code pushes suppressed in the last hour. `
       + 'Someone may be trying to sign in as you.';
}
