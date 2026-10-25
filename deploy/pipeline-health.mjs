#!/usr/bin/env node
/**
 * `node deploy/pipeline-health.mjs [--json]` — is the machinery that feeds the
 * brief actually running?
 *
 * ## Why this exists
 *
 * The brief no longer reads mail. It reads what the triage concluded, which is
 * the right way round — the triage has the policy, the context and the
 * authority to archive, and two readers of the same mailbox under different
 * rules produce two different opinions about what matters.
 *
 * But it moves a failure. A brief that read the mailbox could always see the
 * mailbox; a brief that reads conclusions sees nothing at all when the thing
 * that writes conclusions has stopped, and "no obligations from mail today" is
 * indistinguishable from "the extractor has been 403ing since Tuesday".
 *
 * That exact failure has already happened here once: the calendar section of
 * the brief silently reported nothing for weeks because no calendar was
 * connected, and CLAUDE.md carries the rule that came out of it — a brief that
 * omits what it cannot see is worse than one that admits it.
 *
 * So this is the deterministic half of the brief's honesty. It is arithmetic —
 * file timestamps and counts — and the agent should never be working it out by
 * reading files itself.
 *
 * Read-only. It never writes, and it never calls the network: everything it
 * reports is something the minute dispatcher already left on disk.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OBLIGATIONS = process.env.OBLIGATIONS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** How old each feed may be before its silence stops meaning "nothing happened". */
const STALE_MIN = {
  mail: 60,        // refresh_email runs every 15 min; an hour is a real outage
  calendar: 180,   // refreshed on the same tick, slower cadence
  messages: 60,
  // The Mac pushes this every 15 minutes like the others. A stale one is the
  // quiet failure this whole file exists for: his own reminders stop arriving
  // and the To Do page looks exactly as it does on a day he added none.
  reminders: 90,
};

/**
 * Ages come from mtime, never from the wall-clock stamps written inside these
 * files. Those stamps carry no offset, so reading one means guessing the
 * writer's timezone from the reader's — and the writers here are a container,
 * the host dispatcher and the service. mtime is absolute.
 */
const minutesSince = (ms) => ms == null ? null : Math.round((Date.now() - ms) / 60000);

async function mtime(vault, rel) {
  try { return (await stat(join(vault, rel))).mtimeMs; } catch { return null; }
}

async function load(vault, rel) {
  try { return JSON.parse(await readFile(join(vault, rel), 'utf8')); } catch { return null; }
}

/** Stamps in this repo are local "YYYY-MM-DD HH:MM", which Date.parse needs help with. */
const stampAge = (s) => {
  const t = Date.parse(String(s ?? '').replace(' ', 'T'));
  return Number.isNaN(t) ? null : minutesSince(t);
};

/** Loose git objects — null when git cannot be asked, never a guessed zero. */
async function looseObjects(vault = OBLIGATIONS) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('git', ['-C', vault, 'count-objects', '-v'], { timeout: 10000 });
    const line = stdout.split('\n').find((l) => l.startsWith('count:'));
    return line ? Number(line.split(/\s+/)[1]) : null;
  } catch { return null; }
}

export async function health(vault = OBLIGATIONS) {
  const problems = [];
  const note = (what) => problems.push(what);

  // --- mail ---------------------------------------------------------------
  const extract = await load(vault, 'integrations/gmail.json');
  const changed = await load(vault, 'integrations/gmail-changed.json');
  const runs = (await load(vault, '.log/job-runs.json')) ?? {};

  const mail = {
    extract_age_min: await mtime(vault, 'integrations/gmail.json').then(minutesSince),
    // The differ can die while the extractor lives, and then the mailbox is
    // being read but nothing is deciding what changed. Checked separately for
    // that reason: the first version of this file watched only the extract and
    // reported "fine" while the gate was refusing to run on a stale work list.
    worklist_age_min: await mtime(vault, 'integrations/gmail-changed.json').then(minutesSince),
    extract_error: extract?.error ?? null,
    // Which mailboxes the extract actually contains, and which it could not
    // read. `error` is set only when EVERY account fails, so one mailbox
    // failing alone left this reporting a clean bill of health while nothing
    // from that account had been ingested for hours.
    mailboxes: (extract?.mailboxes ?? []).map((m) => m.account),
    partial: (extract?.partial ?? []).map((x) => x.account),
    waiting: (changed?.needs_judgement ?? []).length,
    held: changed?.counts?.held ?? 0,
    held_accounts: changed?.counts?.held_accounts ?? [],
    escaped: changed?.counts?.escaped_unjudged ?? 0,
    // The object store, so a gc that has stopped is visible rather than a
    // slowly growing disk. See pack_repo() in reminder-dispatch.py.
    loose_objects: await looseObjects(),
    last_run: runs.mail?.at ?? null,
    last_run_ok: runs.mail?.ok ?? null,
    last_run_age_min: stampAge(runs.mail?.at),
  };
  if (mail.extract_error) note(`mail: the extractor is failing — ${mail.extract_error}`);
  else if (mail.extract_age_min == null) note('mail: no extract on disk; nothing is reading the mailbox');
  else if (mail.extract_age_min > STALE_MIN.mail) {
    note(`mail: the extract is ${mail.extract_age_min}m old — the minute dispatcher is not refreshing it`);
  }
  for (const acct of new Set(mail.partial)) {
    const seen = mail.mailboxes.includes(acct);
    note(`mail: the ${acct} mailbox ${seen ? 'was only partly read' : 'could not be read at all'} `
       + `on the last extract — ${seen ? 'some threads are missing' : 'nothing from it has been ingested'}`);
  }
  if (mail.worklist_age_min == null) note('mail: no work list; nothing is deciding what changed');
  else if (mail.worklist_age_min > STALE_MIN.mail) {
    note(`mail: the work list is ${mail.worklist_age_min}m old — the differ has stopped, `
       + 'so waiting mail is not being counted and the triage will not fire');
  }
  if (mail.last_run_ok === false) note('mail: the last triage run failed');
  // Waiting mail is not itself a fault — the gate batches deliberately — but a
  // pile that never drains means the job is not firing.
  if (mail.waiting && mail.last_run_age_min != null && mail.last_run_age_min > 240) {
    note(`mail: ${mail.waiting} threads waiting and nothing judged for ${mail.last_run_age_min}m`);
  }
  // A held mailbox is a deliberate decision, not a fault — but an unmentioned
  // one turns into "the assistant reads all my mail" long after anyone remembers
  // setting it. Stated every day, quietly, for as long as it is true.
  if (mail.held) {
    note(`mail: ${mail.held} thread(s) in ${mail.held_accounts.join(', ')} are held out `
       + 'of triage by integrations/google-policy.json — read, counted, not judged');
  }
  if (mail.escaped) {
    note(`mail: ${mail.escaped} thread(s) left the extract unjudged — see integrations/gmail-escaped.json`);
  }

  // --- calendar -----------------------------------------------------------
  const cal = await load(vault, 'integrations/calendar.json');
  const calendar = {
    age_min: await mtime(vault, 'integrations/calendar.json').then(minutesSince),
    error: cal?.error ?? null,
    today: (cal?.today ?? []).length,
  };
  if (calendar.error) note(`calendar: could not be read — ${calendar.error}`);
  else if (calendar.age_min == null) note('calendar: not connected; the brief cannot see today');
  else if (calendar.age_min > STALE_MIN.calendar) {
    note(`calendar: ${calendar.age_min}m old — today's events may be wrong`);
  }

  // --- messages -----------------------------------------------------------
  const messages = {
    age_min: await mtime(vault, 'integrations/imessage.json').then(minutesSince),
  };
  if (messages.age_min == null) note('messages: no iMessage export; the Mac may not be syncing');
  else if (messages.age_min > STALE_MIN.messages) {
    note(`messages: ${messages.age_min}m old — the Mac is probably asleep`);
  }

  // --- reminders ----------------------------------------------------------
  //
  // Both directions, because they fail differently. A stale extract means his
  // own reminders and his ticks stop arriving. A stale mirror means the list on
  // his phone is a photograph of an older day — and that one is worse, because
  // a list of closed things still reads as a list of things to do.
  const rem = await load(vault, 'integrations/reminders-apple.json');
  const reminders = {
    extract_age_min: await mtime(vault, 'integrations/reminders-apple.json').then(minutesSince),
    mirror_age_min: await mtime(vault, 'integrations/reminders-mirror.json').then(minutesSince),
    lists: (rem?.lists ?? []).length,
    his: (rem?.reminders ?? []).filter((r) => r.list !== 'Obligations' && !r.completed).length,
    mirrored: (rem?.reminders ?? []).filter((r) => r.list === 'Obligations').length,
    // An alarm on something the assistant put there. Nothing here sets one and the
    // mirror says alarms: false, so any number above zero is a list default or
    // his own hand — and the whole basis of the mirror is that it does not buzz.
    alarmed: (rem?.reminders ?? []).filter((r) => r.list === 'Obligations' && r.has_alarm).length,
    // Open on his phone, wanted by nobody, and not being ticked off. Zero after
    // every rebuild, or the two sides disagree about what he owes. Suggested by
    // the Mac session on 2026-09-18, which found 23 of them after nineteen
    // closes: the mirror had dropped them and nothing was asking for them back.
    stranded: 0,
  };
  {
    const mir = await load(vault, 'integrations/reminders-mirror.json');
    if (mir && rem) {
      const wanted = new Set((mir.items ?? []).map((i) => i.id));
      const asked = new Set((mir.complete ?? []).map((c) => c.id));
      const idOf = (r) => String(r.obligations_id ?? '').trim()
        || (/\/todo#pane=([^\s)]+)/.exec(String(r.url ?? '')) ?? [])[1];
      reminders.stranded = (rem.reminders ?? []).filter((r) => {
        if (r.completed || r.list !== 'Obligations') return false;
        const id = idOf(r);
        return id && !wanted.has(decodeURIComponent(id)) && !asked.has(decodeURIComponent(id));
      }).length;
    }
  }
  // Absent is not a problem: the bridge is opt-in and the Mac half may not be
  // running. Present-but-stale is, and so is a mirror nobody is refreshing.
  if (reminders.extract_age_min != null) {
    if (reminders.extract_age_min > STALE_MIN.reminders) {
      note(`reminders: the Mac last read his lists ${reminders.extract_age_min}m ago — anything he adds there is not arriving`);
    }
    if (reminders.alarmed) {
      note(`reminders: ${reminders.alarmed} mirrored item(s) have an alarm set — the assistant never sets one, so the Obligations list has inherited a default`);
    }
    if (reminders.stranded) {
      note(`reminders: ${reminders.stranded} item(s) are open in his Obligations list that the mirror neither wants nor is ticking off — they will sit there until this is zero`);
    }
    if (reminders.mirror_age_min != null && reminders.mirror_age_min > STALE_MIN.reminders) {
      note(`reminders: the list on his phone was last rebuilt ${reminders.mirror_age_min}m ago — it may be showing closed items`);
    }
  }

  return { ok: problems.length === 0, problems, mail, calendar, messages, reminders };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const h = await health();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(h, null, 1));
  } else if (h.ok) {
    console.log(`pipeline ok — mail extract ${h.mail.extract_age_min}m old, `
      + `${h.mail.waiting} waiting, calendar ${h.calendar.age_min}m old`);
  } else {
    console.log('PIPELINE PROBLEMS — say these in the brief:');
    for (const p of h.problems) console.log(`  - ${p}`);
  }
  // Non-zero on trouble, so a watchdog can use this without parsing prose.
  process.exit(h.ok ? 0 : 1);
}
