/**
 * The realtime allowlist, read from `rules/realtime-push.md`.
 *
 * One human-readable list that a machine follows — the same trick `reading.mjs`
 * uses on `gmail-filters.xml`. Alex's edit *is* the ratification: no second
 * copy to drift, no restart, and git history is the audit trail for a list whose
 * entries can wake him at three in the morning.
 *
 * ## The sender table is a fast lane, not a gate
 *
 * Alex decided on 2026-08-30 that anything matching a login pattern should
 * come through, listed or not — a missed code is the failure he cares about.
 * So `senders` is consulted for the login domain and the looser rate limit, and
 * `blocked` is the hard exclusion. `rules/realtime-push.md` states the risk that
 * buys, and `REALTIME_MODE=strict` restores the table as a gate.
 *
 * ## Failing closed
 *
 * Everything here is defensive in one direction. A malformed row is skipped and
 * counted rather than guessed at; over the caps the **whole list is refused**
 * rather than truncated. The asymmetry is deliberate: a list that is too small
 * means a code does not push and he goes and reads it, which is a mild
 * annoyance. A list that is too large, or one built from half-parsed rows, means
 * his phone rings for things he never approved — and that ends the channel.
 *
 * ## Why the hash
 *
 * The agent can write files, and this one is policy rather than enforcement. So
 * `fingerprint` lets the caller notice the section changed and say so. An
 * allowlist that can be edited silently is not an allowlist.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const MAX_SENDERS = 30;
export const MAX_PATTERNS = 20;
export const MAX_BLOCKED = 50;

const SECTION = '## Realtime — what may ring the phone';

/** Text of one `###` subsection of the realtime section, or ''. */
function subsection(body, heading) {
  const re = new RegExp(`^### ${heading}\\s*$`, 'm');
  const m = re.exec(body);
  if (!m) return '';
  const rest = body.slice(m.index + m[0].length);
  const next = /^#{2,3} /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Lines inside the first fenced block of a subsection. */
function fenced(text) {
  const m = /```[a-z]*\n([\s\S]*?)```/.exec(text);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.trim()).filter(Boolean);
}

const domain = (v) => String(v).trim().toLowerCase().replace(/^@/, '');

/**
 * @returns {{senders: Map, addresses: string[], patterns: RegExp[],
 *            vetoSubject: RegExp|null, fingerprint: string,
 *            problems: string[], ok: boolean}}
 */
export async function loadPolicy(vault) {
  const empty = {
    senders: new Map(), addresses: [], patterns: [], blocked: new Set(),
    vetoSubject: null, fingerprint: '', problems: [], ok: false,
  };

  let raw;
  try {
    raw = await readFile(join(vault, 'rules', 'realtime-push.md'), 'utf8');
  } catch {
    return { ...empty, problems: ['rules/realtime-push.md is missing'] };
  }

  const start = raw.indexOf(SECTION);
  if (start < 0) {
    return { ...empty, problems: [`no "${SECTION}" section`] };
  }
  const after = raw.slice(start + SECTION.length);
  const end = /^## /m.exec(after);
  const body = end ? after.slice(0, end.index) : after;

  const problems = [];

  // --- senders -------------------------------------------------------------
  // `| sender | login | what it is | date |`. The separator row and the header
  // are skipped by requiring a date-shaped last cell: a row without one is
  // either furniture or unfinished, and unfinished must not ring the phone.
  const senders = new Map();
  for (const line of subsection(body, 'Senders').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[3])) {
      if (cells[0] && !/^-+$/.test(cells[0]) && cells[0].toLowerCase() !== 'sender domain') {
        problems.push(`sender row without a ratified date: ${cells[0]}`);
      }
      continue;
    }
    const from = domain(cells[0]);
    if (!from.includes('.')) { problems.push(`not a domain: ${cells[0]}`); continue; }
    senders.set(from, { login: cells[1] ? domain(cells[1]) : null, what: cells[2], since: cells[3] });
  }

  // --- his addresses -------------------------------------------------------
  const addresses = fenced(subsection(body, 'His addresses'))
    .map((a) => a.toLowerCase())
    .filter((a) => a.includes('@'));

  // --- subject patterns ----------------------------------------------------
  const patterns = [];
  for (const line of fenced(subsection(body, 'Subject patterns'))) {
    try {
      patterns.push(new RegExp(line, 'i'));
    } catch (e) {
      // A pattern that does not compile is skipped and named. Silently dropping
      // it would narrow the list without anyone noticing.
      problems.push(`unparseable pattern: ${line} (${e.message})`);
    }
  }

  // --- blocklist -----------------------------------------------------------
  // The first lever if the open setting is ever abused, so it is read even when
  // everything else fails to parse.
  const blocked = new Set(
    fenced(subsection(body, 'Blocklist')).map(domain).filter((d) => d.includes('.')));

  // --- vetoes --------------------------------------------------------------
  let vetoSubject = null;
  for (const line of fenced(subsection(body, 'Vetoes'))) {
    const m = /^subject matches:\s*(.+)$/i.exec(line);
    if (!m) continue;
    try {
      vetoSubject = new RegExp(m[1], 'i');
    } catch (e) {
      problems.push(`unparseable veto: ${m[1]} (${e.message})`);
    }
  }

  const fingerprint = createHash('sha256').update(body).digest('hex').slice(0, 16);

  // Over the cap, refuse the whole thing. Truncating would silently pick which
  // of his ratified senders still work, which is worse than none of them.
  if (senders.size > MAX_SENDERS) {
    return { ...empty, fingerprint,
             problems: [`${senders.size} senders exceeds the cap of ${MAX_SENDERS}; refusing the whole list`] };
  }
  if (patterns.length > MAX_PATTERNS) {
    return { ...empty, fingerprint,
             problems: [`${patterns.length} patterns exceeds the cap of ${MAX_PATTERNS}; refusing the whole list`] };
  }

  return {
    senders, addresses, patterns, blocked, vetoSubject, fingerprint, problems,
    // Empty is a valid, inert policy — not an error. Nothing pushes until he
    // adds a row, and that is the intended resting state.
    ok: true,
  };
}
