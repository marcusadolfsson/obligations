/**
 * Reading and marking the messages queue. Format: rules/messages.md.
 *
 * Parsing is deliberately narrow. The frontmatter contract is a handful of
 * one-line scalars written by three different producers (a python script, a
 * shell script, and an LLM job), so this reads exactly those keys and ignores
 * everything else rather than pulling in a YAML parser that would accept — and
 * silently reinterpret — far more than the contract allows.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const FIELDS = ['type', 'kind', 'at', 'title', 'read', 'delivered', 'revoked'];

function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (FIELDS.includes(key)) meta[key] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

export async function listMessages(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];               // no messages/ yet is not an error
  }
  const files = names.filter((n) => n.endsWith('.md')).sort().reverse();  // newest first

  const out = [];
  for (const name of files) {
    try {
      const { meta, body } = parse(await readFile(join(dir, name), 'utf8'));
      out.push({
        id: name,
        kind: meta.kind ?? 'note',
        at: meta.at ?? name.slice(0, 16),
        title: meta.title ?? name,
        read: meta.read === 'true',
        delivered: meta.delivered ?? 'none',
        revoked: meta.revoked || null,
        body: body.trim(),
      });
    } catch {
      // One unreadable file must not blank the whole list.
      out.push({ id: name, kind: 'note', at: '', title: name, read: true,
                 delivered: 'none', body: '(could not read this message)' });
    }
  }
  return out;
}

/**
 * Flip `read:` in place. This is the only field that mutates, and the rewrite
 * touches only that line — the body and every other field are left byte for
 * byte as the producer wrote them, because a message is a record of what the
 * system claimed and the reader has no business editing it.
 */
export async function markRead(dir, id, value = true) {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(id)) throw new Error('bad message id');
  const path = join(dir, id);
  if (!resolve(path).startsWith(resolve(dir) + sep)) throw new Error('outside messages/');

  const text = await readFile(path, 'utf8');
  const updated = text.replace(/^read:.*$/m, `read: ${value ? 'true' : 'false'}`);
  if (updated === text && !/^read:/m.test(text)) throw new Error('no read: field to set');
  await writeFile(path, updated);
  return true;
}

/**
 * Take back an urgent push whose task has since been dealt with.
 *
 * Alex, 2026-09-23: "Urgent briefs that are unread and the underlaying task
 * is resolved, revoke them." Rita asked at 15:42 whether she could clean at
 * 11:00 the next day; the push went at 19:10; he texted her himself at 19:16,
 * the task closed at 19:31 — and "Needs you now" sat unread on the Briefs
 * badge until he opened it an hour later to find nothing needed him.
 *
 * Only an UNREAD `urgent` message, only when the one task it links to is
 * closed, and only by a close made after the push — a close older than the
 * message is a task since reopened, and the push is about the live one. The
 * body stays as written (a message is a record of what the system claimed);
 * `read:` flips and one `revoked:` line says when and on what, so the page can
 * say it plainly and the badge stops counting it.
 *
 * `closed` is obligation-state's closed slice: id -> { at, by, outcome }.
 */
export async function revokeResolved(dir, closed = {}) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.md'))) {
    const path = join(dir, name);
    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    const { meta, body } = parse(text);
    if (meta.kind !== 'urgent' || meta.read !== 'false' || meta.revoked) continue;
    const m = body.match(/\/todo#pane=([^)\s]+)/);
    if (!m) continue;
    let id;
    try { id = decodeURIComponent(m[1]); } catch { continue; }
    const c = closed[id];
    if (!c?.at || String(c.at) < String(meta.at ?? '')) continue;
    const why = String(c.outcome ?? 'closed').replace(/\s+/g, ' ').trim().slice(0, 200);
    const line = `revoked: ${c.at} — ${why}`;
    const updated = text.replace(/^read:.*$/m, `read: true\n${line}`);
    if (updated === text) continue;
    await writeFile(path, updated);
    out.push({ id: name, task: id, at: c.at, why });
  }
  return out;
}

/**
 * Dismiss one. It leaves the list and moves to `archive/messages/` — it is not
 * unlinked.
 *
 * The repo's rule is that nothing gets deleted, it gets moved to `archive/`,
 * because git history is Alex's undo button. That applies here for a second
 * reason: a notification is the record of something the system claimed to have
 * told him. "The brief said the Mac was asleep" and "no brief was ever sent"
 * have to stay distinguishable afterwards, and a swipe on a phone is much too
 * cheap a gesture to destroy that with.
 */
export async function dismissMessage(dir, archiveDir, id) {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(id)) throw new Error('bad message id');
  const from = join(dir, id);
  if (!resolve(from).startsWith(resolve(dir) + sep)) throw new Error('outside messages/');

  await mkdir(archiveDir, { recursive: true });
  await rename(from, join(archiveDir, id));
  return { id, archived: true };
}
