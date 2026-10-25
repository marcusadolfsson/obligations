/**
 * What his projects are, and which one a new thing belongs to.
 *
 * Alex, 2026-09-16: "can we add some more manual ways to create To Dos,
 * grouped by Tags/Projects. And then when data comes in we try to assign to
 * those tags/Projects as needed."
 *
 * Three things already used a tag and none of them could produce one. A tag
 * reached an obligation from exactly three places — the tag editor on /todo, a
 * `#project` he typed on a todo line, and the hardcoded `decision`/`birthday`
 * kinds — so the bulk of the list, every mail and message conclusion, could
 * never carry one. `priorities.mjs` joins on the tag and reported 174 of 177
 * open items attached to nothing, which read as a stale priorities file and was
 * really a missing mechanism. And `projects/*.md` had frontmatter with no tag
 * in it, so a project file and a priority tag were related only by whether one
 * happened to contain the other's name as a substring.
 *
 * So the project file is the registry. It already is the place a project is
 * described; it now also says what its tag is and what belongs to it:
 *
 *   tag: phoa
 *   match-people: community@phoa.example, @phoa.example, +15552000004
 *   match-words: PHOA, Industry Day, candidate evening
 *
 * `match-people` takes an address, a whole domain written `@example.org`, or a
 * phone number (matched on its last ten digits, like the address book).
 * `match-words` is matched whole-word and case-insensitively against the title.
 *
 * Both lists are HIS. Nothing here invents a rule: a project with no match
 * lines assigns nothing and simply groups what he has tagged by hand. That is
 * the lesson from the lint, whose first draft called his own home four rare
 * places by being clever — a missing tag is visible in the unassigned count,
 * while a wrong one quietly files a debt under the wrong project.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { matchKey } from './contacts.mjs';
import { withRepoLock } from './lock.mjs';

const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * A `**Label:** …` line from the body, joined and cleaned. It runs to the blank
 * line, because he writes these as a wrapped sentence rather than one long row,
 * and an HTML comment on the end is provenance rather than part of the sentence.
 */
function line(text, label) {
  const m = new RegExp(`^\\*\\*${label}:\\*\\*([\\s\\S]*?)(?:\\n\\s*\\n|$)`, 'm').exec(String(text ?? ''));
  if (!m) return null;
  const v = m[1].replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim();
  return v || null;
}

/** The frontmatter of one project file, as flat keys. */
function front(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text ?? '');
  const meta = {};
  if (!m) return meta;
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return meta;
}

/**
 * Every project, with its tag and its match rules. `_template.md` and anything
 * `status: done` are left out — a finished project should stop collecting.
 */
export async function readProjects(vault, { includeDone = false } = {}) {
  let names = [];
  try { names = (await readdir(join(vault, 'projects'))).filter((n) => n.endsWith('.md') && !n.startsWith('_')); }
  catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    let text;
    try { text = await readFile(join(vault, 'projects', n), 'utf8'); } catch { continue; }
    const meta = front(text);
    if (!includeDone && (meta.status ?? 'active').toLowerCase() === 'done') continue;
    const slug = n.slice(0, -3);
    // `focus: 1` — this is one of the few he is actually for, and the number is
    // where it sits in the briefs. Alex, 2026-09-16: "maybe combine
    // priorities and projects?" It was two files keyed by the same tag, and
    // every priority he had was a body of work with a project file or a missing
    // one. A project with no `focus:` still groups; it just never leads.
    const focus = Number.parseInt(meta.focus ?? '', 10);
    out.push({
      file: `projects/${n}`,
      slug,
      name: meta.name || slug,
      title: (text.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? (meta.name || slug),
      status: (meta.status ?? 'active').toLowerCase(),
      tag: (meta.tag ?? '').replace(/^#/, '').toLowerCase() || null,
      focus: Number.isFinite(focus) && focus > 0 ? focus : null,
      // What "on track" looks like, in his words — the sentence that used to sit
      // under the priority heading. Falls back to the goal, which is the same
      // kind of sentence written at the start rather than today.
      note: line(text, 'On track') ?? line(text, 'Goal') ?? '',
      // The two sentences apart, for the editor — `note` folds them together
      // for every reader that wants one line and cannot tell you which it got.
      goal: line(text, 'Goal') ?? '',
      onTrack: line(text, 'On track') ?? '',
      people: list(meta['match-people']),
      words: list(meta['match-words']),
      /* A SUB-PROJECT names its parent. Alex, 2026-09-30: "projects can also
         have sub projects, and those sub projects can have tasks." It is a
         project file like any other — its own tag, its own match rules, its
         own tasks — that also says whose it is. One level: a sub-project's
         parent is never itself a sub-project. */
      parent: (meta.parent ?? '').replace(/^#/, '').toLowerCase().trim() || null,
    });
  }
  return out;
}

/** Does this handle belong to that project's people list? */
function personHit(project, who) {
  const s = String(who ?? '').trim().toLowerCase();
  if (!s) return null;
  const addr = (s.match(/<([^>]+)>/) ?? [, s])[1];
  const key = matchKey(addr);
  for (const p of project.people) {
    const rule = p.toLowerCase();
    if (rule.startsWith('@')) {                       // a whole domain
      if (addr.endsWith(rule)) return p;
      continue;
    }
    if (addr === rule) return p;
    const rk = matchKey(rule);
    if (rk && key && rk === key) return p;            // a phone, on its last ten digits
    // A plain name. The triage writes `who` as a name far more often than as a
    // handle — "Hank Mercer", or "Hank Mercer and Ruth Ellis (PHOA)" —
    // and a project whose people list had to be addresses would miss most of
    // its own work. A name inside a group string still counts here: unlike
    // evidence of contact, filing something under a project it is plainly part
    // of costs nothing when the group is wider than the person.
    if (!rule.includes('@') && !rk && rule.length >= 4 && s.includes(rule)) return p;
  }
  return null;
}

// A word rule is matched whole, so "one" cannot match "money" and "#one" is
// still allowed to be a real project tag. Punctuation in the rule is escaped
// rather than rejected: "ONE 2201/2202" is how he writes it.
const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');

function wordHit(project, text) {
  const s = String(text ?? '');
  for (const w of project.words) if (w.length >= 3 && wordRe(w).test(s)) return w;
  return null;
}

/**
 * Which project this obligation belongs to, or null.
 *
 * Pure, and deliberately timid. Two rules, strongest first:
 *
 *   1. the person it is with is named in `match-people` — the near-certain one,
 *      because an address is not ambiguous;
 *   2. a word from `match-words` appears in the title.
 *
 * **Two projects matching at the same strength assigns nothing.** An item that
 * could be either is exactly the one a wrong guess buries, and an unassigned
 * item is already visible as unassigned. `why` is carried so the page can say
 * what the machine saw rather than showing a tag from nowhere.
 */
export function assignTag(o, projects) {
  const usable = (projects ?? []).filter((p) => p.tag);
  const hits = [];
  for (const p of usable) {
    const person = personHit(p, o?.who);
    if (person) { hits.push({ tag: p.tag, strength: 2, why: `${person} is on ${p.name}` }); continue; }
    const word = wordHit(p, `${o?.title ?? ''} ${o?.what ?? ''}`.slice(0, 400));
    if (word) hits.push({ tag: p.tag, strength: 1, why: `"${word}" names ${p.name}` });
  }
  if (!hits.length) return null;
  const best = Math.max(...hits.map((h) => h.strength));
  let top = [...new Set(hits.filter((h) => h.strength === best).map((h) => h.tag))];
  // A sub-project and its own parent both claiming one item is not a tie: the
  // narrower one is the answer (2026-09-30, sub-projects).
  const parentOf = new Map(usable.map((p) => [p.tag, p.parent ?? null]));
  top = top.filter((t) => !top.some((u) => parentOf.get(u) === t));
  if (top.length !== 1) return null;                  // ambiguous: say nothing
  return hits.find((h) => h.strength === best && h.tag === top[0]);
}

/** The few he is for, in his order. The rest of `projects/` groups but never leads. */
export async function focusProjects(vault) {
  return (await readProjects(vault)).filter((p) => p.focus).sort((a, b) => a.focus - b.focus);
}

/**
 * His edit, from the priorities page: which projects are the focus, in what
 * order, and the one line each that says what on track looks like.
 *
 * It writes two things and nothing else — the `focus:` key in the frontmatter
 * and the `**On track:**` line — because everything else in a project file is
 * either his prose or the compaction's, and a form that rewrote the file would
 * be a form that can lose a decision log. A project not named here loses its
 * `focus:` line, which is how a priority stops being one.
 */
export async function setFocus(vault, rows) {
  const want = new Map();
  (rows ?? []).forEach((r, i) => {
    const tag = String(r?.tag ?? '').trim().replace(/^#/, '').toLowerCase();
    if (tag) want.set(tag, { order: i + 1, note: String(r?.note ?? '').replace(/\s+/g, ' ').trim() });
  });
  if (want.size > 7) throw new Error('more than seven — a list of twelve priorities is a list with none');

  return withRepoLock(vault, async () => {
    const all = await readProjects(vault);
    const unknown = [...want.keys()].filter((t) => !all.some((p) => p.tag === t));
    if (unknown.length) throw new Error(`no project file carries #${unknown[0]} — make one in projects/ first`);
    const changed = [];
    for (const p of all) {
      const path = join(vault, p.file);
      let text = await readFile(path, 'utf8');
      const before = text;
      const w = want.get(p.tag);
      // frontmatter
      const has = /^focus:.*$/m.test(text.split('---')[1] ?? '');
      if (w && has) text = text.replace(/^focus:.*$/m, `focus: ${w.order}`);
      else if (w) text = text.replace(/^(tag:.*)$/m, `$1\nfocus: ${w.order}`);
      else if (has) text = text.replace(/^focus:.*\n/m, '');
      // The sentence. No `m` flag on these: `$` there means end of LINE, which
      // matched the moment the paragraph started and replaced nothing. A goal
      // that runs to the end of the file has no blank line after it, so the
      // alternation has to include the end of the string.
      if (w?.note) {
        if (/(^|\n)\*\*On track:\*\*/.test(text)) {
          text = text.replace(/(^|\n)\*\*On track:\*\*[\s\S]*?(?=\n\s*\n|$)/, `$1**On track:** ${w.note}`);
        } else if (/(^|\n)\*\*Goal:\*\*/.test(text)) {
          text = text.replace(/(^|\n)(\*\*Goal:\*\*[\s\S]*?)(?=\n\s*\n|$)/, `$1$2\n\n**On track:** ${w.note}`);
        } else {
          text = text.replace(/(^|\n)(# .*)(?=\n|$)/, `$1$2\n\n**On track:** ${w.note}\n`);
        }
      }
      if (text !== before) { await writeFile(path, text); changed.push(p.tag ?? p.slug); }
    }
    return { focus: [...want.keys()], changed };
  });
}

/** `Hangar lease` → `hangar-lease`, and the same rule for a tag. */
export const slugOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * A new project, from the page.
 *
 * Alex, 2026-09-16: "how do I manually add projects?" He could not, except by
 * writing the file — which is fine for him at a keyboard and impossible on a
 * phone, and the registry only works if starting a project is as cheap as
 * noticing one. CLAUDE.md's rule is unchanged: the *agent* proposes project
 * files and never creates them on its own. This is him creating one.
 *
 * It writes the file the template describes and nothing else. Two refusals
 * matter: a tag another project already carries (work would land in whichever
 * file is read last — the lint reports it, and this stops it happening), and a
 * file that already exists (renaming and merging projects is his, in the file).
 */
/**
 * Archive a priority, or bring one back.
 *
 * Alex, 2026-09-21: "how do I archive a priority?" The mechanism was already
 * here and unreachable — `readProjects` has always skipped `status: done`, so
 * archiving meant opening the file and typing it, which is the same "fine at a
 * keyboard, impossible on a phone" gap that produced the add form.
 *
 * `status: done`, not a deletion and not a move: the file stays where every
 * link into it points, the decision log it carries stays readable, and coming
 * back is one flag. CLAUDE.md's rule is the same one trips follow on
 * /reference — archived is a marker, never an `rm`.
 *
 * Archiving drops `focus:` with it. A project that no longer groups new work
 * cannot lead the briefs, and leaving the line behind would put a heading in
 * every brief that nothing can ever join.
 */
export async function archiveProject(vault, tag, { restore = false } = {}) {
  const t = String(tag ?? '').trim().replace(/^#/, '').toLowerCase();
  if (!t) throw new Error('which project?');
  return withRepoLock(vault, async () => {
    const all = await readProjects(vault, { includeDone: true });
    const p = all.find((x) => x.tag === t);
    if (!p) throw new Error(`no project carries #${t}`);
    const path = join(vault, p.file);
    let text = await readFile(path, 'utf8');
    const want = restore ? 'active' : 'done';
    if ((p.status ?? 'active') === want) return { tag: t, file: p.file, status: want, changed: false };
    text = /^status:.*$/m.test(text.split('---')[1] ?? '')
      ? text.replace(/^status:.*$/m, `status: ${want}`)
      : text.replace(/^(type:.*)$/m, `$1\nstatus: ${want}`);
    // An archived project never leads. Restoring does NOT put it back in the
    // order — that is his pick, on the editor, deliberately.
    if (!restore) text = text.replace(/^focus:.*\n/m, '');
    await writeFile(path, text);
    return { tag: t, file: p.file, status: want, changed: true, title: p.title };
  });
}

/**
 * Edit a project in place: the heading, the two sentences, the match rules.
 *
 * Alex, 2026-09-21: "you should be able to edit an existing priority." Until
 * now the only writer was `setFocus`, which touches two lines — the order and
 * **On track:** — so a typo in a name, or a match rule that turned out too
 * broad, meant editing the file by hand.
 *
 * **The tag is not editable here, on purpose.** Obligations join on it, and
 * nothing rewrites the ones already carrying the old one, so a rename would
 * silently orphan every task attached to the project. Retag by hand when you
 * mean it, with the obligations in front of you.
 *
 * Only the fields sent are touched; the status, the decision log and every
 * other section of the file are left exactly as they were.
 */
export async function updateProject(vault, tag, fields = {}) {
  const t = String(tag ?? '').trim().replace(/^#/, '').toLowerCase();
  if (!t) throw new Error('which project?');
  if (fields.tag && slugOf(fields.tag) !== t) {
    throw new Error('the tag is what obligations join to and cannot be changed here — retag by hand, with the work in front of you');
  }
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const clean = (xs) => (Array.isArray(xs) ? xs : String(xs ?? '').split(','))
    .map((x) => String(x).trim()).filter(Boolean).slice(0, 40);

  return withRepoLock(vault, async () => {
    const all = await readProjects(vault, { includeDone: true });
    const p = all.find((x) => x.tag === t);
    if (!p) throw new Error(`no project carries #${t}`);
    const path = join(vault, p.file);
    let text = await readFile(path, 'utf8');
    const was = text;
    const changed = [];

    if (fields.name != null) {
      const title = one(fields.name).slice(0, 80);
      if (!title) throw new Error('a project needs a name');
      if (/^#\s+.+$/m.test(text)) text = text.replace(/^#\s+.+$/m, `# ${title}`);
      else text = text.replace(/^---\n[\s\S]*?\n---\n/, (m) => `${m}\n# ${title}\n`);
      changed.push('name');
    }
    for (const [key, label] of [['people', 'match-people'], ['words', 'match-words']]) {
      if (fields[key] == null) continue;
      const line = `${label}: ${clean(fields[key]).join(', ')}`;
      text = new RegExp(`^${label}:.*$`, 'm').test(text.split('---')[1] ?? '')
        ? text.replace(new RegExp(`^${label}:.*$`, 'm'), line)
        : text.replace(/^(tag:.*)$/m, `$1\n${line}`);
      changed.push(label);
    }
    /* The two sentences. No `m` flag: `$` there is end of LINE and would match
       the moment the paragraph started, replacing nothing — the bug setFocus
       records above, and the same shape, so the same care. */
    for (const [key, label] of [['goal', 'Goal'], ['onTrack', 'On track']]) {
      if (fields[key] == null) continue;
      const v = one(fields[key]);
      const re = new RegExp(`(^|\n)\\*\\*${label}:\\*\\*[\\s\\S]*?(?=\n\\s*\n|$)`);
      if (re.test(text)) text = v ? text.replace(re, `$1**${label}:** ${v}`) : text.replace(re, '$1').replace(/\n{3,}/g, '\n\n');
      else if (v) text = text.replace(/^(#\s+.+)$/m, `$1\n\n**${label}:** ${v}`);
      if (v || re.test(was)) changed.push(label);
    }
    if (text === was) return { tag: t, file: p.file, changed: [] };
    await writeFile(path, text);
    return { tag: t, file: p.file, changed };
  });
}

export async function createProject(vault, { name, tag = null, goal = '', onTrack = '', people = [], words = [], focus = false, parent = null } = {}) {
  const title = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('a project needs a name');
  if (title.length > 80) throw new Error('that is a description, not a name');
  const slug = slugOf(title);
  if (!slug) throw new Error('a name needs a letter or a digit in it');
  const t = slugOf(tag ?? title);
  if (!t) throw new Error('a tag is letters, digits and dashes');

  const clean = (xs) => (Array.isArray(xs) ? xs : String(xs ?? '').split(','))
    .map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

  return withRepoLock(vault, async () => {
    const all = await readProjects(vault);
    const taken = all.find((p) => p.tag === t);
    if (taken) throw new Error(`#${t} is already ${taken.file} — one project per tag`);
    const up = parent ? all.find((p) => p.tag === String(parent).replace(/^#/, '').toLowerCase()) : null;
    if (parent && !up) throw new Error(`there is no active project #${parent} to put it under`);
    if (up?.parent) throw new Error(`#${up.tag} is itself a sub-project — sub-projects go one level deep`);
    const path = join(vault, 'projects', `${slug}.md`);
    // A project whose file exists but is `status: done` is not in `all`, so the
    // existence check is the filesystem's, not the list's.
    try { await readFile(path, 'utf8'); throw new Error(`projects/${slug}.md already exists`); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }

    const nextFocus = focus ? Math.max(0, ...all.map((p) => p.focus ?? 0)) + 1 : null;
    const body = [
      '---',
      'type: project',
      `name: ${slug}`,
      'status: active',
      `started: ${new Date().toISOString().slice(0, 10)}`,
      `tag: ${t}`,
      ...(up ? [`parent: ${up.tag}`] : []),
      ...(nextFocus ? [`focus: ${nextFocus}`] : []),
      `match-people: ${clean(people).join(', ')}`,
      `match-words: ${clean(words).join(', ')}`,
      '---',
      '',
      `# ${title}`,
      '',
      `**Goal:** ${one(goal) || 'what "done" looks like, in one sentence.'}`,
      '',
      ...(one(onTrack) ? [`**On track:** ${one(onTrack)}`, ''] : []),
      '## Status',
      '',
      'Where it actually stands right now.',
      '',
      '## Decisions',
      '',
      '<!-- Date — decision — why. This is the part you\'ll be glad you wrote. -->',
      '',
      '## Blockers',
      '',
      '## People',
      '',
    ].join('\n');
    await writeFile(path, body, { flag: 'wx' });
    return { file: `projects/${slug}.md`, slug, tag: t, title, focus: nextFocus, parent: up?.tag ?? null };
  });
}
