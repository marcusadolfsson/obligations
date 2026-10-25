/** context-size.mjs — where a run's context came from, in bytes, never content. */
import { toolResultBytes, summarise, tally } from './context-size.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

console.log('sizing a tool result, in every shape the SDK sends one');
{
  check('a plain string', toolResultBytes('hello') === 5);
  check('an array of text blocks', toolResultBytes([{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }]) === 5);
  check('bare strings in an array', toolResultBytes(['ab', 'c']) === 3);
  check('multi-byte characters count as bytes, not characters', toolResultBytes('é€') === 5, String(toolResultBytes('é€')));
  check('an image is its payload, not nothing', toolResultBytes([{ type: 'image', source: { data: 'AAAA' } }]) === 4);
  check('nothing is zero, not a crash', toolResultBytes(null) === 0 && toolResultBytes(undefined) === 0);
  /* A tool whose result cannot be sized is exactly the one that would hide a
     large read, so an unexpected shape gets measured rather than skipped. */
  check('an unexpected shape is still measured', toolResultBytes({ error: 'refused' }) > 0);
  check('  ...and a circular one does not throw', (() => { const o = {}; o.self = o; return toolResultBytes(o) === 0; })());
}

console.log('\nthe per-tool tally');
{
  const t = tally();
  t.use('t1', 'Read'); t.result('t1', 'x'.repeat(1000));
  t.use('t2', 'Read'); t.result('t2', 'x'.repeat(500));
  t.use('t3', 'Bash'); t.result('t3', 'x'.repeat(10));
  const d = t.done();
  check('bytes are summed across the run', d.tool_bytes === 1510, String(d.tool_bytes));
  check('  and grouped by tool, with call counts', d.by_tool.Read.calls === 2 && d.by_tool.Read.bytes === 1500 && d.by_tool.Bash.calls === 1, JSON.stringify(d.by_tool));
  const u = tally();
  u.result('never-seen', 'abc');
  check('a result with no matching call is charged to `unknown`, not dropped', u.done().by_tool.unknown?.bytes === 3, JSON.stringify(u.done()));
  const e = tally();
  check('a run that called nothing reports zero, not null', e.done().tool_bytes === 0 && Object.keys(e.done().by_tool).length === 0);
}

console.log('\nthe log line: biggest first, the rest counted not dropped');
{
  const m = new Map();
  for (let i = 0; i < 9; i++) m.set(`tool${i}`, { calls: 1, bytes: (i + 1) * 100 });
  const s = summarise(m, { top: 3 });
  check('the biggest few by bytes', Object.keys(s).slice(0, 3).join(',') === 'tool8,tool7,tool6', Object.keys(s).join(','));
  check('  everything else is summed under `other`', s.other.tools === 6 && s.other.calls === 6 && s.other.bytes === 100 + 200 + 300 + 400 + 500 + 600, JSON.stringify(s.other));
  check('  and a short list has no `other` at all', !('other' in summarise(new Map([['a', { calls: 1, bytes: 1 }]]))));
}

console.log('\nnothing here holds content');
{
  const t = tally();
  const secret = 'a-login-code-847221-from-a-strangers-mail';
  t.use('t1', 'mcp__personal__get_thread');
  t.result('t1', secret);
  const line = JSON.stringify(t.done());
  check('a tool result never reaches the log, only its size', !line.includes('847221') && !line.includes(secret) && /"bytes":41/.test(line), line);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
