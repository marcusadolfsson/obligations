#!/usr/bin/env python3
"""Tests for the deterministic half of the dispatcher.

Only `stamp_todos` for now, and it earns a test because it writes to a file
Alex maintains by hand. Every check below is the same question: did it add a
date to the lines that needed one and leave every other byte alone?
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        print(f"  ok   {label}"); passed += 1
    else:
        print(f"  FAIL {label}{(' -> ' + str(detail)) if detail else ''}"); failed += 1


TEMPLATE = """# Todo

> Format: `- [ ] thing @person !due:YYYY-MM-DD #project`
> A line in this blockquote is documentation, not a task.

## Now

- [ ] call the surgery scheduler @clara
- [ ] chase the CRM setup @hank !waiting !since:2026-08-20
- [x] already done
- [ ]

## Done

- [ ] this is in Done and is not a live task
"""

vault = Path(tempfile.mkdtemp())
(vault / ".log").mkdir()
(vault / "todo.md").write_text(TEMPLATE)
subprocess.run(["git", "init", "-q"], cwd=vault, check=True)
subprocess.run(["git", "config", "user.email", "t@t"], cwd=vault, check=True)
subprocess.run(["git", "config", "user.name", "t"], cwd=vault, check=True)
subprocess.run(["git", "add", "-A"], cwd=vault, check=True)
subprocess.run(["git", "commit", "-qm", "seed"], cwd=vault, check=True)

os.environ["OBLIGATIONS"] = str(vault)
spec = importlib.util.spec_from_file_location(
    "dispatch", Path(__file__).resolve().parent / "reminder-dispatch.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

now = datetime(2026, 8, 29, 10, 0)
d.stamp_todos(now)
after = (vault / "todo.md").read_text()
lines = after.splitlines()

print("Stamping")
check("an undated task gets today's date",
      "- [ ] call the surgery scheduler @clara !since:2026-08-29" in lines,
      next((l for l in lines if "surgery" in l), "(gone)"))
check("a task that already has one is left alone",
      "- [ ] chase the CRM setup @hank !waiting !since:2026-08-20" in lines)
check("a checked task is not stamped", "- [x] already done" in lines)
check("the empty template bracket is not stamped", "- [ ]" in lines)
check("the Done section is left alone",
      "- [ ] this is in Done and is not a live task" in lines)
check("documentation in the blockquote is not a task",
      "> Format: `- [ ] thing @person !due:YYYY-MM-DD #project`" in lines,
      next((l for l in lines if l.startswith("> Format")), "(changed!)"))
check("nothing else moved", len(lines) == len(TEMPLATE.splitlines()),
      f"{len(lines)} vs {len(TEMPLATE.splitlines())}")

print("\nCommitting")
log = subprocess.run(["git", "log", "--oneline", "-1"], cwd=vault,
                     capture_output=True, text=True).stdout
check("the change is committed", "date new tasks" in log, log.strip())
dirty = subprocess.run(["git", "status", "--porcelain"], cwd=vault,
                       capture_output=True, text=True).stdout
check("nothing is left uncommitted", dirty.strip() == "", dirty)

print("\nIdempotence")
before = (vault / "todo.md").read_text()
d.stamp_todos(datetime(2026, 8, 30, 10, 0))
check("a second run changes nothing", (vault / "todo.md").read_text() == before,
      "every task already carries a date")
check("  ...and makes no empty commit",
      subprocess.run(["git", "log", "--oneline"], cwd=vault, capture_output=True,
                     text=True).stdout.count("date new tasks") == 1)

# The two halves of the missed-job watchdog are computed independently, in two
# languages, and compared as strings. On 2026-08-30 they drifted — a `T` became
# a space when localStamp was consolidated — and the 07:00 brief was reported
# missing 45 minutes after it had finished successfully. Nothing caught it
# because nothing checked that the two formats agreed.
print("\nSlot key")
due = datetime(2026, 8, 30, 7, 0)
check("the watchdog's key is YYYY-MM-DDTHH:MM",
      due.strftime("%Y-%m-%dT%H:%M") == "2026-08-30T07:00",
      due.strftime("%Y-%m-%dT%H:%M"))
check("  ...which is the literal the node side is pinned to as well",
      due.strftime("%Y-%m-%dT%H:%M") == "2026-08-30T07:00",
      "slotKey() in deploy/agent-service/time.mjs must produce this exact string")

# The Gmail watch watchdog. Its whole reason to exist is that the failure it
# guards is SILENCE: users.watch expires after seven days and Gmail then just
# stops publishing, with no error anywhere. A dead channel and a quiet week
# produce identical evidence, and the first sign would be a login code that
# never arrived.
print("\nGmail watch watchdog")
import json as _json

_now = datetime.now()
_iso = lambda hours_ago: (_now - timedelta(hours=hours_ago)).astimezone().isoformat()
_exp = lambda hours: int((_now + timedelta(hours=hours)).timestamp() * 1000)

def watchdog(state):
    """Run watch_gmail over one synthetic state; return the alert titles."""
    tmp = Path(tempfile.mkdtemp())
    (tmp / ".log").mkdir()
    (tmp / ".log" / "gmail-watch.json").write_text(_json.dumps(state))
    old_log, old_send, old_msg = d.LOG, d.send, d.write_message
    fired = []
    d.LOG = tmp / ".log"
    d.send = lambda t, b, pr="default", tag=None, cfg=None, meta=None: (
        fired.append(t) or type("D", (), {"channel": "test"})())
    d.write_message = lambda *a, **k: None
    try:
        d.watch_gmail(_now, {})
        return fired
    finally:
        d.LOG, d.send, d.write_message = old_log, old_send, old_msg

healthy = {"gmail": {"address": "a@b.c", "topic": "t", "error": None,
                     "expiration": _exp(160), "armedAt": _iso(2),
                     "lastPushAt": _iso(1)}}
check("a healthy watch says nothing", watchdog(healthy) == [], watchdog(healthy))

check("an arming failure is reported",
      len(watchdog({"g": {**healthy["gmail"], "error": "gmail watch (400): nope"}})) == 1)

check("a watch expiring within 48h is reported",
      len(watchdog({"g": {**healthy["gmail"], "expiration": _exp(20)}})) == 1)

check("a re-arm that has missed a turn is reported",
      len(watchdog({"g": {**healthy["gmail"], "armedAt": _iso(40)}})) == 1)

check("a day with no push at all is reported",
      len(watchdog({"g": {**healthy["gmail"], "lastPushAt": _iso(30)}})) == 1)

# The soft one must not pile on top of a hard one: an unarmed watch obviously
# has no pushes, and two alerts for one fault is how a watchdog becomes noise.
loud = watchdog({"g": {**healthy["gmail"], "error": "boom", "lastPushAt": _iso(30)}})
check("a quiet channel is not reported ON TOP of a real fault", len(loud) == 1, loud)

# A watch armed but never yet pushed to is not a fault — it is a new install.
check("a watch that has never seen a push is not an alarm",
      watchdog({"g": {**healthy["gmail"], "lastPushAt": None}}) == [])

check("no state file at all is silence, not an alarm",
      watchdog({}) == [])

# Every brief this system has ever written landed with `delivered: none` and
# reached nobody. The push is deliberately the NUMBERS rather than "your brief
# is ready" — a notification whose only effect is to make you go and look is
# noise, and the channel is worth what Alex believes it is worth.
print("\nBrief pushes")
import shutil as _shutil

def messages_run(existing, new_files, fresh=True):
    """Set up messages/, run push_new_messages twice, return what was sent."""
    t = Path(tempfile.mkdtemp())
    (t / "messages").mkdir(); (t / ".log").mkdir()
    old = (d.MESSAGES, d.LOG, d.send, d.summary_line)
    sent = []
    d.MESSAGES, d.LOG = t / "messages", t / ".log"
    d.send = lambda ti, b, pr="default", tag=None, cfg=None, meta=None: (
        sent.append((ti, b)) or type("D", (), {"ok": True, "channel": "ntfy"})())
    d.summary_line = lambda: "1 overdue, 2 due today, 21 on you"

    # The REAL shape of a messages/ file: `type` is always "message" and the
    # brief/note/failure distinction lives in `kind`. This fixture used to write
    # `type: {kind}`, a format nothing produces — so it matched a filter that
    # tested `type` against a set of kinds, passed, and let every brief go
    # undelivered for as long as the feature existed.
    def write(name, kind="brief", delivered="none", at=None):
        at = at or datetime.now().strftime("%Y-%m-%d %H:%M")
        (t / "messages" / name).write_text(
            f"---\ntype: message\nkind: {kind}\nat: {at}\ndelivered: {delivered}\n---\n\nbody\n")

    try:
        for n in existing:
            write(n)
        d.push_new_messages(datetime.now(), {})     # adopt the backlog
        adopted = len(sent)
        for spec in new_files:
            write(*spec) if isinstance(spec, tuple) else write(spec)
        d.push_new_messages(datetime.now(), {})
        return adopted, sent, t
    finally:
        d.MESSAGES, d.LOG, d.send, d.summary_line = old

adopted, sent, t = messages_run(["2026-08-31-0705-brief.md", "2026-09-01-0705-brief.md"],
                                ["2026-09-02-0705-brief.md"])
check("the existing backlog is adopted silently, never sent in a burst", adopted == 0, adopted)
check("a new brief is pushed", len(sent) == 1, sent)
check("  ...with the counts, not 'your brief is ready'",
      "overdue" in sent[0][1] and "due today" in sent[0][1], sent[0][1])
check("  ...titled by the hour in the filename", sent[0][0] == "Morning brief", sent[0][0])
check("delivered: is rewritten to the channel that actually worked",
      "delivered: ntfy" in (t / "messages" / "2026-09-02-0705-brief.md").read_text())
_shutil.rmtree(t)

_, sent, t = messages_run([], [("2026-09-02-1805-brief.md",),
                               ("2026-09-02-1810-note.md", "note"),
                               ("2026-09-02-1815-failure.md", "failure")])
check("an evening brief is titled as such", sent[0][0] == "Evening brief", sent[0][0])
check("a note is not pushed — that would make the channel a feed", len(sent) == 1, sent)
check("  ...and nor is a failure, which has its own push with real detail",
      not any("failed" in ti for ti, _ in sent), sent)
_shutil.rmtree(t)

_, sent, t = messages_run([], [("2026-09-02-0705-brief.md", "brief", "ntfy")])
check("a brief that already reached him is not pushed again", sent == [], sent)
_shutil.rmtree(t)

# 2026-10-05: the evening brief said `delivered: pending` and was read as
# "already reached him". Eight briefs never went. Only a channel counts.
_, sent, t = messages_run([], [("2026-10-05-1800-brief.md", "brief", "pending")])
check("a brief marked 'pending' is pushed — only a real channel means it went", len(sent) == 1, sent)
check("  ...and its delivered: line says the channel afterwards",
      "delivered: ntfy" in (t / "messages" / "2026-10-05-1800-brief.md").read_text())
_shutil.rmtree(t)

_, sent, t = messages_run([], [("2026-09-02-0705-brief.md", "brief", "none", "2026-09-02 07:05")])
check("a brief older than the push window is not pushed months late", sent == [], sent)
_shutil.rmtree(t)

# The push title: the message's own title first, else the slot — three of them.
print("brief_title")
_n = datetime(2026, 9, 6, 12, 41)
check("07:xx with no title is the morning brief", d.brief_title("2026-09-06-0705-brief.md", {}, _n) == "Morning brief")
check("12:xx with no title is the midday brief, not the evening one", d.brief_title("2026-09-06-1240-brief.md", {}, _n) == "Midday brief")
check("18:xx with no title is the evening brief", d.brief_title("2026-09-06-1805-brief.md", {}, _n) == "Evening brief")
_own = d.brief_title("2026-09-06-1240-brief.md", {"title": "Midday — TRON opened, and your Multi Pass does not cover it"}, _n)
check("a message with its own title is pushed under it", _own.startswith("Midday — TRON opened"), _own)
check("  ...cut to a notification's width", len(d.brief_title("x-0705-brief.md", {"title": "t" * 200}, _n)) <= 72)

# ---- refresh_email: a moved judgement re-diffs at once, without a new extract ----
print("refresh_email re-diffs when the judgements moved")
import tempfile as _tf, time as _time, subprocess as _sp, os as _os
_root = Path(_tf.mkdtemp())
(_root / "integrations").mkdir(); (_root / "deploy" / "integrations").mkdir(parents=True)
(_root / "deploy" / "integrations" / "gmail-extract.mjs").write_text("")
(_root / "deploy" / "integrations" / "email-diff.py").write_text("")
_now = _time.time()
(_root / "integrations" / "gmail.json").write_text("{}")
_os.utime(_root / "integrations" / "gmail.json", (_now, _now))                    # fresh extract: no re-extract due
(_root / "integrations" / "gmail-changed.json").write_text("{}")
_os.utime(_root / "integrations" / "gmail-changed.json", (_now - 600, _now - 600))  # list written 10 min ago
(_root / "integrations" / "email-state.json").write_text("{}")
_os.utime(_root / "integrations" / "email-state.json", (_now - 60, _now - 60))      # judged a minute ago
_calls = []
def _fake_run(argv, **kw):
    _calls.append([str(a) for a in argv])
    class R: returncode = 0; stderr = ""; stdout = ""
    return R()
_orig = (d.OBLIGATIONS, d.subprocess.run, d._node)
d.OBLIGATIONS, d.subprocess.run, d._node = _root, _fake_run, (lambda: "/usr/bin/node")
d.refresh_email()
ran_diff = any(a[-1].endswith("email-diff.py") for a in _calls)
ran_extract = any(a[-1].endswith("gmail-extract.mjs") for a in _calls)
check("the differ ran because the judgements are newer than the list", ran_diff, str(_calls))
check("...and the extract did not, because it is fresh", not ran_extract, str(_calls))
_calls.clear()
_os.utime(_root / "integrations" / "gmail-changed.json", (_now, _now))               # list now newer than the state
d.refresh_email()
check("nothing to re-diff when the list is newer than the judgements", not _calls, str(_calls))
d.OBLIGATIONS, d.subprocess.run, d._node = _orig

# ---- push_conditions: a high one once, its all-clear once, never twice ----
print("push_conditions")
import json as _cj, tempfile as _ct, subprocess as _cs
_cd = Path(_ct.mkdtemp()); (_cd / ".log").mkdir(); (_cd / "deploy" / "agent-service").mkdir(parents=True)
(_cd / "deploy" / "agent-service" / "conditions.mjs").write_text("")
_state = {"open": [{"key": "ups:hangar", "since": "2026-09-06 13:02", "minutes": 5, "severity": "high", "what": "UPS at the hangar on battery"},
                   {"key": "piaware:3407", "since": "2026-09-06 12:50", "minutes": 40, "severity": "normal", "what": "PiAware not reporting"}], "resolved": []}
_sent = []
from collections import namedtuple as _nt
_Delivery = _nt("Delivery", "channel ok detail")
class _CR:
    def __init__(self, out): self.stdout, self.returncode, self.stderr = out, 0, ""
_origc = (d.OBLIGATIONS, d.LOG, d.CONDITION_PUSHES, d.subprocess.run, d._node, d.send, d.write_message)
d.OBLIGATIONS, d.LOG, d.CONDITION_PUSHES = _cd, _cd / ".log", _cd / ".log" / "condition-pushes.json"
d.subprocess.run = lambda argv, **kw: _CR(_cj.dumps(_state))
d._node = lambda: "/usr/bin/node"
d.send = lambda t, b, pr="default", tag=None, cfg=None, meta=None: (_sent.append((t, b, pr)) or _Delivery("ntfy", True, "ok"))
d.write_message = lambda *a, **k: None
_day = datetime(2026, 9, 6, 13, 7)
d.push_conditions(_day, {})
check("the high condition is pushed once; the normal one is not", len(_sent) == 1 and _sent[0][0].startswith("Alert: UPS") and _sent[0][2] == "high", _sent)
d.push_conditions(_day, {})
check("a second tick does not push it again", len(_sent) == 1, _sent)
_state["open"] = [_state["open"][1]]
_state["resolved"] = [{"key": "ups:hangar", "opened": "2026-09-06 13:02", "resolved": "2026-09-06 13:12", "minutes": 10, "what": "UPS at the hangar on battery"}]
d.push_conditions(datetime(2026, 9, 6, 13, 13), {})
check("the all-clear is pushed once, with the duration", len(_sent) == 2 and _sent[1][0].startswith("Cleared: UPS") and "10 min" in _sent[1][1], _sent)
d.push_conditions(datetime(2026, 9, 6, 13, 14), {})
check("...and not again", len(_sent) == 2)
_state["open"] = [{"key": "ups:home", "since": "2026-09-06 03:00", "minutes": 3, "severity": "high", "what": "UPS at home on battery"}]; _state["resolved"] = []
d.push_conditions(datetime(2026, 9, 6, 3, 3), {})
check("a high condition at 03:00 waits for morning", len(_sent) == 2)
_state["open"][0]["severity"] = "critical"
d.push_conditions(datetime(2026, 9, 6, 3, 4), {})
check("a critical one rings at night", len(_sent) == 3 and _sent[2][0].startswith("CRITICAL"))
d.OBLIGATIONS, d.LOG, d.CONDITION_PUSHES, d.subprocess.run, d._node, d.send, d.write_message = _origc

# --- push_outbox -----------------------------------------------------------
# Alex, 2026-09-08: "a push notification anytime there is something new to
# approve in the outbox." The failure modes are all about repetition: buzzing
# twice for one draft, buzzing once per draft when a triage run writes three,
# and buzzing at 03:00 about something that will still be there at breakfast.
print("\npush_outbox")
_o = (d.OUTBOX, d.OUTBOX_PUSHES, d.LOG, d.send)
_box = Path(tempfile.mkdtemp()) / "outbox"
_box.mkdir(parents=True)
_log = Path(tempfile.mkdtemp())
_pushes = []


def _draft(name, to, kind="outbox", status="draft"):
    (_box / name).write_text(
        f"---\ntype: {kind}\nto: {to}\nstatus: {status}\ncreated: 2026-09-08 12:00\n---\n\nhi\n")


class _D:
    def __init__(self, ok=True, channel="apns"):
        self.ok, self.channel = ok, channel


d.OUTBOX, d.LOG = _box, _log
d.OUTBOX_PUSHES = _log / "outbox-pushes.json"
d.send = lambda t, b, p=None, cfg=None, meta=None: (_pushes.append((t, b, meta)), _D())[1]

_draft("a.md", "+1555")
d.push_outbox(datetime(2026, 9, 8, 12, 0), {})
check("a new draft pushes once", len(_pushes) == 1, _pushes)
check("and the tap lands on the outbox", _pushes[0][2]["url"] == "/outbox", _pushes[0][2])

d.push_outbox(datetime(2026, 9, 8, 12, 1), {})
check("the same draft never pushes again", len(_pushes) == 1, _pushes)

_draft("b.md", "someone@example.com", kind="outbox-mail")
_draft("c.md", "carl@co19e0.example", kind="outbox-invite")
d.push_outbox(datetime(2026, 9, 8, 12, 2), {})
check("two new drafts make ONE push, not two", len(_pushes) == 2, _pushes)
check("it counts them", _pushes[1][0].startswith("2 things"), _pushes[1][0])
check("it names each kind by what it does",
      "email to" in _pushes[1][1] and "calendar invite to" in _pushes[1][1], _pushes[1][1])

_draft("d.md", "+1999")
d.push_outbox(datetime(2026, 9, 8, 3, 30), {})
check("nothing waiting to send is worth 03:00", len(_pushes) == 2, _pushes)
d.push_outbox(datetime(2026, 9, 8, 9, 0), {})
check("it goes out in the morning instead", len(_pushes) == 3, _pushes)

_draft("e.md", "+1777", status="sent")
d.push_outbox(datetime(2026, 9, 8, 9, 1), {})
check("something already sent is not waiting for anything", len(_pushes) == 3, _pushes)

(_box / "a.md").unlink()
d.push_outbox(datetime(2026, 9, 8, 9, 2), {})
import json as _json
check("the ledger drops drafts that are gone rather than growing forever",
      "a.md" not in _json.loads(d.OUTBOX_PUSHES.read_text()), d.OUTBOX_PUSHES.read_text())

d.OUTBOX, d.OUTBOX_PUSHES, d.LOG, d.send = _o

# ── Repacking the object store. Alex, 2026-09-20, asking whether the .md
# files should become a database: the measurement that said no was that git
# packs this history to 3.5MB and loses nothing — which only stays true while
# something packs it. 3,584 loose objects were carrying 123MB at the time.
print("\npacking the object store")
_gcdir = Path(tempfile.mkdtemp())
_repo = _gcdir / "repo"
_repo.mkdir()
_git = lambda *a: subprocess.run(["git", "-C", str(_repo), *a], capture_output=True, text=True)
_git("init", "-q")                      # no -b: git 2.25 on this host does not take it
_git("config", "user.email", "t@t"); _git("config", "user.name", "t")
_git("config", "gc.auto", "0")          # only our call may pack, or the test proves nothing
for _i in range(6):
    (_repo / f"f{_i}.txt").write_text("x" * 200 + str(_i))
    _git("add", "-A"); _git("commit", "-q", "-m", f"c{_i}")

_g = (d.OBLIGATIONS, d.LOG, d.LOOSE_MAX)
d.OBLIGATIONS, d.LOG = _repo, _gcdir / "log"
d.LOG.mkdir()

def _loose():
    out = subprocess.run(["git", "-C", str(_repo), "count-objects", "-v"],
                         capture_output=True, text=True).stdout
    return int(next(l.split()[1] for l in out.splitlines() if l.startswith("count:")))

_before = _loose()
check("the fixture has loose objects to pack", _before > 0, _before)

d.LOOSE_MAX = 999999                    # far above the count: nothing to do
d.pack_repo(datetime(2026, 9, 20, 4, 0))
_led = _json.loads((d.LOG / "gc.json").read_text())
check("under the threshold it counts and does not pack",
      _loose() == _before and _led["loose"] == _before and "packed_at" not in _led, _led)

d.LOOSE_MAX = 1
d.pack_repo(datetime(2026, 9, 20, 4, 1))
check("  ...and the same day it does not look again, whatever the threshold says",
      _loose() == _before, "the once-a-day ledger did not hold")

d.pack_repo(datetime(2026, 9, 21, 4, 0))
check("over the threshold, on a new day, it packs", _loose() < _before, f"{_before} -> {_loose()}")
_led = _json.loads((d.LOG / "gc.json").read_text())
check("  ...and the ledger says when, and from how many", _led.get("packed_at") and _led.get("packed_from") == _before, _led)
check("  ...and records no error", "error" not in _led, _led)

# Housekeeping is never fatal: a broken repo must not stop reminders going out.
d.OBLIGATIONS = _gcdir / "not-a-repo"
d.pack_repo(datetime(2026, 9, 22, 4, 0))
check("a repo git cannot read is survived, not raised", True)

d.OBLIGATIONS, d.LOG, d.LOOSE_MAX = _g

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
