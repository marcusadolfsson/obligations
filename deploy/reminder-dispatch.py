#!/usr/bin/env python3
"""Minute-cadence reminder dispatcher. Deterministic — no LLM.

Parses reminders.md, pushes anything due via ntfy, updates nag state, commits.
The agent jobs (07:00/18:00) keep the judgment work: briefs, stalled moves,
disposition conversations. This script only does what a clock can do.

Line format (rules/reminders.md is authoritative):
- [ ] YYYY-MM-DD HH:MM | TEXT | gentle|normal|hard | repeat:R | nags:N | last:TS
where last's TS is `-` or YYYY-MM-DDTHH:MM (T-separated: the field match
allows no spaces). Lines inside <!-- --> blocks are ignored.
"""
import fcntl, json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timedelta
from pathlib import Path

# systemd runs this by absolute path; make the sibling module importable
# regardless of cwd. Must happen before the import below.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import write_message  # noqa: E402
from notify import config, send  # noqa: E402

# The repo this file lives in, unless OBLIGATIONS says otherwise. It used to be
# ~/obligations, true on linuxbox and wrong on the Mac mini, where the working copy
# is ~/Developer/obligations (2026-10-01) — a test run without OBLIGATIONS read the old
# path and failed. Where the script is, is where the repo is.
OBLIGATIONS = Path(os.environ.get("OBLIGATIONS") or Path(__file__).resolve().parents[1])
REM = OBLIGATIONS / "reminders.md"
LOG = OBLIGATIONS / ".log"
FMT = "%Y-%m-%d %H:%M"          # DUE field
FMT_LAST = "%Y-%m-%dT%H:%M"     # last: field must contain no space

QUIET_START, QUIET_END = 21, 7          # no pushes 21:00–07:00
DAILY_BUDGET = 3                        # pushes/day, rung-4 questions exempt
RENAG = {"hard": timedelta(hours=2), "normal": timedelta(hours=4)}

LINE = re.compile(
    r"^- \[ \] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \| (.+?) \| (gentle|normal|hard)"
    r" \| repeat:(\S+) \| nags:(\d+) \| last:(\S+)\s*$")


# Delivery moved to deploy/notify.py: one sender, several callers, and the
# channel it returns is what goes into `delivered:` so the record cannot lie
# about how something reached him. The old inline curl also put the topic and
# the message body in argv, visible in `ps` to anything on the box.
def env():
    """Kept as a name because callers below read config for more than push."""
    return config()





def budget_used(today):
    f = LOG / f"pushes-{today}"
    return int(f.read_text()) if f.exists() else 0


def budget_bump(today):
    f = LOG / f"pushes-{today}"
    f.write_text(str(budget_used(today) + 1))


# Where the service runs decides what an alert tells him to type. On linuxbox it
# was systemd; on the Mac mini (2026-10-01) it is two launchd agents owned by
# Obligations Server.app, and the commands that matter there are launchctl's — or
# the Restart button in the Obligations menu, which is what he will actually reach for.
ON_MAC = sys.platform == "darwin"
SERVER_LABEL = "com.example.obligations.server"
if ON_MAC:
    CHECK_SERVICE = ("  the Server section of the Obligations menu, or\n"
                     f"  launchctl print gui/$(id -u)/{SERVER_LABEL}\n"
                     "  tail -50 ~/Library/Logs/Obligations\\ Server/server.log")
    RESTART_SERVICE = (f"  Restart in the Obligations menu, or launchctl kickstart -k gui/$(id -u)/{SERVER_LABEL}")
else:
    CHECK_SERVICE = "  systemctl status obligations-agent\n  journalctl -u obligations-agent -n 50"
    RESTART_SERVICE = "  systemctl restart obligations-agent"


def snapshot_timers():
    """Write systemd timer status where the containerised dashboard can read it.

    The dashboard used to shell out to systemctl, which it can no longer do from
    inside a container — and the fix is not to install systemctl there, but to
    have the one process that already runs on the host do the looking. Cheap,
    once a minute, and it grants the container nothing.
    """
    try:
        if ON_MAC:
            out = launchd_snapshot()
        else:
            out = subprocess.run(
                ["systemctl", "list-timers", "obligations-*", "--no-pager"],
                capture_output=True, text=True, timeout=5).stdout.strip()
        if out:
            LOG.mkdir(exist_ok=True)
            (LOG / "timers").write_text(out + "\n")
    except Exception:                       # noqa: BLE001
        pass                                # never let a status panel break dispatch


def launchd_snapshot():
    """The Mac's equivalent: the two launchd agents, one line each.

    State, pid, how many times launchd has started it, and the last exit —
    the four facts `launchctl print` buries in eighty lines. A server stuck in
    a crash loop shows as a climbing run count and a non-zero last exit.
    """
    lines = []
    uid = os.getuid()
    for label in (SERVER_LABEL, "com.example.obligations.dispatch"):
        out = subprocess.run(["/bin/launchctl", "print", f"gui/{uid}/{label}"],
                             capture_output=True, text=True, timeout=5).stdout
        if not out:
            lines.append(f"{label}: not loaded")
            continue
        def field(name):
            m = re.search(rf"^\s*{re.escape(name)} = (.+)$", out, re.M)
            return m.group(1).strip() if m else "-"
        lines.append(f"{label}: state={field('state')} pid={field('pid')} "
                     f"runs={field('runs')} last-exit={field('last exit code')}")
    return "\n".join(lines)


# Jobs now run inside obligations-agent, which means a wedged agent is also a dead
# scheduler. This is the outside check that makes that visible: obligations-agent
# records each firing in .log/job-runs.json, and if a slot goes unrun well past
# its time, something is wrong with the agent and nobody would otherwise say so.
# Must match JOBS in deploy/agent-service/server.mjs. The Sunday 19:00 slot was
# removed 2026-09-02 and compaction folded into Sunday evening.
# "morning" is deliberately absent: it is paused in server.mjs as of
# 2026-09-02, and a watchdog that alarms about a job nobody intends to run
# is how a watchdog gets muted. Put it back when the job comes back.
# Watched for lateness. `mail` is deliberately absent: it has no slot — it
# fires on work — and a job with no slot can never be "missed".
# Must agree with JOBS in deploy/agent-service/server.mjs — the wiring guard
# checks that, because a slot the watchdog does not know about is a job that
# can stop running with nothing to notice.
# The 12:30 midday brief went 2026-10-24 (one brief a day); evening is
# housekeeping now and is still watched — a journal that stops being written
# is as silent as a brief that stops.
JOB_SLOTS = {"morning": (7, 0, None), "evening": (18, 0, None)}
LATE_AFTER = timedelta(minutes=45)


CONDITION_PUSHES = LOG / "condition-pushes.json"
OUTBOX_PUSHES = LOG / "outbox-pushes.json"


def push_outbox(now, cfg):
    """Tell him when something new is waiting for his tap in the outbox.

    Alex, 2026-09-08: "I think we should have a push notification anytime
    there is something new to approve in the outbox." It is the one queue with
    no other signal — it lives under `more`, the jobs fill it while he is
    somewhere else, and a text nobody sends looks exactly like nothing
    happening. The nav pill answers "is there anything" once he is already
    looking; this is what makes him look.

    Bounded by the work rather than by a counter, like the condition pushes:
    one push per draft id, ever, recorded in .log/outbox-pushes.json so a
    re-run and a restart both stay quiet. Several appearing together make ONE
    push — three buzzes for one triage run is how a channel stops being read.

    Quiet hours are respected in full. Nothing here expires: a draft waiting at
    03:00 is still waiting at 07:00, and none of it is worth waking him for.
    That is the opposite of a login code, and deliberately so.
    """
    if now.hour >= QUIET_START or now.hour < QUIET_END:
        return
    if not OUTBOX.exists():
        return
    try:
        seen = json.loads(OUTBOX_PUSHES.read_text()) if OUTBOX_PUSHES.exists() else {}
    except ValueError:
        seen = {}

    # A chase drafted into Gmail waits for his tap exactly like a text does,
    # but it lives in Gmail rather than outbox/, so the file loop below cannot
    # see it. drafts.mjs records every one it writes in this local file, which
    # keeps this a no-network function.
    # Since 2026-09-20 the ledger is the `chased` slice of the obligation's
    # own record; the old .log/chases.json is read only while that is absent.
    try:
        chases = json.loads((OBLIGATIONS / "integrations" / "obligation-state.json").read_text()).get("chased")
        if not isinstance(chases, dict):
            raise ValueError("no chased slice")
    except (OSError, ValueError, AttributeError):
        try:
            chases = json.loads((LOG / "chases.json").read_text())
        except (OSError, ValueError):
            chases = {}

    # Prune on every tick rather than only when something new turns up.
    # Housekeeping that runs only on the busy path never runs on the quiet one,
    # which is where a ledger keyed by name grows without bound. Both kinds of
    # key are checked against their own source: a filename against the
    # directory, a `chase:<obligation>` against the chase ledger.
    live = {f.name for f in OUTBOX.glob("*.md")} | {f"chase:{k}" for k in chases}
    pruned = {k: v for k, v in seen.items() if k in live}
    dirty = len(pruned) != len(seen)
    seen = pruned

    fresh = []
    for f in sorted(OUTBOX.glob("*.md")):
        try:
            head = f.read_text(errors="replace").split("\n---", 1)[0]
        except OSError:
            continue
        fields = {}
        for line in head.splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                fields[k.strip()] = v.strip()
        if fields.get("status") != "draft":
            continue
        if f.name in seen:
            continue
        fresh.append((f.name, fields))

    for key, c in chases.items():
        if c.get("channel") != "mail" or f"chase:{key}" in seen:
            continue
        fresh.append((f"chase:{key}", {"type": "outbox-mail", "to": c.get("who", "them")}))

    if not fresh:
        if dirty:
            LOG.mkdir(parents=True, exist_ok=True)
            OUTBOX_PUSHES.write_text(json.dumps(seen, indent=1))
        return

    def describe(fields):
        kind = fields.get("type", "outbox")
        to = fields.get("to", "someone")
        if kind == "outbox-invite":
            return f"calendar invite to {to}"
        if kind == "outbox-mail":
            return f"email to {to}"
        return f"text to {to}"

    if len(fresh) == 1:
        title = f"Waiting to send: {describe(fresh[0][1])}"
        body = "Read it and tap Send on the outbox."
    else:
        title = f"{len(fresh)} things waiting for you to send"
        body = "; ".join(describe(f) for _, f in fresh[:4])
        if len(fresh) > 4:
            body += f"; and {len(fresh) - 4} more"

    d = send(title, body, "default", cfg=cfg, meta={"kind": "outbox", "url": "/outbox"})
    # Recorded whether or not the push landed. A push that failed is a push
    # that must not be retried every minute for the rest of the day; the pill
    # and the brief both still carry the count, so nothing is lost silently.
    for name, _ in fresh:
        seen[name] = {"at": now.strftime(FMT), "delivered": d.channel if d.ok else "none"}
    LOG.mkdir(parents=True, exist_ok=True)
    OUTBOX_PUSHES.write_text(json.dumps(seen, indent=1))


def push_conditions(now, cfg):
    """Push an open condition of severity high or critical once, and its
    all-clear once. Alex, 2026-09-06: "some have urgency. Like a UPS device
    going offline." Outside the reminder budget — one push per condition per
    state is bounded by the mail, not by a counter — and outside quiet hours
    only for critical; a high one waits for morning, the way everything else
    does. The record of what was pushed lives in .log, keyed by condition and
    the time it opened, so a re-run never pushes twice."""
    node = _node()
    script = OBLIGATIONS / "deploy" / "agent-service" / "conditions.mjs"
    if not node or not script.exists():
        return
    try:
        r = subprocess.run([node, str(script), "--json"], capture_output=True, text=True, timeout=60,
                           env={**os.environ, "OBLIGATIONS": str(OBLIGATIONS)})
        data = json.loads(r.stdout or "{}")
    except Exception as e:                          # noqa: BLE001
        print(f"conditions failed: {e}", file=sys.stderr)
        return
    try:
        pushed = json.loads(CONDITION_PUSHES.read_text()) if CONDITION_PUSHES.exists() else {}
    except ValueError:
        pushed = {}
    quiet = now.hour >= QUIET_START or now.hour < QUIET_END
    changed = False
    for c in data.get("open", []):
        sev = c.get("severity", "normal")
        if sev == "normal":
            continue
        if quiet and sev != "critical":
            continue
        key = f"{c['key']}|{c.get('since')}"
        if pushed.get(key, {}).get("open"):
            continue
        d = send(f"{'CRITICAL' if sev == 'critical' else 'Alert'}: {c.get('what') or c['key']}",
                 f"open since {c.get('since')} ({c.get('minutes', 0)} min)", "high", cfg=cfg,
                 meta={"kind": "condition", "url": "/"})
        if d.ok:
            pushed.setdefault(key, {})["open"] = now.strftime(FMT)
            changed = True
            try:
                write_message("note", f"Alert: {c.get('what') or c['key']}",
                              f"{c.get('what')}\n\nOpen since {c.get('since')}. Pushed by {d.channel}.", delivered=d.channel, when=now)
            except Exception as e:                  # noqa: BLE001
                print(f"message record failed: {e}", file=sys.stderr)
    for c in data.get("resolved", []):
        key = f"{c['key']}|{c.get('opened')}"
        rec = pushed.get(key)
        if not rec or not rec.get("open") or rec.get("clear"):
            continue                                # never pushed open, or already cleared
        mins = c.get("minutes")
        d = send(f"Cleared: {c.get('what') or c['key']}",
                 f"back after {mins} min" if mins is not None else "resolved", "default", cfg=cfg,
                 meta={"kind": "condition", "url": "/"})
        if d.ok:
            rec["clear"] = now.strftime(FMT)
            changed = True
    if changed:
        CONDITION_PUSHES.write_text(json.dumps(pushed, indent=1) + "\n")


def watch_jobs(now, cfg):
    """Raise one message per missed slot. Never more than one — this is a
    watchdog, not a nag, and a stuck agent would otherwise produce one alert a
    minute until Alex muted the channel."""
    runs_file = LOG / "job-runs.json"
    seen_file = LOG / "job-alerts"
    try:
        runs = json.loads(runs_file.read_text()) if runs_file.exists() else {}
    except (OSError, ValueError):
        runs = {}
    alerted = set(seen_file.read_text().split()) if seen_file.exists() else set()

    for name, (h, m, weekday) in JOB_SLOTS.items():
        if weekday is not None and now.weekday() != weekday:
            continue
        due = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if now < due + LATE_AFTER:
            continue
        # Must match slotKey() in deploy/agent-service/time.mjs exactly. The two
        # are computed independently in two languages, and when they drifted —
        # a `T` became a space — every job looked missed while running fine.
        key = due.strftime("%Y-%m-%dT%H:%M")
        recorded = runs.get(name, {}).get("slot")
        if recorded == key or f"{name}@{key}" in alerted:
            continue

        body = (f"The {name} job was due at {due:%H:%M} and has not run "
                f"{int((now - due).total_seconds() // 60)} minutes later.\n\n"
                f"Expected slot: {key}\n"
                f"job-runs.json: {recorded or '(no record for this job)'}\n\n"
                "If those two look like the same moment in different formats, "
                "this is a false alarm and the bug is the key format, not the "
                "job — slotKey() in deploy/agent-service/time.mjs must match "
                "the line above it here.\n\n"
                "Otherwise the assistant service runs the schedule in-process, so "
                "this usually means it is wedged or down. Check:\n"
                f"{CHECK_SERVICE}")
        title = f"{name} job did not run"
        # `delivered` is whatever actually worked, never a guess. A record that
        # claims a push that failed is worse than no record — rules/messages.md.
        delivered = send(title, body, "high", cfg=cfg, meta={"kind": "failure", "url": "/system"}).channel
        try:
            write_message("failure", title, body, delivered=delivered, when=now)
        except Exception as e:                      # noqa: BLE001
            print(f"watchdog message failed: {e}", file=sys.stderr)
        alerted.add(f"{name}@{key}")
        seen_file.write_text(" ".join(sorted(alerted)[-50:]))


# The Gmail watch lasts seven days; the service re-arms daily. These are the
# thresholds at which "daily re-arming" has demonstrably stopped happening.
WATCH_EXPIRY_WARN_H = 48        # less than two days of watch left
WATCH_STALE_ARM_H = 36          # a daily re-arm has missed at least one turn
WATCH_QUIET_H = 24              # no push at all in a day


def watch_gmail(now, cfg):
    """Notice when the realtime mail channel has gone quiet.

    This is the watchdog the whole realtime path needs most, because its
    failure mode is silence. `users.watch` expires after seven days and Gmail
    then simply stops publishing — no error, no bounce, no entry anywhere. A
    channel that has died looks exactly like a quiet week, and the first
    evidence would be a login code that never arrived while Alex was waiting
    for it.

    Deliberately in the dispatcher rather than in obligations-agent: the thing that
    notices the mail channel is dead must not be the mail channel. obligations-agent
    hosts the webhook, so a wedged service takes the push path down with it and
    would take its own watchdog down too.

    One alert per condition per account, ever, using the same seen-file trick as
    watch_jobs — a watchdog that repeats becomes a nag and then becomes muted.
    """
    state_file = LOG / "gmail-watch.json"
    if not state_file.exists():
        return                          # push is not set up; nothing to watch
    try:
        state = json.loads(state_file.read_text())
    except (OSError, ValueError):
        return

    seen_file = LOG / "watch-alerts"
    alerted = set(seen_file.read_text().split()) if seen_file.exists() else set()

    def age_hours(stamp):
        try:
            return (now - datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
                    .astimezone().replace(tzinfo=None)).total_seconds() / 3600
        except (ValueError, TypeError):
            return None

    for account, s in sorted(state.items()):
        problems = []

        if s.get("error"):
            first = str(s["error"]).splitlines()[0][:160]
            problems.append(("error", f"arming failed: {first}"))

        expires_in = None
        if s.get("expiration"):
            expires_in = (s["expiration"] / 1000 - now.timestamp()) / 3600
            if expires_in < WATCH_EXPIRY_WARN_H:
                problems.append(("expiring", f"the watch expires in {expires_in:.0f}h "
                                             "and re-arming has not renewed it"))

        armed = age_hours(s.get("armedAt"))
        if armed is not None and armed > WATCH_STALE_ARM_H and not s.get("error"):
            problems.append(("stale-arm", f"last armed {armed:.0f}h ago; "
                                          "the daily re-arm has missed a turn"))

        # Softest of the four, and phrased as a question rather than an alarm: a
        # genuinely quiet mailbox produces the same evidence as a dead channel,
        # and crying wolf here is how the whole channel stops being believed.
        quiet = age_hours(s.get("lastPushAt"))
        if quiet is not None and quiet > WATCH_QUIET_H and not problems:
            problems.append(("quiet", f"no Gmail push in {quiet:.0f}h. That may "
                                      "just be a quiet mailbox, or the watch may "
                                      "have lapsed without saying so."))

        for kind, detail in problems:
            key = f"{account}@{kind}"
            if key in alerted:
                continue
            title = f"Gmail push: {account}"
            body = (f"{detail}\n\n"
                    f"mailbox: {s.get('address') or '(not recorded)'}\n"
                    f"topic:   {s.get('topic') or '(none)'}\n"
                    f"armed:   {s.get('armedAt') or '(never)'}\n"
                    f"last push: {s.get('lastPushAt') or '(never)'}\n\n"
                    "The service re-arms every 24h and at startup. If this "
                    "persists:\n"
                    f"{RESTART_SERVICE}\n"
                    "  cat .log/gmail-watch.json\n\n"
                    "Login codes do not reach the phone while this is broken; "
                    "they still arrive by mail.")
            delivered = send(title, body, "high", cfg=cfg, meta={"kind": "failure", "url": "/system"}).channel
            try:
                write_message("failure", title, body, delivered=delivered, when=now)
            except Exception as e:                  # noqa: BLE001
                print(f"watch watchdog message failed: {e}", file=sys.stderr)
            alerted.add(key)
            seen_file.write_text(" ".join(sorted(alerted)[-50:]))


MESSAGES = OBLIGATIONS / "messages"

# Only briefs.
#
# `note` is excluded because it is the type the agent uses for "worth
# recording", and pushing those turns the channel into a feed.
#
# `failure` is excluded for a better reason: failures ALREADY have a push path
# that says what actually broke — watch_jobs() and notify-failure.sh — and they
# record `delivered:` when they send. Pushing them here too would either
# duplicate that or, worse, attach the task-count summary to a message about a
# wedged job, which is the wrong text for the wrong event.
# Which KINDS reach him unprompted, and it is one.
#
# `note` is deliberately absent: the evening job writes one whenever the journal
# turned up something worth seeing, and pushing those turns the channel into a
# feed -- which rules/reminders.md says is exactly how a channel stops being
# believed. A note is on the briefs page; it does not buzz.
#
# `failure` has its own path in notify-failure.sh, which pushes and records
# `delivered:` in one place rather than two that could disagree.
# `prep` too: a meeting-prep note an hour before the meeting is worth nothing
# an hour after it, so it is the second kind whose value is in its timing.
# `debrief` too: twenty minutes after a meeting is when the agreements are still
# in his head; an hour later it is a memory test.
PUSHABLE = {"brief", "prep", "debrief"}
# What `delivered:` may say once something carried it (rules/messages.md).
DELIVERED_CHANNELS = {"ntfy", "sms", "apns"}
PUSH_MAX_AGE_H = 12   # a brief, prep or debrief older than this stays on /briefs, unpushed


def summary_line():
    """What is outstanding, as numbers, computed here rather than by the agent.

    This is the whole point of the push. "Your brief is ready" carries no
    information and its only effect is to make Alex go and look; a lock
    screen saying "2 due today, 1 overdue, 4 waiting on you" is actionable
    without opening anything.

    Deterministic on purpose, and it is why this lives in the dispatcher. The
    text that leaves the box is assembled from integers produced by
    `deploy/tasks.mjs --json`, so nothing an injected email influenced can
    reach the wire — which is the property that made the originally-planned
    "let the agent compose a ping" version complicated, and which this gets for
    free by not involving a model at all.

    Returns None when the list cannot be read: a push that silently claims
    "nothing outstanding" would be worse than no push.
    """
    node = _node()
    script = OBLIGATIONS / "deploy" / "tasks.mjs"
    if not node or not script.exists():
        return None
    try:
        r = subprocess.run([node, str(script), "--json"], capture_output=True,
                           text=True, timeout=30,
                           env={**os.environ, "OBLIGATIONS": str(OBLIGATIONS)})
        if r.returncode != 0:
            return None
        items = json.loads(r.stdout).get("items", [])
    except Exception:                               # noqa: BLE001
        return None

    overdue = sum(1 for i in items if i.get("overdue"))
    due = sum(1 for i in items
              if not i.get("overdue") and i.get("lead_days") is not None
              and i["lead_days"] <= 0)
    mine = sum(1 for i in items if i.get("owed_by") == "me")
    theirs = sum(1 for i in items if i.get("owed_by") == "them")

    bits = []
    if overdue:
        bits.append(f"{overdue} overdue")
    if due:
        bits.append(f"{due} due today")
    bits.append(f"{mine} on you")
    if theirs:
        bits.append(f"{theirs} waiting on others")
    return ", ".join(bits)


def brief_title(name, fields, now):
    """The push title for a brief: the message's own title when it has one,
    else the slot — three of them. The hour split alone called the 12:30
    brief "Evening brief"; Alex, 2026-09-06: "when I got the 12:30 push
    notification, it said good evening." The hour comes from the filename
    rather than the clock, so a delayed push still says which brief it is."""
    own = (fields.get("title") or "").strip()
    if own:
        return own[:72]
    hhmm = re.match(r"\d{4}-\d{2}-\d{2}-(\d{2})", name)
    hour = int(hhmm.group(1)) if hhmm else now.hour
    return "Morning brief" if hour < 11 else ("Midday brief" if hour < 15 else "Evening brief")


def push_new_messages(now, cfg):
    """Push messages the agent wrote that have never reached him.

    Every brief since this system started has been written with
    `delivered: none` and read by nobody unless Alex went looking. The
    dispatcher already owns the channel, already runs every minute, and already
    updates `delivered:` honestly, so it is the right place to close that.

    Only files it has not seen before, and on the FIRST run it marks everything
    existing as seen without sending. Otherwise switching this on would push
    every brief ever written in one burst, which is precisely how a channel
    stops being believed.
    """
    if not MESSAGES.exists():
        return
    seen_file = LOG / "message-pushes"
    first_run = not seen_file.exists()
    seen = set(seen_file.read_text().split()) if not first_run else set()

    for path in sorted(MESSAGES.glob("*.md")):
        name = path.name
        if name in seen:
            continue
        seen.add(name)
        if first_run:
            continue                                # adopt the backlog silently

        try:
            head = path.read_text().split("---")[1]
        except (OSError, IndexError):
            continue
        fields = {}
        for line in head.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fields[k.strip()] = v.strip()

        # `kind`, NOT `type`. Every message file carries `type: message` and puts
        # brief/note/failure in `kind`, so testing `type` against a set of kinds
        # was always false and this function never pushed anything -- every
        # brief since it was written says `delivered: none`, correctly, and
        # nobody read the field that was telling us.
        if fields.get("kind") not in PUSHABLE:
            continue
        # Only a real channel means it reached him. The brief jobs wrote
        # `delivered: pending` on eight briefs between 2026-09-17 and
        # 2026-10-05 -- a word nothing defines -- and this line read anything
        # but `none` as "already reached him somehow", so none of the eight
        # was ever pushed. Alex, 2026-10-05: "why did the 6pm brief not run".
        if fields.get("delivered") in DELIVERED_CHANNELS:
            continue                                # already reached him
        # Too old to be worth a buzz. Also the guard on `seen`, which keeps
        # only the newest 200 names: an old brief that falls out of it, and
        # says `none` because it never went, must not arrive months late.
        try:
            written = datetime.strptime(fields.get("at", ""), FMT)
        except ValueError:
            written = None
        if written is None or now - written > timedelta(hours=PUSH_MAX_AGE_H):
            continue

        # Host-composed, from the message TYPE and from integers. The agent's
        # own prose never reaches the wire.
        kind = fields.get("kind")
        if kind == "failure":
            title = "Obligations: something failed"
        else:
            # messages/ names are YYYY-MM-DD-HHMM-kind.md. Read the hour from
            # the name rather than from the clock: a push delayed by a wedged
            # tick should still say which brief it is about.
            title = brief_title(name, fields, now)
        if kind == "prep":
            title = "Meeting prep"
        elif kind == "debrief":
            title = "Debrief"
        body = summary_line() or "The task list could not be read."

        # Where a tap lands: the message itself, on the digest.
        delivery = send(title, body, "default", cfg=cfg,
                        meta={"kind": kind, "url": f"/briefs#pane={name}", "id": name})
        if delivery.ok:
            # rules/messages.md: `delivered:` records how it ACTUALLY reached
            # him and must never claim a push that failed.
            try:
                text = path.read_text()
                path.write_text(re.sub(r"(?m)^delivered:.*$",
                                       f"delivered: {delivery.channel}", text, count=1))
            except OSError as e:
                print(f"could not record delivery on {name}: {e}", file=sys.stderr)

    seen_file.write_text(" ".join(sorted(seen)[-200:]))


def push_backup():
    """Push committed work to origin.

    Not the agent's job — `git push` is denied at the harness level, because an
    agent that reads untrusted email must not be able to push anywhere. But that
    left nothing pushing at all: origin sat 16 commits behind for two days, and
    the "losing the box costs you nothing" line in deploy/README.md was simply
    untrue. A deterministic host script closes that without handing the
    capability to the agent.

    Cheap when there is nothing to do, and never fatal: a failed push must not
    take the reminder dispatcher down with it.
    """
    try:
        ahead = subprocess.run(
            ["git", "-C", str(OBLIGATIONS), "rev-list", "--count", "origin/main..HEAD"],
            capture_output=True, text=True, timeout=10).stdout.strip()
        if not ahead or ahead == "0":
            return
        r = subprocess.run(["git", "-C", str(OBLIGATIONS), "push", "-q", "origin", "main"],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            print(f"backup push failed: {r.stderr.strip()[:200]}", file=sys.stderr)
    except Exception as e:                          # noqa: BLE001
        print(f"backup push error: {e}", file=sys.stderr)


# Loose objects at which the repo is repacked. We make ~500 a day — 203 commits
# in a week touch a 1.6MB state file — and each loose object is stored whole,
# zlib'd, with no delta against its neighbour. At 3,584 loose objects .git was
# 123MB; the same history packed is 3.5MB, because an append-shaped JSON file
# deltas almost perfectly. Git's own `gc --auto` threshold is 6,700, which this
# repo would cross about every fortnight while carrying 200MB in between.
LOOSE_MAX = 1500


def pack_repo(now):
    """Repack the object store when the loose count says it is worth it.

    Alex, 2026-09-20, on whether the .md files should become a database: the
    measurement that answered it was that git packs this history to 3.5MB and
    loses nothing. That answer only holds while something actually packs it.

    Checked at most once a day, and only in quiet hours: `git gc` is safe
    against a concurrent commit (it takes its own lock and never prunes a
    reachable object), but it rewrites the object store, and doing that while
    a triage is committing is a risk with no upside when 04:00 is empty.

    Never fatal, like every other housekeeping task here: a repo that failed to
    pack is a disk-space problem, not a reason to stop dispatching reminders.
    """
    ledger = LOG / "gc.json"
    today = now.strftime("%Y-%m-%d")
    try:
        state = json.loads(ledger.read_text())
    except (OSError, ValueError):
        state = {}
    if state.get("checked") == today:
        return
    try:
        out = subprocess.run(["git", "-C", str(OBLIGATIONS), "count-objects", "-v"],
                             capture_output=True, text=True, timeout=30).stdout
        loose = int(next((l.split()[1] for l in out.splitlines()
                          if l.startswith("count:")), 0))
        state["checked"] = today
        state["loose"] = loose
        if loose >= LOOSE_MAX:
            r = subprocess.run(["git", "-C", str(OBLIGATIONS), "gc", "--quiet"],
                               capture_output=True, text=True, timeout=600)
            state["packed_at"] = now.strftime("%Y-%m-%d %H:%M")
            state["packed_from"] = loose
            if r.returncode != 0:
                state["error"] = r.stderr.strip()[:200]
                print(f"gc failed: {state['error']}", file=sys.stderr)
            else:
                state.pop("error", None)
        LOG.mkdir(parents=True, exist_ok=True)
        ledger.write_text(json.dumps(state, indent=1) + "\n")
    except Exception as e:                          # noqa: BLE001
        print(f"gc error: {e}", file=sys.stderr)


def refresh_message_diff():
    """Keep the message work list current, so the agent never has to compute it.

    Deterministic, so it belongs here rather than in a turn: deciding which
    threads have new messages is arithmetic, and the agent doing it means
    re-reading 94 threads to answer a question about timestamps. The agent still
    makes every judgement about what a thread *means* — this only says which
    ones moved.

    Also means a scheduled job can use the cache without needing Bash: the job
    cannot run python, but it can Read a file.
    """
    script = Path(__file__).resolve().parent / "integrations" / "imessage-diff.py"
    if not script.exists():
        return
    try:
        subprocess.run([sys.executable, str(script)], capture_output=True,
                       text=True, timeout=30, env={**os.environ, "OBLIGATIONS": str(OBLIGATIONS)})
    except Exception as e:                          # noqa: BLE001
        print(f"message diff failed: {e}", file=sys.stderr)


# How stale the calendar cache may get. The 07:00 brief is the consumer that
# matters and it reads a file, so this only has to be fresher than "useful for
# the next thing that asks" — not live. Ten minutes is one Google call per ten
# ticks instead of one per tick.
CALENDAR_MAX_AGE = 600

# Mail. Slower than the calendar because the extract is 583 metadata fetches
# rather than one list call, and nothing here is the urgent path — a login code
# arrives through the webhook in seconds, not through this.
EMAIL_MAX_AGE = 900


def _node():
    """Find node, which systemd will not have on PATH.

    It lives under nvm here, so `node` resolves in an interactive shell and
    nowhere else. Hardcoding the version path is how that breaks silently at the
    next nvm upgrade — the same failure the ttyd unit hit on 2026-08-31.
    """
    found = shutil.which("node")
    if found:
        return found
    versions = sorted((Path.home() / ".nvm/versions/node").glob("v*/bin/node"))
    return str(versions[-1]) if versions else None


def refresh_email():
    """Re-extract mail and re-diff it, on the same bargain as the message diff.

    Deciding which of 583 threads moved is arithmetic, and an agent doing it
    means re-reading the mailbox to answer a question about timestamps. The
    agent still judges what every thread *means*.

    Slower cadence than the message diff because the extract is a network call
    to Google — see CALENDAR_MAX_AGE for the same reasoning. The realtime path
    for anything genuinely urgent is the Pub/Sub webhook, not this.
    """
    out = OBLIGATIONS / "integrations" / "gmail.json"
    node = _node()
    extract = OBLIGATIONS / "deploy" / "integrations" / "gmail-extract.mjs"
    differ = OBLIGATIONS / "deploy" / "integrations" / "email-diff.py"
    env = {**os.environ, "OBLIGATIONS": str(OBLIGATIONS)}

    # The judgements moved since the work list was written — the mail job
    # just ran — so re-diff now, against the extract we have. Without this the
    # list kept naming threads as waiting for up to fifteen minutes after they
    # were judged; Alex, 2026-09-06: "so why were they not digested 13 min
    # ago." A diff is local and cheap; only the extract is the network call.
    changed = OBLIGATIONS / "integrations" / "gmail-changed.json"
    state = OBLIGATIONS / "integrations" / "email-state.json"
    try:
        if (differ.exists() and out.exists() and state.exists()
                and (not changed.exists() or state.stat().st_mtime > changed.stat().st_mtime)):
            subprocess.run([sys.executable, str(differ)], capture_output=True,
                           text=True, timeout=60, env=env)
    except Exception as e:                          # noqa: BLE001
        print(f"email re-diff failed: {e}", file=sys.stderr)

    try:
        if out.exists() and time.time() - out.stat().st_mtime < EMAIL_MAX_AGE:
            return
    except OSError:
        pass

    if not node or not extract.exists() or not differ.exists():
        return
    try:
        r = subprocess.run([node, str(extract)], capture_output=True, text=True,
                           timeout=180, env=env)
        # Only diff a good extract. Diffing a failed one would re-judge a stale
        # mailbox as though it were current; the differ refuses too, but not
        # running it at all is cheaper and says the same thing.
        if r.returncode == 0:
            subprocess.run([sys.executable, str(differ)], capture_output=True,
                           text=True, timeout=60, env=env)
        else:
            print(f"gmail extract failed: {r.stderr.strip()[:200]}", file=sys.stderr)
    except Exception as e:                          # noqa: BLE001
        print(f"email refresh failed: {e}", file=sys.stderr)


def refresh_calendar():
    """Keep `integrations/calendar.json` current for the brief.

    Same bargain as refresh_message_diff: working out which events are today is
    arithmetic, and the 07:00 job should Read a file rather than spend a model
    call and a network round trip on it. Also means a calendar outage shows up
    as a named error in the file rather than as a brief that quietly omits
    every meeting — which is what happened for weeks before this existed.
    """
    out = OBLIGATIONS / "integrations" / "calendar.json"
    try:
        if out.exists() and time.time() - out.stat().st_mtime < CALENDAR_MAX_AGE:
            return
    except OSError:
        pass

    script = OBLIGATIONS / "deploy" / "integrations" / "calendar-extract.mjs"
    node = _node()
    if not script.exists() or not node:
        return
    try:
        subprocess.run([node, str(script)], capture_output=True, text=True,
                       timeout=60, env={**os.environ, "OBLIGATIONS": str(OBLIGATIONS)})
    except Exception as e:                          # noqa: BLE001
        # Never fatal. The extractor writes its own error into the file; this
        # only reports that it could not be run at all.
        print(f"calendar refresh failed: {e}", file=sys.stderr)


def debrief_meetings():
    """Ask what happened, twenty minutes after a meeting with someone else ends.

    deploy/debrief.mjs: prep's other half. Deterministic, idempotent through
    its own sent-list, and reads only files — so it sits on the minute tick
    beside prep for the same reason prep does.
    """
    script = OBLIGATIONS / "deploy" / "debrief.mjs"
    node = _node()
    if not script.exists() or not node:
        return
    try:
        subprocess.run([node, str(script)], capture_output=True, text=True,
                       timeout=60, env={**os.environ, "OBLIGATIONS": str(OBLIGATIONS)})
    except Exception as e:                          # noqa: BLE001
        print(f"debrief failed: {e}", file=sys.stderr)


def prep_meetings():
    """Write a meeting-prep note for anything starting in the next hour.

    deploy/prep.mjs is deterministic and reads only files, so it belongs on the
    minute tick beside the other refreshes: the same bargain as calendar and
    message extraction — arithmetic is code, and a model call to assemble facts
    the repo already holds would cost $2 per meeting and occasionally invent one.
    It keeps its own sent-list, so calling it every minute is idempotent.
    """
    script = OBLIGATIONS / "deploy" / "prep.mjs"
    node = _node()
    if not script.exists() or not node:
        return
    try:
        subprocess.run([node, str(script)], capture_output=True, text=True,
                       timeout=60, env={**os.environ, "OBLIGATIONS": str(OBLIGATIONS)})
    except Exception as e:                          # noqa: BLE001
        print(f"prep failed: {e}", file=sys.stderr)


OUTBOX = OBLIGATIONS / "outbox"


def commit_outbox():
    """Commit whatever the Mac just wrote into `outbox/`.

    `rules/outbox.md`: every transition is a file change in outbox/, committed,
    so that what was sent as Alex — when, to whom, and who approved it — is
    answerable from `git log` a year later. Nothing was doing that. A receipt
    landed on disk and stayed untracked, which is the one state that rule does
    not allow, and it is the state every send lands in by default. The audit
    trail had a hole exactly where the outward action was.

    Here rather than in the app, deliberately. The Mac already holds the only
    capability that acts outward as Alex; letting it also push commits into
    the repo would be a second one, on the same machine. And this process
    already holds the repo lock, so it is the only place a receipt can be
    committed without racing the agent jobs.

    Runs before the quiet-hours return, because recording what was sent has
    nothing to do with whether we may push tonight.
    """
    if not OUTBOX.exists():
        return
    try:
        r = subprocess.run(["git", "-C", str(OBLIGATIONS), "status", "--porcelain",
                            "--", "outbox"], capture_output=True, text=True, timeout=15)
        if r.returncode != 0 or not r.stdout.strip():
            return

        # Name what moved. "outbox: 1 sent" is answerable a year later in a way
        # that "dispatch: outbox" is not.
        counts = {}
        for ln in r.stdout.splitlines():
            name = ln[3:].strip().strip('"')
            try:
                head = (OBLIGATIONS / name).read_text().split("---")[1]
            except (OSError, IndexError):
                counts["changed"] = counts.get("changed", 0) + 1
                continue
            status = "changed"
            for line in head.splitlines():
                if line.startswith("status:"):
                    status = line.split(":", 1)[1].strip() or "changed"
            counts[status] = counts.get(status, 0) + 1
        summary = ", ".join(f"{n} {k}" for k, n in sorted(counts.items()))

        subprocess.run(["git", "-C", str(OBLIGATIONS), "add", "outbox"],
                       check=True, timeout=15)
        subprocess.run(["git", "-C", str(OBLIGATIONS), "commit", "-q",
                        "-m", f"outbox: {summary}"], check=True, timeout=15)
    except Exception as e:                              # noqa: BLE001
        # Never fatal. A failed commit must not stop reminders being processed,
        # and the receipt is still on disk to be committed on the next tick.
        print(f"outbox commit failed: {e}", file=sys.stderr)


TODO = OBLIGATIONS / "todo.md"

# A task line, unchecked or not: `- [ ] thing @person !due:...`
TODO_LINE = re.compile(r"^(\s*[-*]\s+\[)( |x|X)(\]\s*)(.+?)\s*$")


REPO_LOCK = LOG / "repo.lock"
LOCK_STALE = timedelta(seconds=60)


class repo_lock:
    """The same lock the agent service takes before editing Alex's markdown.

    The flock below is this process against itself and the agent jobs; it cannot
    be shared with node, which has no flock without a native module. An O_EXCL
    create can be, and needs nothing but open(2).

    A collision here does not corrupt a file — both sides read-modify-write
    whole files — it silently drops whichever write landed first, which is worse
    than corruption because nothing looks wrong afterwards.

    A lock older than a minute is broken rather than waited on: one crashed
    process must not wedge every write until somebody notices.
    """

    def __enter__(self):
        deadline = datetime.now() + timedelta(seconds=5)
        while True:
            try:
                LOG.mkdir(exist_ok=True)
                fd = os.open(str(REPO_LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(fd, f"{os.getpid()} {datetime.now().isoformat()}\n".encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    age = datetime.now() - datetime.fromtimestamp(REPO_LOCK.stat().st_mtime)
                    if age > LOCK_STALE:
                        REPO_LOCK.unlink(missing_ok=True)
                        continue
                except OSError:
                    continue
                if datetime.now() > deadline:
                    raise SystemExit("repo lock held for 5s; skipping this tick")
                time.sleep(0.05)

    def __exit__(self, *exc):
        REPO_LOCK.unlink(missing_ok=True)
        return False


def stamp_todos(now):
    """Give every new task in todo.md a `!since:` date.

    A task's age is the reason to look at it — "you wrote this nine days ago and
    it is still there" is the sentence that gets it done — and a hand-typed line
    carries no date. This used to be answered by walking `git log` for the file
    on every page load, which is an indirect way of asking a question the line
    can simply hold, and it went wrong in all the ordinary ways: a rewritten
    line looked new, a squashed history looked ancient.

    Arithmetic, not judgement, so it lives here rather than in an agent job:
    today's date onto anything that has none. Nothing else about the line is
    touched, and a checked one is left alone — its age stopped mattering.
    """
    try:
        lines = TODO.read_text().splitlines()
    except OSError:
        return

    today = now.strftime("%Y-%m-%d")
    changed = False
    section = ""

    for i, ln in enumerate(lines):
        h = re.match(r"^##\s+(.+?)\s*$", ln)
        if h:
            section = h.group(1).strip().lower()
            continue
        if section == "done":
            continue

        m = TODO_LINE.match(ln)
        if not m or m.group(2) != " ":
            continue
        body = m.group(4).strip()
        # The untouched template is a section of empty brackets, and a line that
        # already knows when it started needs nothing.
        if not body or "!since:" in body:
            continue

        lines[i] = f"{m.group(1)} {m.group(3)}{body} !since:{today}"
        changed = True

    if not changed:
        return

    TODO.write_text("\n".join(lines) + "\n")
    subprocess.run(["git", "-C", str(OBLIGATIONS), "add", "todo.md"], check=True)
    subprocess.run(["git", "-C", str(OBLIGATIONS), "commit", "-q",
                    "-m", "dispatch: date new tasks"], check=True)


def main():
    now = datetime.now()
    snapshot_timers()
    push_backup()
    refresh_message_diff()
    refresh_calendar()
    refresh_email()
    prep_meetings()                     # after the calendar, which it reads
    debrief_meetings()                  # same source, the other end of the meeting

    # Before the quiet-hours and no-channel returns below: dating a task has
    # nothing to do with whether we may push tonight.
    LOG.mkdir(exist_ok=True)
    _lock = open(LOG / "write.lock", "w")
    fcntl.flock(_lock, fcntl.LOCK_EX)
    with repo_lock():
        stamp_todos(now)
        commit_outbox()
    fcntl.flock(_lock, fcntl.LOCK_UN)
    _lock.close()
    LOG.mkdir(exist_ok=True)
    watch_jobs(now, env())
    watch_gmail(now, env())
    push_new_messages(now, env())
    push_conditions(now, env())         # before the quiet-hours return: a critical one may ring at night
    push_outbox(now, env())             # obeys quiet hours itself: nothing waiting to send is worth 03:00
    if now.hour >= QUIET_START or now.hour < QUIET_END:
        # The one thing that WANTS the quiet hours rather than tolerating them.
        if now.hour == 4:
            pack_repo(now)
        return 0
    cfg = env()
    if not cfg.get("NTFY_TOPIC"):
        return 0                        # no channel: the briefs carry reminders

    LOG.mkdir(exist_ok=True)
    lockf = open(LOG / "write.lock", "w")
    fcntl.flock(lockf, fcntl.LOCK_EX)   # same lock the jobs take

    rlock = repo_lock().__enter__()      # released at every return below
    lines = REM.read_text().splitlines()
    today = now.strftime("%Y-%m-%d")
    changed = False
    in_active = False
    in_comment = False

    for i, ln in enumerate(lines):
        if in_comment:
            if "-->" in ln:
                in_comment = False
            continue
        if "<!--" in ln:
            if "-->" not in ln:
                in_comment = True
            continue
        if ln.startswith("## "):
            in_active = ln.strip() == "## Active"
            continue
        m = LINE.match(ln) if in_active else None
        if not m:
            continue
        due_s, text, cls, rep, nags_s, last_s = m.groups()
        due, nags = datetime.strptime(due_s, FMT), int(nags_s)
        if due > now or cls == "gentle" or nags >= 4:
            continue                    # gentle: brief-only; 4: awaiting disposition
        last = None if last_s == "-" else datetime.strptime(last_s, FMT_LAST)
        if last is not None and now - last < RENAG[cls]:
            continue

        overdue = now - due
        rung4 = nags == 3               # this push is the 4th → disposition question
        if not rung4 and budget_used(today) >= DAILY_BUDGET:
            continue                    # over budget: morning brief surfaces it

        if rung4:
            title, prio = "Reminder — needs a decision", "high"
            body = (f"4th nudge on: {text}. Do it, give me a real date, "
                    f"or should I kill it? (reply in the assistant session)")
        else:
            title = "Reminder" if overdue < timedelta(minutes=2) else \
                    f"Reminder — overdue {int(overdue.total_seconds()//3600)}h"
            prio = "high" if cls == "hard" else "default"
            body = f"{text} (due {due_s})"

        delivery = send(title, body, prio, cfg=cfg, meta={"kind": "reminder", "url": "/todo"})
        if not delivery.ok:
            # Say so. A push that fails quietly is retried every minute and
            # looks, from the reminder line, exactly like a push never due —
            # which is how the ladder stood still for two days.
            print(f"reminder push failed ({delivery.detail}): {title}", file=sys.stderr)
        if delivery.ok:
            # Record what was sent. Only on a successful push, so the message
            # count and the nag count can never disagree — see rules/messages.md.
            try:
                write_message("reminder", title, body,
                              delivered=delivery.channel, when=now)
            except Exception as e:                      # noqa: BLE001
                print(f"message record failed: {e}", file=sys.stderr)
            if not rung4:
                budget_bump(today)
            lines[i] = (f"- [ ] {due_s} | {text} | {cls} | repeat:{rep}"
                        f" | nags:{nags + 1} | last:{now.strftime(FMT_LAST)}")
            changed = True

    if changed:
        REM.write_text("\n".join(lines) + "\n")
        subprocess.run(["git", "-C", str(OBLIGATIONS), "add", "reminders.md", "messages"],
                       check=True)
        subprocess.run(["git", "-C", str(OBLIGATIONS), "commit", "-q",
                        "-m", "dispatch: nag state"], check=True)
    rlock.__exit__()
    return 0


if __name__ == "__main__":
    sys.exit(main())
