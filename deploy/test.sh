#!/usr/bin/env bash
# Run every test in the deployment. No arguments, no options — if this exits 0,
# the things that have actually broken before are still working.
#
# Two ways to run, chosen by where it runs:
#   - on the Mac mini (macOS), natively: Homebrew's node@22 — the node the
#     server runs there — and the SDK in deploy/agent-service/node_modules.
#     Plus the sandbox test and a smoke boot through Obligations Server's launcher.
#   - on linuxbox (Linux), inside obligations:latest, as before. Needs the image:
#     docker build -t obligations:latest -f deploy/Dockerfile .
# Either way, the same suites and the same verdict line.
set -uo pipefail

OBLIGATIONS="${OBLIGATIONS:-$(cd "$(dirname "$0")/.." && pwd)}"
fail=0

# The same timezone the service runs in — see deploy/agent-service/run.sh. A
# bare `docker run` is UTC, so without this the tests exercise a configuration
# that exists nowhere, and anything that depends on local dates passes here and
# fails in production (or the reverse, which is worse).
TZ_HOST="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null \
  || readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' || echo UTC)"

NATIVE=0
[ "$(uname)" = Darwin ] && NATIVE=1
NODE22="/opt/homebrew/opt/node@22/bin/node"
if [ "$NATIVE" = 1 ] && [ ! -x "$NODE22" ]; then
  echo "native run needs node@22 at $NODE22 — brew install node@22" >&2; exit 2
fi

# One suite, by repo-relative path. `--no-obligations` runs it without OBLIGATIONS set, the
# way a job runs a CLI (mail-draft.mjs must find the repo for itself).
nodetest() {
  local rel="$1" obligationsenv=1
  [ "${2:-}" = --no-obligations ] && obligationsenv=0
  if [ "$NATIVE" = 1 ]; then
    # Native: the system time zone, which is the one the server runs in here.
    if [ "$obligationsenv" = 1 ]; then OBLIGATIONS="$OBLIGATIONS" "$NODE22" "$OBLIGATIONS/$rel"
    else local path="$OBLIGATIONS/$rel"; (unset OBLIGATIONS; "$NODE22" "$path"); fi   # path first: OBLIGATIONS is gone inside
  else
    local benv=(); [ "$obligationsenv" = 1 ] && benv=(-e OBLIGATIONS=/obligations)
    docker run --rm -v "$OBLIGATIONS:/obligations" "${benv[@]}" -e "TZ=$TZ_HOST" --entrypoint node \
      obligations:latest "/obligations/$rel"
  fi
}

# Anything under deploy/agent-service/ is named relative to it — including its
# own subdirectories, `hook/oidc.test.mjs` and the rest — because that is where
# almost every suite lives. A path written from the repo root starts `deploy/`,
# so a suite about something outside the service can sit next to what it tests.
#
# The first cut of this said "a name with a slash is repo-relative", which sent
# all five `hook/` suites to /obligations/hook/ and failed them as a missing module.
# A slash does not mean what that rule needed it to mean.
run() {
  echo
  echo "── $1 ─────────────────────────────────────────────"
  case "$2" in
    deploy/*) rel="$2" ;;
    *)        rel="deploy/agent-service/$2" ;;
  esac
  nodetest "$rel" || fail=1
}

# Cloudflare Access JWT verification: alg=none, algorithm confusion, wrong key,
# wrong audience, expiry, wrong issuer.
run "access" "access.test.mjs"

# The Google OIDC token on a Pub/Sub push. Same attack set as access:
# alg=none, algorithm confusion, wrong key, wrong audience, wrong service
# account, expiry. That route is exempt from Access — Google cannot log in
# — so this function IS the authentication for a public endpoint whose
# effect is Alex's phone ringing.
run "oidc" "hook/oidc.test.mjs"

# The push caps. The realtime tier is the first thing here where someone
# ELSE's action causes an interrupt, and these are what stand between that
# and a phone buzzing all night. Also the dedupe, which exists because a
# retried send once delivered the same code twice.
run "push caps" "hook/rate.test.mjs"

# The push path end to end, with only the network stubbed: the real policy
# parsed from rules/realtime-push.md, the real classifier, the real caps.
# Fails if any of them change in a way that would stop a code reaching his
# phone, or start letting one through that should not.
# Finding the verification code, in a subject or a body. Eight real messages
# Alex received are pinned here — ForeFlight, Zoom, PayPal, Intuit and a
# signature block full of decoy numbers. Relaying the WRONG code is far
# worse than relaying none, so every ambiguous case must return null.
run "code extraction" "hook/code.test.mjs"

run "gmail push route" "hook/route.test.mjs"

# Every served page and its JavaScript, parsed and then executed against a stub
# DOM. Exists because a syntax error once killed the whole chat page and nothing
# noticed: node --check on the module passes while the string it emits is broken.
# What may be remembered as a standing "yes" in the chat, and what must always
# be asked. The negative half is the point: "always allow Bash" is not a
# decision about a tool, it is a decision about every command anyone can put in
# one, including one an injected email body suggests.
# Cross-source conflict detection. Most of that suite is "does NOT fire": a
# report read three times a day survives no false positives, and the calendar
# field names are pinned there because reading a field that does not exist
# produced a clean run rather than an error.
# The day's closes, as a cross-check. Mostly parser tests: logbook.md is
# append-only and authoritative, and its `what` field is prose containing pipes
# and the word "by" — every separator the format uses.
# The chief-of-staff layer (2026-09-05): people graph, meeting prep, decisions,
# priorities, follow-through candidates, project proposals. Each is arithmetic
# over sources that already existed; these pin the parsers and the negatives.
# Snooze (later, not lost) and search (one query, five kinds). The snooze tests
# pin that a hidden obligation wakes and is never touched; the search tests pin
# the ranking and the typing, because the right thing under the wrong label
# sends him to the wrong page.
# Home: gym block planning (in town, Mon/Thu, idempotent markers) and birthdays
# (family is called, others texted; a people/ file outranks Contacts).
# Second pass: scheduling replies (never a slot in the past, on a weekend, in a
# trip, or over his own meeting), the debrief (after the meeting, not for the
# dentist), decisions through one door, verdicts.
# Bookings onto the calendar (the parser, line by line) and duplicates off it
# (a Gmail stub goes only when a real event covers it; two real ones are never
# touched). The second script deletes, so its negatives are the point.
run "trips: bookings + dupes" "trip.test.mjs"

run "chief of staff II" "cos.test.mjs"
run "outbox mail" "outbox-mail.test.mjs"
run "the Obligations menu's heartbeat" "heartbeat.test.mjs"

# The lane a task is done in — reply, decide, pay, call, admin — so To Do can
# hand him one kind of work in a sitting. Every title is a real one from his
# list of 2026-10-03; the cases that matter put a task in the wrong sitting.
run "lanes" "lanes.test.mjs"
run "prepare" "prepare.test.mjs"
run "filed section" "filed-section.test.mjs"
run "filed documents on a task" "filed-docs.test.mjs"
run "keep in inbox" "keep-inbox.test.mjs"
run "today's order" "rank.test.mjs"
run "push to the apps" "push.test.mjs"
run "brief input" "brief-input.test.mjs"
run "written mail digest" "mail-digest.test.mjs"
run "location" "location.test.mjs"
run "answering an invitation" "calendar-respond.test.mjs"
run "conditions" "conditions.test.mjs"
run "rejudge" "rejudge.test.mjs"
run "brief audit" "brief-audit.test.mjs"
run "message gate" "message-gate.test.mjs"
run "urgent pushes taken back" "messages.test.mjs"
run "draft a reply inline" "reply-draft.test.mjs"
run "what pays itself" "autopay.test.mjs"
run "the to-do map" "taskmap.test.mjs"
run "idle means idle" "idle.test.mjs"

# The second lane: one cheap question — does he need this within the hour —
# over new threads from people he knows, then the triage at once and a push of
# ITS verdict. Pinned: who can reach the lane (nobody he does not know), that a
# thread is asked about once, that a failing classifier means "later", and that
# only an open action conclusion pushes, inside quiet hours and a daily cap.
run "urgency" "urgency.test.mjs"

# Where a run's context came from. cache_read is cache_write times the turn
# count, so the bill is set by what a run pulls in — and nothing could say what
# that was. Bytes per tool, and the check that matters most: a tool result
# never reaches the log, only its size.
run "context size" "context-size.test.mjs"

# What /mail actually shows. The rule that had no reader: ignoring a sender has
# to reach the mail already judged, or it silently means "from now on".
run "digest list" "digestlist.test.mjs"

# His switch. Everything that costs a model call asks it first; nothing else
# stops. Pinned: absent and unreadable both mean ON (failing closed would cost
# a week of triage over a stray comma), an unregistered spender is gated, the
# pause ends itself on `until`, and OFF never renders as a quiet week.
run "model gate" "model-gate.test.mjs"

run "home: gym + birthdays" "home.test.mjs"

run "ux: snooze + search" "ux.test.mjs"

run "chief of staff" "chief.test.mjs"

# Person, organisation or machine — the People page lists people only, and a
# wrong exclusion hides a real person, so these are mostly the ones who must
# stay. Every case is a real row from the 2026-09-22 rethink.
run "person or organisation" "handles.test.mjs"

run "closes" "closed.test.mjs"

run "conflicts" "conflicts.test.mjs"

run "auto-approval" "approvals.test.mjs"

run "pages" "pages.test.mjs"

# The gate between "the agent composed a message" and "a message went out as
# Alex". Every negative case is a way one gets sent that nobody meant to send.
run "outbox" "outbox.test.mjs"

# Which task a waiting draft belongs to, now that the Outbox is a filter on
# To Do rather than a page. Mostly the refusals: a draft under the wrong task
# makes that task look answered and the real one look untouched.
run "drafts joined to tasks" "task-drafts.test.mjs"

# Quoted-reply trimming on an inline thread. The refusals are the point:
# trimming a quote is a convenience, trimming a message is losing mail.
run "quoted replies" "quoted.test.mjs"

# One answer, not one schedule: the shared context four passes now read. The
# assertion that matters is that the chase gate and the context agree on what
# "recently in touch" means — the chase gate is the one that sends mail.
run "context" "deploy/context.test.mjs"

# The reconciliation pass: is what the assistant believes still true? Mostly the
# refusals — a finding here sends a model to rewrite something he relies on.
run "review" "deploy/review.test.mjs"

# `closes_when`: what the triage said would close it, as data. The rule pinned
# is the asymmetry — an explicit spec met CLOSES, a parsed sentence only asks —
# and that every kind is bounded by the debt's own start.
run "closes" "deploy/closes.test.mjs"

# The trust ledger: one line a day on whether the assistant's closes stand. What
# is pinned is the arithmetic — who closed what, which findings were acted on —
# and that the first day says "no yesterday" rather than inventing zeros.
run "trust" "deploy/trust.test.mjs"

# Archiving a trip on /reference. Mostly what it does NOT change: four other
# readers parse those headings, and one hashes the trip name into a calendar
# marker — if that moved, archiving would duplicate every event of the trip.
run "trip archive" "trip-archive.test.mjs"

# `surfaced_for`: a dated awareness item waits for its day. The field was
# documented for seventeen days with no reader at all, so what is pinned here is
# mostly that a deferral defers — and that it still surfaces exactly once.
run "digest window" "deploy/digest-window.test.mjs"

# The URL as the view, so a mail or a task can be linked to. The thing that
# must not break is the old single-pair `#pane=<id>` form: every brief, push
# and note ever written links that way.
run "deep links" "histate.test.mjs"

# Narrow-viewport structure. A 3-column table with prose shipped to a phone
# once; this fails that class rather than relying on noticing it there.
run "layout" "layout.test.mjs"

# Calendar shaping. The all-day trap: a bare `YYYY-MM-DD` parses as UTC, so an
# all-day event on the 1st reads as the 31st in any western timezone. Also that
# a declined meeting never reaches the brief and a description never does.
run "calendar" "calendar.test.mjs"

# URL handling in message text. A pasted search link is 600 characters of
# tracking parameters, and "only http(s) ever becomes a link" is a safety rule.
run "links" "links.test.mjs"

# todo.md as a task source. The risk is the write: completeTodo edits a file
# Alex maintains by hand, and it must change exactly one character.
run "todo" "todo.test.mjs"

# The obligation model: the same debt on three channels is one item, and
# closing it discharges all three. Answering the email and leaving the text
# open forever is the failure this replaced.
run "obligations" "obligations.test.mjs"

# Mail as an obligation source. The ref is a thread so a chase-up does not
# become a second item, and close() defers the archive rather than reaching
# Gmail from under the repo lock.
run "email" "email.test.mjs"

# What decides to run an unattended agent against his mailbox. Too eager burns
# money on empty runs; too shy strands mail; and treating a stale work list as
# "nothing waiting" makes the whole pipeline go quiet exactly when it breaks.
run "mail gate" "mail-gate.test.mjs"

# The reading list's one piece of state and the matcher over it. Ignore Sender
# decides what he is never shown again, so exact must stay exact and @domain
# must stay broad.
run "reading" "reading.test.mjs"

# The two failures that let a whole mailbox go missing for hours: a cursor
# deadlock that could not escape itself, and a health check that called it fine.
run "health" "health.test.mjs"

# The shape of every artifact, checked against the LIVE files rather than a
# fixture — the bug it exists for passed its own test for weeks because the
# fixture invented a format nothing emits.
run "contract" "contract.test.mjs"

# Wiring, wall-clock stamps and test validity. Each guard is here because a
# specific silent failure got through today.
run "guards" "guards.test.mjs"

# The realtime gate: what may ring his phone at 03:00. Every failing case is a
# way a stranger causes an interrupt he never approved.
run "hook" "hook.test.mjs"

# The subject patterns, against subjects he was really sent. One missing word
# ("authentication") meant every FlyNorthwind code was refused for six days and
# nothing anywhere said so — subjects are never logged, so a refused code and a
# refused newsletter look identical. This is the only place that can catch it.
run "realtime policy" "hook/policy.test.mjs"

# Recurring obligations and the logbook. Month boundaries are where this kind
# of arithmetic goes wrong, and it goes wrong silently.
run "recurring" "recurring.test.mjs"

# The Gmail fences. Under gmail.modify the deny list is what stands between a
# prompt injection in an email body and mail going out as Alex.
run "mcp-fences" "mcp-fences.test.mjs"

# Handle to name. Resolving a string that merely CONTAINS a number labelled a
# group thread with a stranger's name, in the list whose job is telling Alex
# who is waiting on him.
run "contacts" "contacts.test.mjs"

# Time formats. slotKey is compared as a string against a key the host watchdog
# computes independently in python; when they drifted, every job looked missed.
run "time" "time.test.mjs"

# The shared renderer. It escapes first, which is what makes it safe and what
# broke blockquotes: the test looked for `>` after it had become `&gt;`.
run "markdown" "markdown.test.mjs"

# Folding an append-only `what` into a state and a history. The rule it has to
# hold is that nothing disappears -- shortening one would take away the reason
# the list is trustworthy -- so it is checked against every conclusion on disk.
run "what" "what.test.mjs"

# The derived layer against the sources it came from. Mostly about false
# positives: the first draft called his own home four rare places and three
# live cabinet vendors dead, and a weekly list he learns to skim is worse than
# no list at all.
run "lint" "lint.test.mjs"

# The assistant adding entries to his diary. It may do this unasked only because
# every change is announced in the next brief, so that half is pinned as hard as
# the refusals are.
run "diary" "diary.test.mjs"

# Drafts waiting to go out as him: the stale rules, the promise and chase
# writers, and the pass. Written 2026-09-08 and never registered here, so for a
# week it passed or failed with nobody looking — guards.test.mjs now fails when
# a suite exists that this file does not run.
run "drafts" "drafts.test.mjs"
run "scheduling" "scheduling.test.mjs"

# One waiting draft per person, rewritten rather than added, and thrown away
# once he has dealt with the matter. Alex, 2026-09-15: "Auto discard drafts
# if I dealt with the issue." The refusals are the point: his own edits, his
# approvals, and contact that is only contact.
run "draft tidy" "draft-tidy.test.mjs"

# Projects as the registry: which tag a project owns, what it claims, and the
# add-a-task door. Mostly false-positive cases — a missing tag is visible as
# unassigned, a wrong one files a debt under a project he will not look in.
run "projects" "projects.test.mjs"

# Apple Reminders through the Mac bridge. Mostly refusals: his lists are his,
# a mirrored item must never read back as a second task, and nothing here may
# alarm — the dispatcher owns the push channel.
run "apple reminders" "reminders-bridge.test.mjs"

# Two rows for one thing. Mostly the pairs it must REFUSE: a wrong merge hides
# one of two real debts behind the other and nothing ever surfaces it again.
run "duplicates" "similar.test.mjs"

# Invoice fields off a filed PDF. The fixture is the real Lakeside Jet Hangar Co
# invoice that named the feature: it sat three weeks with no due date while the
# PDF said "Due On Receipt". The negatives are the point — terms never become a
# date here, and an image-only PDF reports blind rather than "no fields".
echo
echo "── invoice fields ─────────────────────────────────"
nodetest deploy/integrations/pdf-fields.test.mjs || fail=1

# A document or a signature logo. Wrong in both directions once each: eight
# copies of a 2KB PNG burying an invoice, and a 2.8MB proposal dropped for
# being marked inline.
echo
echo "── attachments: document or furniture ─────────────"
nodetest deploy/integrations/attachment-parts.test.mjs || fail=1

# The draft door, run as a script the way every job runs it. Exit 13 from a
# module deadlock hid for ten evenings as "a network hang" (2026-09-15 to 09-24).
echo
echo "── mail-draft.mjs as a job runs it ────────────────"
nodetest deploy/integrations/mail-draft-cli.test.mjs --no-obligations || fail=1

echo
echo "── imessage extractor ─────────────────────────────"
python3 "$OBLIGATIONS/deploy/integrations/imessage-extract.test.py" || fail=1

python3 "$OBLIGATIONS/deploy/integrations/imessage-diff.test.py" || fail=1
# The mail differ. Mostly the floor: the three facts that stop a contract,
# a tax letter or a message from his wife being archived into a digest.
python3 "$OBLIGATIONS/deploy/integrations/email-diff.test.py" || fail=1
python3 "$OBLIGATIONS/deploy/integrations/contacts-extract.test.py" || fail=1
python3 "$OBLIGATIONS/deploy/integrations/call-log-extract.test.py" || fail=1

echo
echo "── dispatcher ─────────────────────────────────────"
python3 -c "import ast,sys; ast.parse(open('$OBLIGATIONS/deploy/reminder-dispatch.py').read()); \
            ast.parse(open('$OBLIGATIONS/deploy/messages.py').read()); print('  ok   python syntax')" || fail=1
python3 "$OBLIGATIONS/deploy/reminder-dispatch.test.py" || fail=1

# The one place anything reaches Alex's phone. The failure classification is
# what matters: a rejection is safe to retry, an ambiguity is not.
python3 "$OBLIGATIONS/deploy/notify.test.py" || fail=1

# Boot the service once, as systemd would. A startup error is a failed test
# here rather than a crash loop on the box.
if [ "$NATIVE" = 1 ]; then
  # The boundary between the server and everything Obligations.app holds. A suite
  # that passes with this failing has tested a server that can read his texts.
  echo; echo "── the sandbox ────────────────────────────────────"
  "$OBLIGATIONS/deploy/mac-server/sandbox.test.sh" | tail -3 || fail=1
fi

echo; echo "Service boot"
"$OBLIGATIONS/deploy/smoke.sh" || fail=1

echo
if [ "$fail" -eq 0 ]; then echo "ALL PASSED"; else echo "FAILURES ABOVE"; fi
exit "$fail"
