/**
 * `node deploy/tasks.mjs` — what is outstanding, as one list.
 *
 * Exists because the assistant kept answering "summarise the task list" by
 * reading `todo.md`, `reminders.md`, `recurring.md` and the triage cache and
 * describing each in turn. Every sentence of that was true and the answer was
 * still wrong: those are four *sources*, not four lists. Reading them raw
 * misses the merges, so one debt tracked in two places is reported twice; it
 * misses lead-time urgency, so a deadline three weeks out looks as loud as one
 * that has passed; and it misses which direction each obligation runs.
 *
 * `obligations.mjs` already knows all of that. This is the door onto it for
 * anything that is not the web UI — the scheduled jobs, the chat session, and
 * Alex at a terminal.
 *
 * Read-only. It cannot close anything, and it never writes.
 *
 *   node deploy/tasks.mjs            grouped, human-readable
 *   node deploy/tasks.mjs --json     the same data, for a script
 *   node deploy/tasks.mjs --all      include what has already been closed
 *   node deploy/tasks.mjs --find X   only the ones matching X
 *   node deploy/tasks.mjs --id ID    one obligation, in full, with its evidence
 *
 * ## Why --find and --id exist
 *
 * Alex, 2026-09-08, reading the denied-tool log: seventeen job turns had been
 * refused for piping this script into `grep`, `head`, or an inline `node -e`
 * that parsed the JSON with a regular expression. The permission layer refuses
 * a compound command on purpose — a pipeline is not a prefix anything can
 * match — so every one of those was a turn spent, denied, and worked around.
 *
 * The lesson was not that the fence is wrong. It was that "show me the ones
 * about the hangar" and "show me this id" are questions the door itself should
 * answer, and a model reaching for `grep` was telling us the door was too
 * narrow. Filtering here is also better than filtering downstream: it searches
 * the fields that mean something rather than the whole serialised line, so
 * `--find rosa` cannot match a thread id that happens to contain those letters.
 */
import { listObligations, sortObligations } from './agent-service/obligations.mjs';
import { localStamp } from './agent-service/time.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const argv = process.argv.slice(2);
const args = new Set(argv);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] ?? null : null; };
const find = valueOf('--find');
const wanted = valueOf('--id');

const items = await listObligations(OBLIGATIONS);
let open = args.has('--all') ? items : items.filter((o) => o.open);

// Named fields, not the whole record: a search over `JSON.stringify(o)` also
// matches ids, links and watermarks, which is how "find rosa" starts returning
// a thread whose id happens to contain those letters.
if (find) {
  const q = find.toLowerCase();
  const hit = (o) => o.code === find.trim().toUpperCase()
    || [o.title, o.what, o.who, o.closes, o.tag]
      .some((v) => String(v ?? '').toLowerCase().includes(q));
  open = open.filter(hit);
}
// The short code counts as an id. Alex, 2026-09-19: "can you add a unique id
// (like the reminders have) so I can easily share with you" — a code is only
// shareable if the thing he shares it with accepts it, so every door that takes
// an id takes four characters too, in whatever case he typed them.
if (wanted) {
  const want = String(wanted).trim();
  const code = want.toUpperCase();
  open = items.filter((o) => o.id === want || o.id.endsWith(want) || o.code === code);
}

if (args.has('--json')) {
  // Write, then exit in the drain callback. process.exit() straight after
  // console.log truncates a pipe at ~64KB — the dispatcher read exactly 65,420
  // bytes of a 300KB list, could not parse it, and pushed "The task list
  // could not be read." A file redirect is synchronous and never showed it.
  const json = JSON.stringify({ generated_at: localStamp(), count: open.length, items: open }, null, 1);
  await new Promise((done) => process.stdout.write(json + '\n', done));
  process.exit(0);
}

const age = (o) => {
  if (o.due) {
    const d = o.lead_days;
    if (d == null) return o.due;
    if (d < 0) return `${o.due}  ${-d}d overdue`;
    if (d === 0) return `${o.due}  today`;
    return `${o.due}  in ${d}d`;
  }
  return o.days == null ? '' : o.days === 1 ? '1 day' : `${o.days} days`;
};

/** One chip per source with a count — not one per piece of evidence. */
function sources(o) {
  const n = new Map();
  for (const e of o.evidence) n.set(e.source, (n.get(e.source) ?? 0) + 1);
  return [...n].map(([s, c]) => (c === 1 ? s : `${s}\u00d7${c}`)).join('+');
}

function group(title, rows, by = 'days') {
  if (!rows.length) return;
  console.log(`\n${title.toUpperCase()}`);
  for (const o of sortObligations(rows, by)) {
    const pri = o.priority === 'normal' ? '' : ` [${o.priority}]`;
    const who = o.who ? `${o.who} — ` : '';
    // Headline first, paragraph indented under it. The list is read by
    // scanning the left column; a 200-character sentence there is not scanned.
    const tags = o.tags?.length ? '  ' + o.tags.map((t) => '#' + t).join(' ') : '';
    // The code leads the line: it is what he quotes back, so it belongs where
    // the eye already is rather than at the end of a sentence.
    console.log(`  ${(o.code ?? '').padEnd(7)}${age(o).padEnd(24)}${pri.padEnd(8)}${who}${o.title}   (${sources(o)})${tags}`);
    const pad = ' '.repeat(39);
    if (o.what && o.what !== o.title) console.log(`  ${pad}${o.what}`);
    if (o.closes) console.log(`  ${pad}closes when: ${o.closes}`);
    // The mail an obligation came from, once archiving is the normal outcome.
    // A task whose evidence you cannot reach is a task you have to take on
    // trust, and this list exists so he does not have to.
    for (const e of o.evidence) {
      if (e.detail?.link) console.log(`  ${pad}${e.detail.link}`);
    }
  }
}

// One obligation in full. The grouped view truncates and omits, which is right
// for a list and wrong when the question is about a single thing.
if (wanted) {
  if (!open.length) { console.log(`no obligation matches id ${wanted}`); process.exit(1); }
  for (const o of open) {
    console.log(`${o.id}\n  ${o.title}`);
    if (o.what && o.what !== o.title) console.log(`  what:      ${o.what}`);
    for (const [k, v] of [['who', o.who], ['due', o.due], ['owed_by', o.owed_by ?? 'me'],
                          ['priority', o.priority], ['closes', o.closes], ['open', o.open],
                          ['since', o.since], ['tag', o.tag]]) {
      if (v !== undefined && v !== null && v !== '') console.log(`  ${(k + ':').padEnd(10)} ${v}`);
    }
    for (const e of o.evidence ?? []) {
      console.log(`  evidence:  ${e.source ?? '?'} ${e.ref ?? ''}${e.detail?.link ? ' ' + e.detail.link : ''}`);
    }
  }
  process.exit(0);
}

const mine = (o) => (o.owed_by ?? 'me') !== 'them';
// Same split as the web page, and deliberately the same rule: two doors onto
// one list that disagree about what is urgent is worse than either alone.
// A date beats a priority flag. "High" on something due in twelve days means
// it matters, not that it is today — and letting it jump the queue is how a
// Today list fills up with things that are not.
const isToday = (o) => mine(o) && (o.due ? o.lead_days <= 0 : o.priority === 'high');

const today = open.filter(isToday);
const rest = open.filter((o) => !isToday(o));

// A filtered list that says only "0 open obligations" reads as "you owe
// nothing", which is the one thing it must never be mistaken for.
const lens = find ? ` matching "${find}"` : '';
console.log(`${open.length} open obligation${open.length === 1 ? '' : 's'}${lens} — ${localStamp()}`);
if (find && !open.length) console.log(`\nNothing matches "${find}". ${items.filter((o) => o.open).length} are open in total.`);
group('today', today, 'due');
group('upcoming', rest.filter((o) => o.due && mine(o)), 'due');
group('waiting on you', rest.filter((o) => !o.due && mine(o)));
group('waiting on others', rest.filter((o) => !mine(o)));

// Only on the unfiltered list. "Nothing outstanding" under a search that
// matched nothing says he owes nothing, which is the one sentence this script
// must never get wrong — the filtered case says so in its own words above.
if (!open.length && !find) console.log('\nNothing outstanding.');
