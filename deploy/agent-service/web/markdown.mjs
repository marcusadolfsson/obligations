/**
 * Markdown → HTML. One implementation, imported by both the browser (chat page,
 * as a module script) and node (the dashboard, server-rendered). Two copies of a
 * renderer drift, and the one that drifts is always the one you are not looking
 * at.
 *
 * Escaping happens FIRST and unconditionally. Model output, message text and
 * file contents all pass through here, and every one of them is untrusted input
 * to a renderer.
 */

export function esc(t) {
  return String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(t) {
  return t
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    // Only http(s) and same-page relatives become links. Anything else —
    // javascript:, data: — stays as plain text.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) =>
      /^(https?:\/\/|\/|#)/.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : m);
}

/**
 * @param offset  Push heading levels down. Embedded file content — a journal
 *                entry starting `# 2026-08-28`, a todo file starting `# Todo` —
 *                otherwise renders at the same level as the page's own section
 *                headings and impersonates page structure.
 */
/**
 * A newline inside a paragraph: a space, or a line break?
 *
 * Alex, 2026-09-09, reading a brief: "that line wrapping isn't nice." Every
 * `\n` became a `<br>`, so a paragraph broke wherever the writer's own wrap
 * fell — around 78 characters — no matter how wide the column was. The reading
 * measure did nothing, and a link whose text happened to straddle a wrap ("It
 * is on [the Morgan evening\nthread](…)") broke mid-phrase.
 *
 * Collapsing every newline is wrong too, and the corpus says so: the `failure`
 * messages are key/value blocks and indented commands, where the line breaks
 * are the whole meaning.
 *
 * So the test is positive — reflow only what is clearly wrapped prose. Every
 * line but the last has to be long enough to have been wrapped rather than
 * ended, and nothing may be indented, because an indented line in a paragraph
 * is a command someone is meant to type. Anything else keeps its breaks: a
 * paragraph that reflows when it should not is unreadable, while one that
 * keeps breaks it did not need is merely narrow.
 */
const WRAPPED_AT = 55;

/**
 * Judged on the SOURCE lines, before any markup expands them.
 *
 * The first attempt measured the rendered HTML, where a link's href lands on
 * whichever line held the opening bracket and pushes the rest of the phrase
 * onto a short one. The paragraph that prompted all this — "It is on [the Morgan
 * evening\nthread](/thread/…)" — came out as a 44-character line and was judged
 * hand-broken, which is the opposite of true. What the heuristic is about is
 * the author's own wrap, so it has to read the author's own lines.
 */
export function isWrappedProse(src) {
  const lines = String(src ?? '').split('\n');
  if (lines.length < 2) return false;
  return lines.slice(0, -1).every((l) => l.length >= WRAPPED_AT)
    && !lines.some((l) => /^\s\s/.test(l));
}

export function markdown(src, offset = 0) {
  const fences = [];
  const text = esc(src ?? '').replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, (_, code) => {
    fences.push(code);
    return ` FENCE${fences.length - 1} `;
  });

  return text.split(/\n{2,}/).map((block) => {
    const b = block.trim();
    if (!b) return '';

    const fence = b.match(/^ ?FENCE(\d+) ?$/);
    if (fence) return `<pre class=code><code>${fences[+fence[1]]}</code></pre>`;

    const h = b.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length + 1 + offset, 6);
      return `<h${n}>${inline(h[2])}</h${n}>`;
    }

    // `&gt;`, not `>`: escaping happens first and unconditionally, so by the
    // time a block reaches here its quote markers have already become entities.
    // Testing for a bare `>` matched nothing, and every blockquote ever written
    // fell through to the paragraph branch and rendered with its markers
    // showing — in the chat, the dashboard and the briefs alike.
    if (/^&gt;\s/.test(b)) {
      return `<blockquote>${inline(b.replace(/^&gt;\s?/gm, ''))}</blockquote>`;
    }

    /* Tables.
     *
     * Alex, 2026-09-04: "render that table properly in chat." A bid
     * comparison came back as raw pipes and dashes, which is the one place a
     * table matters most — five vendors against four columns is exactly the
     * shape prose cannot hold, and it is why the model reached for a table.
     *
     * A table block is a first line of cells and a second line of dashes.
     * Requiring the delimiter row is what stops a paragraph that merely
     * contains a pipe from being eaten as a one-column table.
     *
     * Escaping already ran over the whole source, so cells arrive as entities;
     * splitting on a literal `|` is safe because esc() never emits one. A
     * backslash-escaped pipe inside a cell is honoured, without lookbehind —
     * it is supported everywhere now, but a regex feature is not worth a blank
     * page on one browser.
     */
    const rows = b.split('\n');
    if (rows.length >= 2 && /^\s*\|/.test(rows[0]) && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(rows[1])) {
      const cells = (line) => {
        const out = [];
        let cur = '';
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '\\' && line[i + 1] === '|') { cur += '|'; i++; }
          else if (line[i] === '|') { out.push(cur); cur = ''; }
          else cur += line[i];
        }
        out.push(cur);
        // A leading and trailing pipe are conventional, and produce an empty
        // cell at each end that is punctuation rather than data.
        if (!out[0].trim()) out.shift();
        if (out.length && !out[out.length - 1].trim()) out.pop();
        return out.map((c) => c.trim());
      };

      const align = cells(rows[1]).map((d) => {
        const l = d.startsWith(':'), r = d.endsWith(':');
        return r && l ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      const at = (i) => (align[i] ? ` style="text-align:${align[i]}"` : '');

      const head = cells(rows[0]).map((c, i) => `<th${at(i)}>${inline(c)}</th>`).join('');
      const body = rows.slice(2).filter((r) => r.trim()).map((r) => {
        const cs = cells(r);
        // Short rows are padded rather than dropped: a ragged table is still
        // information, and a row that vanishes is worse than one with a gap.
        while (cs.length < align.length) cs.push('');
        return '<tr>' + cs.map((c, i) => `<td${at(i)}>${inline(c)}</td>`).join('') + '</tr>';
      }).join('');

      // The wrapper is what keeps a wide table from widening the page. Five
      // vendors will not fit a phone, and the body must scroll the table, not
      // the document.
      return `<div class=tablewrap><table><thead><tr>${head}</tr></thead>`
           + `<tbody>${body}</tbody></table></div>`;
    }

    // A wrapped list item is one item. Markdown continues a bullet on an
    // indented line, and treating every line as its own <li> fragmented the
    // journal into bullets that were half-sentences.
    const items = (text) => {
      const out = [];
      for (const line of text.split('\n')) {
        if (/^\s*[-*]\s|^\s*\d+[.)]\s/.test(line)) out.push(line.trim());
        else if (out.length) out[out.length - 1] += ' ' + line.trim();
      }
      return out;
    };

    // Task lists render as real checkboxes so a todo file looks like a todo
    // list rather than a wall of brackets.
    if (/^[-*]\s+\[[ xX]\]/.test(b)) {
      return '<ul class=tasks>' + items(b).map((li) => {
        const m = li.match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
        if (!m) return `<li>${inline(li.replace(/^[-*]\s+/, ''))}</li>`;
        const done = m[1].toLowerCase() === 'x';
        return `<li class="${done ? 'done' : ''}">` +
               `<span class=box>${done ? '&#10003;' : ''}</span>${inline(m[2])}</li>`;
      }).join('') + '</ul>';
    }

    if (/^[-*]\s/.test(b)) {
      return '<ul>' + items(b)
        .map((li) => `<li>${inline(li.replace(/^[-*]\s+/, ''))}</li>`).join('') + '</ul>';
    }
    if (/^\d+[.)]\s/.test(b)) {
      return '<ol>' + items(b)
        .map((li) => `<li>${inline(li.replace(/^\d+[.)]\s+/, ''))}</li>`).join('') + '</ol>';
    }
    // Join before `inline` runs, so a link whose text straddles a wrap is one
    // phrase by the time the link is matched.
    const body = isWrappedProse(b) ? b.replace(/\n/g, ' ') : b;
    return `<p>${inline(body).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}
