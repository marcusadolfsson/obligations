/**
 * Keep in Inbox: a thread he wants in front of him, held there until he lets
 * it go or its task is done.
 *
 * Alex, 2026-10-09: "I want to add a feature 'Keep in Inbox'. that moves the
 * message back to Inbox, and keeps it there until I manually archive OR we
 * determine that the task is closed."
 *
 * Against the grain on purpose. The policy since 2026-09-02 is that every
 * judged thread archives — "nothing lives in the box" — and three things act
 * on it: the differ's `needs_archive` sweep, the mail job archiving what it has
 * just judged, and a new message re-judged and archived again. So a thread he
 * moved back by hand was gone at the next run. Here, his word holds:
 *
 *   keep      his tap: INBOX goes back on the thread, the thread is recorded
 *   hold      the differ leaves kept threads out of `needs_archive` and marks
 *             them in the work list; and `archiveGuard`, a PreToolUse hook on
 *             every model run, refuses any call that would take INBOX off one —
 *             a rule in a prompt is a request, the hook is the guarantee
 *   release   `keepPass`, each minute: the task closed → the assistant archives it;
 *             it left the inbox after being seen there → that was him (nothing
 *             else may archive it), and the record goes quietly
 *
 * `integrations/keep-in-inbox.json` is written only here: by his tap through
 * the page (his identity required) and by the pass releasing an entry.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { localStamp } from './time.mjs';
import { OWNER_FIRST } from './owner.mjs';

export const FILE = ['integrations', 'keep-in-inbox.json'];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const keyOf = (account, threadId) => `${account || 'personal'}:${threadId}`;

export async function readKept(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, ...FILE), 'utf8'));
    return d?.threads && typeof d.threads === 'object' ? d.threads : {};
  } catch { return {}; }
}

async function writeKept(vault, threads) {
  const file = join(vault, ...FILE);
  await mkdir(dirname(file), { recursive: true });
  const doc = {
    $comment: 'Threads he asked to Keep in Inbox (keep-inbox.mjs). Written by his tap and by the minute pass that releases one; nothing archives a thread listed here.',
    threads,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 1) + '\n');
  await rename(tmp, file);
}

/** Gmail's thread modify, through the service's own token. Injected in tests. */
export async function gmailThreadModify(vault, account, threadId, body) {
  const { accessToken } = await import('../mcp/google-auth.mjs');
  const token = await accessToken(vault, fetch, account);
  const res = await fetch(`${API}/threads/${encodeURIComponent(threadId)}/modify`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json().catch(() => ({}));
}

/** His tap: put the thread back in the inbox and hold it there. */
export async function keep(vault, { account, threadId, by, task = null, now = new Date(), modify = gmailThreadModify }) {
  if (!/^[0-9a-f]{4,32}$/i.test(String(threadId ?? ''))) throw new Error('not a Gmail thread id');
  await modify(vault, account, threadId, { addLabelIds: ['INBOX'] });
  const kept = await readKept(vault);
  const key = keyOf(account, threadId);
  kept[key] = { at: localStamp(now), by, task, seen_in_inbox: null };
  await writeKept(vault, kept);
  return { key, kept: kept[key] };
}

/** His other tap: stop holding it. With `archive`, it leaves the inbox too. */
export async function release(vault, { account, threadId, archive = false, modify = gmailThreadModify }) {
  const kept = await readKept(vault);
  const key = keyOf(account, threadId);
  if (!kept[key]) return { key, released: false };
  if (archive) await modify(vault, account, threadId, { removeLabelIds: ['INBOX'] });
  delete kept[key];
  await writeKept(vault, kept);
  return { key, released: true, archived: archive };
}

/**
 * The task behind a kept thread: an obligation whose id is the thread's, or
 * whose evidence names it. `closed` only when there is at least one, every one
 * is closed, and the last close came AFTER he kept it — keeping a thread whose
 * task was already done is him wanting it there anyway. A thread kept with no
 * task is released by his hand alone.
 */
export function taskState(key, obligations, since = '') {
  const [account, threadId] = key.split(':');
  const mine = obligations.filter((o) => o.id === `mail:${key}`
    || (o.evidence ?? []).some((e) => e.source === 'email' && e.detail?.thread_id === threadId && (e.detail?.account ?? 'personal') === account));
  const done = mine.length > 0 && mine.every((o) => o.open === false || o.closed);
  const last = mine.map((o) => String(o.closed_at ?? '')).sort().at(-1) ?? '';
  return { tasks: mine.map((o) => o.id), closed: done && last >= since };
}

/**
 * Each minute. `extract` is the latest mail extract (integrations/gmail.json):
 * what is in the inbox now. `obligations` is every obligation, open and closed.
 * Returns what it did; changes the record and Gmail only through `modify`.
 */
export async function keepPass(vault, { extract, obligations, now = new Date(), modify = gmailThreadModify, log = async () => {} }) {
  const kept = await readKept(vault);
  const keys = Object.keys(kept);
  if (!keys.length) return { kept: 0, released: [] };
  const inInbox = new Set();
  for (const t of extract?.threads ?? []) if (t.in_inbox) inInbox.add(keyOf(t.account, t.thread_id));
  const whole = !!extract && !extract.partial;
  const released = [];
  let changed = false;
  for (const key of keys) {
    const k = kept[key];
    const [account, threadId] = key.split(':');
    const { tasks, closed } = taskState(key, obligations, k.at ?? '');
    if (closed) {
      try {
        await modify(vault, account, threadId, { removeLabelIds: ['INBOX'] });
        delete kept[key]; changed = true;
        released.push({ key, why: 'task closed', tasks });
        await log('keep_released', { key, why: 'task closed', tasks });
      } catch (err) { await log('keep_release_failed', { key, error: String(err?.message ?? err).slice(0, 200) }); }
      continue;
    }
    if (inInbox.has(key)) {
      if (!k.seen_in_inbox) { k.seen_in_inbox = localStamp(now); changed = true; }
      continue;
    }
    // Gone from the inbox after being seen there. Nothing of ours may archive a
    // kept thread (archiveGuard), so it was him. Before it was ever seen there,
    // the extract has simply not caught up with the tap.
    if (whole && k.seen_in_inbox) {
      delete kept[key]; changed = true;
      released.push({ key, why: 'he archived it' });
      await log('keep_released', { key, why: 'he archived it' });
    }
  }
  if (changed) await writeKept(vault, kept);
  return { kept: Object.keys(kept).length, released };
}

/* ------------------------------------------------------------- the guard */

const ARCHIVERS = /^mcp__([a-z0-9_-]+)__(batch_modify_emails|modify_email|modify_thread)$/;

/**
 * Would this tool call take INBOX off a kept thread? Pure: `kept` is the
 * record, `byMessage` maps a message id to its `account:thread` key (from the
 * extract). Returns null to allow, or the keys it would have archived.
 * The account comes from the server's name in the tool (mcp__work__… → work;
 * the old single `gmail` server meant the main mailbox).
 */
export function archiveGuard(toolName, input, kept, byMessage) {
  const m = ARCHIVERS.exec(String(toolName));
  if (!m) return null;
  if (!(input?.removeLabelIds ?? []).includes('INBOX')) return null;
  const account = m[1] === 'gmail' ? 'personal' : m[1];
  const hit = new Set();
  if (m[2] === 'modify_thread') {
    const key = keyOf(account, input?.threadId);
    if (kept[key]) hit.add(key);
  } else {
    const ids = m[2] === 'modify_email' ? [input?.messageId] : (input?.messageIds ?? []);
    for (const id of ids) {
      const key = byMessage.get(String(id));
      if (key && kept[key]) hit.add(key);
    }
  }
  return hit.size ? [...hit] : null;
}

/** message id → thread key, from the extract. */
export function messageIndex(extract) {
  const map = new Map();
  for (const t of extract?.threads ?? []) for (const msg of t.messages ?? []) if (msg?.id) map.set(String(msg.id), keyOf(t.account, t.thread_id));
  return map;
}

/** The SDK hook: a PreToolUse callback that blocks an archive of a kept thread. */
export function keepInboxHook(vault, { log = async () => {} } = {}) {
  return async (input) => {
    const name = input?.tool_name;
    if (!ARCHIVERS.test(String(name ?? ''))) return {};
    const [kept, extract] = await Promise.all([
      readKept(vault),
      readFile(join(vault, 'integrations', 'gmail.json'), 'utf8').then(JSON.parse).catch(() => null),
    ]);
    if (!Object.keys(kept).length) return {};
    const hit = archiveGuard(name, input?.tool_input, kept, messageIndex(extract));
    if (!hit) return {};
    await log('keep_guard_blocked', { tool: name, threads: hit });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${OWNER_FIRST} asked to Keep in Inbox: ${hit.join(', ')}. Never archive these — leave them out of this call and archive the rest.`,
      },
    };
  };
}
