/**
 * The read-only dashboard pages.
 *
 * Ported from deploy/web/dashboard.py, which ran as a separate host process on
 * :7680. Merging it here removes a systemd unit, a port, a Cloudflare ingress
 * rule, and the relative-vs-absolute link special-casing that the split forced.
 *
 * It stays read-only by construction: this module only reads files and renders.
 * Nothing here mutates the repo, and no route reaches it with a request body.
 *
 * The one thing lost by moving into a container is systemd visibility — there is
 * no `systemctl` to call, and the fix for that is not installing one (see
 * timerStatus below). Everything else is file reads plus `git log`, and git is
 * in the image with the repo mounted.
 */
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { markdown, esc } from './web/markdown.mjs';
import { mailDue } from './mail-gate.mjs';
import { archivedAt, bare } from './trip-archive.mjs';
import { nav, tools } from './nav.mjs';
import { read as readCached } from '../integrations/mail-cache.mjs';
import { localStamp, humanStamp, humanDate } from './time.mjs';
import { listMessages } from './messages.mjs';

const run = promisify(execFile);


async function read(vault, rel, max = 6000) {
  try {
    return (await readFile(join(vault, rel), 'utf8')).slice(0, max);
  } catch {
    return '(missing)';
  }
}

/**
 * The schedule, as rows rather than a dump of two log files.
 *
 * Timer health comes from a snapshot the minute dispatcher writes on the host,
 * not from `systemctl` — this process runs in a container whose PID 1 is node,
 * so systemctl would have no systemd to talk to. Giving it one means mounting
 * the host's systemd control socket, which is write access to every unit on the
 * box: a larger grant than the docker socket, handed to the container that
 * processes untrusted email. A file that is at most 60 seconds stale is a
 * better trade for a panel about daily timers.
 *
 * The mail row is live, from the same predicate the scheduler uses, so the page
 * says what the gate will do next and why — "ran 12m ago, waiting 60m" — rather
 * than leaving that to be inferred from a timestamp.
 */
async function scheduleCard(vault) {
  const rows = [];
  const row = (name, status, detail, cls = '') =>
    `<div class="sched-row ${cls}"><span class=sched-name>${esc(name)}</span>` +
    `<span class=sched-status>${esc(status)}</span><span class=sched-detail>${esc(detail)}</span></div>`;

  let runs = {};
  try { runs = JSON.parse(await readFile(join(vault, '.log', 'job-runs.json'), 'utf8')); } catch {}

  const SLOTS = { morning: '07:00 daily, the brief', evening: '18:00 daily, journal and housekeeping', mail: 'when mail is waiting' };
  for (const [name, when] of Object.entries(SLOTS)) {
    const r = runs[name];
    if (!r) { rows.push(row(name, 'never run', when, 'sched-quiet')); continue; }
    rows.push(row(name, r.ok ? 'ok' : 'FAILED',
                  `${when} · last ${r.at ?? r.slot ?? '?'}`, r.ok ? 'sched-ok' : 'sched-bad'));
  }

  // The gate's own verdict, live.
  try {
    const v = await mailDue(vault, new Date(), runs);
    rows.push(row('mail gate', v.due ? 'due now' : 'holding', v.why,
                  v.stale ? 'sched-bad' : v.due ? 'sched-ok' : 'sched-quiet'));
  } catch (e) {
    rows.push(row('mail gate', 'unreadable', String(e.message), 'sched-bad'));
  }

  // The one timer still on the host: the minute dispatcher. Its snapshot is
  // systemd's table; the row that matters is the LAST/PASSED pair.
  try {
    const raw = await readFile(join(vault, '.log', 'timers'), 'utf8');
    const m = /obligations-dispatch\.timer/.exec(raw);
    const line = raw.split('\n').find((l) => l.includes('obligations-dispatch.timer')) ?? '';
    const passed = /(\d+(?:ms|s|min|h)[^ ]*) ago/.exec(line)?.[1];
    rows.push(row('dispatcher', m ? 'every minute' : 'not found',
                  passed ? `last tick ${passed} ago` : 'no snapshot yet',
                  m ? 'sched-ok' : 'sched-bad'));
  } catch {
    rows.push(row('dispatcher', 'no snapshot', '.log/timers is written by the host timer', 'sched-quiet'));
  }

  return `<div class=sched>${rows.join('')}</div>`;
}

/**
 * What each scheduled job last said — in full.
 *
 * `job-runs.json` answers "did it run"; this answers "and what did it decide".
 * Alex asked for the whole message rather than a truncated one, so each job's
 * latest report is here complete, one collapsed <details> per job. Collapsed,
 * because three full reports open at once is a page you read rather than glance
 * at — the thing the layout test exists to catch — and a tap is the right price
 * for the full text. The summary line carries what you would scan for anyway:
 * when it ran, how long, and what it cost.
 */
async function lastJobOutput(vault) {
  const out = [];
  for (const name of ['morning', 'evening', 'mail']) {
    let text;
    try {
      text = await readFile(join(vault, '.log', 'jobs', `${name}-latest.md`), 'utf8');
    } catch {
      continue;                       // never run since this was added
    }
    const [head, ...rest] = text.split('\n\n');
    const meta = head.split('\n').slice(1).join(' · ').replace(/^ran: /, '').trim();
    const body = rest.join('\n\n').trim();
    out.push(`<details class=job><summary><span class=job-name>${esc(name)}</span>` +
             `<span class=job-meta>${esc(meta)}</span></summary>` +
             `<div class=job-body>${markdown(body, 3)}</div></details>`);
  }
  return out.length ? out.join('') : '<p class=mut>no job has produced output yet</p>';
}

/**
 * Recent commits as rows: when, what. The hash is there but quiet — it is for
 * the terminal, not for reading.
 *
 * The subject is clamped for DISPLAY, with the whole thing on the row's title.
 * The principle that the commit message is the record and must not be reshaped
 * by a dashboard still holds — git holds the record, and nothing here rewrites
 * it. What changed is that ten unclamped subjects pushed this panel past the
 * glance cap the layout guard enforces, which is the guard doing its job: a
 * long-form commit style arrived and the panel silently became a reader.
 */
const ACT_SUBJ = 88;      // ~one line at the panel's width
async function activityRows(vault) {
  try {
    const { stdout } = await run('git', ['-C', vault, 'log', '--format=%h%x09%ar%x09%s', '-10'],
                                 { timeout: 5000 });
    const rows = stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [hash, when, ...rest] = l.split('\t');
      const subj = rest.join('\t');
      const shown = subj.length > ACT_SUBJ ? subj.slice(0, ACT_SUBJ - 1).trimEnd() + '…' : subj;
      return `<div class=act-row title="${esc(subj)}"><span class=act-when>${esc(when)}</span>` +
             `<span class=act-subj>${esc(shown)}</span>` +
             `<span class=act-hash>${esc(hash)}</span></div>`;
    });
    return rows.length ? `<div class=act>${rows.join('')}</div>` : '<p class=mut>(no commits)</p>';
  } catch (err) {
    return `<p class=mut>(unavailable: ${esc(err.message)})</p>`;
  }
}

async function journalDays(vault) {
  try {
    return (await readdir(join(vault, 'journal'))).filter((n) => /^2\d{3}-\d{2}-\d{2}\.md$/.test(n))
      .map((n) => n.slice(0, -3)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * The newest journal day, in full, followed by links to the days before it.
 *
 * It used to be one day capped at 900 characters — "the full entry is a file;
 * this is a glance" — which was right when the journal shared a page with three
 * other things and wrong once Alex asked what the page was for: "is the notes
 * page just the memory of everything? always show full entries, or make them
 * linkable." Both. The notes page is not the memory of everything — that is
 * journal/, people/ and projects/ together — but the journal half of it should
 * read whole, and every earlier day is one link away at /journal/<date>.
 */
async function latestJournal(vault) {
  const days = await journalDays(vault);
  if (!days.length) return '(no entries yet)';
  const body = (await read(vault, join('journal', `${days[0]}.md`), 200000)).trim();
  const earlier = days.slice(1, 15).map((d) => `<a class=jday href="/journal/${d}">${d}</a>`).join('');
  return body + (earlier ? `\n\n<div class=jdays>earlier: ${earlier}</div>` : '');
}

/** One journal day, in full, as its own page. Null when there is no such day. */
export async function journalPage(vault, unread, date) {
  const days = await journalDays(vault);
  if (!days.includes(date)) return null;
  const body = (await read(vault, join('journal', `${date}.md`), 200000)).trim();
  const i = days.indexOf(date);
  const nav = [
    i + 1 < days.length ? `<a class=jday href="/journal/${days[i + 1]}">‹ ${days[i + 1]}</a>` : '',
    `<a class=jday href="/notes">notes</a>`,
    i > 0 ? `<a class=jday href="/journal/${days[i - 1]}">${days[i - 1]} ›</a>` : '',
  ].filter(Boolean).join('');
  return shell({
    title: `journal ${date}`, current: '/notes', unread,
    body: `<div class=col><div class=jdays>${nav}</div><div class=card>${markdown(body, 1)}</div></div>`,
  });
}

async function messagesPanel(vault) {
  let d;
  try {
    d = JSON.parse(await readFile(join(vault, 'integrations', 'imessage.json'), 'utf8'));
  } catch {
    return '<p class=mut>iMessage integration is not set up ' +
           '(see deploy/integrations/README.md)</p>';
  }

  const gen = new Date(String(d.generated_at).replace(' ', 'T'));
  const mins = Math.round((Date.now() - gen.getTime()) / 60000);
  const stale = mins > 180;
  const age = mins < 60 ? `${mins} min old`
            : `${Math.round(mins / 60)}h old`;

  const buckets = { '12–48h': 0, '2–7d': 0, 'over a week': 0 };
  for (const t of d.threads ?? []) {
    const h = t.awaiting_reply_hours;
    if (h == null || h < 12) continue;
    buckets[h < 48 ? '12–48h' : h < 168 ? '2–7d' : 'over a week']++;
  }

  // The list itself is rendered client-side by web/dashboard.js — it is the one
  // interactive thing here, since an item can be closed by hand.
  const rows = Object.entries(buckets)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('');

  return `<table>
<tr><th>extract</th><td class="${stale ? 'overdue' : ''}">${esc(d.generated_at)} · ${esc(age)}` +
    (stale ? ' — the Mac is probably asleep; these are not today' : '') + `</td></tr>
<tr><th>threads</th><td>${d.thread_count ?? '?'}</td></tr>
<tr><th>last word not yours</th><td>${d.awaiting_reply ?? '?'} — mostly finished conversations</td></tr>
</table>
<p class=mut style="margin-top:.6rem">Tap a task to read the thread it came from
and answer it. The full reasoning behind the ranking is in the brief under
<a href="/messages">messages</a>.</p>`;
}

async function failures(vault) {
  try {
    const t = (await readFile(join(vault, '.log', 'FAILURES'), 'utf8')).trim();
    if (!t) return '';
    return `<h2>⚠ failures</h2><div class=card><pre>${esc(t.slice(-1500))}</pre></div>`;
  } catch {
    return '';
  }
}

/**
 * now.md as cards, one per `##` section.
 *
 * Rendered whole, it was a 19,000-pixel scroll: the H1, every section, and the
 * HTML comments that tell the compaction routine what each section is for —
 * those rendered as visible text, because the markdown renderer escapes rather
 * than strips them (correctly; they are not to be trusted as markup). Stripped
 * here before rendering, because they are instructions to the writer, not
 * content for the reader.
 */
async function nowSections(vault) {
  const raw = await read(vault, 'now.md', 20000);
  if (raw === '(missing)') return { title: null, cards: '<p class=mut>now.md does not exist yet</p>' };
  const clean = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^>.*$/gm, '');
  const title = /^#\s+(.+)$/m.exec(clean)?.[1]?.trim() ?? null;
  const parts = clean.split(/^##\s+/m).slice(1);
  const cards = parts.map((part) => {
    const nl = part.indexOf('\n');
    const heading = part.slice(0, nl).trim();
    const body = part.slice(nl + 1).trim();
    const meat = body.replace(/^[-*]\s*(\[[ x]\])?\s*$/gm, '').trim();
    return `<div class=card><h3>${esc(heading)}</h3>` +
           (meat ? markdown(body, 3) : '<p class=mut>nothing here this week</p>') + '</div>';
  });
  return { title, cards: cards.join('') || '<p class=mut>now.md has no sections</p>' };
}

/**
 * The shell every dashboard page shares: head, palette, top bar, nav.
 *
 * One page per thing, rather than one page holding everything. The single
 * dashboard put reminders, tasks, notes and machine state on one scroll, so
 * reaching any one of them meant scrolling past the other three — on a phone
 * that is most of the screen budget spent on things you did not open it for.
 */
/* NO TIMED RELOAD. Every page but the ones that opted out carried
   <meta http-equiv=refresh content=180> — a reload every three minutes, which
   threw away a reply half-written in the task pane. Alex, 2026-10-05: "lets
   stop the auto page refreshes. Sometimes I am in the middle of writing a
   reply, and the page refreshes." The pages fetch their own data when opened
   and Today follows the events stream; a reload is his pull, never a timer. */
function shell({ title, heading, stamp, current, unread, body, panes = false }) {
  // Every page is `wide`: the frame fills the window and the header sits hard
  // against the left, so the top bar does not move as you navigate. `panes`
  // adds the two-column behaviour — full window height, list and pane
  // scrolling separately — and only the pages that have two columns get it.
  // Prose pages keep a reading measure on their CONTENT, not on the frame.
  //
  // Two rows at the top, not one. Alex, 2026-09-19: "make the Obligations UI feel
  // nicer … right now it feels very component code driven." The masthead is
  // the brand and the navigation, the same on every page; the page heading
  // beneath it is what THIS page is — Today's is the date, because that is
  // what a desk says — with the clock as a person reads it, not a file stamp.
  return `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>obligations — ${esc(title)}</title>
<script>try{var t=localStorage.getItem('obligations.theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel=stylesheet href="/assets/style.css">
<div class="wrap wide${panes ? ' panes' : ''}">
<div class=top>
  <a class=brand href="/">obligations</a>
  ${nav(current, unread)}
  ${tools()}
</div>
<!-- HIS SWITCH, WHEN IT IS THROWN. Alex, 2026-09-21, building the model
     toggle. Off and idle must not render the same: a quiet mail page and one
     where judgement is paused look identical, and the second is a decision he
     made and can forget. Filled by drawer.js, which runs on every page, so no
     page builder has to know about it. Hidden while runs are on. -->
<div id=modelgate class=gatebar hidden></div>
<div class=pagehead>
  <h1>${esc(heading ?? title)}</h1>
  <span class=stamp>${esc(stamp ?? humanStamp())}</span>
</div>
${body}
</div>
<script type=module src="/assets/dashboard.js"></script>
<script type=module src="/assets/digest.js"></script>
<script type=module src="/assets/people.js"></script>
<script type=module src="/assets/today.js"></script>
<script type=module src="/assets/search.mjs"></script>
<script type=module src="/assets/reference.js"></script>
<script type=module src="/assets/drawer.js"></script>
`;
}

/**
 * Tasks: everything outstanding, in one place.
 *
 * Three sections, because they are three different questions with three
 * different remedies:
 *
 *   due               — anything with a deadline, whatever it came from
 *   waiting on you    — something he owes someone
 *   waiting on others — something he asked for and never got
 *
 * All three come from one call to `/api/obligations`, which is the whole point
 * of the obligation model: a reminder, a hand-typed task and a thread the
 * triage judged are the same kind of thing, and the page no longer needs to
 * know which store any of them came from. The split here is by *deadline and
 * direction*, not by source.
 */
/**
 * One mail thread, read from the local cache.
 *
 * Alex, 2026-09-02: show the content in the UI "rather than loading you into
 * Gmail". A task whose evidence is a link to somewhere else is a task you have
 * to leave the page to understand.
 *
 * **Rendered as escaped text, never as the sender's HTML.** Injecting a
 * stranger's markup into a page served from obligations.example.com would hand any
 * sender a script tag on his own origin, behind his own Access session. The
 * cache stores plain text for exactly this reason; this function escapes it
 * again anyway, because two independent reasons a thing is safe is the right
 * number for content nobody vetted.
 */
export async function threadPage(vault, unread, account, threadId) {
  const t = await readCached(vault, account, threadId);
  if (!t) {
    return shell({
      title: 'thread', current: '/tasks', unread,
      body: `<div class=card><p>Not cached.</p>
<p class=mut>The cache holds threads the assistant has judged. Run
<code>node deploy/integrations/mail-cache.mjs ${esc(account)} ${esc(threadId)}</code>
to fetch this one, or open it in Gmail.</p></div>`,
    });
  }

  const messages = t.messages.map((m) => {
    const files = m.attachments.length
      ? `<p class=mut>attached: ${m.attachments
          .map((a) => `${esc(a.filename)} <span class=mut>(${Math.round(a.bytes / 1024)}KB)</span>`)
          .join(' · ')}</p>`
      : '';
    return `<div class=card style="margin-bottom:.8rem">
  <p style="margin:0 0 .3rem"><strong>${esc(m.from)}</strong>
     <span class=mut>${esc(m.date)}</span></p>
  <p class=mut style="margin:0 0 .6rem">to ${esc(m.to)}${m.cc ? ` · cc ${esc(m.cc)}` : ''}</p>
  ${files}
  <pre style="white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:inherit">${esc(m.text)}</pre>
  ${m.truncated ? '<p class=mut>[truncated]</p>' : ''}
</div>`;
  }).join('\n');

  return shell({
    title: t.subject.slice(0, 60), current: '/tasks', unread,
    body: `<p class=mut>${esc(t.account)} · ${t.messages.length} message(s) ·
  <a href="https://mail.google.com/mail/u/?authuser=${encodeURIComponent(t.account)}#all/${esc(t.thread_id)}">open in Gmail</a></p>
${messages}`,
  });
}

export async function tasksPage(vault, unread) {
  return shell({
    title: 'to do', current: '/todo', unread, panes: true,
    body: `${await failures(vault)}
<div class=filt id=filt role=tablist>
  <!-- The map: projects as circles. Alex, 2026-09-30: "I love mind maps …
       this will not replace anything; we'll just add to what we have." -->
  <button type=button data-f=map>Map</button>
  <!-- Today, Upcoming and No date, as one page since 2026-10-03. Alex:
       "Combine today, upcoming, no date on one page." -->
  <button type=button data-f=today>Mine <b id=n-today></b></button>
  <button type=button data-f=owed>Waiting on others <b id=n-owed></b></button>
  <!-- By project is the projects page too since 2026-10-04: new, edit,
       archive, what leads the briefs (web/project-forms.mjs). -->
  <button type=button data-f=projects>By project <b id=n-projects></b></button>
  <!-- The Outbox, merged in on 2026-09-19. Alex: "here are the To Do's with
       items Drafted so you can see which task the entry is for." -->
  <button type=button data-f=drafted>Drafted <b id=n-drafted></b></button>
  <!-- What was closed, and by whom. Alex's review, 2026-09-20: a closed item
       had no page, so a wrong close could not be seen or taken back. -->
  <button type=button data-f=closed>Closed <b id=n-closed></b></button>
  <!-- A project filter, on By project only. Alex, 2026-10-04: "we'll
       remove tags because they are now going to be by project … maybe we'll
       have a project filter … on the project tab" — and the same day the
       Projects tab became By project. Kind tags have their own homes now:
       bills are the Pay lane, decisions the Decide lane. -->
  <select id=tagsel class=tagsel aria-label="Filter by project" hidden><option value="">all projects</option></select>
</div>
<div class=split id=split>
  <div class=listcol>
    <div class=sortbar id=sortbar>
      <!-- Four sorts, each one list (Alex, 2026-10-03). -->
      <button type=button data-s=priority>priority</button>
      <button type=button data-s=due>due date</button>
      <button type=button data-s=oldest>oldest</button>
      <button type=button data-s=newest>newest</button>
    </div>
    <div class=list id=tasklist><div class=empty>loading…</div></div>
  </div>
  <div class=pane id=taskpane><div class=empty>Select a task.</div></div>
</div>
<div id=workdock class=composer-dock></div>`,
  });
}

/**
 * Digest: everything judged, nothing owed.
 *
 * Replaces the reading page. Alex, 2026-09-04: "we need a digest tab. The
 * reading list needs an overhaul, those really should be in the digest and then
 * accessible if you want a deep dive. There was nothing special about the
 * newsletter forward list you imported."
 *
 * The old page queried Gmail live for unread mail from the senders in his
 * imported filters file — membership by provenance, running beside the triage
 * rather than out of it. This one reads conclusions, so a row can say what the
 * thread WAS instead of repeating the sender's subject line back at him. See
 * digestlist.mjs.
 *
 * Client-rendered like the pages it sits beside: the shell and its navigation
 * paint immediately, the list fills in.
 */
export async function digestPage(vault, unread) {
  return shell({
    title: 'mail', current: '/mail', unread, panes: true,
    body: `<div class=filt id=digfilters></div>
<div class="mut read-count" id=digcount></div>
<div class=split id=digsplit>
  <div class=list id=diglist><div class=empty>loading…</div></div>
  <div class=pane id=digpane><div class=empty>Select an item.</div></div>
</div>
<div id=digdock class=composer-dock></div>`,
  });
}

/**
 * Today: the front door.
 *
 * Alex, 2026-09-05: "A chief of staff's desk isn't a chat window or a filing
 * cabinet; it's one screen that says here's your day." Served at / — the chat
 * moved to /chat. One API call assembles it; web/today.js draws it.
 */
export async function todayPage(vault, unread) {
  return shell({
    // The date is the headline, so the stamp is only the clock — "Saturday 19
    // September · Sat 19 Sep" said the same thing twice.
    title: 'today', heading: humanDate(), stamp: localStamp().slice(11), current: '/', unread, panes: false,
    body: `<div id=today class=col><div class=empty>assembling…</div></div>
<div id=todaydock class=composer-dock></div>`,
  });
}

/**
 * Priorities: what he is for, and what moved on it.
 *
 * Alex, 2026-09-05: "Do we have a UI for priorities?" The file, the report and
 * the briefs existed; the one file in the system that is his to write had no
 * door on a phone. This is the door, and it edits the file.
 */
/* /projects is To Do opened on its Projects tab. Alex, 2026-09-30: "can we
   port the /projects on to the to-do page, so we don't need a page refresh?"
   It was its own page wearing To Do's tabs; now it is one of them. The path
   still answers — it is on his home screen and in past briefs — and
   dashboard.js swaps it for /todo?f=projectlist without a reload. */
export async function prioritiesPage(vault, unread) {
  return tasksPage(vault, unread);
}

/**
 * People: who, and what stands between you.
 *
 * Alex, 2026-09-05, from the chief-of-staff audit: 492 senders judged, 3 with
 * a file, 50 who wrote three or more times and were strangers to the system.
 * The graph is derived by people.mjs from what already exists — people/ files,
 * the `who` on every conclusion, open obligations — so this page is never stale
 * and there is no index file to drift.
 */
export async function peoplePage(vault, unread) {
  return shell({
    title: 'people', current: '/people', unread, panes: true,
    body: `<div class=filt id=ppfilters></div>
<div class="mut read-count" id=ppcount></div>
<div class=split id=ppsplit>
  <div class=list id=pplist><div class=empty>loading…</div></div>
  <div class=pane id=pppane><div class=empty>Select a person.</div></div>
</div>
<div id=ppdock class=composer-dock></div>`,
  });
}

/**
 * Reference: the facts nobody owes anything on.
 *
 * Alex, 2026-09-03: "build out the reference section on the web UI, where we
 * store trip confirmations etc. we should group it by trips."
 *
 * Grouped by trip because that is how the questions arrive — "where are we
 * staying in Cape Harbor", not "show me hotel confirmations". The grouping
 * lives in `reference/bookings.md` itself as `##` headings, the same shape
 * now.md uses, so there is no second file to drift and the answer is still
 * greppable from a terminal. A trip is a heading; the room, the car, the
 * tickets and the cancelled duplicate are the bullets under it.
 *
 * Rendered whole rather than fetched: bookings are 60 lines, and an API call
 * for that would be machinery earning nothing.
 */
async function referenceGroups(vault) {
  const raw = await read(vault, 'reference/bookings.md', 60000);
  if (raw === '(missing)') return [];
  /* THE ARCHIVE FLAG IS READ BEFORE THE COMMENTS ARE STRIPPED. It lives in an
     HTML comment on the heading — see trip-archive.mjs for why there and not
     in a second file — and this function's first act is to delete every
     comment in the document, so reading it afterwards would find nothing and
     report every trip as live. */
  const flags = new Map();
  for (const line of raw.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) flags.set(bare(m[1]).trim(), archivedAt(m[1]));
  }
  const clean = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^>.*$/gm, '');
  return clean.split(/^##\s+/m).slice(1).map((part) => {
    const nl = part.indexOf('\n');
    const heading = part.slice(0, nl).trim();
    const body = part.slice(nl + 1).trim();
    // "Name · dates" — split once, so a name containing a separator survives.
    const dot = heading.lastIndexOf(' · ');
    return {
      name: dot === -1 ? heading : heading.slice(0, dot).trim(),
      when: dot === -1 ? '' : heading.slice(dot + 3).trim(),
      count: (body.match(/^- /gm) ?? []).length,
      archived: flags.get(heading) ?? null,
      body,
    };
  });
}

/**
 * Mail that was filed rather than acted on, newest first, each linking to the
 * thread itself.
 *
 * Alex, 2026-09-03: "is the digest only surfaced in the brief? Where do I see
 * deep links if I want to." It was, and there was nowhere. The brief gives a
 * grouped count — "11 social notifications, 6 payment receipts" — which is the
 * right shape for 07:00 and useless when you want the actual receipt. Every
 * conclusion already carries its thread, and /thread/<account>/<id> already
 * renders the cached body, so the link was there and unexposed.
 */
async function referenceFiled(vault, limit = 60) {
  const TIERS = ['digest', 'reading', 'awareness', 'memory', 'ephemeral'];
  let state;
  try {
    state = JSON.parse(await readFile(join(vault, 'integrations', 'email-state.json'), 'utf8'));
  } catch {
    return { rows: [], total: 0 };
  }
  const all = (state.threads ?? [])
    .filter((t) => t.conclusion && TIERS.includes(t.conclusion.tier))
    .sort((a, b) => String(b.reviewed ?? '').localeCompare(String(a.reviewed ?? '')));
  const rows = all.slice(0, limit).map((t) => {
    const c = t.conclusion;
    const to = `/thread/${t.account || 'personal'}/${t.thread_id}`;
    return `<div class=filed-row><span class="ob-src">${esc(c.tier)}</span>` +
      `<a class=filed-link href="${esc(to)}">${esc(c.title || c.what || t.thread_id)}</a>` +
      `<span class=filed-who>${esc(c.who ?? '')}</span>` +
      `<span class=filed-when>${esc(String(t.reviewed ?? '').slice(0, 10))}</span></div>`;
  });
  return { rows, total: all.length };
}

/** The documents filed to Drive, newest first. One line each, as recorded. */
async function referenceDocs(vault, limit = 40) {
  const raw = await read(vault, 'reference/statements.md', 400000);
  if (raw === '(missing)') return { rows: [], total: 0, groups: [] };
  const all = raw.split('\n').filter((l) => l.startsWith('- '));
  // Grouped by who sent them — "where is my LFC statement" is the question
  // this section answers, and a flat list of 700 lines does not. The sender
  // is the quoted organisation when the line has one, else the name before
  // the address, else the address's domain.
  // A line is `- DATE — **Title** from SENDER · [file](link) · size · msg:id`;
  // "from" also appears inside titles ("Invoice from Anthropic"), so the
  // sender is what follows the closing ** and precedes the first ` · `.
  const by = new Map();
  for (const l of all) {
    const m = l.match(/^- \d{4}-\d{2}-\d{2} — \*\*.*?\*\* from (.+?) · \[/);
    const sender = (m?.[1] ?? '').trim();
    const q = sender.match(/^"([^"]+)"/);
    const named = sender.replace(/\s*<?\S+@\S+>?\s*$/, '').trim();
    const domain = (sender.match(/@([\w.-]+)/) ?? [])[1] ?? '';
    const key = q?.[1] || named || domain || 'unknown sender';
    if (!by.has(key)) by.set(key, { name: key, lines: [] });
    by.get(key).lines.push(l);
  }
  const groups = [...by.values()].map((g) => ({ ...g, count: g.lines.length, latest: (g.lines[0].match(/^- (\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? '' }))
    .sort((a, b) => (b.latest > a.latest ? 1 : b.latest < a.latest ? -1 : b.count - a.count));
  return { rows: all.slice(0, limit), total: all.length, groups };
}

export async function referencePage(vault, unread) {
  const groups = await referenceGroups(vault);
  const docs = await referenceDocs(vault);

  // Three sections, one list. Alex, 2026-09-05: "split that up into
  // bookings, Documents, Filed Mail." Each row carries its section so the
  // chips can show one at a time on a phone.
  const head = (key, title, count) => `<div class="sec-head ref-sec" data-sec="${key}"><span class=sec-title>${title}  ·  ${count}</span></div>`;
  const row = (ref, sec, who, age, preview) =>
    `<div class="ob ref-row" data-ref="${ref}" data-sec="${sec}"><div class="ob-inner ob-row">` +
    `<div class=ob-who>${esc(who)}</div><span class=ob-age>${esc(String(age))}</span>` +
    `<div class="ob-preview">${esc(preview)}</div></div></div>`;
  const live = groups.filter((g) => !g.archived);
  const shelved = groups.filter((g) => g.archived);
  const rows =
    head('bookings', 'bookings', live.length) +
    (groups.length ? groups.map((g, i) => row(i, g.archived ? 'archived' : 'bookings', g.name, g.when,
      `${g.count} booking${g.count === 1 ? '' : 's'}${g.archived ? ` · archived ${g.archived}` : ''}`)).join('') : '<div class=empty>no trips on file</div>') +
    (shelved.length ? head('archived', 'archived trips', shelved.length) : '') +
    head('documents', 'documents', docs.total) +
    (docs.groups.length ? docs.groups.map((g, i) => row(`doc-${i}`, 'documents', g.name, g.latest, `${g.count} document${g.count === 1 ? '' : 's'} in Drive`)).join('') : '<div class=empty>nothing filed yet</div>') +
    '';

  const paneOf = (ref, title, metaHtml, bodyHtml, actsHtml = '') =>
    `<div class=ref-pane data-ref="${ref}" hidden><div class=pane-inner>` +
    `<div class=pane-head><h3 class=pane-title>${esc(title)}</h3><div class=ob-meta>${metaHtml}</div></div>` + actsHtml + bodyHtml + '</div></div>';
  /* Trips only. Alex, 2026-09-19: "specially for trips, there should be an
     Archive button." A filed document has no equivalent — it is one line
     pointing at Drive, and there is nothing to put away. */
  const tripActs = (g) =>
    '<div class=ref-acts><button type=button class="pane-act trip-archive" '
    + `data-trip="${esc(g.name)}" data-archived="${g.archived ? '1' : '0'}">`
    + (g.archived ? 'Restore to bookings' : 'Archive this trip') + '</button>'
    + (g.archived ? `<span class=mail-acts-why>Archived ${esc(g.archived)}. It stays in reference/bookings.md and still counts for travel conflicts.</span>` : '')
    + '</div>';
  const panes =
    groups.map((g, i) => paneOf(i, g.name, `<span class=ob-age>${esc(g.when)}</span>`, markdown(g.body, 3), tripActs(g))).join('') +
    docs.groups.map((g, i) => paneOf(`doc-${i}`, g.name, `<span class=ob-age>${g.count} filed</span><span class=ob-who>newest ${esc(g.latest)}</span>`, markdown(g.lines.join('\n'), 3))).join('') +
    '';

  return shell({
    title: 'reference', current: '/reference', unread, panes: true,
    body: `<div class=filt id=reffilters></div>
<div class=split id=refsplit>
  <div class=list id=reflist>${rows || '<div class=empty>Nothing filed yet.</div>'}</div>
  <div class=pane id=refpane>${panes}<div class="empty ref-empty">Select a trip.</div></div>
</div>`,
  });
}

/**
 * His standing lists, readable and undoable. Alex, 2026-09-30: "where can
 * you see the list of bills on autopay?" — nowhere; the file and a chat
 * command. The ignore list had the same gap: the Mail page showed only how
 * many were ignored. Both are his (a job never adds to either), so both are
 * shown whole, with what each entry is for and a way off it.
 */
async function standingLists(vault) {
  const row = (who, meta, why, btn) =>
    `<div class=filed-row><span class=filed-link>${esc(who)}</span><span class=filed-who>${esc(meta)}</span>`
    + (why ? `<span class="filed-who mut">${esc(why)}</span>` : '') + btn + '</div>';
  const btn = (kind, key, label) => `<button type=button class=sec-action data-unlist="${kind}" data-key="${esc(key)}">${label}</button>`;
  let autopay = '', ignored = '';
  try {
    const { readAutopay } = await import('./autopay.mjs');
    const v = await readAutopay(vault);
    const keys = Object.keys(v).sort((a, b) => String(v[a].name ?? a).localeCompare(String(v[b].name ?? b)));
    autopay = keys.length
      ? keys.map((k) => row(v[k].name ?? k,
          `${v[k].name ? k + ' · ' : ''}${v[k].accounts?.length ? `account${v[k].accounts.length > 1 ? 's' : ''} ending ${v[k].accounts.join(', ')}` : 'every account'} · since ${String(v[k].since ?? '').slice(0, 10)}`,
          v[k].note ?? '', btn('autopay', k, 'Remove'))).join('')
      : '<p class=mut>Nothing yet. Tap <b>On autopay</b> on a bill in To Do to add its vendor.</p>';
  } catch (err) { autopay = `<p class=mut>the autopay list could not be read: ${esc(String(err?.message ?? err))}</p>`; }
  try {
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'ignored-senders.json'), 'utf8'));
    const s = d?.senders ?? {};
    const keys = Object.keys(s).sort();
    ignored = keys.length
      ? keys.map((k) => row(k, `since ${String(s[k]?.since ?? '').slice(0, 10)}${s[k]?.closed?.length ? ` · closed ${s[k].closed.length} task${s[k].closed.length === 1 ? '' : 's'}` : ''}`,
          s[k]?.name ?? '', btn('ignored', k, 'Un-ignore'))).join('')
      : '<p class=mut>Nobody is ignored.</p>';
  } catch { ignored = '<p class=mut>Nobody is ignored.</p>'; }
  return `<h2 id=standing>standing lists</h2>
<div class=card><h3>on autopay</h3><p class=mut>A bill from these is filed with its amount, never a task — unless the payment fails.</p><div class=filed>${autopay}</div></div>
<div class=card><h3>ignored senders</h3><p class=mut>Mail from these is archived without being judged, listed or counted. Un-ignoring reopens the tasks the ignore closed.</p><div class=filed>${ignored}</div></div>`;
}

export async function notesPage(vault, unread) {
  const now = await nowSections(vault);
  return shell({
    title: 'notes', current: '/notes', unread,
    body: `<div class=col><a class=crumb href="/system">‹ system</a><h2>${esc(now.title ?? 'now')}</h2>
<div class="grid two notes-grid">${now.cards}</div>

<p class="mut notes-pointer">Hand-typed tasks live in <a href="/tasks">tasks</a> with everything else — todo.md is one of its sources, not a second list.</p>

${await standingLists(vault)}

<h2>journal</h2><div class=card>${markdown(await latestJournal(vault), 2)}</div></div>`,
  });
}

/**
 * The system talking about itself: every `failure` message, newest first, with
 * a link to read and dismiss it on Briefs. Alex, 2026-09-06: "separate the
 * failure messages, currently under briefs, should be under system."
 */
async function failuresCard(vault, limit = 12) {
  let all = [];
  try { all = await listMessages(join(vault, 'messages')); } catch { return '<p class=mut>the messages folder could not be read</p>'; }
  const fails = all.filter((m) => m.kind === 'failure').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!fails.length) return '<p class=mut>nothing has failed. A failure message is written when a job does not run, a push cannot be delivered, or the mail watch cannot arm.</p>';
  const rows = fails.slice(0, limit).map((m) =>
    `<div class=filed-row><span class=filed-when>${esc(String(m.at).slice(0, 16))}</span>` +
    `<a class=filed-link href="/briefs#pane=${encodeURIComponent(m.id)}">${esc(m.title)}</a>` +
    `<span class=filed-who>${m.read ? 'read' : 'unread'}${m.delivered && m.delivered !== 'none' ? ' · pushed by ' + esc(m.delivered) : ''}</span></div>`).join('');
  return `<p class=mut>${fails.length} failure message${fails.length === 1 ? '' : 's'}${fails.length > limit ? `, newest ${limit} shown` : ''} · ${fails.filter((m) => !m.read).length} unread</p><div class=filed>${rows}</div>`;
}

/** The assistant's own scorecard: the last line of .log/trust.jsonl and the week. */
async function trustCard(vault) {
  try {
    const { readTrust, trustLine, trend } = await import('../trust.mjs');
    const rows = await readTrust(vault);
    const last = rows[rows.length - 1] ?? null;
    const t = trend(rows);
    const line = esc(trustLine(last));
    const week = t ? `<div class=mut>last ${t.days} days: the assistant closed ${t.closed_agent}, you closed ${t.closed_him}, ${t.reopened} reopened, ${t.dismissed} dismissed as not a task; findings ${t.findings_delta >= 0 ? '+' : ''}${t.findings_delta}; median wait on others ${t.owed_them_median_delta >= 0 ? '+' : ''}${t.owed_them_median_delta}d</div>` : '';
    return `<div class=prose>${line}</div>${week}<div class=mut>recorded by the 18:00 run, told in the morning brief; reopened and dismissed are the disagreements</div>`;
  } catch (err) { return `<div class=mut>trust ledger unreadable: ${esc(String(err?.message ?? err))}</div>`; }
}

/**
 * The model switch, as a control he can actually reach.
 *
 * Alex, 2026-09-21: "I am about to run out of claude credits for the week. I
 * want to build a 'Model Enabled' toggle, where we can turn on and off
 * anything that requires a claude model."
 *
 * It lives on System because that is where the assistant talks about itself, and
 * the banner on every other page is what stops it being forgotten there. The
 * card says what stops AND what does not — the value of this switch is that
 * the deterministic half of the assistant keeps working, and a control that only
 * said "off" would read as switching the assistant off.
 */
async function modelCard(vault) {
  try {
    const { readGate, statusLine, skipTotal, SPENDERS } = await import('./model-gate.mjs');
    const g = await readGate(vault);
    const spend = Object.values(SPENDERS).join(', ');
    const keeps = 'the minute dispatcher, both differs, the drafts pass, the closes the '
      + 'reconciliation makes on its own, conflicts, meeting prep and the calendar';
    if (g.enabled) {
      return `<div id=models><div><b>Model runs are on.</b></div>
<div class=mut>Paused, these stop: ${esc(spend)}. These do not: ${esc(keeps)}. The chat is never gated.</div>
<div class=ob-actions>
  <button type=button class="sec-action" id=mg-off>Pause model runs</button>
  <button type=button class="sec-action" id=mg-off-week>Pause until the Tuesday 18:00 reset</button>
</div>
<div class=mut id=mg-msg></div></div>`;
    }
    const n = skipTotal(g);
    const rows = Object.entries(g.skipped ?? {}).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<div class=ob-evrow><span>${esc(SPENDERS[k] ?? k)}</span><span class=ob-age>${v} skipped</span></div>`).join('');
    return `<div id=models><div><b>Model runs are off.</b></div>
<div class=prose>${esc(statusLine(g) ?? '')}</div>
${n ? `<div class=ob-ev>${rows}</div>` : ''}
<div class=mut>Still running: ${esc(keeps)}. Nothing has been lost — the threads are still waiting and the briefs you are owed will run when this goes back on.</div>
<div class=ob-actions><button type=button class="sec-action" id=mg-on>Turn model runs back on</button></div>
<div class=mut id=mg-msg></div></div>`;
  } catch (err) { return `<div class=mut>the model switch is unreadable: ${esc(String(err?.message ?? err))}</div>`; }
}

export async function systemPage(vault, unread) {
  return shell({
    title: 'system', current: '/system', unread,
    body: `<div class=col>${await failures(vault)}
<p class=sys-sub>Also here: <a href="/notes">notes</a> — this week, the journal, and the standing lists (autopay, ignored senders).</p>
<h2>failures</h2><div class=card>${await failuresCard(vault)}</div>
<h2>model runs</h2><div class=card>${await modelCard(vault)}</div>
<h2>trust</h2><div class=card>${await trustCard(vault)}</div>
<h2>schedule</h2><div class=card>${await scheduleCard(vault)}</div>

<h2>message extract</h2><div class=card>${await messagesPanel(vault)}</div>

<h2>last job output</h2><div class=card>${await lastJobOutput(vault)}</div>

<h2>recent activity</h2><div class=card>${await activityRows(vault)}</div></div>`,
  });
}

/** Path → renderer. The server routes off this; the tests iterate it. */
/**
 * Said to you: every message the assistant sent unprompted — briefs, prep,
 * debriefs, notes, failures — with the full text one tap away. They used to
 * share the digest with judged mail; Alex, 2026-09-06: "move Briefings out
 * of it now that it is on homepage." Today shows the day's; this is all of
 * them, and where a push lands.
 */
export async function saidPage(vault, unread) {
  return shell({
    title: 'briefs', current: '/briefs', unread, panes: true,
    body: `<div class=filt id=sdfilters></div>
<div class="mut read-count" id=sdcount></div>
<div class=split id=sdsplit>
  <div class=list id=sdlist><div class=empty>loading…</div></div>
  <div class=pane id=sdpane><div class=empty>Select a message.</div></div>
</div>
<div id=sddock class=composer-dock></div>
<script type=module src="/assets/said.js"></script>`,
  });
}

export const DASH_PAGES = {
  '/today': todayPage,
  '/briefs': saidPage,
  '/todo': tasksPage,
  '/projects': prioritiesPage,
  '/mail': digestPage,
  '/people': peoplePage,
  '/reference': referencePage,
  '/notes': notesPage,
  '/system': systemPage,
};
