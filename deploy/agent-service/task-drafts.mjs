/**
 * Which task a waiting draft belongs to.
 *
 * Alex, 2026-09-19: "Lets merge the outbox into To Do. It should be more of
 * a filter, here are the To Do's with items Drafted so you can see which task
 * the entry is for."
 *
 * The Outbox was a second queue with its own page, and the thing it never
 * answered is the thing he asked for: a text to Glen Marsh sitting in it
 * says nothing about *Give Glen a verdict on the engine quote* being the debt
 * it discharges. Joined, the draft is an attribute of the task — read the
 * task, see the reply that is ready to go, send it there.
 *
 * ## The join is exact, and where it is not, it says so
 *
 * A text carries the `chat_id` it was drafted against and an obligation from
 * the message triage carries the same string. A Gmail draft carries the
 * thread id, and a mail obligation's evidence carries the thread ids it was
 * read out of. Both are identifiers the two sides already share, so this is a
 * lookup rather than a guess.
 *
 * The handle is a **fallback only**, and only for a phone number, matched on
 * the last ten digits the way the address book does. It exists because a draft
 * written against a person rather than a thread has no chat id to match —
 * and it is a fallback because a number is a person, and a person can owe him
 * four different things. When a handle matches more than one open task it
 * matches none of them: a draft filed under the wrong debt is worse than one
 * filed under no debt, because the wrong one looks answered.
 */

/** Last ten digits — the address book's convention for the same phone. */
export const digits = (s) => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

/** Every identifier a draft could be joined on. */
export function draftKeys(d) {
  const threads = new Set();
  const chats = new Set();
  const handles = new Set();
  if (d?.kind === 'mail') {
    if (d.threadId) threads.add(String(d.threadId));
  } else {
    if (d?.chatId) chats.add(String(d.chatId));
    const h = digits(d?.to);
    if (h) handles.add(h);
  }
  return { threads, chats, handles };
}

/** Every identifier an obligation could be joined on. */
export function taskKeys(o) {
  const threads = new Set();
  const chats = new Set();
  const handles = new Set();
  if (o?.chat_id) {
    chats.add(String(o.chat_id));
    const h = digits(o.chat_id);
    if (h) handles.add(h);
  }
  for (const e of o?.evidence ?? []) {
    const t = e?.detail?.thread_id;
    if (t) threads.add(String(t));
    const c = e?.detail?.chat_id;
    if (c) {
      chats.add(String(c));
      const h = digits(c);
      if (h) handles.add(h);
    }
  }
  const w = digits(o?.who);
  if (w) handles.add(w);
  return { threads, chats, handles };
}

const shares = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

/**
 * Attach each draft to at most one task.
 *
 * @param obligations  open obligations, as /api/obligations returns them
 * @param drafts       waiting drafts, as /api/outbox assembles them
 * @returns `{ taskOf, byTask, loose }` — the task id per draft id, the drafts
 *          per task id, and the drafts that belong to no task (an invite, a
 *          reply on a thread nobody owes anything on). Loose is never empty
 *          by accident: it is the list that must still be shown somewhere, or
 *          merging the two queues would lose the half that did not join.
 */
export function joinDrafts(obligations, drafts) {
  const tasks = (obligations ?? []).map((o) => ({ o, k: taskKeys(o) }));
  const taskOf = new Map();
  const byTask = new Map();
  const loose = [];

  for (const d of drafts ?? []) {
    const k = draftKeys(d);
    // Exact first: a shared thread or chat id is the two sides naming the same
    // conversation. Only if nothing matches exactly does the handle get a turn.
    let hits = tasks.filter((t) => shares(k.threads, t.k.threads) || shares(k.chats, t.k.chats));
    if (!hits.length && k.handles.size) {
      hits = tasks.filter((t) => shares(k.handles, t.k.handles));
      // A person is not a thread: four debts to one number is not four matches,
      // it is no match. Same refusal `similar.mjs` makes on a tie.
      if (hits.length > 1) hits = [];
    }
    if (hits.length !== 1) { loose.push(d); continue; }
    const id = hits[0].o.id;
    taskOf.set(d.id, id);
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(d);
  }
  return { taskOf, byTask, loose };
}
