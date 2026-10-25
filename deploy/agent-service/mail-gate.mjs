/**
 * Should the mail job run right now?
 *
 * Its own module, and not a helper inside server.mjs, because server.mjs cannot
 * be imported without the Agent SDK — and a decision this consequential (it
 * fires an unattended agent that archives Alex's mail) has to be testable
 * without standing up the thing it fires.
 *
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The mail job is fired by WORK, not by the clock.
 *
 * Alex wanted mail judged hourly rather than twice a day, so the brief can
 * stop reading mail itself. A plain hourly slot would have run the agent
 * twenty-four times to discover twenty-three times that nothing arrived, and
 * that is not free: CLAUDE.md, rules/email-triage.md and the skill are ~64KB of
 * instruction the model reads before it sees a single message, plus the work
 * list itself. An empty run still pays all of it, and on a monthly plan that is
 * budget the interactive session does not get.
 *
 * So the gate is deterministic and costs nothing. The host dispatcher already
 * re-extracts and re-diffs the mailbox on the minute tick (refresh_email in
 * reminder-dispatch.py); this only reads the answer it left behind.
 *
 *   never more often than MIN_GAP     — a burst of mail is one run, not twenty
 *   fire at once on BATCH_AT threads  — the normal case
 *   or on one that has waited MAX_WAIT — so a single stray mail is not stranded
 *
 * ## Draining is not the same job as keeping up
 *
 * An hour between runs is right when mail arrives a few threads at a time: it
 * batches arrivals instead of spending a whole run's fixed cost on two
 * newsletters. It is wrong when there is already a queue, and measurably so —
 * runs took 18-20 minutes and then sat idle for 60 more, so three quarters of
 * every cycle was spent waiting for permission to continue on work already in
 * hand.
 *
 * So the gap depends on whether anything is left over. `not_shown` in the work
 * list is exactly that: threads that are queued and did not fit in this run's
 * batch. More than zero means another run is already owed, and making it wait
 * an hour is the thing that was wasting three quarters of the cycle.
 *
 * Deliberately NOT a threshold on `waiting`. That was the first version and it
 * was dead code within the hour: `waiting` is the work list length, which is
 * capped at MAX_JUDGEMENT, so a threshold of 100 could never be reached once
 * the batch went back to 80. A gate whose fast path depends on a constant in
 * another file being large enough is not a gate.
 *
 * Measured from the END of the last run, so a cycle is the run plus the gap:
 * ~35 minutes while draining, ~80 while keeping up.
 *
 * `noticed` in the work list is rewritten on every diff, so it cannot say how
 * long a thread has waited. Time since the last run is the honest proxy: it
 * bounds how long anything can sit regardless of how it got there.
 */
export const MAIL = {
  // Alex, 2026-09-07: "sonnet for mail and messages every 30 min." The gap
  // halved because the floor did — a run is ~$0.36 on Sonnet against ~$1.78 on
  // Opus, so waiting three hours to amortise it no longer buys anything. A
  // lone thread now waits at most an hour.
  MIN_GAP_MIN: 30,
  DRAIN_GAP_MIN: 15,
  BATCH_AT: 3,
  MAX_WAIT_MIN: 60,
};
/** A work list older than this means the pipeline is down, not that mail is quiet. */
const MAIL_LIST_MAX_AGE_MIN = 60;

/**
 * Is there enough mail waiting to be worth an agent turn?
 *
 * Reads only what the deterministic pipeline already wrote. Every "no" is a
 * reason, returned rather than logged, so the caller can say why nothing ran —
 * "the extract is stale" and "there is no mail" are opposite facts and must
 * never look the same from outside.
 */
export async function mailDue(vault, now, runs) {
  const listPath = join(vault, 'integrations', 'gmail-changed.json');
  let list, writtenAt;
  try {
    list = JSON.parse(await readFile(listPath, 'utf8'));
    writtenAt = (await stat(listPath)).mtimeMs;
  } catch {
    return { due: false, why: 'no work list — the mail pipeline has not run' };
  }

  // Age from the file's mtime, NOT from the `extract_generated_at` stamp inside
  // it. That stamp is local wall-clock text with no offset, so reading it means
  // guessing the writer's timezone from the reader's: the differ runs in a
  // container, this runs in the service, and the two agreeing is a deployment
  // detail rather than a property. Read with TZ unset it was out by four hours,
  // which happened to fail safe -- the other direction would have called a dead
  // pipeline fresh. mtime is absolute and cannot be wrong.
  const listAge = (now.getTime() - writtenAt) / 60000;

  // Stamps written and read by this same process are self-consistent, so the
  // last-run gap can use one.
  const minutesSince = (stamp) => {
    const t = Date.parse(String(stamp ?? '').replace(' ', 'T'));
    return Number.isNaN(t) ? Infinity : (now.getTime() - t) / 60000;
  };

  if (listAge > MAIL_LIST_MAX_AGE_MIN) {
    // Refusing here rather than running on it: jobs/mail.md would stop anyway,
    // and a stale list judged as current archives mail on a mailbox that moved.
    return { due: false, stale: true,
             why: `work list is ${Math.round(listAge)}m old — the extract is not refreshing` };
  }

  const waiting = (list.needs_judgement ?? []).length;

  // Archiving is work the gate could not previously see. A thread judged
  // "digest" whose archive call never happened, or one closed on /tasks with
  // `archive_pending`, has a conclusion and is therefore never `new`, never
  // `stale`, and never aged out — so needs_judgement stays empty and the job
  // never fires again. 18 threads sat in the inbox that way, filed as far as
  // the assistant was concerned and still there as far as Alex was.
  const toArchive = (list.needs_archive ?? []).length;

  if (!waiting && !toArchive) return { due: false, why: 'nothing waiting' };
  if (!waiting) {
    // A sweep that archived nothing will archive nothing again. The work MCP
    // server was disabled in settings.local.json, so three consecutive runs
    // spent roughly $12 between them concluding the same thing and re-arming
    // themselves, because the gate only asked "is there work" and never "did
    // the last attempt move it".
    //
    // Refusing is the right failure: nothing is lost, the threads keep their
    // conclusions and stay visible in the inbox, and the reason says what to
    // look at. A loop that burns money to reach an unchanged answer is worse
    // than a stop that explains itself.
    if (runs.mail?.archive_left != null && runs.mail.archive_left <= toArchive
        && runs.mail?.archive_only) {
      return { due: false, toArchive, stuck: true,
               why: `last sweep left ${toArchive} unarchived and made no progress `
                  + '— not retrying until something changes' };
    }

    // Otherwise archiving is cheap and has no reason to wait for a batch, the
    // judging being done already. It still respects the gap, so a burst of
    // closes on /tasks is one sweep rather than one run each.
    const gap0 = minutesSince(runs.mail?.at);
    if (gap0 < MAIL.MIN_GAP_MIN) {
      return { due: false, toArchive,
               why: `${toArchive} to archive, ran ${Math.round(gap0)}m ago` };
    }
    return { due: true, toArchive, archiveOnly: true,
             why: `${toArchive} judged thread(s) to archive` };
  }

  const gap = minutesSince(runs.mail?.at);
  // Anything the work list could not fit. One left over is already a second run
  // owed, so there is no threshold here and nothing to tune.
  const backlog = list.counts?.not_shown ?? 0;
  const draining = backlog > 0;
  const need = draining ? MAIL.DRAIN_GAP_MIN : MAIL.MIN_GAP_MIN;
  if (gap < need) {
    return { due: false, waiting, draining,
             why: `ran ${Math.round(gap)}m ago, waiting ${need}m`
                + (draining ? ` (draining, ${backlog} behind)` : '') };
  }
  if (waiting >= MAIL.BATCH_AT) return { due: true, why: `${waiting} threads waiting`, waiting };
  if (gap >= MAIL.MAX_WAIT_MIN) {
    return { due: true, why: `${waiting} waiting, nothing judged for ${Math.round(gap)}m`, waiting };
  }
  return { due: false, why: `only ${waiting} waiting, holding for a batch`, waiting };
}
