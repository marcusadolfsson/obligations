/**
 * The To Do list as circles.
 *
 * Alex, 2026-09-30: "It just feels a bit overwhelming. I love mind maps …
 * let's say that we have projects and they show up as different circles. The
 * circle gets bigger the more tasks you have inside a project. When you click
 * on the circle, it shows all the tasks associated with it." And: "an invoice
 * could be tagged with 'one' or just classified as an invoice. So, when I sit
 * down to pay bills, I'll have them all right there. But I also want to see
 * that when I'm working on the 'one' project."
 *
 * One circle per project tag and per kind tag, and one for everything no
 * project claims — drawn, not hidden: on the day this was built it held 148 of
 * 202, and a map that left it out would have been the list's problem with a
 * nicer face. Area is proportional to the count. A task in two circles is in
 * both, and a line between them says how many they share — the mind-map part.
 *
 * Layout is a greedy circle pack: biggest first at the centre, each next one
 * at the free spot touching the placed ones that is nearest the centre. A
 * dozen circles; no library.
 */
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text = null) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
};

/** Radii from counts: area ∝ count, with a floor so a one-task project can hold its name. */
export function radii(circles, { unit = 15, min = 34 } = {}) {
  return circles.map((c) => ({ ...c, r: Math.max(min, unit * Math.sqrt(Math.max(1, c.n))) }));
}

/** Greedy pack. Pure: [{r, …}] → the same with x, y. */
export function pack(circles, { gap = 10 } = {}) {
  const placed = [];
  const fits = (x, y, r) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + gap - 1e-6);
  for (const c of [...circles].sort((a, b) => b.r - a.r)) {
    if (!placed.length) { placed.push({ ...c, x: 0, y: 0 }); continue; }
    let best = null;
    for (const p of placed) {
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        const d = p.r + c.r + gap;
        const x = p.x + d * Math.cos(a), y = p.y + d * Math.sin(a) * 0.82;   // a little wider than tall
        if (!fits(x, y, c.r)) continue;
        const score = Math.hypot(x, y * 1.2);
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    placed.push({ ...c, x: best?.x ?? 0, y: best?.y ?? 0 });
  }
  return placed;
}

/**
 * Draw it. `circles`: [{ key, label, n, kind: 'project'|'kind'|'none', focus,
 * overdue }]; `links`: [{ a, b, n }] between keys.
 *
 * `positions` ({ key: {x, y} }) are where he dragged circles to — Alex,
 * 2026-09-30: "I want you to be able to drag the circles anywhere." A circle
 * with a saved spot sits there; the rest are packed as before. A tap opens
 * (`onPick`), a drag past a few pixels moves (`onMove(key, x, y)` on drop),
 * and a right-click on empty space asks for a new circle (`onAdd(x, y,
 * clientX, clientY)`) — "You can right click to add a new circle (project)".
 */
export function taskMap(host, circles, links, { onPick = () => {}, onMove = null, onAdd = null, onAddChild = null, onBlank = null, onDropTask = null, picked = null, positions = {} } = {}) {
  host.textContent = '';
  const laid = pack(radii(circles)).map((c) => (positions[c.key] ? { ...c, x: positions[c.key].x, y: positions[c.key].y } : c));
  if (!laid.length) { host.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing open.' })); return; }
  const pad = 14;
  const minX = Math.min(...laid.map((c) => c.x - c.r)) - pad, maxX = Math.max(...laid.map((c) => c.x + c.r)) + pad;
  const minY = Math.min(...laid.map((c) => c.y - c.r)) - pad, maxY = Math.max(...laid.map((c) => c.y + c.r)) + pad;
  /* Natural size, shrunk only to fit. A viewBox alone scales UP to the width
     of the page too, and the type with it — with three circles the labels
     grew past their edges on the first look. */
  const w = maxX - minX, h = maxY - minY;
  const root = svg('svg', { viewBox: `${minX} ${minY} ${w} ${h}`, width: Math.round(w), class: 'tmap', role: 'group', 'aria-label': 'Tasks by project' });
  const at = new Map(laid.map((c) => [c.key, c]));
  const toSvg = (cx, cy) => {
    const m = root.getScreenCTM();
    if (!m) return { x: cx, y: cy };
    const pt = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    return { x: pt.x, y: pt.y };
  };

  // Shared tasks first, so the circles sit on top of their lines.
  const drawn = [];
  for (const l of links) {
    const a = at.get(l.a), b = at.get(l.b);
    if (!a || !b) continue;
    // A sub-project hangs from its parent on a solid branch, with no count —
    // it is family, not overlap (2026-09-30).
    if (l.branch) {
      const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'tmap-branch' });
      root.append(line);
      drawn.push({ a: l.a, b: l.b, line });
      continue;
    }
    if (!l.n) continue;
    const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'tmap-link' });
    const dot = svg('circle', { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, r: 11, class: 'tmap-shared' });
    const num = svg('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 4, class: 'tmap-shared-n', 'text-anchor': 'middle' }, String(l.n));
    root.append(line, dot, num);
    drawn.push({ a: l.a, b: l.b, line, dot, num });
  }
  const relink = () => {
    for (const d of drawn) {
      const a = at.get(d.a), b = at.get(d.b);
      d.line.setAttribute('x1', a.x); d.line.setAttribute('y1', a.y); d.line.setAttribute('x2', b.x); d.line.setAttribute('y2', b.y);
      if (!d.dot) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      d.dot.setAttribute('cx', mx); d.dot.setAttribute('cy', my);
      d.num.setAttribute('x', mx); d.num.setAttribute('y', my + 4);
    }
  };

  for (const c of laid) {
    const g = svg('g', { class: `tmap-c tmap-${c.kind}${c.focus ? ' tmap-focus' : ''}${c.n ? '' : ' tmap-empty'}${c.key === picked ? ' tmap-picked' : ''}`, tabindex: 0, role: 'button',
      'aria-label': `${c.label}: ${c.n} task${c.n === 1 ? '' : 's'}${c.overdue ? `, ${c.overdue} overdue` : ''}` });
    const shape = svg('circle', { cx: 0, cy: 0, r: c.r });
    const big = c.r >= 48;
    const n = svg('text', { x: 0, y: big ? -4 : -1, class: 'tmap-n', 'text-anchor': 'middle' }, String(c.n));
    // As many characters as the circle is wide at the label's line.
    const fit = Math.max(4, Math.floor((c.r * 1.7) / 6.6));
    const label = c.label.length > fit ? c.label.slice(0, fit - 1).trimEnd() + '…' : c.label;
    const lab = svg('text', { x: 0, y: big ? 16 : 13, class: 'tmap-label', 'text-anchor': 'middle' }, label);
    g.append(shape, n, lab);
    if (c.overdue && big) g.append(svg('text', { x: 0, y: 32, class: 'tmap-over', 'text-anchor': 'middle' }, `${c.overdue} overdue`));
    g.setAttribute('transform', `translate(${c.x} ${c.y})`);

    /* Tap or drag. A press that moves less than a few pixels is a tap —
       fingers wobble — and anything further is a move, saved on release. */
    let start = null, moved = false;
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { px: e.clientX, py: e.clientY, x: c.x, y: c.y, p: toSvg(e.clientX, e.clientY) };
      moved = false;
      g.setPointerCapture?.(e.pointerId);
    });
    g.addEventListener('pointermove', (e) => {
      if (!start || !onMove) return;
      if (!moved && Math.hypot(e.clientX - start.px, e.clientY - start.py) < 5) return;
      moved = true;
      g.classList.add('tmap-dragging');
      const p = toSvg(e.clientX, e.clientY);
      c.x = start.x + (p.x - start.p.x); c.y = start.y + (p.y - start.p.y);
      g.setAttribute('transform', `translate(${c.x} ${c.y})`);
      relink();
    });
    const end = (e) => {
      if (!start) return;
      const wasMove = moved;
      start = null; moved = false;
      g.classList.remove('tmap-dragging');
      g.releasePointerCapture?.(e.pointerId);
      if (wasMove) onMove?.(c.key, c.x, c.y); else onPick(c.key);
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', () => { start = null; moved = false; g.classList.remove('tmap-dragging'); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(c.key); } });
    /* Right-click a top-level project: a sub-project of it. "projects can also
       have sub projects" (2026-09-30). One level, so not on a sub-project. */
    g.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      if (!onAddChild || c.kind !== 'project') return;
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      onAddChild(c.key, p.x + c.r * 0.6, p.y + c.r * 0.6, e.clientX, e.clientY);
    });
    // A task dropped from the list: "drag a task from the list and onto a
    // circle to assign/re-assign" (2026-09-30).
    if (onDropTask) {
      g.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; g.classList.add('tmap-drop'); });
      g.addEventListener('dragleave', () => g.classList.remove('tmap-drop'));
      g.addEventListener('drop', (e) => {
        e.preventDefault(); g.classList.remove('tmap-drop');
        const id = e.dataTransfer.getData('text/plain');
        if (id) onDropTask(c.key, id);
      });
    }
    root.append(g);
  }

  // A click on empty space lets go of the picked circle.
  if (onBlank) root.addEventListener('click', (e) => { if (e.target === root) onBlank(); });
  if (onAdd) {
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      onAdd(p.x, p.y, e.clientX, e.clientY);
    });
  }
  host.append(root);
}
