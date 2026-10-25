/**
 * The project doors, drawn into whatever pane holds them.
 *
 * They lived in priorities.js, the Projects tab. Alex, 2026-10-04: "lets
 * combine By Project and Project under to-do. so By Project needs a New
 * Project button, and then for each project a way to edit it." So By project
 * is the one place, and these are its doors: a new project, editing one (with
 * Archive beside Save), what leads the briefs, and what was archived. Each
 * takes the element to draw into and two callbacks — `onBack` when he leaves
 * without saving, `onSaved` when the file changed — and owns nothing else: the
 * page decides what a pane is and what to redraw.
 *
 * What these may write is unchanged: a project file through /api/projects,
 * /api/projects/update and /api/projects/archive, the order of what leads
 * through /api/priorities. The tag is never editable once a project exists —
 * obligations join on it. `focus:` and `**On track:**` are his; these forms are
 * his hand, which is why they may set them.
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error ?? 'refused');
  return d;
};

function frame(host, title, note, onBack) {
  host.textContent = '';
  const inner = el('div', 'pane-inner');
  const back = el('button', 'pane-back', '‹ back');
  back.type = 'button';
  back.onclick = onBack;
  const head = el('div', 'pane-head');
  head.append(el('h2', 'pane-title', title));
  if (note) head.append(el('div', 'ob-meta', note));
  inner.append(back, head);
  host.append(inner);
  return inner;
}

/** Every project with its own fields, archived ones too when asked. */
export async function projectsIndex(withArchived = false) {
  try {
    const r = await fetch('/api/projects' + (withArchived ? '?archived=1' : ''));
    return (await r.json()).projects ?? [];
  } catch { return []; }
}

/**
 * A new project, or editing one. Alex, 2026-09-16: "how do I manually add
 * projects?" — a file in projects/, in his hand; the AGENT proposes project
 * files and never creates one, and this door is him.
 */
export function projectForm(host, existing, { onBack, onSaved }) {
  const editing = !!existing;
  const inner = frame(host,
    editing ? `editing ${existing.title || existing.tag}` : 'a new project',
    editing
      ? 'The heading, the two sentences and the match rules. Everything else in the file — the status, '
        + 'the decision log — is left exactly as it is. The tag is not editable: obligations join on it.'
      : 'A file in projects/, in your hand. The tag is what tasks join to; '
        + 'the match rules are how new work files itself here without you tagging it. Both can be filled in later.',
    onBack);

  const form = el('form', 'pr-form pr-new');
  form.onsubmit = (e) => e.preventDefault();
  const status = el('span', 'mut pr-status');
  const field = (label, { hint = '', multiline = false } = {}) => {
    const w = el('label', 'pr-field');
    const inp = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) inp.type = 'text'; else inp.rows = 2;
    inp.placeholder = hint;
    w.append(el('span', 'pr-label', label), inp);
    return { w, inp };
  };
  const name = field('name', { hint: 'Hangar lease' });
  const tag = field('tag', { hint: 'one word — tasks join it as #tag' });
  const goal = field('goal — what done looks like', { hint: 'one sentence', multiline: true });
  const track = field('what on track looks like', { hint: 'optional; the line the briefs read', multiline: true });
  const people = field('match people', { hint: 'addresses, @a-whole-domain.com, phone numbers or names, comma separated' });
  const words = field('match words', { hint: 'words in a title that mean this project, comma separated' });
  if (editing) {
    name.inp.value = existing.title || '';
    goal.inp.value = existing.goal || '';
    track.inp.value = existing.onTrack || '';
    people.inp.value = (existing.people ?? []).join(', ');
    words.inp.value = (existing.words ?? []).join(', ');
    // Shown, never editable: it is the one field that would silently re-home work.
    tag.inp.value = existing.tag; tag.inp.disabled = true;
    tag.w.querySelector('.pr-label').textContent = 'tag — fixed, tasks join on it';
  }
  let touched = false;
  const slug = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  name.inp.oninput = () => { if (!touched && !editing) tag.inp.value = slug(name.inp.value); };
  tag.inp.oninput = () => { touched = true; };
  tag.inp.onblur = () => { tag.inp.value = slug(tag.inp.value); };

  const lead = el('label', 'pr-check');
  const box = document.createElement('input'); box.type = 'checkbox';
  lead.append(box, el('span', null, 'this leads the briefs'));

  const save = el('button', 'pane-act pr-save', editing ? 'save' : 'create');
  save.type = 'button';
  save.onclick = async () => {
    if (!name.inp.value.trim()) { status.textContent = ' it needs a name'; return; }
    save.disabled = true; status.textContent = editing ? ' saving…' : ' creating…';
    try {
      const body = { name: name.inp.value, goal: goal.inp.value, onTrack: track.inp.value,
                     people: people.inp.value, words: words.inp.value };
      const d = editing
        ? await post('/api/projects/update', { ...body, tag: existing.tag })
        : await post('/api/projects', { ...body, tag: tag.inp.value || null, focus: box.checked });
      status.textContent = editing
        ? (d.changed?.length ? ` saved: ${d.changed.join(', ')}` : ' nothing changed')
        : ` created ${d.file}`;
      await onSaved?.(editing ? existing.tag : d.tag);
    } catch (err) { status.textContent = (editing ? ' not saved: ' : ' not created: ') + (err?.message ?? err); save.disabled = false; }
  };

  form.append(name.w, tag.w, goal.w, track.w, people.w, words.w);
  // "This leads the briefs" is the ranking's question once the project
  // exists — editing one must never silently reorder what leads.
  if (!editing) form.append(lead);
  const acts = el('div', 'ob-actions');
  acts.append(save);
  if (editing) {
    const arch = el('button', 'pr-archive ghost', 'Archive');
    arch.type = 'button';
    arch.onclick = () => confirmArchive(existing, acts, { onDone: () => onSaved?.(null) });
    acts.append(arch);
  }
  inner.append(form, acts, status);
  name.inp.focus();
}

/**
 * Archiving asks first, and says what it does: `status: done` in the file —
 * not a deletion and not a move, so every link into it still resolves. It
 * stops grouping new work and stops leading the briefs; `archived` brings it
 * back. CLAUDE.md: never `rm` in projects/.
 */
export function confirmArchive(p, host, { onDone }) {
  const box = el('div', 'outcomebox');
  const q = el('span', 'mut', `Archive ${p.title || p.tag}? It stops leading the briefs and stops grouping new work. The file stays, and you can bring it back from archived.`);
  const go = el('button', null, 'Archive');
  const cancel = el('button', 'ghost', 'Cancel');
  const note = el('span', 'mut');
  host.style.display = 'none';
  cancel.onclick = () => { box.remove(); host.style.display = ''; };
  go.onclick = async () => {
    go.disabled = true; note.textContent = ' archiving…';
    try { await post('/api/projects/archive', { tag: p.tag }); await onDone?.(); }
    catch (err) { note.textContent = ' not archived: ' + (err?.message ?? err); go.disabled = false; }
  };
  box.append(q, go, cancel, note);
  host.parentNode.insertBefore(box, host);
}

/** What he has put away, and the way back. */
export async function archivedPane(host, { onBack, onSaved }) {
  const inner = frame(host, 'archived',
    'Put away, not deleted. The file is still in projects/ with its decision log; '
      + 'it groups no new work and leads no brief until you bring it back.', onBack);
  const rows = (await projectsIndex(true)).filter((x) => x.status === 'done');
  if (!rows.length) { inner.append(el('p', 'mut', 'Nothing archived.')); return; }
  for (const row of rows) {
    const r = el('div', 'ob');
    const box = el('div', 'ob-inner ob-row');
    const b = el('button', 'sec-action', 'bring back');
    b.type = 'button';
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'restoring…';
      try { await post('/api/projects/archive', { tag: row.tag, restore: true }); await onSaved?.(row.tag); archivedPane(host, { onBack, onSaved }); }
      catch (err) { b.textContent = 'could not: ' + (err?.message ?? err); }
    };
    box.append(el('div', 'ob-title', row.title || row.tag), el('div', 'ob-meta', `#${row.tag}`), b);
    r.append(box);
    inner.append(r);
  }
}

/**
 * What leads the briefs: the few projects he is for, in order, each with the
 * line on what on track looks like. Alex, 2026-09-05: "The editor here
 * needs to be form based." Nothing reaches a file until Save, and Save writes
 * two lines per project and nothing else.
 */
export async function rankEditor(host, { onBack, onSaved }) {
  const inner = frame(host, 'what leads the briefs',
    'Yours. Pick the few projects you are actually for, in order. '
      + 'A project not chosen still groups your work — it just never leads. Five or so; a list of twelve is a list with none.',
    onBack);
  let data;
  try { data = await (await fetch('/api/priorities')).json(); }
  catch (err) { inner.append(el('p', 'mut', 'could not read the projects: ' + (err?.message ?? err))); return; }
  const ranked = Array.isArray(data?.priorities) ? data.priorities : [];
  const byTag = new Map((data?.all ?? []).map((p) => [p.tag, p]));
  for (const p of ranked) if (p.tag && !byTag.has(p.tag)) byTag.set(p.tag, p);
  const chosen = ranked.filter((p) => p.tag).map((p) => ({ tag: p.tag, note: p.note ?? '' }));
  const rest = () => [...byTag.values()].filter((p) => !chosen.some((c) => c.tag === p.tag));

  const form = el('form', 'pr-form');
  form.onsubmit = (e) => e.preventDefault();
  const status = el('span', 'mut pr-status');
  const list = el('div', 'pr-cards');
  const others = el('div', 'pr-others');
  const save = el('button', 'pane-act pr-save', 'save');
  save.type = 'button';

  const card = (it, idx) => {
    const p = byTag.get(it.tag) ?? { title: it.tag };
    const c = el('div', 'pr-card');
    const t = el('div', 'pr-title', `${idx + 1}. ${p.title ?? it.tag} `);
    t.append(el('span', 'ob-tag', '#' + it.tag));
    const w = el('label', 'pr-field');
    const note = document.createElement('textarea'); note.rows = 2; note.value = it.note;
    note.placeholder = 'one or two lines — this is the sentence the briefs lead with';
    note.oninput = () => { it.note = note.value; };
    w.append(el('span', 'pr-label', 'what on track looks like'), note);
    const tools = el('div', 'pr-tools');
    const mk = (txt, title, on, disabled = false) => { const b = el('button', null, txt); b.type = 'button'; b.title = title; b.disabled = disabled; b.onclick = on; return b; };
    tools.append(
      mk('↑', 'move up', () => { [chosen[idx - 1], chosen[idx]] = [chosen[idx], chosen[idx - 1]]; draw(); }, idx === 0),
      mk('↓', 'move down', () => { [chosen[idx + 1], chosen[idx]] = [chosen[idx], chosen[idx + 1]]; draw(); }, idx === chosen.length - 1),
      mk('not a focus', 'stop leading the briefs — the project itself stays', () => { chosen.splice(idx, 1); draw(); }),
    );
    c.append(t, w, tools);
    return c;
  };
  const problems = () => (!chosen.length ? 'pick at least one — a brief has to lead with something'
    : chosen.length > 7 ? `${chosen.length} is more than seven` : null);
  function draw() {
    list.textContent = '';
    chosen.forEach((it, i) => list.append(card(it, i)));
    others.textContent = '';
    const left = rest();
    if (left.length) {
      others.append(el('div', 'pr-label', 'your other projects'));
      for (const p of left) {
        const b = el('button', 'pr-add', `+ ${p.title ?? p.tag}  #${p.tag}`);
        b.type = 'button';
        b.onclick = () => { chosen.push({ tag: p.tag, note: p.note ?? '' }); draw(); };
        others.append(b);
      }
    }
    const why = problems();
    save.disabled = !!why;
    status.textContent = why ? ' ' + why : '';
  }
  save.onclick = async () => {
    save.disabled = true; status.textContent = ' saving…';
    try {
      const d = await post('/api/priorities', { priorities: chosen.map(({ tag, note }) => ({ tag, note: String(note ?? '').trim() })) });
      status.textContent = ` saved — ${d.priorities} project${d.priorities === 1 ? '' : 's'} leading`;
      await onSaved?.(null);
    } catch (err) { status.textContent = ' could not save: ' + (err?.message ?? err); save.disabled = false; }
  };
  draw();
  form.append(list, others);
  inner.append(form, save, status);
}
