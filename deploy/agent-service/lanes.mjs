/**
 * Which kind of work a task is — the lane it is done in.
 *
 * Alex, 2026-10-03: "I feel like I need more help to tackle similar to dos
 * in one sitting." What his open list shares is not the project — 9 of 90
 * carried a project tag that day — but the act: 69 came from email, 11 began
 * "Decide", about 21 began "Tell", "Answer", "Give", "Confirm" or "RSVP".
 * Twenty replies are one sitting; twenty replies scattered among decisions,
 * bills and errands are twenty context switches. So each task he owes gets a
 * lane, and the To Do page can hand him one lane at a time.
 *
 * Arithmetic on read, like kindTagsOf in obligations.mjs: the leading verb of
 * the title, plus the kind tags already worked out (a bill is paid, a
 * decision is decided). Timid on purpose — a title it cannot read with
 * confidence is `other`, never a guess, because a reply filed under Pay is a
 * worse sitting than one left out of every lane.
 */

export const LANES = ['reply', 'decide', 'pay', 'call', 'admin', 'other'];

export const LANE_LABEL = {
  reply: 'Reply',
  decide: 'Decide',
  pay: 'Pay',
  call: 'Call & schedule',
  admin: 'Admin',
  other: 'Other',
};

const VERBS = {
  reply: ['tell', 'answer', 'reply', 'respond', 'confirm', 'rsvp', 'give', 'send', 'let',
          'email', 'text', 'write', 'thank', 'introduce', 'share', 'forward', 'ask',
          'follow', 'wish', 'acknowledge', 'accept', 'decline', 'chase', 'nudge', 'remind',
          'say'],
  decide: ['decide', 'choose', 'pick', 'approve', 'review', 'weigh', 'consider',
           'evaluate', 'compare', 'settle', 'elect'],
  pay: ['pay', 'fund', 'wire'],
  call: ['call', 'schedule', 'book', 'arrange', 'meet', 'phone', 'ring', 'reschedule'],
  admin: ['check', 'get', 'pull', 'find', 'look', 'update', 'file', 'sign', 'fill',
          'upload', 'download', 'verify', 'read', 'research', 'submit', 'register',
          'renew', 'cancel', 'order', 'buy', 'return', 'fix', 'add', 'move', 'print',
          'scan', 'complete', 'finish', 'prepare', 'collect', 'request', 'redeem',
          'transfer', 'install', 'set', 'create', 'change', 'remove', 'clean', 'sort',
          'organize', 'track', 'test', 'try', 'save', 'log', 'record', 'put', 'take',
          'reset', 'reconcile', 'strip', 'place', 'repurchase', 'start'],
};
const BY_VERB = new Map(Object.entries(VERBS).flatMap(([lane, vs]) => vs.map((v) => [v, lane])));

/* Calibrated on his list of 2026-10-03, where 18 of 90 first landed in Other:
   "Get back to Neil", "Come back to Goldwing Aviation", "Circle back to Jared"
   are replies — but "get" alone is admin ("Get the ELCO document"); and
   "Boat 15yo engine decision!" is a decision by its own word. */
const BACK_TO = /^[\s"'“‘(]*(get|come|circle|write|reach)\s+back\s+to\b/i;
const DECISION = /\bdecisions?\b/i;
/* "Pick up Noah from school" is an errand, not a choice — "pick" alone
   decides ("Pick villa dates"), "pick up" fetches. 2026-10-07. */
const PICK_UP = /^[\s"'“‘(]*pick\s+up\b/i;

/** "Set up a call with X" is scheduling; "Set the gym time" is admin. */
const MEETING = /\b(call|meeting|meet|time|appointment|slot|intro|zoom)\b/i;

/** The first word of the title, lower-cased, without quotes or punctuation. */
export function leadingVerb(title) {
  const m = /^[\s"'“‘(]*([A-Za-z]+)/.exec(String(title ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * The lane for one obligation, or null when it is not his to do — something
 * they owe him is waiting, not work, and lives under Waiting on others.
 */
export function laneOf(o) {
  if ((o?.owed_by ?? 'me') === 'them') return null;
  const tags = o?.tags ?? [];
  if (tags.includes('invoice')) return 'pay';
  if (tags.includes('decision')) return 'decide';
  // Todo lines, reminders and texts carry only `what`; the page shows that
  // when there is no title, so the lane reads the same words he does.
  const title = String(o?.title || o?.what || '');
  if (BACK_TO.test(title)) return 'reply';
  if (PICK_UP.test(title)) return 'admin';
  const verb = leadingVerb(title);
  if (verb === 'set' && MEETING.test(title)) return 'call';
  if (!BY_VERB.has(verb) && DECISION.test(title)) return 'decide';
  return BY_VERB.get(verb) ?? 'other';
}
