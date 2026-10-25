#!/usr/bin/env python3
"""Tests for the mail differ.

The signals are what these mostly guard. Everything else here is a work list that
can be regenerated; the floor is the one place where being wrong archives a
contract or a message from his wife into a digest nobody reads.
"""
import importlib.util
import sys
from datetime import datetime, timedelta
from pathlib import Path

# The module's filename has a hyphen, so it cannot be imported by name.
spec = importlib.util.spec_from_file_location(
    "email_diff", Path(__file__).resolve().parent / "email-diff.py")
ed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ed)

# Tests must not read production config. `held_accounts()` opens the real
# integrations/google-policy.json, so the day Alex held work two unrelated
# tests failed — their fixtures happened to use "work" as an account name and
# their threads silently left the work list. Neutralised here; the cases that
# care about holding pass `hold=` explicitly.
ed.held_accounts = lambda: set()
ed.ignored_senders = lambda: set()   # same reason: tests must not read production config
import json as _json

passed = failed = 0


def check(what, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok   {what}")
    else:
        failed += 1
        print(f"  FAIL {what}" + (f" -> {detail}" if detail else ""))


def thread(**over):
    t = {
        "thread_id": "t1", "account": "gmail", "subject": "Hello",
        "watermark": "2026-09-01 10:00", "never_replied": True,
        "has_attachment": False, "in_inbox": True,
        "messages": [{"from": "stranger@example.com", "at": "2026-09-01 10:00"}],
    }
    t.update(over)
    return t


print("Signals: facts reported, constraining nothing")
people = {"jane@example.com"}

r = ed.signals_for(thread(messages=[{"from": "jane@example.com"}]), people)
check("a sender with a file in people/ is reported", len(r) == 1 and "people/" in r[0], r)
check("  ...and names who, so the agent knows why", "jane@example.com" in r[0])

r = ed.signals_for(thread(never_replied=False), people)
check("a thread he has replied to is reported",
      any("replied" in x for x in r), r)

r = ed.signals_for(thread(has_attachment=True), people)
check("an attachment is reported", any("attachment" in x for x in r), r)

r = ed.signals_for(thread(), people)
check("an ordinary stranger's mail has no signals — the agent decides", r == [], r)

r = ed.signals_for(thread(messages=[{"from": "jane@example.com"}],
                        never_replied=False, has_attachment=True), people)
check("all three reasons are reported, not just the first", len(r) == 3, r)

# people/ unreadable must not mean "nobody is known" — that would silently drop
# a whole leg of the floor and look identical to a working system.
r = ed.signals_for(thread(messages=[{"from": "jane@example.com"}]), None)
check("no people/ index drops that leg rather than treating everyone as a stranger",
      r == [], r)

print("\nWhat moved")
extract = {"updated": "2026-09-01 12:00", "threads": [thread()]}

out = ed.diff(extract, {}, people)
check("a thread never seen before is new", out["counts"]["new"] == 1)
check("  ...and carries the ref sources/email.mjs will use",
      out["needs_judgement"][0]["ref"] == "mail:gmail:t1",
      out["needs_judgement"][0]["ref"])

# `reviewed` is relative to now on purpose. It was the literal "2026-09-01
# 11:00", which meant this case asserted "unchanged" only while the calendar
# agreed — and at 11:00 on 2026-09-08 the fixture turned STALE_DAYS old and the
# differ started correctly calling it stale, mid-session, with nothing changed.
# A test that passes in the morning and fails after lunch is testing the date,
# not the rule. Alex, 2026-09-08.
fresh_day = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M")
state = {"threads": [{"thread_id": "t1", "account": "gmail",
                      "watermark": "2026-09-01 10:00", "reviewed": fresh_day,
                      "conclusion": {"open": True}}]}
out = ed.diff(extract, state, people)
check("a thread that has not moved is unchanged", out["counts"]["unchanged"] == 1)

moved = {"updated": "x", "threads": [thread(watermark="2026-09-01 18:00")]}
out = ed.diff(moved, state, people)
check("new mail on a known thread is updated", out["counts"]["updated"] == 1)
check("  ...and says what it is newer than",
      out["needs_judgement"][0]["since"] == "2026-09-01 10:00")

print("\nA decision Alex made is not re-judged on age")
closed_by_hand = {"threads": [{"thread_id": "t1", "account": "gmail",
                               "watermark": "2026-09-01 10:00",
                               "reviewed": "2020-01-01 00:00",
                               "conclusion": {"open": False, "closed_by": "alex",
                                              "closed_at": "2026-08-01 09:00"}}]}
out = ed.diff(extract, closed_by_hand, people)
check("closed by a human and quiet since is left alone",
      out["counts"]["settled"] == 1 and not out["needs_judgement"], out["counts"])

out = ed.diff(moved, closed_by_hand, people)
check("but new mail on it comes back with a louder reason",
      out["needs_judgement"][0]["reason"] == "new mail on a thread that was closed",
      out["needs_judgement"][0]["reason"])
check("  ...carrying who closed it and when",
      out["needs_judgement"][0]["closed_by"] == "alex")

# His note on the close goes with it. Alex, 2026-09-30: "when I close a task
# with a note, is that note helpful for future actions?" It was not — the
# triage learned only that he had closed the thread, never what he wrote.
out = ed.diff(moved, closed_by_hand, people, close_notes={"mail:gmail:t1": "Not interested"})
check("  ...and his own note on the close",
      out["needs_judgement"][0].get("closed_note") == "Not interested", out["needs_judgement"][0])
out = ed.diff(moved, closed_by_hand, people, close_notes={})
check("  ...and no note field when he left none", "closed_note" not in out["needs_judgement"][0])
_d = _tf.mkdtemp() if "_tf" in globals() else __import__("tempfile").mkdtemp()
_p = Path(_d) / "obligation-state.json"
_p.write_text(_json.dumps({"closed": {"mail:gmail:parent": {"at": "2026-09-01 09:00", "by": "alex", "outcome": "paid by check 9/12"}},
                           "links": {"mail:gmail:t1": {"into": "mail:gmail:parent"}}}))
notes = ed.load_close_notes(_p)
check("a merged thread's note is its parent's", notes.get("mail:gmail:t1") == "paid by check 9/12", notes)
check("a missing file is no notes, not an error", ed.load_close_notes(Path(_d) / "nope.json") == {})

# His autopay list, as a signal. Alex, 2026-09-30: "I only want to be a task
# if autopay fails."
_ap = {"powercopaperlessbilling@paperless.powerco.example": {"accounts": ["5464"]}, "@co21cc.example": {}}
_duke = {"messages": [{"from": "Power Co <powercopaperlessbilling@paperless.powerco.example>"}], "never_replied": True}
check("a bill from a vendor on his autopay list is flagged, with its accounts",
      any("on his autopay list" in w and "5464" in w for w in ed.signals_for(_duke, set(), autopay=_ap)), ed.signals_for(_duke, set(), autopay=_ap))
check("  ...a domain entry covers its subdomains",
      any("@co21cc.example" in w for w in ed.signals_for({"messages": [{"from": "noreply@mail.co21cc.example"}]}, set(), autopay=_ap)))
check("  ...and nobody else is", not any("autopay" in w for w in ed.signals_for({"messages": [{"from": "a@example.com"}]}, set(), autopay=_ap)))

# A closed conclusion is left alone, whoever closed it. The one second look an
# agent close used to get — 140 over its life, none of which reopened anything
# — was deleted on 2026-09-20; obligation-state.json, the evening's "closed
# today" and the Reopen door are what guard a wrong close now.
closed_by_agent = {"threads": [{"thread_id": "t1", "account": "gmail",
                                "watermark": "2026-09-01 10:00",
                                "reviewed": "2020-01-01 00:00",
                                "conclusion": {"open": False, "tier": "action"}}]}
out = ed.diff(extract, closed_by_agent, people)
check("a conclusion the agent closed is NOT re-offered, however stale",
      out["counts"]["stale"] == 0 and out["counts"]["unchanged"] == 1 and not out["needs_judgement"], out["counts"])

print("\nNothing open is allowed to vanish")
aged = {"threads": [{"thread_id": "old", "account": "work",
                     "watermark": "2026-08-01 09:00",
                     "conclusion": {"open": True, "what": "send the dates"}}]}
out = ed.diff(extract, aged, people)
check("an open obligation that fell out of the window is reported",
      out["counts"]["aged_out_still_open"] == 1, out["counts"])
check("  ...with the right account in its ref",
      out["needs_judgement"][0]["ref"] == "mail:work:old",
      out["needs_judgement"][0]["ref"])
check("  ...and is first in the queue, because nothing else will surface it",
      out["needs_judgement"][0]["thread_id"] == "old")

closed_and_aged = {"threads": [{"thread_id": "old", "account": "work",
                                "conclusion": {"open": False, "closed_by": "alex"}}]}
out = ed.diff(extract, closed_and_aged, people)
check("a CLOSED obligation that aged out is not resurrected",
      out["counts"]["aged_out_still_open"] == 0)

# An aged-out thread has no new messages by definition — that is why it aged
# out — so re-judging one the day after judging it cannot change the answer and
# spends a turn to prove it. In a live work list this was 32 of 40 slots, every
# one reviewed the same day, and it pushed new mail off the end of the queue.
just_judged = {"threads": [{"thread_id": "old", "account": "work",
                            "watermark": "2026-08-01 09:00",
                            "reviewed": datetime.now().strftime("%Y-%m-%d %H:%M"),
                            "conclusion": {"open": True, "what": "send the dates"}}]}
out = ed.diff(extract, just_judged, people)
check("an aged-out obligation judged today is not re-queued",
      out["counts"]["aged_out_still_open"] == 0, out["counts"])
check("  ...but is counted as resting, so it is not silently dropped",
      out["counts"]["aged_out_resting"] == 1, out["counts"])
check("  ...and is nowhere in the work list",
      not any(e["thread_id"] == "old" for e in out["needs_judgement"]))

long_quiet = {"threads": [{"thread_id": "old", "account": "work",
                           "watermark": "2026-08-01 09:00",
                           "reviewed": (datetime.now() - timedelta(days=ed.STALE_DAYS + 1))
                                       .strftime("%Y-%m-%d %H:%M"),
                           "conclusion": {"open": True, "what": "send the dates"}}]}
out = ed.diff(extract, long_quiet, people)
check("...while one nobody has looked at for a week comes back",
      out["counts"]["aged_out_still_open"] == 1, out["counts"])

print("\nA held account is out of the work list, not out of the counts")
# Alex put work on hold on 2026-09-02 to clear six months of newsletters by
# hand. A hold that quietly shrank the backlog numbers would be the same failure
# as a silently truncated extract: the list looks done because the mail stopped
# being mentioned.
two = {"threads": [thread(thread_id="a", account="work"),
                   thread(thread_id="b", account="personal")]}
out = ed.diff(two, {}, people, hold={"work"})
accounts = {e["account"] for e in out["needs_judgement"]}
check("a held account is not offered for judgement", accounts == {"personal"}, accounts)
check("  ...but is still counted as new", out["counts"]["new"] == 2, out["counts"])
check("  ...and the hold is named", out["counts"]["held"] == 1
      and out["counts"]["held_accounts"] == ["work"], out["counts"])

out = ed.diff(two, {}, people, hold=set())
check("removing the hold resumes it immediately",
      {e["account"] for e in out["needs_judgement"]} == {"personal", "work"})

print("\nA closed conclusion stays closed in the differ, whoever closed it")
stale_day = (datetime.now() - timedelta(days=ed.STALE_DAYS + 1)).strftime("%Y-%m-%d %H:%M")
def closed_state(by, closed_at=None):
    c = {"open": False, "closed_by": by, "tier": "action", "what": "done"}
    if closed_at: c["closed_at"] = closed_at
    return {"threads": [{"thread_id": "t1", "account": "gmail",
                         "watermark": "2026-09-01 09:00", "reviewed": stale_day,
                         "conclusion": c}]}
one = {"threads": [thread(thread_id="t1", watermark="2026-09-01 09:00")]}
for who in ("agent:mail-triage", None, "alex"):
    out = ed.diff(one, closed_state(who, stale_day), people)
    check(f"a stale close by {who or 'the triage itself'} is not offered again",
          not out["needs_judgement"] and out["counts"]["stale"] == 0, out["counts"])
    out = ed.diff({"threads": []}, closed_state(who, stale_day), people)
    check(f"  ...nor once its thread has left the extract", not out["needs_judgement"] and out["counts"]["aged_out_still_open"] == 0, out["counts"])
check("new mail on a closed thread still reopens the question",
      ed.diff({"threads": [thread(thread_id="t1", watermark="2026-09-02 09:00")]}, closed_state("agent:mail-triage", stale_day), people)["counts"]["updated"] == 1)

print("\nA held mailbox is not tripwired")
# Alex archived 846 work threads by hand within twenty minutes of putting that
# account on hold, and every one was recorded as a thread that vanished
# unjudged. The morning brief would have reported them, every day, forever.
# Holding an account means he is clearing it himself; threads leaving it is the
# expected outcome, not an anomaly.
_saved_ids = ed.LAST_IDS.read_text() if ed.LAST_IDS.exists() else None
_saved_esc = ed.ESCAPED.read_text() if ed.ESCAPED.exists() else None
try:
    ed.LAST_IDS.parent.mkdir(parents=True, exist_ok=True)
    ed.LAST_IDS.write_text(_json.dumps({
        "gone_held": {"account": "work", "subject": "newsletter"},
        "gone_live": {"account": "personal", "subject": "a real thread"},
    }))
    ed.ESCAPED.write_text(_json.dumps({
        "old_held": {"thread_id": "old_held", "account": "work", "subject": "older newsletter"},
    }))
    empty = {"threads": []}
    out = ed.note_escapes(empty, {}, hold={"work"})
    ids = {e["thread_id"] for e in out}
    check("a thread leaving a held mailbox is not an escape", "gone_held" not in ids, ids)
    check("  ...while one leaving a live mailbox still is", "gone_live" in ids, ids)
    check("  ...and existing records for a held account are dropped",
          "old_held" not in ids, ids)
finally:
    if _saved_ids is not None: ed.LAST_IDS.write_text(_saved_ids)
    if _saved_esc is not None: ed.ESCAPED.write_text(_saved_esc)

print("\nOut of the inbox splits three ways, and only one is work")
# The extract reaches past the inbox now, so "never judged" is ambiguous until
# you ask WHO archived it. His own filter, the assistant, or his own hand.
three = {"threads": [
    thread(thread_id="f1", in_inbox=False, filtered=True),          # his filter
    thread(thread_id="h1", in_inbox=False, filtered=False),         # his hand
    thread(thread_id="i1", in_inbox=True, filtered=False),          # ordinary new mail
]}
out = ed.diff(three, {}, people)
reasons = {e["thread_id"]: e["reason"] for e in out["needs_judgement"]}
check("a thread his own filter archived is never queued",
      "f1" not in reasons, reasons)
check("  ...but it is counted, not dropped",
      out["counts"]["filter_archived"] == 1, out["counts"])
check("one he archived by hand IS queued, and says so",
      reasons.get("h1") == "archived by hand, never judged", reasons)
# A signal, not a rule: it joins the other reasons the agent is told about and
# constrains nothing. Alex: "it could be taken into consideration."
_h = next(e for e in out["needs_judgement"] if e["thread_id"] == "h1")
check("  ...and carries it as a signal, not a constraint",
      "he archived this himself" in _h["signals"], _h["signals"])
_i = next(e for e in out["needs_judgement"] if e["thread_id"] == "i1")
check("  ...which ordinary inbox mail does not carry",
      "he archived this himself" not in _i["signals"], _i["signals"])
check("  ...and counted separately",
      out["counts"]["hand_archived"] == 1, out["counts"])
check("ordinary new inbox mail is unchanged",
      reasons.get("i1") == "not seen before", reasons)

print("\nA watermark is compared as an instant, not as text")
# `watermark` is local wall-clock text with no offset. One extract run in a
# container without TZ made every thread read four hours newer than its stored
# watermark -- 389 queued as "new messages" when nothing had moved.
same = 1788400000000
tz_shifted = {"threads": [dict(thread(thread_id="t1"),
                               watermark="2026-09-01 14:00", watermark_at=same)]}
state_utc = {"threads": [{"thread_id": "t1", "account": "gmail",
                          "watermark": "2026-09-01 10:00", "watermark_at": same,
                          "reviewed": datetime.now().strftime("%Y-%m-%d %H:%M"),
                          "conclusion": {"open": True, "tier": "action", "what": "x"}}]}
out = ed.diff(tz_shifted, state_utc, people)
check("a four-hour timezone shift is not 'new messages'",
      out["counts"]["updated"] == 0, out["counts"])
moved = {"threads": [dict(thread(thread_id="t1"),
                          watermark="2026-09-01 10:00", watermark_at=same + 60000)]}
out = ed.diff(moved, state_utc, people)
check("  ...while a real new message still is",
      out["counts"]["updated"] == 1, out["counts"])

print("\nAn ignored sender is never judged, and never lost")
# Alex's Ignore Sender button. Every level honours it: the differ never offers
# the thread, queues it for archive if it is still in an inbox, counts it so the
# silence is a number, and the escape tripwire does not fire when the archive
# then takes it out of the extract.
ign = {"threads": [
    thread(thread_id="i1", account="gmail", in_inbox=True,
           messages=[{"from": "news@spam.example", "from_me": False}]),
    thread(thread_id="i2", account="gmail", in_inbox=False,
           messages=[{"from": "news@spam.example", "from_me": False}]),
    thread(thread_id="d1", account="gmail", in_inbox=True,
           messages=[{"from": "x@platform.example", "from_me": False}]),
    thread(thread_id="ok", account="gmail", in_inbox=True,
           messages=[{"from": "friend@example.com", "from_me": False}]),
]}
out = ed.diff(ign, {}, people, ignore={"news@spam.example", "@platform.example"})
queued = {e["thread_id"] for e in out["needs_judgement"]}
check("ignored senders are not offered for judgement",
      queued == {"ok"}, queued)
check("  ...whether ignored by address or by @domain",
      "i1" not in queued and "d1" not in queued)
check("  ...and are counted", out["counts"]["ignored"] == 3, out["counts"])
arch = {e["thread_id"] for e in out["needs_archive"]}
check("the ones still in an inbox go to the archive sweep as silent",
      arch == {"i1", "d1"} and all(e["tier"] == "silent" for e in out["needs_archive"]), arch)
check("  ...and one already archived is left alone", "i2" not in arch)

print("\nKeep in Inbox — a kept thread is never swept (2026-10-09)")
# Alex: "moves the message back to Inbox, and keeps it there until I manually
# archive OR we determine that the task is closed."
kept_x = {"threads": [
    thread(thread_id="k1", account="gmail", in_inbox=True, messages=[{"from": "a@b.example", "from_me": False}]),
    thread(thread_id="j1", account="gmail", in_inbox=True, messages=[{"from": "a@b.example", "from_me": False}]),
    thread(thread_id="k2", account="gmail", in_inbox=True, messages=[{"from": "c@d.example", "from_me": False}]),
]}
kept_state = {"threads": [
    {"thread_id": "k1", "account": "gmail", "conclusion": {"tier": "action", "open": True}},
    {"thread_id": "j1", "account": "gmail", "conclusion": {"tier": "digest"}},
]}
out = ed.diff(kept_x, kept_state, people, kept={"gmail:k1", "gmail:k2"})
arch = {e["thread_id"] for e in out["needs_archive"]}
check("a kept thread that is judged and in the inbox is not swept", "k1" not in arch, arch)
check("  ...while a judged one he did not keep still is", "j1" in arch, arch)
flag = {e["thread_id"]: e.get("keep_in_inbox") for e in out["needs_judgement"]}
check("a kept thread offered for judgement says so, so the job leaves it in the inbox",
      flag.get("k2") is True, flag)

# note_escapes: the archive taking an ignored thread out of the extract is the
# button working, not a thread vanishing unjudged.
_saved_ids = ed.LAST_IDS.read_text() if ed.LAST_IDS.exists() else None
_saved_esc = ed.ESCAPED.read_text() if ed.ESCAPED.exists() else None
try:
    ed.LAST_IDS.parent.mkdir(parents=True, exist_ok=True)
    ed.LAST_IDS.write_text(_json.dumps({
        "gone_ign": {"account": "gmail", "subject": "n", "sender": "news@spam.example"},
        "gone_real": {"account": "gmail", "subject": "r", "sender": "friend@example.com"},
    }))
    ed.ESCAPED.write_text(_json.dumps({}))
    esc = ed.note_escapes({"threads": []}, {}, hold=set(), ignore={"news@spam.example"})
    ids = {e["thread_id"] for e in esc}
    check("an ignored sender leaving the extract is not an escape", "gone_ign" not in ids, ids)
    check("  ...while a real one still is", "gone_real" in ids, ids)
finally:
    if _saved_ids is not None: ed.LAST_IDS.write_text(_saved_ids)
    if _saved_esc is not None: ed.ESCAPED.write_text(_saved_esc)

print("\nA partial extract is not evidence that anything disappeared")
# The day the inbox window came off, rate limiting silently dropped 1,333 of
# work's 1,523 threads and the extract reported no problems. Absence is the only
# signal escapes and aged-out have, so on a partial extract both must go quiet:
# otherwise one bad fetch files a false escape for most of a mailbox.
partial_extract = {**extract, "partial": [{"account": "work", "error": "429 rate limit"}]}
aged_state = {"threads": [{"thread_id": "old", "account": "work",
                           "watermark": "2026-08-01 09:00",
                           "conclusion": {"open": True, "what": "send the dates"}}]}
out = ed.diff(partial_extract, aged_state, people)
check("a partial extract reports nothing as aged out",
      out["counts"]["aged_out_still_open"] == 0, out["counts"])
out_whole = ed.diff(extract, aged_state, people)
check("  ...while the same state on a whole extract does",
      out_whole["counts"]["aged_out_still_open"] == 1, out_whole["counts"])

print("\nThe work list is bounded, and says so")
# Sized FROM the cap, not to a literal. This was 100 threads against a cap of
# 40; raising the cap to 160 left the fixture smaller than the limit it was
# meant to prove, so three tests failed for having nothing to truncate rather
# than for anything being wrong.
OVERFLOW = 40
total = ed.MAX_JUDGEMENT + OVERFLOW
many = {"threads": [thread(thread_id=f"t{i}", watermark=f"2026-09-01 {i % 24:02d}:00")
                    for i in range(total)]}
out = ed.diff(many, {}, people)
check(f"at most {ed.MAX_JUDGEMENT} threads are handed over",
      len(out["needs_judgement"]) == ed.MAX_JUDGEMENT, len(out["needs_judgement"]))
check("the rest are counted, never silently dropped",
      out["counts"]["not_shown"] == OVERFLOW, out["counts"]["not_shown"])
check("newest first — a thread that moved an hour ago beats one from the 20th",
      out["needs_judgement"][0]["watermark"] >= out["needs_judgement"][-1]["watermark"])
check("and it says how to drain the backlog rather than leaving it to be guessed",
      f"--max {total}" in out.get("drain_with", ""), out.get("drain_with"))

# The cap protects the unattended path; a deliberate catch-up is a different
# situation and must be able to take the lot.
out = ed.diff(many, {}, people, limit=10**6)
check("a raised limit hands over everything", len(out["needs_judgement"]) == total,
      len(out["needs_judgement"]))
check("  ...and then has nothing left to report as hidden",
      out["counts"]["not_shown"] == 0 and "drain_with" not in out)

# "We never want emails invisible to the assistant" — Alex, 2026-09-02. The
# extract is not a complete mirror, and aged_out_still_open cannot catch a thread that
# was never judged, because such a thread has no state entry for it to be built
# from. These are the tests for the tripwire that does catch them.
print("\nNothing leaves the window unnoticed")
import tempfile as _tf, shutil as _sh, json as _j

def escapes(previous, current, state=None):
    """Run note_escapes over a synthetic pair of runs."""
    t = Path(_tf.mkdtemp())
    (t / "integrations").mkdir(); (t / ".log").mkdir()
    old = (ed.LAST_IDS, ed.ESCAPED)
    ed.LAST_IDS, ed.ESCAPED = t / ".log/gmail-last-ids.json", t / "integrations/gmail-escaped.json"
    try:
        ed.LAST_IDS.write_text(_j.dumps(previous))
        got = ed.note_escapes({"threads": current}, state or {})
        recorded = _j.loads(ed.ESCAPED.read_text()) if ed.ESCAPED.exists() else {}
        return got, recorded, t
    finally:
        ed.LAST_IDS, ed.ESCAPED = old

prev = {"a": {"account": "gmail", "subject": "Invoice", "watermark": "2026-08-19 10:00"}}
got, rec, t = escapes(prev, [])
check("a thread that vanished unjudged is recorded", len(rec) == 1 and "a" in rec, rec)
check("  ...and comes back on the work list", len(got) == 1 and got[0]["thread_id"] == "a")
check("  ...saying why", "never judged" in got[0]["reason"] or "before it was ever judged" in got[0]["reason"],
      got[0]["reason"])
_sh.rmtree(t)

# The whole point of the state check: a thread with a conclusion has been dealt
# with, and re-surfacing it every run would make the tripwire noise.
got, rec, t = escapes(prev, [], state={"threads": [{"thread_id": "a", "conclusion": {"open": False}}]})
check("a thread that was JUDGED before ageing out is not an escape", rec == {} and got == [], rec)
_sh.rmtree(t)

got, rec, t = escapes(prev, [{"thread_id": "a", "account": "gmail", "watermark": "2026-08-19 10:00"}])
check("a thread still in the window is not an escape", rec == {} and got == [])
_sh.rmtree(t)

# An escape stays on the list until something is done about it — one run's
# notice is exactly how a thing gets lost twice.
got, rec, t = escapes(prev, [])
check("escapes persist across runs until judged", len(got) == 1)
_sh.rmtree(t)

# Alex, 2026-10-20: why did the brief lead with two threads that 404 on
# every run? Gmail no longer had them, so no conclusion could ever be written
# and they stayed first in the queue forever. A 404 from the extractor ends it.
def escapes_gone(previous, extract, state=None):
    t = Path(_tf.mkdtemp())
    (t / "integrations").mkdir(); (t / ".log").mkdir()
    old = (ed.LAST_IDS, ed.ESCAPED)
    ed.LAST_IDS, ed.ESCAPED = t / ".log/gmail-last-ids.json", t / "integrations/gmail-escaped.json"
    try:
        ed.LAST_IDS.write_text(_j.dumps(previous))
        ed.note_escapes({"threads": []}, state or {}, hold=set(), ignore=set())
        ed.LAST_IDS.write_text(_j.dumps({}))
        got = ed.note_escapes(extract, state or {}, hold=set(), ignore=set())
        return got, _j.loads(ed.ESCAPED.read_text())
    finally:
        ed.LAST_IDS, ed.ESCAPED = old
        _sh.rmtree(t)

got, rec = escapes_gone(prev, {"threads": [], "gone": [{"account": "gmail", "thread_id": "a"}]})
check("an escape Gmail says is gone leaves the work list", got == [], got)
check("  ...but its record is kept, stamped", "a" in rec and rec["a"].get("gone"), rec)
got, rec = escapes_gone(prev, {"threads": [], "partial": [{"account": "x", "error": "y"}],
                               "gone": [{"account": "gmail", "thread_id": "a"}]})
check("  ...even on a partial extract, a 404 being direct evidence", got == [] and rec["a"].get("gone"), rec)
got, rec = escapes_gone(prev, {"threads": [], "gone": [{"account": "gmail", "thread_id": "zz"}]})
check("a 404 for some other id leaves a real escape on the list",
      len(got) == 1 and not rec["a"].get("gone"), rec)

print("\nThe window edge outranks freshness")
edge = {"updated": "x", "threads": [
    thread(thread_id="fresh", watermark=datetime.now().strftime("%Y-%m-%d %H:%M"),
           has_attachment=True),
    thread(thread_id="old", watermark=(datetime.now() - timedelta(days=13)).strftime("%Y-%m-%d %H:%M"),
           has_attachment=True),
]}
out = ed.diff(edge, {}, set())
check("a thread with signals near the edge sorts above a fresh one",
      out["needs_judgement"][0]["thread_id"] == "old",
      [e["thread_id"] for e in out["needs_judgement"]])

# ...but only when it is floored. An ordinary old thread is just old.
plain = {"updated": "x", "threads": [
    thread(thread_id="fresh", watermark=datetime.now().strftime("%Y-%m-%d %H:%M")),
    thread(thread_id="old", watermark=(datetime.now() - timedelta(days=13)).strftime("%Y-%m-%d %H:%M")),
]}
out = ed.diff(plain, {}, set())
check("  ...an old thread with no signals does not jump the queue",
      out["needs_judgement"][0]["thread_id"] == "fresh",
      [e["thread_id"] for e in out["needs_judgement"]])

# A rolled-back thread is offered again even after it has left the extract.
#
# Alex, 2026-09-09. rejudge is documented as "the door" for a conclusion that
# cannot correct itself, and it silently did nothing for any thread the extract
# no longer held — which, once the triage archives one, is most of them. The
# rollback landed in the state file and no run ever read it.
print("\nA rolled-back thread comes back, even when the extract has dropped it")
_o = (ed.ESCAPED, ed.LAST_IDS)
_dir = Path(_tf.mkdtemp())
ed.ESCAPED, ed.LAST_IDS = _dir / "escaped.json", _dir / "last.json"
ed.ESCAPED.write_text(_json.dumps({"t9": {"thread_id": "t9", "account": "gmail",
                                        "subject": "invoice", "watermark": "2026-08-19 11:50",
                                        "sender": "billing@example.com", "noticed": "2026-09-09 20:41",
                                        "reason": "rolled back for re-judging; no longer in the extract"}}))
ed.LAST_IDS.write_text("{}")
_concluded = {"threads": [{"thread_id": "t9", "account": "gmail",
                           "watermark": "2026-08-19 11:50", "reviewed": "2026-08-20 09:00",
                           "conclusion": {"open": True, "what": "unpaid"}}]}
out = ed.note_escapes({"threads": []}, _concluded)
check("a judged thread on the escaped list is NOT offered", not any(e["thread_id"] == "t9" for e in out), out)

_concluded["threads"][0]["conclusion"]["rejudge"] = {"at": "2026-09-09 20:41", "why": "read the PDF"}
out = ed.note_escapes({"threads": []}, _concluded)
check("...but it is once rejudge has rolled it back", any(e["thread_id"] == "t9" for e in out), out)
check("   and it carries the account, or the job cannot fetch it",
      next((e for e in out if e["thread_id"] == "t9"), {}).get("account") == "gmail")
ed.ESCAPED, ed.LAST_IDS = _o

print("\nThe other open thread with the same counterparty")
# Alex, 2026-09-17: "any idea why the Northwind reporting hours didn't
# autoclose?" It could not: he asked Northwind on 08-19 to regenerate an invoice,
# the answer came on 09-14 on a different thread from a different Northwind
# address, and nothing ever put the two in front of one reader.
hours = thread(thread_id="hours", account="gmail", subject="N200BB & N300CC",
               participants=["eecreportinghours@northwind-aero.example"],
               watermark="2026-08-19 12:48")
pay = thread(thread_id="pay", account="gmail", subject="Payment Notification",
             participants=["accounts.receivable@northwind-aero.example.br"],
             watermark="2026-09-14 18:05")
mail = thread(thread_id="other", account="gmail", subject="Unrelated",
              participants=["someone@gmail.com"], watermark="2026-09-14 09:00")
mail2 = thread(thread_id="other2", account="gmail", subject="Also unrelated",
               participants=["else@gmail.com"], watermark="2026-09-14 09:30")
conc = {
    "hours": {"thread_id": "hours", "conclusion": {"open": True, "title": "Chase Northwind on the regenerated hours invoice", "since": "2026-08-19 12:48"}},
    "pay": {"thread_id": "pay", "conclusion": {"open": True, "title": "Chase Northwind on the N200BB credit", "since": "2026-09-14 17:39"}},
    "other": {"thread_id": "other", "conclusion": {"open": True, "title": "Something else", "since": "2026-09-14 09:00"}},
    "other2": {"thread_id": "other2", "conclusion": {"open": True, "title": "Another thing", "since": "2026-09-14 09:30"}},
}
els = ed.open_elsewhere([hours, pay, mail, mail2], conc)
check("two addresses at one company are one counterparty",
      [r["ref"] for r in els.get("pay", [])] == ["mail:gmail:hours"], str(els.get("pay")))
check("   ...and it says what the other one is",
      "regenerated hours invoice" in (els.get("pay", [{}])[0].get("title") or ""))
check("   ...and which counterparty made the link", els.get("pay", [{}])[0].get("with") == "northwind-aero")
check("two strangers at gmail.com are NOT one counterparty",
      "other" not in els or not [r for r in els["other"] if r["ref"] == "mail:gmail:other2"],
      str(els.get("other")))
check("a thread is never told about itself",
      all(r["ref"] != "mail:gmail:pay" for r in els.get("pay", [])))
closed = {**conc, "hours": {"thread_id": "hours", "conclusion": {"open": False, "title": "done"}}}
check("only OPEN items are worth mentioning", "pay" not in ed.open_elsewhere([hours, pay], closed))
# His own domain is a surname, not a counterparty: dana@rivera.example and
# alex@rivera.example share one, and on the first live run this filed his
# brother's utility bill next to a K-1 chase.
mine1 = thread(thread_id="m1", participants=["dana@rivera.example"], watermark="2026-09-14 09:00")
mine2 = thread(thread_id="m2", participants=["hank@example.com", "alex@rivera.example"], watermark="2026-09-14 09:30")
mineconc = {
    "m1": {"thread_id": "m1", "conclusion": {"open": True, "title": "Utility bill", "since": "2026-09-14 09:00"}},
    "m2": {"thread_id": "m2", "conclusion": {"open": True, "title": "Something of Hank's", "since": "2026-09-14 09:30"}},
}
check("his own domain does not make two threads one piece of business",
      not ed.open_elsewhere([mine1, mine2], mineconc, {"rivera.example"}),
      str(ed.open_elsewhere([mine1, mine2], mineconc, {"rivera.example"})))
check("   ...but the same person on both still counts",
      ed.open_elsewhere([mine1, thread(thread_id="m3", participants=["dana@rivera.example"], watermark="2026-09-15 09:00")],
                        {**mineconc, "m3": {"thread_id": "m3", "conclusion": {"open": True, "title": "Elmwood leak", "since": "2026-09-15 09:00"}}},
                        {"rivera.example"}).get("m1", [{}])[0].get("ref") == "mail:gmail:m3")
# Alex, 2026-10-20: "Todo NKRS should auto close based on the COI I
# forwarded." The open COI ask was older than the extract, so it was never
# indexed and the thread that carried the COI was judged blind.
coi = thread(thread_id="coi", account="personal", subject="Unit 2201",
             participants=["khoff@co024c.example", "onereceiving@harborview-condo.example"],
             watermark="2026-10-19 14:59")
aged = {"coi": {"thread_id": "coi", "conclusion": {"open": False, "title": "COI on file"}},
        "ask": {"thread_id": "ask", "account": "personal", "watermark": "2026-09-03 08:49",
                "conclusion": {"open": True, "title": "Get ONE a COI for Bayside Plumbing",
                               "who": "onereceiving@harborview-condo.example", "since": "2026-09-02 17:08"}}}
aels = ed.open_elsewhere([coi], aged)
check("an open item older than the extract is still offered",
      [r["ref"] for r in aels.get("coi", [])] == ["mail:personal:ask"], str(aels))
check("   ...but not once it is closed",
      not ed.open_elsewhere([coi], {**aged, "ask": {**aged["ask"], "conclusion": {**aged["ask"]["conclusion"], "open": False}}}))
check("   ...and never when the state has no address to match on",
      not ed.open_elsewhere([coi], {**aged, "ask": {**aged["ask"], "conclusion": {**aged["ask"]["conclusion"], "who": "Jake"}}}))
out2 = ed.diff({"updated": "2026-09-14 19:00", "threads": [hours, pay]},
               {"threads": list(conc.values())}, set())["needs_judgement"]
rows = [e for e in out2 if e.get("open_elsewhere")]
check("it rides on the work list, where the agent will see it before judging",
      any(r["thread_id"] in ("hours", "pay") for r in rows) or not out2, str(rows)[:200])

print("\nAn aged-out debt is asked about on a cadence, not every run")
def day(n):
    return (datetime.now() - timedelta(days=n)).strftime("%Y-%m-%d %H:%M")
# Alex, 2026-09-18: "why is that old email sitting in waiting to be digest?"
# The Luxury Brand pickup was on every work list for a week. The job did the
# right thing each time — read the conclusion, found nothing new, carried it
# forward — but carrying forward does not rewrite `reviewed`, so the next run
# met a thread "not revisited in 7+ days" and asked again.
aged = {"threads": [{"chat_id": None, "thread_id": "lv", "account": "gmail",
                     "watermark": day(20), "reviewed": day(20),
                     "conclusion": {"open": True, "tier": "action", "title": "Pick up the order"}}]}
empty_extract = {"updated": day(0), "threads": []}
asked = {}
first = ed.diff(empty_extract, aged, set(), asked_before={}, asked_out=asked)
check("an aged-out open debt is put on the work list",
      any(e["thread_id"] == "lv" for e in first["needs_judgement"]),
      str([e["thread_id"] for e in first["needs_judgement"]]))
check("   and the ask is written down", "lv" in asked, str(asked))

again = {}
second = ed.diff(empty_extract, aged, set(), asked_before=asked, asked_out=again)
check("the next run does NOT ask again — that was the loop",
      not any(e["thread_id"] == "lv" for e in second["needs_judgement"]),
      str([e["thread_id"] for e in second["needs_judgement"]]))
check("   and it is still counted as resting, not forgotten",
      second["counts"]["aged_out_resting"] >= 1, str(second["counts"]))

stale_ask = {"lv": {"at": day(9)}}
later = ed.diff(empty_extract, aged, set(), asked_before=stale_ask, asked_out={})
check("once the window passes it is asked about again",
      any(e["thread_id"] == "lv" for e in later["needs_judgement"]),
      "a debt nobody has looked at for weeks still deserves a second look")

# A conclusion the job DID revisit recently is quiet whatever the ledger says.
fresh = {"threads": [{**aged["threads"][0], "reviewed": day(1)}]}
quiet = ed.diff(empty_extract, fresh, set(), asked_before={}, asked_out={})
check("a recently revisited one is quiet on its own",
      not any(e["thread_id"] == "lv" for e in quiet["needs_judgement"]))


# OPEN ELSEWHERE SEES TEXTS. Review 2026-09-20, the remaining item: a mail
# thread's open_elsewhere could see other mail and nothing else. Joined on the
# person from Contacts — the only thing an address and a phone number share.
print("\nopen elsewhere sees the text thread too")
xcontacts = {"dana@x.com": "Dana Rivera", "5552000002": "Dana Rivera", "nobody@y.com": "Somebody Else"}
xthread = thread(thread_id="tm1", watermark="2026-09-18 10:00")
xthread["participants"] = ["dana@x.com"]
xstate = {"threads": []}
xmsgs = {"threads": [
    {"chat_id": "any;-;+15552000002", "participants": ["+15552000002"], "watermark": "2026-09-10 10:00",
     "conclusion": {"open": True, "who": "+15552000002", "since": "2026-09-10 10:00", "title": "Chase Dana on the Elmwood leak"}},
    {"chat_id": "any;-;+15552000002-old", "participants": ["+15552000002"], "watermark": "2026-09-01 10:00",
     "conclusion": {"open": False, "who": "+15552000002", "since": "2026-09-01 10:00", "title": "closed, must not appear"}},
    {"chat_id": "any;-;+15559990000", "participants": ["+15559990000"], "watermark": "2026-09-10 10:00",
     "conclusion": {"open": True, "who": "+15559990000", "since": "2026-09-10 10:00", "title": "someone else"}},
]}
xout = ed.diff({"threads": [xthread]}, xstate, people, msg_state=xmsgs, contacts=xcontacts)
xe = xout["needs_judgement"][0]
xrefs = {r["ref"]: r for r in xe.get("open_elsewhere", [])}
check("Dana's open text thread rides on her mail thread", "im:any;-;+15552000002" in xrefs, str(list(xrefs)))
check("  ...marked as a text, joined on her name", xrefs.get("im:any;-;+15552000002", {}).get("channel") == "text"
      and xrefs.get("im:any;-;+15552000002", {}).get("with") == "dana rivera", str(xrefs))
check("  ...a closed text thread does not", "im:any;-;+15552000002-old" not in xrefs)
check("  ...and somebody else's does not", "im:any;-;+15559990000" not in xrefs)
xno = ed.diff({"threads": [xthread]}, xstate, people, msg_state=xmsgs, contacts={})
check("with no address book, nothing is guessed", "open_elsewhere" not in xno["needs_judgement"][0])


# IN-WINDOW STALE IS TIMED FROM WHEN WE LAST ASKED, TOO. The last branch keyed
# on `reviewed` alone — the field the model has to remember to write.
print("\nin-window stale asks once per cadence")
stale_open = {"threads": [{"thread_id": "so", "account": "gmail", "watermark": "2026-09-01 09:00", "reviewed": "2020-01-01 00:00",
                           "conclusion": {"open": True, "tier": "action", "what": "still owed"}}]}
so_thread = {"threads": [thread(thread_id="so", watermark="2026-09-01 09:00")]}
asked = {}
out = ed.diff(so_thread, stale_open, people, asked_out=asked)
check("a stale open thread is offered and the ask is recorded", out["counts"]["stale"] == 1 and "so" in asked, out["counts"])
out = ed.diff(so_thread, stale_open, people, asked_before=asked, asked_out={})
check("  ...and not again inside the cadence, even with `reviewed` untouched", out["counts"]["stale"] == 0 and out["counts"]["unchanged"] == 1, out["counts"])

# THE MAIL→TEXT JOIN ON A BARE NAME. Message conclusions carry `who` as free
# text and no participants; the first cut resolved only an address or ten
# digits and so matched zero text threads on the live data.
print("\nopen elsewhere joins a text by the name the triage wrote")
ncontacts = {"dana@x.com": "Dana Rivera", "5552000002": "Dana Rivera"}
nmsgs = {"threads": [{"chat_id": "any;-;+15552000002", "watermark": "2026-09-10 10:00",
                      "conclusion": {"open": True, "who": "Dana Rivera", "since": "2026-09-10 10:00", "title": "Chase Dana on the leak"}},
                     {"chat_id": "any;+;group", "watermark": "2026-09-10 10:00",
                      "conclusion": {"open": True, "who": "Cody Hurst, Dana Rivera", "since": "2026-09-10 10:00", "title": "the group plan"}}]}
nout = ed.diff({"threads": [xthread]}, {"threads": []}, people, msg_state=nmsgs, contacts=ncontacts)
nrefs = {r["ref"] for r in nout["needs_judgement"][0].get("open_elsewhere", [])}
check("a `who` that is her name, no participants, still joins", "im:any;-;+15552000002" in nrefs, str(nrefs))
check("  ...and so does a `who` naming several people", "im:any;+;group" in nrefs, str(nrefs))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
