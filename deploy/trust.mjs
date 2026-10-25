/**
 * The trust ledger — is the assistant earning the closes it makes?
 *
 * Alex, 2026-09-20, after a day of fixing un-closes: the system now closes
 * on its own, corrects its own headlines, expires its own doubt and chases
 * on its own cadence. Every one of those is a claim about what he owes, and
 * the only check on them is whether he ends up agreeing. This is the place
 * that number lives: one line a day, arithmetic over records that already
 * exist, so a week of it says whether the agent's closes stand, whether its
 * findings get acted on, and whether waiting on others is getting shorter
 * or longer.
 *
 *   opened          obligations whose `since` is on the day
 *   closed_agent    logbook closes by an `agent:` that day (`closed_review`
 *                   the subset made by review.mjs apply())
 *   closed_him      logbook closes with his name on them
 *   corrected       headlines rewritten against the record (obligation-changes)
 *   reopened        closes he or newer evidence took back (obligation-changes)
 *   dismissed       "Not a task" on the page — closes whose outcome says so
 *   findings        review findings open at measurement, with their ids
 *   findings_acted  yesterday's findings that are gone today — the item was
 *                   closed, corrected or the record caught up
 *   findings_stand  yesterday's findings still there
 *   owed_them_*     the wait on others: how many, the median days, how many
 *                   past two weeks
 *
 * `.log/trust.jsonl`, one line per day, last line per date wins; not in git,
 * like every other ledger — it is derived and can be rebuilt from the
 * logbook and the changes file for any day the review findings were kept.
 * Read-only over its sources; the only thing it writes is its own line.
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOpen } from './agent-service/obligations.mjs';
import { parseLogbook } from './closed.mjs';
import { review } from './review.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER = ['.log', 'trust.jsonl'];
const CHANGES = ['integrations', 'obligation-changes.jsonl'];

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/** Every line, oldest first, one per date (the last written for a date wins). */
export async function readTrust(vault = OBLIGATIONS) {
  let raw = '';
  try { raw = await readFile(join(vault, ...LEDGER), 'utf8'); } catch { return []; }
  const byDate = new Map();
  for (const l of raw.split('\n').filter(Boolean)) { try { const r = JSON.parse(l); if (r?.date) byDate.set(r.date, r); } catch {} }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Pure: the day's numbers from the records handed in. Exported for tests. */
/**
 * What the day's model runs cost, from the service log.
 *
 * Alex, 2026-09-20, asking whether to move to a database: the measurement
 * that answered that question also turned up this one. $1,210 over 854 runs
 * was in the log and on no surface — and the documented triage floor, $0.36,
 * was four times under what a run actually costs. Cost that nobody sees is
 * the same failure as a silence that looks like a success.
 *
 * The log is JSONL and append-only; a bad line is skipped rather than fatal.
 */
export async function spendOn(vault, date) {
  let raw = '';
  try { raw = await readFile(join(vault, '.log', 'agent-service.log'), 'utf8'); } catch { return null; }
  const by = {};
  let total = 0, runs = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('"job_done"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    // The log stamps UTC (`at`), the ledger's date is local — compare on the
    // local day, which is the one he means by "today".
    const local = new Date(d.at); if (Number.isNaN(local.getTime())) continue;
    if (dayOf(local) !== date) continue;
    const c = d.costUSD ?? 0;
    total += c; runs++;
    by[d.name] = Math.round(((by[d.name] ?? 0) + c) * 100) / 100;
  }
  return { total: Math.round(total * 100) / 100, runs, by };
}

export function measureFrom({ date, open, logbook, changes, findings, previous, spend = null }) {
  const closes = logbook.filter((r) => r.date === date);
  const agent = closes.filter((r) => r.by && r.by.startsWith('agent:'));
  const dismissed = closes.filter((r) => /^not a task\b/i.test(r.outcome ?? ''));
  const dayChanges = changes.filter((c) => String(c.at ?? '').slice(0, 10) === date);
  const them = open.filter((o) => (o.owed_by ?? 'me') === 'them');
  const ids = findings.map((f) => f.id);
  const prev = new Set(previous?.findings_ids ?? []);
  const now = new Set(ids);
  return {
    date,
    open: open.length,
    opened: open.filter((o) => String(o.since ?? '').slice(0, 10) === date).length,
    closed: closes.length,
    closed_agent: agent.length,
    closed_review: agent.filter((r) => r.by === 'agent:review').length,
    closed_him: closes.length - agent.length,
    corrected: dayChanges.filter((c) => !c.action).length,
    reopened: dayChanges.filter((c) => c.action === 'reopened').length,
    dismissed: dismissed.length,
    findings: ids.length,
    findings_ids: ids,
    findings_acted: previous ? [...prev].filter((id) => !now.has(id)).length : null,
    findings_stand: previous ? [...prev].filter((id) => now.has(id)).length : null,
    owed_them: them.length,
    owed_them_median_days: median(them.map((o) => o.days ?? 0)),
    owed_them_over_14: them.filter((o) => (o.days ?? 0) >= 14).length,
    spend_usd: spend?.total ?? null,
    runs: spend?.runs ?? null,
    spend_by_job: spend?.by ?? null,
  };
}

/** The day's line, measured now. Writes nothing. */
export async function measure(vault = OBLIGATIONS, { now = new Date(), open = null } = {}) {
  const date = dayOf(now);
  const obligations = open ?? await listOpen(vault);
  let logbook = [];
  try { logbook = parseLogbook(await readFile(join(vault, 'logbook.md'), 'utf8')); } catch {}
  let changes = [];
  try { changes = (await readFile(join(vault, ...CHANGES), 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const r = await review(vault, { now, open: obligations }).catch(() => ({ findings: [] }));
  const rows = await readTrust(vault);
  const previous = [...rows].reverse().find((x) => x.date < date) ?? null;
  const spend = await spendOn(vault, date).catch(() => null);
  return measureFrom({ date, open: obligations, logbook, changes, findings: r.findings ?? [], previous, spend });
}

/** Append the day's line. Called once a day by the evening brief input. */
export async function record(vault = OBLIGATIONS, row) {
  await mkdir(join(vault, '.log'), { recursive: true });
  await appendFile(join(vault, ...LEDGER), JSON.stringify(row) + '\n');
  return row;
}

/** One sentence, in words — what the brief and /system say. */
export function trustLine(row) {
  if (!row) return 'no trust line yet — the evening brief writes the first one';
  const bits = [];
  bits.push(`opened ${row.opened}, closed ${row.closed} (${row.closed_agent} by the assistant${row.closed_review ? `, ${row.closed_review} of them by the review` : ''}, ${row.closed_him} by you)`);
  if (row.corrected) bits.push(`corrected ${row.corrected}`);
  if (row.reopened) bits.push(`reopened ${row.reopened}`);
  if (row.dismissed) bits.push(`you dismissed ${row.dismissed} as not a task`);
  const f = row.findings_acted == null ? `${row.findings} findings open` : `of yesterday's ${row.findings_acted + row.findings_stand} findings ${row.findings_acted} were acted on and ${row.findings_stand} stand (${row.findings} open now)`;
  bits.push(f);
  bits.push(row.owed_them ? `waiting on others: ${row.owed_them}, median ${row.owed_them_median_days}d, ${row.owed_them_over_14} past two weeks` : 'waiting on nobody');
  if (row.spend_usd != null) bits.push(`it cost $${row.spend_usd.toFixed(2)} over ${row.runs} runs`);
  return `${row.date} — ${bits.join('; ')}.`;
}

/** The week, as a trend the brief can read: what moved, not every number. */
export function trend(rows) {
  const last = rows.slice(-7);
  if (last.length < 2) return null;
  const a = last[0], b = last[last.length - 1];
  const d = (k) => (b[k] ?? 0) - (a[k] ?? 0);
  return {
    days: last.length,
    closed_agent: last.reduce((n, r) => n + (r.closed_agent ?? 0), 0),
    closed_him: last.reduce((n, r) => n + (r.closed_him ?? 0), 0),
    reopened: last.reduce((n, r) => n + (r.reopened ?? 0), 0),
    dismissed: last.reduce((n, r) => n + (r.dismissed ?? 0), 0),
    findings_delta: d('findings'),
    owed_them_median_delta: (b.owed_them_median_days ?? 0) - (a.owed_them_median_days ?? 0),
    over_14_delta: d('owed_them_over_14'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const row = await measure(OBLIGATIONS);
  if (argv.includes('--record')) await record(OBLIGATIONS, row);
  if (argv.includes('--json')) { console.log(JSON.stringify({ today: row, week: await readTrust(OBLIGATIONS) }, null, 1)); process.exit(0); }
  console.log(trustLine(row));
  const t = trend([...(await readTrust(OBLIGATIONS)).filter((r) => r.date !== row.date), row]);
  if (t) console.log(`last ${t.days} days: the assistant closed ${t.closed_agent}, you closed ${t.closed_him}, ${t.reopened} reopened, ${t.dismissed} dismissed; findings ${t.findings_delta >= 0 ? '+' : ''}${t.findings_delta}; median wait on others ${t.owed_them_median_delta >= 0 ? '+' : ''}${t.owed_them_median_delta}d`);
}
