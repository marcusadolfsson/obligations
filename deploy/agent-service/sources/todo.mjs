/**
 * `todo.md` as a source of tasks.
 *
 * Until now there were two task lists that did not know about each other: the
 * obligations the message triage derived, and the things Alex typed into
 * `todo.md` by hand. The second was rendered as a page of markdown and nothing
 * read it, so writing a task down was the same as filing it away.
 *
 * The syntax is the one already documented at the top of `todo.md` — `@person`,
 * `!due:YYYY-MM-DD`, `#project` — with two additions in the same shape:
 *
 *   !waiting        this is something he is waiting on, not something he owes
 *   !high !low      priority; otherwise it comes from the section
 *   !since:DATE     when it started; stamped by the dispatcher if absent
 *   !closes:TEXT    what discharge looks like; must come last on the line
 *
 * Nothing else about the file changes. It stays a file he edits by hand, and
 * this only ever reads it or flips one `[ ]` to `[x]`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseStamp } from '../time.mjs';

export const SOURCE = 'todo';

const ITEM = /^\s*[-*]\s+\[( |x|X)\]\s*(.+?)\s*$/;

// Where a task sits says how urgent it is without needing a tag on every line.
const SECTION_PRIORITY = { now: 'high', next: 'normal', someday: 'low' };

/**
 * Stable id for a task. Derived from the prose with the tags stripped, so it
 * survives the file being reordered, the dispatcher stamping `!since:` on it,
 * and Alex changing its priority. An id that changed when a date was added
 * would make the close button fail on any page opened before the stamp.
 */
export function todoId(text) {
  return 'todo:' + createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** Pull the documented tags out of one line, leaving the prose behind. */
function parseTags(raw) {
  let text = raw;
  const take = (re) => {
    const m = re.exec(text);
    if (!m) return null;
    text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim();
    return m;
  };

  const waiting = !!take(/\s*!waiting\b/i);
  const pri = take(/\s*!(high|low|normal)\b/i);
  const due = take(/\s*!due:(\d{4}-\d{2}-\d{2})\b/);
  const since = take(/\s*!since:(\d{4}-\d{2}-\d{2})\b/);
  // `(^|\s)` and not `\s*`: an assignee is a word starting with @, and an email
  // address is not one. `\s*` matched zero spaces, so a line mentioning
  // gmail-api-push@system.gserviceaccount.com had "system.gserviceaccount.com"
  // lifted out as the person who owed it AND cut out of the text, leaving a
  // task that named a different address than the one written.
  const who = take(/(?:^|\s)@([^\s@#!]+)/);
  const project = take(/(?:^|\s)#([^\s@#!]+)/);
  // Last, and greedy to end of line: what "done" looks like is a sentence, and
  // every other tag has already been lifted out of the text.
  const closes = take(/\s*!closes:(.+)$/i);

  return {
    text,
    waiting,
    priority: pri ? pri[1].toLowerCase() : null,
    due: due ? due[1] : null,
    since: since ? since[1] : null,
    closes: closes ? closes[1].trim() : null,
    who: who ? who[1] : null,
    project: project ? project[1] : null,
  };
}

/**
 * Every unchecked task in `todo.md`. `## Done` is skipped, and so is a ticked
 * box: unlike a triage conclusion — which the diff needs to keep seeing so it
 * does not rediscover the same thread tomorrow — a completed line here carries
 * no information the layer above can use.
 */
export async function read(vault) {
  let raw;
  try {
    raw = await readFile(join(vault, 'todo.md'), 'utf8');
  } catch {
    return [];
  }

  const now = Date.now();
  const out = [];
  let section = '';

  for (const line of raw.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    if (section === 'done') continue;

    const m = ITEM.exec(line);
    if (!m || m[1] !== ' ') continue;                 // checked ones are done

    const body = m[2].trim();
    // The untouched template is a section of empty brackets. Rendering those
    // as tasks produces a list of blank cards that looks like data.
    if (!body) continue;

    const t = parseTags(body);
    if (!t.text) continue;

    // A due date in the past outranks anything the section says.
    const overdue = t.due && parseStamp(t.due + ' 23:59') < now;
    out.push({
      ref: todoId(t.text),
      who: t.who,
      what: t.text,
      since: t.since,
      // The day the line was written (addTask stamps it). A line he adds AFTER
      // a close is a new decision and reopens it; the same line left in the
      // file is not. See obligation-state.mjs.
      at: t.since ?? null,
      due: t.due,
      priority: t.priority || (overdue ? 'high' : SECTION_PRIORITY[section] ?? 'normal'),
      owed_by: t.waiting ? 'them' : 'me',
      open: true,
      closes: t.closes,
      // Top level as well as in `detail`: the merge reads `m.project` to turn a
      // line's #project into a tag, and reading it only from `detail` meant no
      // todo tag ever reached the tasks page.
      project: t.project,
      detail: { section, project: t.project },
    });
  }
  return out;
}

/**
 * Write a new task into `todo.md`.
 *
 * Alex, 2026-09-16: "can we add some more manual ways to create To Dos."
 * There was no create path anywhere — no route, no CLI, no function. Every
 * writer here mutated a line that already existed, so the only way to add a
 * task was to open the file, or to tell the chat and have a model edit it with
 * ordinary file tools: prose in, no structure, and a `#project` only if it
 * remembered one.
 *
 * This writes the same line he would have typed, in the file's own grammar, and
 * nothing else about the file changes. The section decides the priority the way
 * it always has (Now high, Next normal, Someday low), so `section` is the only
 * priority argument; `!since:` is stamped here rather than waiting for the
 * dispatcher's next minute, so the task does not appear undated on the page he
 * just added it from.
 *
 * No provenance note: the lines the assistant adds carry "(added by the
 * assistant …)" because it is not his handwriting, and this door is. It
 * refuses a task with no words. It does not commit: `todo.md` is tracked and
 * the jobs commit the tree.
 */
export async function addTask(vault, { text, tag = null, due = null, who = null, waiting = false, closes = null, section = 'Now' } = {}) {
  const prose = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!prose) throw new Error('a task needs words');
  if (prose.length > 500) throw new Error('that is a paragraph, not a task line');
  const d = due ? String(due).slice(0, 10) : null;
  if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))) throw new Error('due must be YYYY-MM-DD');
  const want = String(section || 'Now').trim();
  if (!['Now', 'Next', 'Someday'].includes(want)) throw new Error('section must be Now, Next or Someday');

  // The prose may already carry its own tags — he types the same line here as
  // in the file — so anything passed as a field is only added when the words do
  // not already say it. Two `#project` tags on one line is a line that parses
  // to the wrong one.
  const has = parseTags(prose);
  const bits = [prose];
  const t = String(tag ?? '').trim().replace(/^#+/, '').toLowerCase();
  if (t && !has.project) bits.push(`#${t.replace(/[^a-z0-9-]/g, '')}`);
  const w = String(who ?? '').trim().replace(/^@+/, '');
  if (w && !has.who) bits.push(`@${w.replace(/\s+/g, '-')}`);
  if (waiting && !has.waiting) bits.push('!waiting');
  if (d && !has.due) bits.push(`!due:${d}`);
  if (!has.since) bits.push(`!since:${localDay()}`);
  // Last, because it is greedy to the end of the line.
  if (closes && !has.closes) bits.push(`!closes:${String(closes).replace(/\s+/g, ' ').trim()}`);
  const line = `- [ ] ${bits.join(' ')}`;

  const path = join(vault, 'todo.md');
  const raw = await readFile(path, 'utf8').catch(() => '# Todo\n\n## Now\n\n');
  const lines = raw.split('\n');
  let at = lines.findIndex((l) => new RegExp(`^##\\s+${want}\\s*$`, 'i').test(l));
  if (at < 0) {
    // No such section: make it at the end rather than dropping the task into
    // whichever one happens to be last.
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', `## ${want}`, '');
    at = lines.length - 2;
  }
  // Under the heading, above what is already there: newest first matches how
  // the page reads and keeps a long Now list from hiding the thing just added.
  let i = at + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  lines.splice(i, 0, line, '');
  await writeFile(path, lines.join('\n'));
  const parsed = parseTags(line.replace(/^-\s+\[ \]\s*/, ''));
  // `ref` is already self-prefixed (`todo:…`), which is what the merge uses as
  // the obligation id for this source, so the page can jump straight to it.
  const ref = todoId(parsed.text);
  return { ref, id: ref, line, section: want, tag: parsed.project ?? null };
}

/** Today, local — the same shape every stamp in this repo has. */
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Tick one off: `- [ ]` becomes `- [x]`, in place.
 *
 * In place rather than moved to `## Done`, because the weekly sweep is what
 * moves them and it does that with the journal in front of it. Nothing else
 * about the line changes — it is a line Alex wrote.
 */
/**
 * Move or set a line's `!due:`. Alex, 2026-09-06, the task action center:
 * "change due date if there is one." The id is a hash of the prose with the
 * tags taken out, so the line keeps its id.
 */
export async function setDue(vault, ref, due) {
  const d = String(due ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new Error('due must be YYYY-MM-DD');
  const path = join(vault, 'todo.md');
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');
  const i = lines.findIndex((line) => {
    const m = ITEM.exec(line);
    if (!m || m[1] !== ' ' || !m[2].trim()) return false;
    return todoId(parseTags(m[2].trim()).text) === ref;
  });
  if (i < 0) throw new Error('no open todo line with that id');
  const was = (lines[i].match(/!due:(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null;
  lines[i] = /!due:\d{4}-\d{2}-\d{2}/.test(lines[i]) ? lines[i].replace(/!due:\d{4}-\d{2}-\d{2}/, `!due:${d}`) : lines[i].replace(/\s*$/, ` !due:${d}`);
  await writeFile(path, lines.join('\n'));
  return { ref, was, due: d };
}

export async function close(vault, ref) {
  const path = join(vault, 'todo.md');
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');

  const i = lines.findIndex((line) => {
    const m = ITEM.exec(line);
    if (!m || m[1] !== ' ' || !m[2].trim()) return false;
    return todoId(parseTags(m[2].trim()).text) === ref;
  });
  // Idempotent: a task already ticked is a task that is done.
  if (i < 0) return { ref, alreadyClosed: true };

  lines[i] = lines[i].replace(/\[ \]/, '[x]');
  await writeFile(path, lines.join('\n'));
  return { ref, closed: true };
}
