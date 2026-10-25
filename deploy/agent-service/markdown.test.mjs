/**
 * The shared markdown renderer.
 *
 * Written after a blockquote in a brief rendered with its `>` markers showing.
 * The cause is the thing that makes this renderer safe: it escapes first and
 * unconditionally, so by the time a block is classified its `>` has become
 * `&gt;` — and the blockquote test was looking for a bare `>`. It had therefore
 * never worked, anywhere, since the renderer was written.
 *
 * So the block tests below all run against text that has been escaped, because
 * that is the only state this code ever sees.
 */
import { markdown, esc } from './web/markdown.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

console.log('Escaping comes first');
check('angle brackets never reach the page raw',
      !markdown('<script>alert(1)</script>').includes('<script>'),
      markdown('<script>alert(1)</script>'));
check('an img tag in a quoted email is inert',
      !markdown('An email said <img src=x onerror=alert(1)>').includes('<img'),
      markdown('An email said <img src=x onerror=alert(1)>'));
check('ampersands survive readably', esc('Pinewood Engines') === 'Pinewood Engines');

console.log('\nBlocks');
{
  const q = markdown('> Please forgive the delay.\n> I will send Monday.');
  check('a blockquote renders as one', q.includes('<blockquote>'), q);
  check('  ...without its markers', !q.includes('&gt;'), q);
  check('  ...keeping both lines',
        q.includes('Please forgive the delay.') && q.includes('I will send Monday.'), q);
}
{
  const m = markdown('Body text.\n\n> quoted\n\nMore body.');
  check('a quote between paragraphs is still a quote',
        m.includes('<blockquote>') && (m.match(/<p>/g) || []).length === 2, m);
}
check('a heading is offset so it cannot impersonate the page',
      markdown('# Brief', 2).includes('<h4>'), markdown('# Brief', 2));
check('a bullet list', markdown('- one\n- two').includes('<li>one</li>'));
check('a wrapped bullet stays one item',
      (markdown('- one that wraps\n  onto a second line').match(/<li>/g) || []).length === 1,
      markdown('- one that wraps\n  onto a second line'));
check('a task list gets checkboxes', markdown('- [x] done').includes('&#10003;'));
check('a fenced block', markdown('```\ncode here\n```').includes('<pre class=code>'));

console.log('\nInline');
check('bold', markdown('**Tuesday**').includes('<strong>Tuesday</strong>'));
check('italic', markdown('do it *before* the visit').includes('<em>before</em>'));
check('code', markdown('run `deploy/login.sh`').includes('<code>deploy/login.sh</code>'));
{
  const link = markdown('[the portal](https://apps.coc1d9.example/iv)');
  check('an http link becomes a link', link.includes('href="https://apps.coc1d9.example/iv"'));
  check('  ...and opens safely', link.includes('rel="noopener noreferrer"'));
}
check('a javascript: link stays text',
      !markdown('[click](javascript:alert(1))').includes('<a '),
      markdown('[click](javascript:alert(1))'));
check('a data: link stays text', !markdown('[x](data:text/html,hi)').includes('<a '));

console.log('\nEdges');
check('empty is empty', markdown('') === '');
check('null does not throw', markdown(null) === '');
check('a lone paragraph', markdown('Just a line.') === '<p>Just a line.</p>');

console.log('\nTables');
{
  // The bid comparison that prompted this: five vendors, four columns, rendered
  // as raw pipes in the chat. Alex, 2026-09-04: "render that table properly."
  const t = markdown('| Vendor | Number |\n|---|---:|\n| MWC | $220,716.54 |');
  check('a table becomes a <table>', t.includes('<table>'), t);
  check('the header row is <th>', t.includes('<th>Vendor</th>'), t);
  check('the body row is <td>', t.includes('<td>MWC</td>'), t);
  check('the delimiter row is not a body row', !t.includes('---'), t);
  check('right alignment is honoured', t.includes('text-align:right'), t);
  // The wrapper is the whole reason a wide table does not widen the page.
  check('the table is wrapped so it can scroll', t.startsWith('<div class=tablewrap>'), t);

  // The guard against eating ordinary prose. Requiring the dashes row is what
  // separates a table from a sentence with a pipe in it.
  const p1 = markdown('cost | benefit was weighed');
  check('a paragraph with a pipe is still a paragraph', p1 === '<p>cost | benefit was weighed</p>', p1);
  const p2 = markdown('| not actually a table\njust two lines');
  check('a pipe line with no delimiter row is not a table', !p2.includes('<table>'), p2);

  // Inline markup has to survive inside cells, or a bolded vendor name comes
  // out with its asterisks showing.
  const t2 = markdown('| a | b |\n|---|---|\n| **bold** | `code` |');
  check('inline markup renders inside cells', t2.includes('<strong>bold</strong>'), t2);

  // A ragged row is still information; dropping it loses a vendor silently.
  const t3 = markdown('| a | b | c |\n|---|---|---|\n| one |');
  check('a short row is padded, not dropped', (t3.match(/<td/g) || []).length === 3, t3);

  const t4 = markdown('| a | b |\n|---|---|\n| x \\| y | z |');
  check('an escaped pipe stays inside its cell', t4.includes('x | y'), t4);
}

/* A newline inside a paragraph. Alex, 2026-09-09: "that line wrapping isn't
 * nice." Every `\n` became a `<br>`, so a brief broke at the writer's own wrap
 * however wide the column was, and the reading measure did nothing. */
console.log('\nsoft wrapping');
{
  const { isWrappedProse } = await import('./web/markdown.mjs');
  const prose = 'It was written into your drafts yesterday afternoon and it is not\n'
    + 'there now, and nothing has gone to Hank since the 5th, so it was\n'
    + 'discarded rather than sent.';
  check('wrapped prose reflows', !markdown(prose).includes('<br>'), markdown(prose));

  // The failure notes are the reason this is not a blanket collapse.
  const kv = 'mailbox: alex@rivera.example\ntopic:   projects/x/topics/gmail-push\narmed:   2026-09-02';
  check('a key/value block keeps its breaks', markdown(kv).includes('<br>'));
  const cmds = 'The service re-arms every 24h and at startup. If this persists:\n  systemctl restart obligations-agent\n  cat .log/gmail-watch.json';
  check('an indented command block keeps its breaks', markdown(cmds).includes('<br>'));
  check('  ...even though its first line is long', cmds.split('\n')[0].length > 55);

  // The paragraph that started it: the link text straddled the wrap.
  const split = 'tickets come with this week\'s push. It is on [the Morgan evening\n'
    + 'thread](/thread/personal/1a05edfcae0aba8e), waiting on your tap. Morgan\n'
    + 'speaks in nineteen days.';
  const out = markdown(split);
  check('a link split across a wrap becomes one anchor',
        /<a [^>]*>the Morgan evening thread<\/a>/.test(out), out.slice(0, 200));

  check('a single-line paragraph is untouched', isWrappedProse('one line') === false);
  check('the judgement reads the source, not the rendered html',
        isWrappedProse(split) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
