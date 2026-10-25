/**
 * What each artifact in this repo is shaped like, in one place.
 *
 * ## Why
 *
 * Every file here is informally specified, and the failures cluster exactly
 * where informality bites. `reminder-dispatch.py` and `messages.mjs` both parse
 * message frontmatter independently; one read `type` where the other writes
 * `kind`, so no brief was ever pushed — and the test passed, because its fixture
 * invented `type: brief`, a shape nothing emits. A schema in one place, checked
 * against the LIVE files, turns that from a silent four-hour outage into a red
 * test.
 *
 * ## What this is not
 *
 * Not a validator anything writes through. Files stay plain markdown and plain
 * JSON, greppable from a terminal, because that is the point of the repo. This
 * describes them and is checked against them; it does not stand between a writer
 * and a file.
 *
 * `required` fields must be present and of the stated type; `if` on one names a
 * sibling that must be truthy first, for a field that is only meaningful in one
 * state. `epoch` names a
 * field that MUST have an epoch sibling for ordering — see guards.test.mjs and
 * the timezone bugs that rule exists for. `advisory` is a field being rolled
 * out: reported, never failed, so a migration is visible without being blocking.
 */
export const CONTRACTS = {
  /** messages/*.md — anything the system said to Alex unprompted. */
  message: {
    file: 'messages/*.md',
    kind: 'frontmatter',
    required: {
      type: { type: 'string', is: 'message' },
      kind: { type: 'string', oneOf: ['brief', 'note', 'reminder', 'failure', 'prep', 'debrief', 'urgent', 'digest'] },
      at: { type: 'stamp' },
      title: { type: 'string' },
      read: { type: 'boolish' },
      // `none` until a channel carried it. "pending", on eight briefs, read
      // as delivered to the dispatcher and kept them off his phone (2026-10-05).
      delivered: { type: 'string', oneOf: ['none', 'ntfy', 'sms', 'apns'] },
    },
    note: '`type` is always "message"; the brief/note/failure distinction is `kind`. '
        + 'Reading one for the other is what stopped every brief being pushed.',
  },

  /** integrations/email-state.json — the triage's conclusions. */
  conclusion: {
    file: 'integrations/email-state.json',
    kind: 'json',
    at: 'threads[]',
    required: {
      thread_id: { type: 'string' },
      account: { type: 'string' },
      watermark: { type: 'stamp' },
      reviewed: { type: 'stamp' },
    },
    advisory: {
      watermark_at: { type: 'number', why: 'epoch sibling; compared across runs' },
    },
    nested: {
      conclusion: {
        required: {
          open: { type: 'boolean' },
          tier: { type: 'string', oneOf: ['action', 'digest', 'reading', 'awareness',
                                          'memory', 'ephemeral', 'silent'] },
        },
        // A conclusion must carry SOMETHING readable, and which field holds it
        // is not the contract's business: 14 awareness items wrote `title` and
        // no `what`, which is drift worth knowing about but not a broken record.
        requiredAny: [['title', 'what']],
        advisory: {
          title: { type: 'string', why: 'the headline /tasks reads; derived when absent' },
          tags: { type: 'array', why: 'project tags from projects/*.md; the arithmetic assigns most, this is for the ones only a reader of the thread can see' },
          surfaced_for: { type: 'string', why: 'YYYY-MM-DD; a time-sensitive awareness item waits and surfaces in the brief on that day. Read by deploy/digest-window.mjs — it was described in rules/email-triage.md for seventeen days with no reader at all, so it is pinned here now' },
          closes_when: { type: 'array', why: '[{kind, who?, words?}] — what would discharge it, as data deploy/closes.mjs can test; the review pass closes on it. The prose `closes` stays for him to read' },
          confidence: { type: 'string', oneOf: ['low', 'normal', 'high'], why: '`low` when opened on doubt; review.mjs closes it as never confirmed after 14 quiet days' },
          handed_to: { type: 'string', why: 'the colleague this thread was handed to. The chase never writes to whoever handed off — see deploy/drafts.mjs' },
        },
      },
    },
  },

  /**
   * integrations/imessage-state.json — the message triage's conclusions.
   *
   * It had no contract until 2026-09-08, which is the more interesting fact
   * about it: mail's conclusions were pinned and texts' were not, though both
   * are hand-written by a job and both feed the same obligation list. The
   * asymmetry was an oversight, not a decision — found by reading the log of
   * calls the jobs had been refused, six of which were a job trying to check
   * this file with an inline script because nothing would check it for them.
   */
  messageConclusion: {
    file: 'integrations/imessage-state.json',
    kind: 'json',
    at: 'threads[]',
    required: {
      chat_id: { type: 'string' },
      watermark: { type: 'stamp' },
      reviewed: { type: 'stamp' },
    },
    advisory: {
      participants: { type: 'array', why: 'raw handles, copied from the work list; what names the people once the thread has left the extract (2026-09-20)' },
    },
    nested: {
      conclusion: {
        required: {
          open: { type: 'boolean' },
          since: { type: 'stamp', if: 'open' },
        },
        // Same rule as mail: something readable must be there, and which field
        // carries it is drift worth seeing rather than a broken record.
        requiredAny: [['title', 'what']],
        advisory: {
          title: { type: 'string', why: 'the headline /tasks reads; derived from `what` when absent' },
          owed_by: { type: 'string', why: 'read as `me` when absent, so a chase looks like a debt' },
          promised: { type: 'stamp', why: 'what drafts.mjs chases; only on threads where he committed' },
          tags: { type: 'array', why: 'project tags from projects/*.md; the arithmetic assigns most, this is for the ones only a reader of the thread can see' },
          // Review item 6, 2026-09-20: the message triage gets the mail model.
          tier: { type: 'string', oneOf: ['action', 'awareness', 'memory', 'digest', 'ephemeral'],
                  why: 'absent means action — every conclusion before 2026-09-20 was one. Anything else is open:false by definition and reaches him through the brief, never /tasks' },
          due: { type: 'stamp', why: 'a deadline the thread names; sources/imessage.mjs threw it away until 2026-09-20' },
          closes: { type: 'string', why: 'what would discharge it, in the triage\'s words; shown beside the task' },
          surfaced_for: { type: 'string', why: 'YYYY-MM-DD; an awareness text with a date comes back in the brief on that morning, as mail does' },
          closes_when: { type: 'array', why: '[{kind, who?, words?}] — what would discharge it, as data deploy/closes.mjs can test; the review pass closes on it' },
          confidence: { type: 'string', oneOf: ['low', 'normal', 'high'], why: '`low` when opened on doubt; expires after 14 quiet days' },
          handed_to: { type: 'string', why: 'the colleague this thread was handed to; the chase never writes to whoever handed off' },
        },
      },
    },
  },

  /** integrations/gmail.json — the mailbox extract. */
  extractThread: {
    file: 'integrations/gmail.json',
    kind: 'json',
    at: 'threads[]',
    required: {
      thread_id: { type: 'string' },
      account: { type: 'string' },
      watermark: { type: 'stamp' },
      watermark_at: { type: 'number' },
      in_inbox: { type: 'boolean' },
    },
  },

  /**
   * integrations/digest-archived.json — which threads a digest has reported.
   *
   * The record the old design never kept. A digest used to be a 14-day window
   * over whatever was unread, so nothing could answer "has he been told about
   * this" and a thread left the digest by ageing rather than by being
   * reported. Alex, 2026-09-21: "digest emails that have yet been included
   * in an 'Archived Digest' is labeled 'Current Digest'."
   *
   * A map, not a list of records: the key IS the fact and the value is when.
   */
  digestArchived: {
    file: 'integrations/digest-archived.json',
    kind: 'json',
    at: 'map',
    in: 'archived',
    key: /^[a-z0-9_-]+:[a-z0-9]+$/i,
    of: { type: 'stamp' },
    note: 'written only by markDigestArchived, which never unsets: a digest that went out cannot be un-sent.',
  },

  /** .log/prepared.json — what a session readied (prepare.mjs): id → entry.
      A cache, and absent until he first works through a lane. */
  prepared: {
    file: '.log/prepared.json',
    kind: 'json',
    at: 'values',
    optional: true,
    required: {
      kind: { type: 'string', oneOf: ['reply', 'decide', 'pay'] },
      state: { type: 'string', oneOf: ['ready', 'failed'] },
      basis: { type: 'string' },
      at: { type: 'stamp' },
      at_epoch: { type: 'number' },
      text: { type: 'string', if: 'read' },
    },
    note: 'written only by prepare.mjs; `queued`/`working` live in the process and never reach the file.',
  },

  /** .log/filed-reported.json — which awareness/memory thread a brief carried,
      and when (filed-section.mjs). A thread in here is never appended again. */
  filedReported: {
    file: '.log/filed-reported.json',
    kind: 'json',
    at: 'map',
    in: 'reported',
    optional: true,
    key: /^(?:[a-z0-9_-]+:[a-z0-9]+|text:.+)$/i,
    of: { type: 'stamp' },
    note: 'written only by filedIntoBrief, after the brief it names; never unset.',
  },

  /** integrations/keep-in-inbox.json — threads he asked to Keep in Inbox
      (keep-inbox.mjs). Absent until his first tap. */
  keepInInbox: {
    file: 'integrations/keep-in-inbox.json',
    kind: 'json',
    at: 'map',
    in: 'threads',
    optional: true,
    key: /^[a-z0-9_-]+:[0-9a-f]{4,32}$/i,
    of: { type: 'object' },
    note: 'written by his tap (/api/mail/keep, his identity) and by keepPass releasing one; the differ and the archive hook read it.',
  },

  /** .log/rank.json — today's order (rank.mjs): the top ten and why. */
  rank: {
    file: '.log/rank.json',
    kind: 'json',
    optional: true,
    required: {
      date: { type: 'stamp' },
      at: { type: 'stamp' },
      at_epoch: { type: 'number' },
      order: { type: 'array' },
      suggest: { type: 'array' },
    },
    note: 'written only by runRank; his own order for the day is .log/rank-manual.json, his moves .log/rank-moves.jsonl.',
  },

  /** .log/job-runs.json — did a job run, and did it succeed. */
  jobRun: {
    file: '.log/job-runs.json',
    kind: 'json',
    at: 'values',
    required: {
      slot: { type: 'string' },
      at: { type: 'stamp' },
      ok: { type: 'boolean' },
    },
  },
};

/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, which is how every stamp here is written. */
export const STAMP = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;

export function checkValue(spec, value) {
  if (value === undefined || value === null) return 'missing';
  switch (spec.type) {
    case 'stamp':
      if (typeof value !== 'string' || !STAMP.test(value)) return `not a stamp: ${JSON.stringify(value)}`;
      break;
    case 'boolish':
      if (!['true', 'false', true, false].includes(value)) return `not boolean: ${JSON.stringify(value)}`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `not a number: ${JSON.stringify(value)}`;
      break;
    // `typeof []` is "object", so an array field checked by the default branch
    // would be reported as broken the first time a job wrote one correctly.
    case 'array':
      if (!Array.isArray(value)) return `not an array: ${JSON.stringify(value)}`;
      break;
    default:
      if (typeof value !== spec.type) return `not a ${spec.type}: ${JSON.stringify(value)}`;
  }
  if (spec.is !== undefined && value !== spec.is) return `must be "${spec.is}", got "${value}"`;
  if (spec.oneOf && !spec.oneOf.includes(value)) return `not one of ${spec.oneOf.join('|')}: "${value}"`;
  return null;
}

/** Parse the frontmatter block of a messages/ file into a flat object. */
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Check the live file a contract describes, and say what is wrong with it.
 *
 * ## Why this grew a CLI
 *
 * Alex, 2026-09-08, reading the denied-tool log. A triage job hand-writes
 * `integrations/email-state.json` — every obligation the assistant knows about
 * lives in it — and then, sensibly, wants to know it did not just corrupt it.
 * Six job turns tried to ask with `node -e "JSON.parse(...)"` and were refused,
 * because an inline script is arbitrary code and the fence does not care that
 * this particular one was harmless.
 *
 * The fence was right and the job was right. What was missing was a door. The
 * schema was already here and already checked against the live files by the
 * suite; it just could not be run by the thing that most needed it, at the one
 * moment it mattered. And it answers a better question than `JSON.parse` did:
 * not "is this JSON" but "is this the shape everything downstream expects".
 */
export async function checkFile(vault, name) {
  const spec = CONTRACTS[name];
  if (!spec) throw new Error(`no contract called ${name} — have: ${Object.keys(CONTRACTS).join(', ')}`);
  if (spec.kind !== 'json') throw new Error(`${name} describes ${spec.file}, which is not JSON`);
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let raw;
  try { raw = await readFile(join(vault, spec.file), 'utf8'); }
  catch (err) {
    // A cache that exists only once used. Absent is said, never passed off as checked.
    if (spec.optional && err?.code === 'ENOENT') return { file: spec.file, ok: true, parsed: false, absent: true, records: 0, errors: [] };
    throw err;
  }
  let doc;
  // The failure this is most often run to catch. Say where, because "Unexpected
  // token" with no offset over a 12,000-line file is not a usable answer.
  try { doc = JSON.parse(raw); }
  catch (err) {
    const at = /position (\d+)/.exec(String(err.message));
    const line = at ? raw.slice(0, Number(at[1])).split('\n').length : null;
    return { file: spec.file, ok: false, parsed: false, records: 0,
             errors: [`not valid JSON${line ? ` — around line ${line}` : ''}: ${err.message}`] };
  }
  const at = spec.at ?? '';
  const records = at === 'values' ? Object.entries(doc ?? {})
    : at.endsWith('[]') ? (doc?.[at.slice(0, -2)] ?? []).map((r, i) => [r?.thread_id ?? r?.chat_id ?? `#${i}`, r])
    : at === 'map' ? Object.entries(doc?.[spec.in] ?? {})
    : [['(root)', doc]];
  const errors = [];

  /* A MAP OF SCALARS, not records. `digest-archived.json` is id → stamp: the
     key is the fact and the value is when, so there are no fields to walk.
     Checked here rather than bent into the record shape, where every value
     would have been reported as a missing field. */
  if (at === 'map') {
    for (const [k, v] of records) {
      if (spec.key && !spec.key.test(k)) errors.push(`${k}: not a valid key`);
      const e = checkValue(spec.of, v);
      if (e) errors.push(`${k}: ${e}`);
    }
    return { file: spec.file, ok: !errors.length, parsed: true, records: records.length, errors };
  }
  const walk = (label, rec, sub) => {
    for (const [field, fs] of Object.entries(sub.required ?? {})) {
      // `if` names a sibling that must be truthy for the field to be required.
      // Without it, `since` would have to be a stamp on all 119 message
      // conclusions, and it is legitimately null on the 91 that are closed —
      // "waiting since Tuesday" is a question about something still open. A
      // contract that reports 91 correct records as broken gets switched off.
      if (fs.if && !rec?.[fs.if]) continue;
      const e = checkValue(fs, rec?.[field]);
      if (e) errors.push(`${label}: ${field} ${e}`);
    }
    for (const group of sub.requiredAny ?? []) {
      if (!group.some((f) => rec?.[f])) errors.push(`${label}: none of ${group.join('/')} present`);
    }
    for (const [child, cs] of Object.entries(sub.nested ?? {})) {
      if (rec?.[child]) walk(`${label}.${child}`, rec[child], cs);
    }
  };
  for (const [id, rec] of records) walk(String(id), rec, spec);
  return { file: spec.file, ok: !errors.length, parsed: true, records: records.length, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = asked.length ? asked : Object.entries(CONTRACTS).filter(([, c]) => c.kind === 'json').map(([n]) => n);
  let bad = 0;
  for (const n of names) {
    try {
      const r = await checkFile(OBLIGATIONS, n);
      if (r.absent) console.log(`ok    ${n} — ${r.file} absent (optional; nothing on disk yet)`);
      else if (r.ok) console.log(`ok    ${n} — ${r.records} record(s) in ${r.file} match the contract`);
      else {
        bad++;
        console.log(`FAIL  ${n} — ${r.file}: ${r.errors.length} problem(s)`);
        for (const e of r.errors.slice(0, 8)) console.log(`        ${e}`);
        if (r.errors.length > 8) console.log(`        …and ${r.errors.length - 8} more`);
      }
    } catch (err) { bad++; console.log(`FAIL  ${n} — ${err.message}`); }
  }
  process.exit(bad ? 1 : 0);
}
