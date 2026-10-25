# Deploying

> **Where this runs.** Two supported hosts: a Mac, natively, inside a sandbox,
> under Obligations Server.app (see `deploy/mac-server/README.md`), or a Linux
> box with systemd and Docker, which the sections below on GCE, systemd, Docker
> and VNC describe.

> **The map is `deploy/PIPELINE.md`** — which script does what, which four runs
> cost a model call and what gates each, and the seven places that read two
> sources together. This file is how to deploy and test; that one is what you
> are deploying.

One ephemeral container per job. Systemd timers invoke `deploy/run-job.sh`; the container
runs, writes to the mounted `obligations/` volume, and exits. Nothing long-lived, no state
inside the image, no drift between runs.

```
git clone <repo> ~/obligations && cd ~/obligations
cp deploy/.env.example deploy/.env    # fill it in
docker build -t obligations:latest -f deploy/Dockerfile .
./deploy/login.sh                     # one-time subscription login
./deploy/run-job.sh morning           # test by hand BEFORE scheduling anything
./deploy/install-systemd.sh           # timers: 07:00, 18:00, Sun 19:00
```

## Testing

```
./deploy/test.sh
```

Runs inside `obligations:latest` so the tests see the same node and SDK the service
does. Covers Access JWT verification (alg=none, algorithm confusion, wrong key,
wrong audience, expiry, wrong issuer) and every served page: each page's script
is parsed **and executed against a stub DOM**, so a missing element id or a
handler typo fails here rather than in a browser.

That second suite exists because the chat page once shipped with a syntax error
that killed its entire script — no sending, no history, no model picker — and
nothing caught it. `node --check` on the module passed happily while the string
it exported was broken. Page JS now lives in `deploy/agent-service/web/*.js` as
real files rather than inside a template literal, because nesting it meant every
escape was processed twice: `'\n'` became a literal newline (fatal) and `\.` in
a regex quietly lost its backslash (a dot that matched any character).

Run it before restarting the service after touching anything under
`deploy/agent-service/`.

### Visual tests — run these after touching any page

```
./deploy/visual.sh
```

Renders every page in a real browser at iPhone 13 width and desktop width, fails
on horizontal overflow, and writes screenshots to `.log/screens/` that are worth
actually opening.

This exists because a three-column table with prose in the last column shipped to
Alex's phone. At 390px that column got a third of the width and wrapped to one
word per line. It was obvious on the device and invisible from here, and
`./deploy/test.sh` could not have caught it — structure alone does not tell you
what a layout does.

Pages are served to the browser by a stub HTTP server with canned API responses,
so the parts that fetch render with real content. An obligations list showing
"could not load" would prove nothing about the layout of an obligations list.

The image (`deploy/Dockerfile.visual`, ~2GB of browsers) is separate from
`obligations:latest` deliberately — the job and service image stays small, and nothing
in production needs a browser. It sets `safe.directory` because it runs as root
against a repo owned by another uid, so git refused and the activity panel
rendered an error the real page never shows: a test environment that renders a
different page than production is worse than no test.

**Looking at the screenshots is the point.** They caught three things the
assertions did not: the swipe-reveal label painting over card text, embedded
file headings impersonating page sections, and a journal entry taking 59% of the
page.

## Scheduling

**The three agent jobs run inside `obligations-agent`, not as systemd units.** It is
already long-lived and already spawns an agent per turn, so a scheduled run is
just a turn whose prompt comes from `jobs/*.md`. One systemd timer remains.

- **`obligations-dispatch.timer`, every minute** — runs `reminder-dispatch.py` natively
  on the host: pushes due reminders, updates nag state, snapshots timer status
  for the dashboard, and watches for missed jobs (below). Deterministic on
  purpose — `due <= now` needs no model, and 1,440 agent runs a day would be
  expense and attack surface for nothing.
- **In `obligations-agent`** — morning 07:00, evening 18:00, weekly Sunday 19:00, fired
  by a minute tick in the service. Each records its firing in
  `.log/job-runs.json`.

**Catch-up.** The scheduler compares against the recorded slot rather than
matching the clock, so a service that was down at 07:00 still runs the 07:00 job
when it comes back. That was `Persistent=true` on the old timers, and losing it
would mean silently skipping a day — the exact failure this system exists to
prevent.

**Fate-sharing, and the watchdog that answers it.** Scheduling inside the agent
means a wedged agent is also a dead scheduler, and nothing would say so. So the
host dispatcher — which cannot be taken down by the agent — reads
`.log/job-runs.json` and raises a `failure` message plus an ntfy push when a slot
is more than 45 minutes overdue. Once per slot, never repeating: a watchdog that
nags every minute gets muted, and then it is worth nothing.

`deploy/run-job.sh` remains as break-glass: it runs a job in a one-shot container
without the service, for when the service is the thing that is broken.

Day-to-day:

```
systemctl list-timers 'obligations-*'     # the one remaining host timer
cat .log/job-runs.json              # when each job last fired, and whether it worked
journalctl -u obligations-agent -n 50     # what the scheduler and service are doing
./deploy/run-job.sh morning         # break-glass: run a job without the service
```

A job can also be run from the browser: `POST /jobs/<name>`, behind the same
Google sign-in as everything else. No separate credential — an automated trigger
would have needed one, and scheduling in-process removed the need.

## The interactive agent

**The web chat at `https://obligations.example.com/` is the thing you talk to.** It is
`obligations-agent`, described under "The agent as a service" below: same image, same
`CLAUDE.md`, same credentials, same repo as the scheduled jobs. One obligations,
several doors.

### Retired 2026-08-28: obligations-chat

A persistent `claude` in tmux inside a long-lived container, attached over ssh
(`deploy/chat.sh`) and once over ttyd. It was the original interactive door and
is gone. Its transcripts remain on the volume under
`deploy/claude-home/projects/-obligations/` — retiring the container did not delete
the conversations.

What made it retirable was interactive tool approval landing in the web chat
(below). Before that the web chat was strictly less capable: it could only ever
use what `.claude/settings.json` pre-allowed, and would silently work around
anything else — it refused to read its own iMessage extract that way. A terminal
session could just ask. Once the web chat could ask too, the only thing tmux
still had was Remote Access, which Alex chose to give up in exchange for one
view holding chat, dashboard, messages and approvals together.

What retiring it bought, beyond the single view:

- One less always-running container.
- One less conversation to keep in sync — two agents with separate memories
  writing the same repo was a standing source of confusion.
- One less process sharing `deploy/claude-home/.credentials.json`. The token
  refresh contention flagged when this system was first deployed is now moot.

What it cost: Remote Access to that session, and a door that works when the
tunnel, Access, and the network are all broken. `ssh` plus
`./deploy/run-job.sh` remain as break-glass, so it is not the last resort — just
the comfortable one.

## Gmail

`@klodr/gmail-mcp` 1.3.3, pinned in the image, wired in `.mcp.json`. A
maintained, signed fork of the Gmail MCP server most projects use — GongRzhe's,
which was archived 2026-03-03 and still takes 115k downloads a month.

**Scope is `gmail.modify`.** Read-only was enough to notice mail; it is not
enough to triage it — archiving is removing the `INBOX` label, filing is adding
one, and staging a reply is creating a draft. All writes.

That widening is not free and the honest version is worth stating: this server
registers a tool if **any** of its declared scopes is granted, and `send_email`
declares `[gmail.modify, gmail.compose, gmail.send]`. So `gmail.modify` alone
registers `send_email`, `send_draft`, `reply_to_email`, `reply_all`,
`forward_email` and `move_to_spam`. Under read-only those tools did not exist;
now they do, and something else has to stop them.

**Four layers, because email is the one attacker-controlled input here:**

1. `.claude/settings.json` denies all 13 outward and destructive tools by name,
   read out of the published bundle rather than guessed. Deny beats allow and
   binds jobs and chat alike. The allow list is separately what the *scheduled*
   jobs may use — a job's `canUseTool` is a blanket deny, so anything not
   pre-approved never runs unattended.
2. `GMAIL_MCP_RECIPIENT_PAIRING=true` with an **empty** allowlist: the server
   refuses to send to an unpaired address, so a send that got past layer 1 still
   fails. `pair_recipient` is itself denied, so the agent cannot add one.
3. Rate limits clamped far below the defaults. `modify` at 60/day is the one
   that matters — triage archives mail, and the failure mode of a confused run
   is not one wrong archive, it is the whole inbox.
4. The audit log, so what was touched is answerable afterwards.

`gmail.settings.basic` must never be granted: it is what `create_filter` needs,
and CLAUDE.md's "never create standing rules" is exactly that capability.
`gmail.labels` must never be granted either — the six labels in
`rules/email-triage.md` are created once, by hand, in Gmail.

The triage method is `.claude/skills/email-triage/SKILL.md`; the policy it obeys
is `rules/email-triage.md`, which is Alex's and versioned separately.

**A second mailbox is a second server instance.** This server has no
multi-account support — every call is `userId: "me"` — so each mailbox gets its
own credentials directory and its own tool-name prefix (`mcp__phoa__*`), which
means **its own deny rules**. The first mailbox's rules do not cover it.

```
# on a machine with a browser
bash deploy/integrations/install-gmail.sh --account=phoa
# then, here
node deploy/add-mailbox.mjs phoa
```

`add-mailbox.mjs` copies the fences from the `gmail` server rather than
restating them, and writes both the allow and deny rules for the new prefix.
Doing it by hand means editing two files and remembering thirteen tool names;
forget them and the new account is entirely unfenced while `mcp-check` still
reports the old one clean. `mcp-check` walks every Gmail server for the same
reason.

Note "Internal" is internal to **one** Workspace org. A mailbox on a different
tenant needs its own Google Cloud project inside that tenant — the existing
client cannot consent a user outside its own org. Another address or secondary
domain on the same tenant reuses the client and only the sign-in differs.

**Connecting it** is `deploy/integrations/install-gmail.sh`, run on a machine
with a browser. rivera.example is a Workspace domain, so the OAuth app is
**Internal** — an External app left in Testing issues refresh tokens that expire
after seven days, and mail would work for a week and then fail with a bare
`invalid_grant`. Credentials land in `deploy/gmail-state/`, which is gitignored
and read by both the container and host sessions through relative paths in
`.mcp.json` (`GMAIL_MCP_STATE_DIR` alone is not enough — it only moves the
rate-limit file).

**`deploy/mcp-check.mjs`** asks the running server what it registered and
cross-checks it against the layers — every destructive tool denied by name, the
send verbs in *neither* permission list so they reach the prompt, the rate
limits clamped. **Run it in the container**; `.mcp.json` names the server by its
container-absolute path because that is the only place it is installed, and on
the host it has nothing to ask:

```
docker run --rm -v ~/obligations:/obligations -e OBLIGATIONS=/obligations \
    --entrypoint node obligations:latest /obligations/deploy/mcp-check.mjs
```

Run it after connecting, after editing `.mcp.json` or the permissions, and any
time credentials change: a scope can be re-granted from a browser without
touching a file in this repo, so the config is not the authority on what is
possible. It exits 2 — not 0 — when it *could not* check, because "no problems
found" and "nothing was examined" must never read the same.

The rules themselves are `deploy/mcp-fences.mjs`, a pure function, tested
without a mailbox — including the specific regression that the deny list was
originally written against another project's naming and matched nothing real.
A deny list that has stopped matching the tool names looks exactly like one that
works.

Still to build: email as an obligation source. The shape is settled and matches
every other source — a bounded extractor into `integrations/email.json`, the
deterministic diff, then `sources/email.mjs` — rather than the agent querying the
mailbox live on every run, which is what `rules/knowledge.md` argues against.

## Web frontend

Two services, both bound to **loopback**, published by a **Cloudflare tunnel**
and gated by **Cloudflare Access with Google sign-in**:

**One service, `obligations-agent.service` on `:7683`**, serving five pages from one
origin: `/` chat, `/tasks`, `/notifications`, `/notes`, `/system`. `/dashboard`
and `/messages` redirect — both are in Alex's history. The menu is generated
from one list in `agent-service/nav.mjs`, and a test fails if it links to
something nothing serves.

The single dashboard was split on 2026-08-29. It had grown to hold reminders,
tasks, notes and machine state on one scroll, so reaching any one of them meant
scrolling past the other three — on a phone that is most of the screen budget
spent on things you did not open it for.

Reminders are a section of `/tasks`, not a page beside it. A reminder with a due
date and an unanswered message are both "something is owed, here is since when";
split across two pages, neither page could answer *what is outstanding*.

`/notifications` is `messages/` on screen. The directory keeps its name —
`rules/messages.md` and three producers write to it — but what it holds is
things the system said to Alex unprompted, which is what a notification is.
Swiping one left dismisses it: the file moves to `archive/messages/`, it is
never unlinked. A notification is the record of something the system claimed to
have told him, and a swipe on a phone is too cheap a gesture to destroy that.

**`/tasks`** lists everything outstanding, in both directions: *waiting on you*
(things he owes) and *waiting on others* (things he asked for and never got),
split by `owed_by`. They are different problems with different remedies, and
merged into one list the second kind was never looked at.

Five sources feed it, through `agent-service/obligations.mjs` — the message
triage (`integrations/imessage-state.json`), `todo.md` for tasks he typed
himself, `reminders.md` for anything with a time on it, `recurring.md` for
anything owed every period, and the mail triage
(`integrations/email-state.json`). A recurring block yields one obligation *per
period*, so August's hours submission and September's are different items with
different records; closing is recorded in `logbook.md`, which is also where the
adapter reads its state, so the record and the state cannot disagree. The page does not
know what a reminder is: it asks for obligations and splits them by deadline and
direction. Adding email means adding one file under `agent-service/sources/`.

`todo.md` is parsed with the syntax already documented at the top of that file
(`@person`, `!due:`, `#project`, `!since:`) plus `!waiting` for direction and
`!high`/`!low` for priority — otherwise priority comes from the section.

**Closing discharges every channel at once.** The same debt often arrives twice —
a text and a reminder about the same thing — and before 2026-08-29 those were
separate items in separate lists that never closed each other. Merges are
recorded by the agent in `integrations/obligation-links.json`, never inferred:
deciding two things are the same question is judgement, and a script matching on
subject lines would quietly merge things that are not.

A task's age comes from `!since:YYYY-MM-DD` on the line itself. The minute
dispatcher stamps that onto any live task that has none, so a task typed by hand
carries a date within a minute and never needs one typed. Ticking one off flips
`[ ]` to `[x]` in place and changes nothing else; the weekly sweep is what moves
it to `## Done`.

This was briefly answered by walking `git log -p` for the file on every page
load. That is an indirect way to ask a question the line can hold, and it went
wrong in the ordinary ways — a rewritten line looked new, a squashed history
looked ancient — for the cost of a subprocess per render.

That list became fair only once the triage cache existed: `awaiting_reply_hours`
alone means the last word was not Alex's — ~76 of 94 threads, mostly finished
conversations — and listing those would put noise on the page wearing the
clothes of a task list. The ones in `integrations/imessage-state.json` survived a
judgement pass. The raw count stays alongside as the honest denominator.

Anything outstanding a week or more renders in the overdue colour. Tapping a task
opens the tail of the thread it came from — twelve messages, names resolved
through `contacts.json` — with a reply box under it. A claim you cannot check has
to be taken on trust, and these are claims a model made.

Closing is a swipe left, or the Done button beside it (a gesture nobody is told
about is not a feature, and it is unusable with a keyboard). Closing writes
`open: false` plus `closed_at` and `closed_watermark`; nothing reopens it except
a message arriving after that watermark. Ageing does not, and neither does the
agent changing its mind.

The other two stay read-only: **`/notes`** (`now.md`, `todo.md`, latest journal)
and **`/system`** (job runs, timer health, recent commits). `.log/FAILURES`
renders at the top of tasks and system — an alarm buried on the page you visit
least is an alarm you miss.

Merged 2026-08-28. It was previously `obligations-web.service`, a separate host
process running stdlib python on `:7680`. The split was historical rather than
designed, and it forced real complexity: relative-vs-absolute link rewriting, a
second ingress rule, a second Access surface, and one proxy attempt that could
not work at all. Merging removed a unit, a port, an ingress rule and two
languages' worth of duplicated unread-count logic.

Removed 2026-08-27: `obligations-ttyd.service`, a browser terminal onto the tmux
session on `:7681`. The chat UI replaced it, and Claude's own remote access
already reaches that session from a phone — so it was a writable
root-equivalent terminal kept for a convenience nothing needed any more. The
tmux session it bridged has since been retired too (see above).

### How a request gets in

```
browser ──HTTPS──> Cloudflare edge ──Access (Google sign-in)──> tunnel
                                                                  │
                              cloudflared (--network host) ────────┘
                                          │
                              127.0.0.1:7680 / :7683
```

Nothing listens on a routable address. No inbound port is open, no GCE firewall
rule exists, and the services cannot be reached from the tailnet or the VPC —
only from the box's own loopback, which in practice means only cloudflared.

**Authentication is enforced twice, on purpose.** Access authenticates at the
edge and refuses unauthenticated requests before they reach the tunnel. Then
`obligations-agent` independently *verifies the signed Access JWT* on every request
(`deploy/agent-service/access.mjs`) and takes the identity from the verified
payload. It never reads `Cf-Access-Authenticated-User-Email` — that header is
plain text, and trusting it is the standard way a service that looks
authenticated turns out not to be. `deploy/agent-service/access.test.mjs` covers
the failure modes that matter: `alg=none`, algorithm confusion, wrong signing
key, a token minted for a different Access application, expiry, and a wrong
issuer. Run it after touching that file.

Example: team `your-team.cloudflareaccess.com`, application
`obligations.example.com`. Config lives in `deploy/.env`: `ACCESS_TEAM_DOMAIN`,
`ACCESS_AUD`, and `REQUIRE_ACCESS=1`.

**Ingress: one hostname, one rule.**

| Hostname | Path | Service |
|---|---|---|
| `obligations.example.com` | *(none)* | `http://127.0.0.1:7683` |

One hostname and no path split means **one Access application covers
everything**. A second hostname, or an app scoped to a path, is how one of these
ends up quietly unprotected — which is the main reason the dashboard was merged
rather than published beside it.

### Why timer health comes from a file

The dashboard's schedule panel used to shell out to `systemctl`. It cannot from
inside a container: PID 1 there is `node`, so `systemctl` has no systemd to talk
to, and installing the binary changes nothing. Making it work would mean
mounting the host's systemd control socket — write access to every unit on the
box, a larger grant than the docker socket, handed to the container that
processes untrusted email.

So `deploy/reminder-dispatch.py`, which already runs on the host every minute,
writes `.log/timers` and the dashboard reads it. At most 60 seconds stale, for a
panel about daily timers, and it grants the container nothing. The service **refuses to start** if `REQUIRE_ACCESS=1` and
the other two are missing — a typo must not silently downgrade an authenticated
deployment into an open one. The connector token is *not* in that file; it lives
in `/etc/cloudflared/obligations.env`, root-only, because `deploy/.env` is
`--env-file`'d into the agent containers that read untrusted email.

**SSE through the tunnel needs a heartbeat.** A turn can think for minutes
without emitting a byte, and Cloudflare closes an idle response at ~100s. The
service writes a `: keepalive` comment frame every 15s — valid SSE the client
ignores. Without it, long turns die on the tunnel and look like the agent hung.

### When Cloudflare is the thing that's broken

Tunnel-only means a Cloudflare, tunnel, or Access failure takes the web UI with
it. The escape hatch is one line in `deploy/.env`:

```
OBLIGATIONS_BIND=tailnet
sudo systemctl restart obligations-web obligations-agent
```

That rebinds both services to `tailscale0`, reachable at `100.64.0.1:7680`
and `:7683`. **That path has no sign-in in front of it** — it is a deliberate
break-glass, not a second front door. Remove the line and restart when the
tunnel is back.

### Rejected on the way here

- **`tailscale serve`** — HTTPS and tailnet identity at the proxy layer, at the
  cost of an interactive enablement step. Never enabled.
- **Binding the tailnet interface directly, no proxy** — simplest thing that
  worked, and what ran 2026-08-27. Replaced because reachability required being
  on the tailnet, and because "on my tailnet" is a weaker statement than "signed
  in as me".
- **A Cloudflare tunnel with no authentication** — the first attempt at this,
  reverted the same day. The objection was never the tunnel; it was putting an
  unauthenticated path to a root-equivalent agent on the internet. Access with
  Google sign-in is what answers that, and is why this shape is not a repeat of
  that one.

## Skills

`.claude/skills/<name>/SKILL.md`, in this repo. Verified rather than assumed: the
SDK service omits `Options.skills`, whose contract is "omit to load every
discovered skill", and a probe skill dropped there was visible to a container
run. A skill added here reaches the web chat **and** the scheduled jobs with no
wiring.

Not `~/.claude/skills/` on the `claude-home` volume — that is gitignored, and we
have been bitten by putting behaviour there before: the `curl` deny lives on that
volume, is invisible to git, and needed a pointer comment in
`.claude/settings.json` so it would not be lost. Skills are the assistant's
behaviour and belong in the repo that *is* the assistant.

Worth keeping straight, since this repo has both:

- **`rules/`** — policy the agent must follow, referenced from `CLAUDE.md`,
  always in force.
- **`.claude/skills/`** — procedures the harness surfaces when relevant, without
  `CLAUDE.md` naming them. `CLAUDE.md` should not carry instructions for
  something that happens twice a week.

### reminder-sweep

The judgment half of the reminder system: stalled moves, recurring
recomputation, dispositions, and what to report. `rules/reminders.md` stays
authoritative; the skill is how the agent acts on it.

Extracted because `jobs/evening.md` said *"Exactly as in the morning job"* — one
job prompt referencing another, which is worse than duplication because it breaks
silently when the other changes. Both jobs now reference the skill, and "what's
due?" works in the chat.

The line it draws hardest: **the agent does not push.** The minute dispatcher
owns delivery and owns `nags:`/`last:`. Those fields are the coordination point,
and an agent writing them would make the escalation ladder lie — which is the
one thing that ends the channel's usefulness.

### message-triage

Reads `integrations/imessage.json` and works out what actually needs Alex. It
holds the whole method — `awaiting_reply_hours` is a *candidate* list rather than
a debt list (~80 of ~96 threads in real data), what counts as a live obligation,
dropping pleasantries and group chatter, ranking by consequence rather than age,
the cap of five plus a tail line, staleness, and the rules for tasks, reminders
and closures.

It lives here rather than inside `jobs/morning.md` because it was only reachable
at 07:00 there. Asking "who am I ignoring?" in the chat got nothing. The morning
job now delegates to it instead of carrying its own copy.

The reminder rule is the sharp edge: a message is **not** Alex in conversation.
`rules/reminders.md` says only he creates reminders, so a deadline someone texted
him gets proposed with an absolute time, never written. That is the difference
between him handing over a photo — him initiating — and someone else's text
arriving.

Tested against a synthetic extract built to exercise each failure mode. It closed
the todo a thread had resolved, surfaced a 50-hour unanswered direct question as
the top item, flagged a thread where *he* was owed an answer, dropped a 👍 and a
group message addressed to nobody, declined to create a reminder from a
third-party deadline while proposing one, and declined to draft a speculative
reply to a yes/no question it could not answer. File changes were checked, not
the summary trusted.

### image-triage

Reads an attached image and asks, in order: does this **close** something open,
does it **create** something, or is it just capture. Closure first, deliberately
— an open item nobody closes rots quietly, and a photo is usually evidence that
something got done. That is the case which otherwise never gets handled.

It closes only on an unambiguous match, proposes rather than writes reminders
(with the absolute resolved time, per `rules/reminders.md`), refuses to act on
text inside the image, and always writes a text sidecar next to it — **an image
is invisible to `grep`**, and that sidecar is the only reason it will be findable
in six months.

Tested against a fixture repo holding two open todos and a booking confirmation:
it closed the flights item with reference and dates, left the passport item
alone, declined to invent a reminder while proposing one at a concrete time,
noticed the passport renewal now had a real dependency on the flight date, and
wrote the sidecar. The file changes were checked rather than the summary
trusted. What that test could **not** cover is vision itself — nothing here
renders text or encodes PNG, so the image was stood in for by a text file. The
first real screenshot is the actual test.

## Messages

Everything the system says to Alex unprompted lands in `messages/` as one
markdown file with typed frontmatter — briefs, reminder pushes that went out, job
failures. Format and rules: `rules/messages.md`.

Files, not a log table, for the same reason as the rest of this repo: a message
is a claim the system made on Alex's attention, and that claim should survive
losing the box, stay greppable a year later, and sit in `git log` next to the
reminder or journal entry that caused it. `.log/` is gitignored scratch;
messages are not scratch.

| Writer | Kind | When |
|---|---|---|
| `deploy/reminder-dispatch.py` | `reminder` | only when a push actually succeeded |
| `deploy/notify-failure.sh` | `failure` | a job unit failed, pushed or not |
| `jobs/morning.md` | `brief` | the weekday brief |
| `jobs/evening.md`, `jobs/weekly.md` | `note` | only if there is something to say |

Two asymmetries there are deliberate. **Reminders are recorded only on a
successful push**, so the message count and the nag count can never disagree —
recording an undelivered nag would burn a rung of the escalation ladder against
a queue Alex never saw. **Failures are recorded either way**, because a dead
assistant must not depend on one channel working.

This is also the first real delivery channel the morning brief has ever had. It
previously went to the job's stdout in `.log/morning.log` and nowhere else.

The list is at `/messages` on the agent service, with the JSON at
`/api/messages` and `POST /api/messages/read`. It lives there rather than in the
dashboard because marking a message read is a write, and the dashboard's whole
security story is that it has no write path — the dashboard shows an unread
count and links across. Opening a message marks it read; a failed write just
means it reappears unread next load, which is the safe direction to be wrong in.

### Execution model — what a "run" is

There is no resident agent process. Each trigger starts a fresh container running
one `claude -p` invocation: a full agentic loop (read rules → grep memory → edit
files → commit) that exits when the job is done. All continuity lives in the repo —
each run wakes with amnesia and reads its way back to context. That's the design:
the memory structure IS the assistant; processes are disposable.

Concurrency is handled in layers:

- systemd never overlaps a unit with itself; `--name obligations-$JOB` double-locks that.
- `run-job.sh` takes a `flock` on `.log/write.lock`, so two *different* jobs — or a
  job and anything else that honors the lock — never write the repo simultaneously.
- If you work interactively in the repo on the server, take the same lock:
  `flock ~/obligations/.log/write.lock claude` — or just don't worry: worst case is a git
  conflict between two commits, which git makes loud rather than dangerous.

## The agent as a service (obligations-agent)

A third door onto the same assistant: `obligations-agent.service` runs
`deploy/agent-service/server.mjs` on the Claude Agent SDK, exposing HTTP + SSE on
`100.64.0.1:7683` instead of a terminal. Same image, same `CLAUDE.md`, same
`.claude/settings.json`, same credentials, same repo — the only thing that
changes is how a turn arrives.

```
GET  /          -> the chat UI
GET  /health    -> {ok, busy, sessionId}
GET  /history   -> ?limit=&before= ; a window of the stored conversation
GET  /models    -> the models the picker offers, and the default
GET  /file      -> ?path=inbox/... ; read-only, for attachment thumbnails
POST /upload    -> raw body, filename in X-Filename; saves into inbox/
POST /stop      -> end the in-flight turn
POST /message   -> {"text", "model"?, "attachments"?}  ; SSE stream back
                   events: session | text | tool | result | stopped | error
```

`/history` exists because the session outlives the page: without it the agent
remembers the whole thread and the browser shows an empty box, which reads as
data loss even though nothing was lost. It is windowed — newest 30 on load,
older fetched as you scroll up. `before` is an index into the *flattened* list
(one stored message can render as several blocks), which is why the whole
transcript is flattened server-side and sliced, rather than paginated at the SDK
call: paging over messages while scrolling over blocks would drift out of step.
Transcripts are tens of KB, so re-reading one per scroll is cheaper than getting
that wrong. `/file` is confined to `inbox/` and must
stay that way — it is not a general read API for the repo.

**Stop** works by breaking out of the message loop, which calls `.return()` on
the generator and tears the subprocess down. The SDK's `interrupt()` is the
graceful path but only supports streaming input, which this service does not
use; it is called anyway, best-effort. A dropped client (phone locking its
screen) stops the turn the same way, so nothing keeps burning tokens against a
socket nobody is reading.

**Markdown** is rendered by a ~50-line function in the page, not a library — no
build step, no dependency. It escapes HTML unconditionally *before* any
transformation, and only linkifies `http(s)` and relative URLs, because model
output and any file it quotes back are both untrusted input to that renderer.

**Attachments land in `inbox/` and are passed to the agent as paths**, not as
inlined image or document blocks. Two reasons: the agent already has the Read
tool, and an upload then survives the turn as a real artifact that the evening
journal write triages like any other capture — which is exactly what CLAUDE.md
already says to do with anything Alex dumps. A separate `uploads/` directory
would have been a second capture path with nothing sweeping it.

Filenames from a browser become paths on disk, so they are treated as hostile:
basename only, conservative character set, dot-prefixes stripped, length capped,
and the joined path is re-checked to be inside `inbox/` before anything is
written. `/message` re-checks attachment containment too — those paths come back
via the client, so the round trip is not trusted. Uploads cap at 25MB and every
one is logged.

**The model picker** sets `model` per turn; the browser remembers the last
choice and the server rejects anything not on the `/models` list, so a stale
value fails in the picker rather than obscurely inside a turn. Default is
`OBLIGATIONS_MODEL` or Sonnet 5. The scheduled jobs are unaffected — they stay on
Sonnet via `deploy/entrypoint.sh`, because they are mechanical file work.

The chat UI is served by **this** process, not by the dashboard, and that is the
point. The dashboard's whole security story is "no POST, no API, so the worst a
tailnet visitor can do is read". Proxying chat through it would trade that away
for nothing. Serving the page from the agent service keeps them same-origin (no
CORS) and keeps the write path in the process that already audits every turn.
The two pages share a palette so they read as one stack; the dashboard's
"open chat →" points here; the ttyd terminal that used to sit beside it is gone.

Why it exists: a terminal is a fine door for a human and a useless one for
anything else. With an HTTP door, a notification reply ("snooze 2h") can reach
the agent, and the dashboard can grow a write path, without anyone attaching a
tty.

Design decisions that are load-bearing — read before changing them:

- **One turn spawns one agent process**, resuming the session id stored in
  `.log/agent-session`. Slower than holding a process open, and deliberate: it
  matches the rest of this system, where continuity lives on disk and processes
  are disposable. A crash costs one turn, not the conversation.
- **Single-flight.** This is *one* conversation. Two concurrent turns would
  interleave writes into the same session JSONL, so a second caller gets `409`
  rather than a corrupted history.
- **The permission policy is not duplicated in JavaScript.**
  `.claude/settings.json` is the policy. The SDK auto-approves what that file
  allows; `canUseTool` only ever sees what it did not, and denies it with a
  logged reason. One source of truth, failing closed. `permissionMode` is
  `default` and must never become `bypassPermissions` — this process reads
  attacker-controlled email and can write the repo.
- **`settingSources` is set explicitly** to `['user','project','local']`. The SDK
  currently defaults to loading all of them, and that default is what loads
  `CLAUDE.md` and the deny list — not something to inherit implicitly across a
  version bump.
- **The SDK version is pinned** in `deploy/agent-service/package.json`, installed
  at `/` in the image. ESM resolution ignores `NODE_PATH` and only walks parent
  directories, so `/node_modules` is the one place a file under `/obligations` can
  reach — the service's code lives in the mounted repo, not baked into the image.
- **It does not take `.log/write.lock`**, same rule as the chat session: the jobs
  serialize against each other, interactive writers just commit and let git make
  collisions loud.

Every turn and every denied tool is appended to `.log/agent-service.log` as JSON.

### One session, one door

`obligations-agent` holds the conversation. As of 2026-08-28 it is the only
interactive agent — `obligations-chat` is retired — so the "two obligationss with separate
memories writing one repo" problem this section used to describe is gone.

**Interactive tool approval** is what closed the capability gap. Tools that
`.claude/settings.json` does not already allow now surface in the chat as an
Approve/Deny card carrying the actual command, and the turn waits for an answer
(denying after three minutes, so an unanswered prompt cannot wedge the
single-flight lock). Every decision is logged with the verified identity that
made it — something a terminal keypress could never record.

**Scheduled jobs get no prompt and no escalation, ever.** They run with a
different `canUseTool` that denies outright. There is no human present, and a
job processes attacker-controlled email and iMessage content — the same
reasoning `rules/gbrain-adoption.md` already commits to for memory write verbs.
A job that needs a tool needs it added to `settings.json` in daylight.

**New conversation** (`POST /api/session/new`, the `new` button) forgets the
session id so the next turn starts fresh. It does not delete the old transcript.

## Auth

Two options; subscription login is the default.

**Subscription login.** `./deploy/login.sh` once, interactively. Credentials persist
in `deploy/claude-home/` — gitignored, mounted into every job container as
`~/.claude` — and jobs run against your plan instead of metered API billing. If jobs
start failing with auth errors, re-run `login.sh`.

**API key.** Set `ANTHROPIC_API_KEY` in `deploy/.env` instead. Worth it if you don't
want login credentials at rest on the server, or the box is shared and you want the
billing fenced off.

### Which model runs

`OBLIGATIONS_MODEL` in `deploy/.env` is the single knob, read by all three consumers —
the scheduled jobs (`deploy/entrypoint.sh`), the chat session
(`deploy/chat-entry.sh`), and the agent service. Unset, they each default to
**`claude-opus-5`**; Alex set that on 2026-08-27, replacing the earlier
"jobs run on Sonnet, Opus is a waste for mechanical file work" position. The
chat UI's picker overrides it per turn without changing the default.

If the 3×/day job cost stops being worth it, add a `OBLIGATIONS_JOB_MODEL` override in
`entrypoint.sh` rather than introducing a second default somewhere else — one
answer, one place, is the point of the knob.

## Connectors — budget real time for this

The Gmail and Calendar connectors in the Claude desktop app are **interactively
authenticated** and will not be present in a headless container. You need MCP servers
that hold their own OAuth refresh tokens:

1. Create a Google Cloud project, enable the Gmail and Calendar APIs.
2. OAuth consent screen, desktop client, do the consent dance **once** on your laptop.
3. Keep the **refresh token**. Put it in `deploy/.env`.
4. Add the MCP server to `.mcp.json` reading those vars from the environment.

Grant read-only scopes if you possibly can (`gmail.readonly`, `calendar.readonly`).
The triage policy needs `gmail.modify` to label and archive — add that scope only when
you actually turn triage on, and never `gmail.compose` or `https://mail.google.com/`.

This step, not Docker, is where the afternoon goes.

## Interactive desktop (VNC)

A **second** container, from `Dockerfile.desktop`: Xvfb + x11vnc + noVNC + Chromium +
fluxbox, mounting the same obligations volume. Separate image on purpose — a VNC daemon is
long-lived and Chromium is ~600MB, and the job image should stay small and disposable.

```
./deploy/desktop.sh build
./deploy/desktop.sh up
./deploy/desktop.sh down     # stop it when you're done
```

What it's actually for:

- **The OAuth consent dance.** Run the flow in Chromium *inside* the container, and
  the refresh token lands on the volume where the jobs will find it — no copying
  secrets between machines. This is the main reason to build it.
- **Giving the agent a real browser** for anything without an API.
- **Watching a run** when something's behaving oddly.

Bring it up for a task, then stop it. It is not part of the cron path and nothing
scheduled depends on it.

### Reaching it — read this before you expose a port

**Do not publish VNC to the internet.** The VNC protocol's own auth is weak (8-char
effective password, no lockout, no transport encryption), and this container has your
mail and a file describing everyone you know. VNC on a public IP gets found by
scanners within hours.

The scripts here bind to host loopback only (`127.0.0.1:5901`, `127.0.0.1:6080`) and
x11vnc runs with `-localhost`. Get in over SSH:

```
ssh -N -L 6080:127.0.0.1:6080 <server>
open http://127.0.0.1:6080/vnc.html
```

If you ever find yourself changing `127.0.0.1:6080` to `0.0.0.0:6080` to make
something work, stop and fix the tunnel instead.

### Notes

- `--shm-size 1g` is not optional — Chromium crashes on Docker's 64MB default.
- The desktop container inherits `.claude/settings.json` like the jobs do. If you're
  driving Claude interactively in there for setup, the deny list still applies; loosen
  it deliberately rather than by reflex.
- Chromium in a container this size is fine for OAuth and light browsing. Don't expect
  it to be pleasant for real work.

## Security

This container reads your mail and holds a file describing everyone you know. It is a
higher-value target than most things you'll run.

- `deploy/.env` is gitignored. Keep it that way — the assistant repo will have a remote.
- Runs as non-root, `no-new-privileges`, only the assistant volume is writable.
- `.claude/settings.json` denies send/trash/push/curl at the harness level. The prompt
  says don't; the settings file means can't. Keep both — email is attacker-controlled
  input, and prompt instructions are not a security boundary.
- Consider egress rules allowing only the Anthropic API, Google APIs, and your
  notification endpoint. A personal-memory container has no reason to reach anything else.
- The desktop container is the weak point: it has a browser, a listening service, and
  the same volume. Keep it stopped when you're not using it, and never publish its
  ports beyond loopback.

## GCE notes

- **Don't open firewall ports for any of this.** The jobs make outbound calls only,
  and the desktop container binds to loopback. Reach VNC through an SSH tunnel, which
  on GCE is one line with IAP — no public SSH needed either:

  ```
  gcloud compute ssh <instance> --tunnel-through-iap -- -N -L 6080:127.0.0.1:6080
  ```

  then `http://127.0.0.1:6080/vnc.html`.

- **Shared box caveat.** If this instance runs other services, the container boundary
  is doing real work in both directions — keep the assistant volume and `claude-home/`
  readable only by the user that owns the cron jobs (`chmod 700`).

- **Snapshot custody.** Disk snapshots of this instance now contain your mail-adjacent
  memory and login credentials. If the project has scheduled snapshots, know who can
  read them; consider excluding this disk or encrypting with a CMEK if that matters
  to you.

- The instance's service account has whatever GCP permissions it has — the agent
  container doesn't need any of them. Don't mount gcloud credentials into it.

## Backups

The volume is the source of truth, not the container. Add a private git remote and
push after the weekly compaction — then losing the box costs you nothing.
`git push` is currently in the deny list; allow it deliberately, to one known remote,
if you want the agent doing this itself.
