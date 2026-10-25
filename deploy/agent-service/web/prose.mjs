/**
 * The assistant's own writing, set as writing.
 *
 * Alex, 2026-09-07, comparing with another product: "I like how their
 * briefings have more style." That got the briefs a lede, section eyebrows, a
 * jump bar and definition lists — and left the mail digest, which is the same
 * kind of thing by the same model, rendered as an undifferentiated wall of
 * serif. Alex, 2026-09-19: "can we style the mail digest better, more like
 * the brief?"
 *
 * So the renderer moved here and both pages call it. Not a copy each: the
 * digest drifting away from the briefs again is exactly what this file exists
 * to prevent, and the two are read minutes apart.
 */
import { el } from './ui.mjs';
import { markdown } from './markdown.mjs';

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * `Bills: AutoPay, Power Co…` — a run-in term, as the briefs set
 * `**Overdue:** …`.
 *
 * The digest groups a hundred receipts under half a dozen labels and writes
 * them plain, so the labels were the same weight as the list behind them and
 * the only way to find the money was to read all of it. Marked here rather
 * than asked of the model: a label the model forgot to bold would otherwise be
 * a paragraph that silently looks different from the five around it.
 *
 * Deliberately narrow. The label must be short, must carry no sentence
 * punctuation, and must open a paragraph long enough to be a list rather than
 * a sentence that merely begins with a colon.
 */
const LABEL = /^([A-Z][^:.!?]{2,26}):\s+/;
function runInLabels(host) {
  for (const para of host.querySelectorAll('p')) {
    if (para.firstElementChild?.tagName === 'STRONG') continue;   // already a term
    const first = para.firstChild;
    if (!first || first.nodeType !== 3) continue;                  // must start with text
    const m = LABEL.exec(first.textContent);
    if (!m || para.textContent.length < 60) continue;
    first.textContent = first.textContent.slice(m[0].length);
    const term = el('strong', 'prose-label', m[1]);
    para.insertBefore(term, first);
    para.classList.add('has-label');
  }
}

/**
 * `- **Term** — the rest` reads as a definition, so set it as one — but the
 * decision belongs to the LIST, not to each item.
 *
 * Alex, 2026-09-09: "the text still flows oddly." Per item, a list where
 * three bullets happened to open with a bold term and one did not was
 * rendered as three flush left-ruled blocks and one indented disc, with the
 * left edge and the text colour changing between them. A definition list is a
 * list where everything is a definition; anything else is a bulleted list and
 * should look like one.
 */
function definitionLists(host) {
  const isTerm = (li) => {
    const b = li.firstElementChild;
    return !!b && b.tagName === 'STRONG' && li.textContent.length > b.textContent.length + 3;
  };
  for (const ul of host.querySelectorAll('ul, ol')) {
    const items = [...ul.children].filter((n) => n.tagName === 'LI');
    if (items.length && items.every(isTerm)) for (const li of items) li.classList.add('term');
  }
}

/**
 * Undo the model's own line wrapping, inside prose blocks only.
 *
 * Alex, 2026-09-19: "the brief formatting is all wacky again." markdown.mjs
 * turns a single newline into `<br>`, which is right for a chat message typed
 * with deliberate breaks and wrong for a brief: when the model happens to hard
 * wrap a paragraph at 76 characters, every one of those wraps became a line
 * break on screen, so the text broke mid-sentence at the model's column rather
 * than at the reader's. Whether a brief renders as prose or as a ragged column
 * depended on a formatting choice nothing here controls.
 *
 * Standard markdown already says a line break needs two trailing spaces; this
 * applies that to the blocks that are prose and leaves every structural block
 * exactly as written — a list, a heading, a quote, a table or a fence keeps
 * its own lines, because there the newline is the structure.
 */
function reflow(text) {
  return String(text ?? '').split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.some((l) => /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```)/.test(l))) return block;
    return lines.map((l) => l.trim()).filter(Boolean).join(' ');
  }).join('\n\n');
}

/**
 * @param host    the element to fill
 * @param text    markdown, as the model wrote it
 * @param offset  heading level shift — the section heads must land on h4–h6,
 *                which is what `brief-sec` is found by. A brief writes `###`
 *                and a digest writes `##`, so they pass 2 and 3.
 * @param lede    whether the opening paragraph carries the accent rule. A
 *                brief opens with its lead sentence; a digest opens with a
 *                section head, so its first paragraph is already inside a
 *                section and a second marker there would be noise.
 */
export function renderProse(host, text, { offset = 2, lede = true, jumpFrom = 3 } = {}) {
  // The renderer treats a heading as a block, so it needs a blank line after
  // it; the model does not always leave one.
  // HTML comments are markers for the machine (the attached digest carries
  // one), never prose; the renderer escapes HTML, so they would show as text.
  const clean = String(text ?? '').replace(/<!--[\s\S]*?-->\n?/g, '');
  host.innerHTML = markdown(reflow(clean).replace(/^(#{1,4} .*)$/gm, '$1\n'), offset);

  const heads = [...host.querySelectorAll('h4, h5, h6')];
  if (lede) {
    const first = host.querySelector('p');
    // Only when it opens the piece: a paragraph that follows a section head is
    // that section's first line, not the document's lead.
    const beforeAnyHead = first && (!heads.length
      || (first.compareDocumentPosition(heads[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (first && beforeAnyHead && first.textContent.trim().length > 40) first.classList.add('lede');
  }

  const jumps = [];
  for (const h of heads) {
    const label = h.textContent.trim();
    if (!label) continue;
    h.classList.add('brief-sec');
    h.id = 'sec-' + slug(label);
    jumps.push({ id: h.id, label });
  }
  // A jump bar earns its place only on something long enough to scroll.
  if (jumps.length >= jumpFrom) {
    const bar = el('div', 'brief-jump');
    for (const j of jumps) {
      const a = el('a', 'chip brief-jump-chip', j.label.replace(/\s*[—-].*$/, ''));
      a.href = '#' + j.id;
      a.onclick = (e) => { e.preventDefault(); host.querySelector('#' + j.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
      bar.append(a);
    }
    host.insertBefore(bar, host.querySelector('.brief-sec'));
  }

  runInLabels(host);
  definitionLists(host);
}
