/**
 * rejudge: a conclusion that cannot correct itself goes back to the triage,
 * with the reason attached and nothing invented in its place.
 */
import { markForRejudge } from '../rejudge.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const state = () => ({ threads: [
  { thread_id: 'a1', account: 'personal', watermark: '2026-09-07 18:04', reviewed: '2026-09-07 18:45',
    conclusion: { tier: 'action', open: false, who: 'amyr@citycab.example', since: '2026-08-13 13:29', what: 'a follow-up went out at 18:04' } },
  { thread_id: 'b2', account: 'personal', watermark: '2026-09-01 10:00', conclusion: { tier: 'digest', open: false, who: 'x@y.com', since: '2026-08-30 09:00', what: 'receipt' } },
] });

console.log('markForRejudge');
{
  const s = state();
  const r = markForRejudge(s, ['a1'], { why: 'the drafts were read as sent', at: '2026-09-07 19:30' });
  const t = r.state.threads[0];
  check('the watermark goes back to before the judgement, so the differ sees a change', t.watermark === '2026-08-13 13:29' && r.touched[0].was === '2026-09-07 18:04');
  check('the reason rides on the conclusion for the next pass to read', t.conclusion.rejudge.why === 'the drafts were read as sent' && t.conclusion.rejudge.watermark_was === '2026-09-07 18:04');
  check('it reopens, and the old judgement is left in place rather than invented over', t.conclusion.open === true && t.conclusion.what === 'a follow-up went out at 18:04');
  check('threads not named are untouched', r.state.threads[1].watermark === '2026-09-01 10:00' && !r.state.threads[1].conclusion.rejudge);
  check('an id with no thread is reported, not silently dropped', markForRejudge(state(), ['zz'], { why: 'x' }).missing.join() === 'zz');
  let err = null; try { markForRejudge(state(), ['a1'], { why: '  ' }); } catch (e) { err = e; }
  check('a reason is required — the next pass has to know why it is looking again', /--why is required/.test(err?.message ?? ''));
  const to = markForRejudge(state(), ['a1'], { why: 'x', to: '2026-09-05 08:00' });
  check('an explicit --to wins over the conclusion\'s own start', to.state.threads[0].watermark === '2026-09-05 08:00');
}


/* NEVER A CLOSE HE MADE. Review 2026-09-20: markForRejudge set open = true
 * on whatever it was pointed at, including a conclusion Alex closed by
 * hand, while its own header said it never closes anything. A human close is
 * a decision; the repair tool for the agent's judgements does not reverse one. */
console.log('\nrejudge will not reopen his decision');
{
  const s = state();
  s.threads[0].conclusion = { ...s.threads[0].conclusion, open: false, closed_by: 'alex@rivera.example', closed_at: '2026-09-10 09:00' };
  const r = markForRejudge(s, ['a1'], { why: 'checking', at: '2026-09-20 10:00' });
  check('a conclusion he closed is refused, not reopened', r.refused.length === 1 && r.touched.length === 0 && s.threads[0].conclusion.open === false, JSON.stringify(r));
  check('  ...and named as refused rather than reported missing', r.refused[0].closed_by === 'alex@rivera.example' && !r.missing.length);
  const s2 = state();
  s2.threads[0].conclusion = { ...s2.threads[0].conclusion, open: false, closed_by: 'agent:mail-triage', closed_at: '2026-09-10 09:00' };
  const r2 = markForRejudge(s2, ['a1'], { why: 'checking', at: '2026-09-20 10:00' });
  check('an agent close is still reopened for another look', r2.touched.length === 1 && s2.threads[0].conclusion.open === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
