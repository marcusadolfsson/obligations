/**
 * The documents filed to Drive from a task's own threads, so the task carries
 * a link to them.
 *
 * Alex, 2026-10-15, on C4KF (the Lakeside Jet Hangar Co flap actuator invoice):
 * "did we file it, we need to link the filed document in the task." It was
 * filed — both PDFs, the day the mail came — and the only way to find them was
 * the /reference page or a grep, while the task said "Both PDFs filed" in
 * prose with nowhere to tap.
 *
 * Arithmetic, not judgement: `reference/statements.md` already records each
 * filed document with the Gmail message it came from (`msg:<id>`), and a mail
 * task's evidence names its threads. A line belongs to a task when its message
 * is one of those threads' messages — the thread id itself (a thread's first
 * message shares its id) or any message id in the assistant's own cache of that
 * thread. A thread the cache has never held matches on its first message only;
 * that is an under-report, never a wrong link.
 *
 * Read-only. Nothing here writes the record or the obligation.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// The line `file-attachment.mjs` writes; the same shape /reference and
// statements-tidy.mjs parse.
const LINE = /^- (\d{4}-\d{2}-\d{2}) — \*\*([\s\S]*?)\*\* from (.+?) · \[(.+?)\]\((https:[^)\s]+)\) · (\d+)KB.*? · msg:([0-9a-f]+)\s*$/;

/** Every filed document, keyed by the message it came from. */
export function parseFiled(text) {
  const byMsg = new Map();
  for (const l of String(text ?? '').split('\n')) {
    const m = l.match(LINE);
    if (!m) continue;
    const [, date, title, , name, link, kb, msg] = m;
    const list = byMsg.get(msg) ?? [];
    // Append-only record: a re-filed or corrected line repeats the link.
    if (!list.some((d) => d.link === link)) list.push({ date, title, name, link, kb: Number(kb) });
    byMsg.set(msg, list);
  }
  return byMsg;
}

// The message ids in one cached thread, remembered against the file's mtime:
// /api/obligations calls this for every mail task on every load.
const cacheIds = new Map();
async function messageIds(vault, account, threadId) {
  if (!/^[a-z][a-z0-9_-]*$/.test(account) || !/^[0-9a-f]{4,32}$/.test(threadId)) return [];
  const path = join(vault, '.log', 'mail-cache', account, `${threadId}.json`);
  let mtime;
  try { mtime = (await stat(path)).mtimeMs; } catch { return []; }
  const hit = cacheIds.get(path);
  if (hit && hit.mtime === mtime) return hit.ids;
  let ids = [];
  try { ids = (JSON.parse(await readFile(path, 'utf8')).messages ?? []).map((m) => String(m.id ?? '')).filter(Boolean); } catch { /* a torn cache file is no ids */ }
  cacheIds.set(path, { mtime, ids });
  return ids;
}

/**
 * Put `filed: [{ date, title, name, link, kb }]` on each item whose mail
 * evidence has a filed document. Items without one are left untouched.
 */
export async function attachFiled(vault, items) {
  let text = '';
  try { text = await readFile(join(vault, 'reference', 'statements.md'), 'utf8'); } catch { return items; }
  const byMsg = parseFiled(text);
  if (!byMsg.size) return items;
  for (const o of items) {
    const found = [];
    for (const e of o.evidence ?? []) {
      if (e.source !== 'email' || !e.detail?.thread_id) continue;
      const t = e.detail.thread_id;
      const ids = new Set([t, ...(await messageIds(vault, e.detail.account ?? '', t))]);
      for (const id of ids) {
        for (const d of byMsg.get(id) ?? []) if (!found.some((f) => f.link === d.link)) found.push(d);
      }
    }
    if (found.length) o.filed = found;
  }
  return items;
}
