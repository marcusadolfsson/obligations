#!/usr/bin/env node
/**
 * Put a thread back in front of the triage, and say why.
 *
 * A conclusion can be wrong in a way that cannot correct itself: on
 * 2026-09-07 the triage read five Gmail drafts as sent mail and wrote "a
 * follow-up went out at 18:04" into four threads. Their watermarks moved with
 * it, so the differ sees them as unchanged and the triage will never look
 * again. Nothing decays back to the truth.
 *
 * This is the door for that. It rolls a thread's watermark back to what it was
 * before the bad judgement and stamps the conclusion with `rejudge`, so the
 * next mail run treats it as changed and reads the note. It never invents a
 * new conclusion and never closes anything — the triage still judges.
 *
 *   node deploy/rejudge.mjs <threadId>… --why "the reason" [--to "YYYY-MM-DD HH:MM"] [--dry]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { clearClosed } from './agent-service/obligation-state.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRepoLock } from './agent-service/lock.mjs';
import { localStamp } from './agent-service/time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = ['integrations', 'email-state.json'];

/** The state, with these threads marked for another look. Exported for the tests. */
export function markForRejudge(state, ids, { why, to = null, at = localStamp() }) {
  if (!why?.trim()) throw new Error('--why is required: the next pass reads it');
  const want = new Set(ids);
  const touched = [];
  const refused = [];
  for (const t of state.threads ?? []) {
    if (!want.has(t.thread_id) || !t.conclusion) continue;
    /* NEVER A CLOSE HE MADE. Review 2026-09-20: this set `open = true` on
       whatever it was pointed at, including a conclusion Alex closed by
       hand — while the header above says it "never closes anything", which
       is half the promise. Reopening what he settled is the other half. A
       human close is a decision, and a repair tool for the agent's own
       judgements has no business reversing one. */
    const by = t.conclusion.closed_by || '';
    if (t.conclusion.open === false && by && !by.startsWith('agent:')) {
      refused.push({ thread_id: t.thread_id, closed_by: by, closed_at: t.conclusion.closed_at ?? null });
      continue;
    }
    const was = t.watermark ?? null;
    // Back to before the judgement, so the differ sees the thread as changed.
    t.watermark = to ?? t.conclusion.since ?? was;
    t.conclusion.rejudge = { at, why: why.trim(), watermark_was: was };
    t.conclusion.open = true;
    touched.push({ thread_id: t.thread_id, who: t.conclusion.who ?? null, was, now: t.watermark });
  }
  return { state, touched, refused, missing: [...want].filter((id) => !touched.some((x) => x.thread_id === id) && !refused.some((x) => x.thread_id === id)) };
}

/**
 * A rolled-back thread the extract no longer holds needs carrying.
 *
 * Alex, 2026-09-09, on the Lakeside invoice: rolling the watermark back put the
 * note in the state file and nothing ever read it, because the differ can only
 * offer threads the extract still has and this one had been archived weeks
 * ago. The rollback was real, silent and useless.
 *
 * `gmail-escaped.json` is already the file for exactly this — threads the work
 * list must carry that the extract cannot supply, fetched by id when the job
 * gets to them. Its records say "left the extract before it was ever judged";
 * this one says why it is back, so the distinction survives.
 */
async function carryIfGone(vault, touched, state) {
  let extract = { threads: [] };
  try { extract = JSON.parse(await readFile(join(vault, 'integrations', 'gmail.json'), 'utf8')); } catch { return []; }
  const have = new Set((extract.threads ?? []).map((t) => t.thread_id));
  const gone = touched.filter((t) => !have.has(t.thread_id));
  if (!gone.length) return [];
  const path = join(vault, 'integrations', 'gmail-escaped.json');
  let escaped = {};
  try { escaped = JSON.parse(await readFile(path, 'utf8')); } catch {}
  const at = localStamp();
  // The account and the subject come from the state record, not from what
  // markForRejudge hands back — the job fetches a carried thread by account
  // AND id, so an entry with a null account is one it cannot open.
  const byId = new Map((state?.threads ?? []).map((t) => [t.thread_id, t]));
  for (const t of gone) {
    const rec = byId.get(t.thread_id) ?? {};
    const c = rec.conclusion ?? {};
    escaped[t.thread_id] = { thread_id: t.thread_id, account: rec.account ?? null,
                             subject: c.subject ?? rec.subject ?? null, watermark: t.now,
                             sender: t.who ?? c.who ?? null, noticed: at,
                             reason: 'rolled back for re-judging; no longer in the extract' };
  }
  await writeFile(path, JSON.stringify(escaped, null, 1) + '\n');
  return gone.map((t) => t.thread_id);
}

export async function rejudge(vault, ids, opts) {
  return withRepoLock(vault, async () => {
    const path = join(vault, ...STATE);
    const state = JSON.parse(await readFile(path, 'utf8'));
    const r = markForRejudge(state, ids, opts);
    let carried = [];
    const reopened = [];
    if (!opts.dry && r.touched.length) {
      await writeFile(path, JSON.stringify(r.state, null, 1) + '\n');
      carried = await carryIfGone(vault, r.touched, r.state);
      // A rolled-back conclusion is a reopen. Clear the obligation's own
      // record too, or the list keeps showing it closed whatever the
      // conclusion says — the record outranks the sources by design.
      const byId = new Map((r.state.threads ?? []).map((t) => [t.thread_id, t]));
      for (const t of r.touched) {
        const rec = byId.get(t.thread_id);
        const id = `mail:${rec?.account ?? 'gmail'}:${t.thread_id}`;
        const c = await clearClosed(vault, id, { by: 'rejudge', why: opts.why ?? 'rolled back for re-judging' });
        if (c.reopened) reopened.push(id);
      }
    }
    return { touched: r.touched, missing: r.missing, carried, reopened, dry: !!opts.dry };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
  const ids = argv.filter((a) => /^[0-9a-f]{8,20}$/.test(a));
  try {
    const r = await rejudge(OBLIGATIONS, ids, { why: flag('--why'), to: flag('--to'), dry: argv.includes('--dry') });
    for (const t of r.touched) console.log(`${r.dry ? 'would mark' : 'marked'}  ${t.thread_id}  ${t.who ?? ''}  watermark ${t.was} → ${t.now}`);
    for (const m of r.missing) console.log(`not found: ${m}`);
    // Say it, because a rollback on a thread the extract has dropped used to
    // look identical to one that would be picked up on the next tick.
    for (const id of r.carried ?? []) console.log(`  ${id} is no longer in the extract — carried on the escaped list so the job fetches it by id`);
    if (!r.touched.length) process.exit(1);
  } catch (err) { console.error(`rejudge: ${err.message}`); process.exit(1); }
}
