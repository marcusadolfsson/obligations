#!/usr/bin/env python3
"""Tests for the message diff — the thing that decides what the agent re-reads.

Getting this wrong is expensive in both directions. Too eager and every run
re-judges everything, which is what the cache exists to stop. Too lazy and a
thread with a new message never gets looked at again, so an obligation arrives
and is silently never surfaced. Both failures are quiet, which is why they are
tests.

Run:  python3 deploy/integrations/imessage-diff.test.py
"""
import importlib.util
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("dif", HERE / "imessage-diff.py")
dif = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dif)

now = datetime.now()
def at(h): return (now - timedelta(hours=h)).strftime("%Y-%m-%d %H:%M")
def day(d): return (now - timedelta(days=d)).strftime("%Y-%m-%d %H:%M")

passed = failed = 0
def check(label, cond, detail=""):
    global passed, failed
    if cond:
        print(f"  ok   {label}"); passed += 1
    else:
        print(f"  FAIL {label}{(' -> ' + detail) if detail else ''}"); failed += 1

def thread(cid, *stamps):
    return {"chat_id": cid, "messages": [{"at": s, "text": "x"} for s in stamps]}

extract = {"generated_at": at(0), "threads": [
    thread("brand-new", at(1)),
    thread("has-new-message", at(30), at(2)),
    thread("quiet-and-fresh", at(50)),
    thread("quiet-and-stale-open", at(400)),
    thread("quiet-and-stale-closed", at(400)),
    thread("closed-then-spoke-again", at(400), at(3)),
    thread("agent-closed-stale", at(400)),
    thread("spoke-by-phone", at(400)),
    thread("spoke-and-seen", at(400)),
    thread("rang-out", at(400)),
]}

state = {"threads": [
    {"chat_id": "has-new-message", "watermark": at(30), "reviewed": day(1),
     "conclusion": {"open": True, "what": "owes a reply"}},
    {"chat_id": "quiet-and-fresh", "watermark": at(50), "reviewed": day(1),
     "conclusion": {"open": False}},
    {"chat_id": "quiet-and-stale-open", "watermark": at(400), "reviewed": day(30),
     "conclusion": {"open": True, "what": "still owes the quote"}},
    {"chat_id": "quiet-and-stale-closed", "watermark": at(400), "reviewed": day(30),
     "conclusion": {"open": False, "closed_at": day(20), "closed_by": "alex"}},
    {"chat_id": "closed-then-spoke-again", "watermark": at(400), "reviewed": day(30),
     "conclusion": {"open": False, "closed_at": day(20), "closed_by": "alex"}},
    # closed by the triage, with nobody's name on it
    {"chat_id": "agent-closed-stale", "watermark": at(400), "reviewed": day(30),
     "conclusion": {"open": False}},
    {"chat_id": "spoke-by-phone", "watermark": at(400), "reviewed": day(1),
     "conclusion": {"open": True, "what": "asked him to call back",
                    "who": "+15551110000", "since": at(300)}},
    # Same call, but the triage has already looked since it happened. Alex,
    # 2026-09-16, reading a 01:23 note that said nothing: six threads were being
    # re-flagged on every run because the call was only ever compared with the
    # obligation's start, so a job fired all night and concluded nothing.
    {"chat_id": "spoke-and-seen", "watermark": at(400), "reviewed": at(0),
     "conclusion": {"open": True, "what": "asked him to call back",
                    "who": "+15551110000", "since": at(300)}},
    {"chat_id": "rang-out", "watermark": at(400), "reviewed": day(1),
     "conclusion": {"open": True, "what": "still waiting",
                    "who": "+15552220000", "since": at(300)}},
    # in state, absent from the extract, still open, and not looked at in a week
    {"chat_id": "aged-out-open", "watermark": day(20), "reviewed": day(9),
     "conclusion": {"open": True, "what": "never answered about the invoice"}},
    # SAME, BUT JUDGED THIS MORNING. The thread can never come back into the
    # window, so with no `reviewed` guard this was offered on every run for
    # ever: Troy Shaw's and Pete Rourke's conclusions each took ten entries in
    # a day saying "re-checked, still outside the extract window. Unchanged."
    # Alex, 2026-09-20: "Maybe it should have some follow up but not that
    # frequently." It gets the stale cadence, like every other quiet thread.
    {"chat_id": "aged-out-fresh", "watermark": day(20), "reviewed": day(1),
     "conclusion": {"open": True, "what": "aged out, but judged this morning"}},
    # same, but closed BY ALEX — must NOT be resurrected
    {"chat_id": "aged-out-closed", "watermark": day(20), "reviewed": day(2),
     "conclusion": {"open": False, "closed_at": day(10), "closed_by": "alex"}},
    # and closed by the AGENT, thread gone from the window: one look, from here
    {"chat_id": "aged-out-agent-closed", "watermark": day(20), "reviewed": day(12),
     "conclusion": {"open": False, "closed_at": day(10), "closed_by": "agent:messages"}},
]}

CALLS = {"by_handle": {
    # He rang this one back after the obligation started.
    "5551110000": {"last_connected_at": at(1), "attempts": 1, "connected": 1,
                   "missed_incoming": 0, "last_at": at(1)},
    # Tried and missed: not a conversation, and must not close anything.
    "5552220000": {"last_connected_at": None, "attempts": 2, "connected": 0,
                   "missed_incoming": 0, "last_at": at(1)},
}}

out = dif.diff(extract, state, CALLS)
by_id = {j["chat_id"]: j for j in out["needs_judgement"]}

check("a thread never seen before needs judging", "brand-new" in by_id)
check("a thread with a new message needs judging", "has-new-message" in by_id)
check("  ...and carries its previous conclusion forward for context",
      by_id.get("has-new-message", {}).get("previous_conclusion", {}).get("what") == "owes a reply",
      str(by_id.get("has-new-message")))
check("  ...and says what it is comparing against",
      by_id.get("has-new-message", {}).get("since") == at(30))

check("a quiet, recently-reviewed thread is NOT re-judged",
      "quiet-and-fresh" not in by_id and "quiet-and-fresh" in out["unchanged"])
# A call leaves no trace in a message thread, so watermarks never move for it.
# Without this, "call me back" stayed open forever even though he rang a minute
# later — which is exactly what happened when the call log first landed.
check("an open obligation is re-judged after a real conversation",
      "spoke-by-phone" in by_id
      and by_id["spoke-by-phone"]["reason"].startswith("spoke by phone"),
      str(by_id.get("spoke-by-phone")))
check("  ...and says when they spoke",
      by_id.get("spoke-by-phone", {}).get("spoke_at") == at(1))
check("a call the triage has already looked at is not flagged again",
      "spoke-and-seen" not in by_id,
      "re-flagging it every run is what made a job fire all night and conclude nothing")
check("attempts that never connected do NOT re-open anything",
      "rang-out" not in by_id,
      "trying twice and missing is not a conversation")

check("a quiet open conclusion nobody has revisited in a week IS re-judged",
      "quiet-and-stale-open" in by_id,
      "a wrong call must not become permanent just because the thread went quiet")

# Alex marking something done is a decision. A decision that expires after a
# week is not a decision — he would close the same item every Monday.
check("a conclusion ALEX closed is never re-judged on age alone",
      "quiet-and-stale-closed" not in by_id
      and "quiet-and-stale-closed" in out["unchanged"],
      "closing something must mean it stays closed")

# A closed conclusion is left alone, whoever closed it — the one second look an
# agent close used to get was deleted on 2026-09-20 (140 looks, none reopened
# anything); obligation-state.json and the Reopen door guard a wrong close now.
check("a conclusion the AGENT closed is not re-judged on age either",
      "agent-closed-stale" not in by_id and "agent-closed-stale" in out["unchanged"])
second = dif.diff(extract, state, CALLS)
second_ids = {e["chat_id"] for e in second["needs_judgement"]}
check("  ...while the genuinely stale OPEN thread still is",
      "quiet-and-stale-open" in second_ids)
check("an agent-closed chat that aged out of the window is not resurrected either",
      "aged-out-agent-closed" not in by_id if "aged-out-agent-closed" in {t["chat_id"] for t in state["threads"]} else True)

check("a closed thread with a NEW message does come back",
      "closed-then-spoke-again" in by_id,
      "new information is the one thing that reopens a closed item")
check("  ...labelled as a reopen, not as ordinary new mail",
      "closed" in by_id.get("closed-then-spoke-again", {}).get("reason", "")
      and by_id.get("closed-then-spoke-again", {}).get("closed_at") is not None,
      str(by_id.get("closed-then-spoke-again")))
_noted = {t["chat_id"]: t for t in dif.diff(extract, state, CALLS,
          close_notes={"im:closed-then-spoke-again": "Told her no — not doing the listing"})["needs_judgement"]}
check("  ...carrying his own note on the close (2026-09-30)",
      _noted.get("closed-then-spoke-again", {}).get("closed_note") == "Told her no — not doing the listing",
      str(_noted.get("closed-then-spoke-again")))

check("an open obligation that aged out of the window is still surfaced",
      "aged-out-open" in by_id,
      "silently forgetting it is the failure the cache exists to avoid")
check("a closed thread that aged out is NOT resurrected",
      "aged-out-closed" not in by_id)
check("an aged-out thread judged this morning is left alone until it goes stale",
      "aged-out-fresh" not in by_id,
      "it cannot come back into the window, so with no guard this fires on every run for ever")

check("counts add up",
      out["counts"]["new"] == 1 and out["counts"]["updated"] == 2
      and out["counts"]["stale"] == 1 and out["counts"]["unchanged"] == 6
      and out["counts"]["settled"] == 1
      and out["counts"]["aged_out_still_open"] == 1,
      str(out["counts"]))

# The whole point: a second run with nothing new must ask for nothing.
state2 = {"threads": [
    {"chat_id": t["chat_id"], "watermark": dif.newest(t),
     "reviewed": now.strftime("%Y-%m-%d %H:%M"), "conclusion": {"open": False}}
    for t in extract["threads"]
]}
out2 = dif.diff(extract, state2)
check("an unchanged second run judges nothing",
      out2["counts"]["new"] == 0 and out2["counts"]["updated"] == 0
      and out2["counts"]["stale"] == 0 and len(out2["needs_judgement"]) == 0,
      str(out2["counts"]))

# A thread missing chat_id must not crash or silently become "new" every run.
out3 = dif.diff({"threads": [{"messages": [{"at": at(1)}]}]}, {})
check("a thread with no chat_id is skipped, not counted forever",
      out3["counts"]["new"] == 0, str(out3["counts"]))

# ---- names on every judged thread ------------------------------------------
# Alex, 2026-09-05: the evening brief called his brother "the 702 number"
# while Ben sat in Contacts with a people/ file. The lookup now happens here.
import json as _json, tempfile as _tmp
_d = Path(_tmp.mkdtemp())
(_d / "people").mkdir()
(_d / "contacts.json").write_text(_json.dumps({"contacts": [
    {"name": "Ben Rivera", "handles": [{"key": "5552000019", "kind": "phone"}, {"key": "ben@example.com", "kind": "email"}]},
    {"name": "Mia", "handles": [{"raw": "(352) 555-0100", "kind": "phone"}]},
]}))
(_d / "people" / "ben-rivera.md").write_text("---\ntype: person\nname: Ben Rivera\nrelation: brother\n---\n")
(_d / "people" / "tom-rourke.md").write_text("---\ntype: person\nname: Pete Rourke\nrelation: trainer\nphone: +1 813 555 0199\n---\n")
(_d / "people" / "_template.md").write_text("---\ntype: person\nname:\n---\n")
names = dif.load_names(_d / "contacts.json", _d / "people")
check("a Contacts handle resolves by its last ten digits", names["5552000019"]["name"] == "Ben Rivera")
check("  ...and picks up relation and file from people/ by name",
      names["5552000019"]["relation"] == "brother" and names["5552000019"]["file"] == "people/ben-rivera.md")
check("an email handle resolves lowercased", dif.who("ben@Example.com", names)["name"] == "Ben Rivera")
check("a phone: line in people/ names a handle Contacts lacks", dif.who("+18135550199", names)["relation"] == "trainer")
check("a formatted contact number still keys", dif.who("+13525550100", names)["name"] == "Mia")
check("the template is not a person", not any(str(v.get("file") or "").endswith("_template.md") for v in names.values()))
ex = {"generated_at": at(0), "threads": [
    {"chat_id": "fam", "name": "The Rivera's", "participants": ["+13525550100", "+15552000019", "+19995551234"],
     "messages": [{"at": at(1), "from": "+15552000019", "text": "hi"}]}]}
out = dif.diff(ex, {}, None, names)
e = out["needs_judgement"][0]
check("every judged thread carries its participants, named", [p["name"] for p in e["participants"]] == ["Mia", "Ben Rivera", None], e["participants"])
check("  ...with one line a model can use as-is", e["who"] == "Mia, Ben Rivera (brother), +19995551234", e["who"])
check("  ...and the thread's own name", e.get("thread_name") == "The Rivera's")
check("a handle nobody can name is counted, not hidden",
      out["counts"]["unresolved_handles"] == 1 and out["unresolved_handles"] == ["+19995551234"], out["counts"])
check("no names at all still runs, everything unresolved", dif.diff(ex, {}, None, None)["counts"]["unresolved_handles"] == 3)


# OPEN ELSEWHERE, ACROSS THE CHANNELS. Review item 6, 2026-09-20. email-diff
# has had this since 09-17 for the Northwind failure — an answer on a different
# thread judged on its own and becoming a second debt — but mail-only and
# keyed on the domain. A phone number has no domain, and the message differ
# had no cross-thread view at all. Keyed on the PERSON now, both channels.
print("\nopen elsewhere, across the channels")
xnames = {"5551110000": {"name": "Dana Rivera", "relation": None, "file": None},
          "dana@x.com": {"name": "Dana Rivera", "relation": None, "file": None}}
xextract = {"generated_at": at(0), "threads": [thread("chat-dana", at(10))]}
xextract["threads"][0]["participants"] = ["+15551110000"]
xstate = {"threads": [
    {"chat_id": "chat-dana", "watermark": at(300), "reviewed": day(1),
     "conclusion": {"open": True, "who": "+15551110000", "since": at(300), "title": "Chase Dana on the leak"}},
    {"chat_id": "chat-dana-group", "watermark": at(400), "reviewed": day(1),
     "conclusion": {"open": True, "who": "+15551110000", "since": at(400), "title": "Dana: the generator quote"}},
    {"chat_id": "chat-other", "watermark": at(400), "reviewed": day(1),
     "conclusion": {"open": True, "who": "+15559990000", "since": at(400), "title": "Somebody else entirely"}},
]}
xmail = {"threads": [
    {"thread_id": "m1", "account": "personal", "conclusion": {"open": True, "who": "dana@x.com", "since": at(200), "title": "Reply to Dana on the utility bill"}},
    {"thread_id": "m2", "account": "personal", "conclusion": {"open": False, "who": "dana@x.com", "since": at(200), "title": "closed, must not appear"}},
    {"thread_id": "m3", "account": "personal", "conclusion": {"open": True, "who": "nobody@y.com", "since": at(200), "title": "a stranger"}},
]}
xout = dif.diff(xextract, xstate, None, xnames, mail_state=xmail)
xentry = [e for e in xout["needs_judgement"] if e["chat_id"] == "chat-dana"][0]
xrefs = {r["ref"] for r in xentry.get("open_elsewhere", [])}
check("the same person's other text thread is offered", "im:chat-dana-group" in xrefs, str(xrefs))
check("and her mail thread, joined on the person not the address", "mail:personal:m1" in xrefs, str(xrefs))
check("the thread itself is not listed as elsewhere", "im:chat-dana" not in xrefs)
check("a closed mail conclusion is not", "mail:personal:m2" not in xrefs)
check("somebody else's debts are not", "im:chat-other" not in xrefs and "mail:personal:m3" not in xrefs)
check("each carries its channel and title", all("channel" in r and r["title"] for r in xentry["open_elsewhere"]))
xnone = dif.diff(xextract, {"threads": []}, None, xnames, mail_state={"threads": []})
check("no other debts means the key is absent, not an empty list",
      "open_elsewhere" not in xnone["needs_judgement"][0])


# A CLOSED CONCLUSION IS NEVER OFFERED, IN THE WINDOW OR OUT OF IT; and a
# partial extract offers nothing aged out at all.
print("\nclosed stays closed; a partial extract ages nothing out")
pstate = {"threads": [{"chat_id": f"p{k}", "watermark": at(400), "reviewed": day(30),
                       "conclusion": {"open": False, "closed_by": "agent:m", "closed_at": day(20 + k), "title": "t"}} for k in range(12)]}
pout = dif.diff({"generated_at": at(0), "threads": [thread("keep", at(1))]}, pstate, None, {})
check("twelve stale agent closes that left the window: none offered", not any(e["chat_id"].startswith("p") for e in pout["needs_judgement"]), str(pout["counts"]))
eout = dif.diff({"generated_at": at(0), "threads": []}, pstate, None, {})
check("an empty extract is partial: nothing aged out is offered", eout["counts"]["aged_out_still_open"] == 0 and not eout["needs_judgement"], str(eout["counts"]))
fout = dif.diff({"generated_at": at(0), "partial": True, "threads": [thread("keep", at(1))]}, pstate, None, {})
check("  ...and so is one flagged partial", not any(e["chat_id"].startswith("p") for e in fout["needs_judgement"]))

# IN-WINDOW STALE AND AGED-OUT-OPEN ASK ONCE PER CADENCE, not once per run.
print("\nthe message side asks once per cadence")
sstate = {"threads": [{"chat_id": "so", "watermark": at(400), "reviewed": day(30), "conclusion": {"open": True, "what": "owed", "since": at(400)}},
                      {"chat_id": "gone-open", "watermark": at(400), "reviewed": day(30), "conclusion": {"open": True, "what": "owed", "since": at(400)}}]}
sext = {"generated_at": at(0), "threads": [thread("so", at(400))]}
sasked = {}
sout = dif.diff(sext, sstate, None, {}, asked_out=sasked)
sids = {e["chat_id"] for e in sout["needs_judgement"]}
check("stale-open in the window and aged-out-open are both offered, and asked", sids == {"so", "gone-open"} and set(sasked) == {"so", "gone-open"}, str((sids, sorted(sasked))))
sout2 = dif.diff(sext, sstate, None, {}, asked_before=sasked, asked_out={})
check("  ...and neither again inside the cadence with `reviewed` untouched", not sout2["needs_judgement"], [e["chat_id"] for e in sout2["needs_judgement"]])

# ── Review item 4, 2026-09-20: message plumbing ──
import tempfile as _t4
print("\nwho is in an aged-out thread")
gstate = {"threads": [{"chat_id": "gone-1", "watermark": at(400), "reviewed": day(30), "participants": ["+15552000002"], "name": None,
                       "conclusion": {"open": True, "what": "owed", "since": at(400)}}]}
gnames = {"5552000002": {"name": "Dana", "relation": None, "file": None}}
gout = dif.diff({"generated_at": at(0), "threads": [thread("keep", at(1))]}, gstate, None, gnames, asked_out={})
gone_entry = next((e for e in gout["needs_judgement"] if e["chat_id"] == "gone-1"), None)
check("an aged-out thread is offered with its people, from the state record", gone_entry is not None and gone_entry["who"] == "Dana", str(gone_entry and gone_entry.get("who")))

print("\nthe escape tripwire")
_d4 = Path(_t4.mkdtemp())
lastp, escp = _d4 / "last.json", _d4 / "escaped.json"
seen = {"generated_at": at(2), "threads": [
    {"chat_id": "judged", "participants": ["+1"], "messages": [{"at": at(3), "text": "x"}]},
    {"chat_id": "vanishes", "participants": ["+15552000002"], "messages": [{"at": at(40), "text": "old"}, {"at": at(3), "text": "can you call me about the dock"}]},
    {"chat_id": "stays", "participants": ["+2"], "messages": [{"at": at(3), "text": "y"}]},
    {"chat_id": "also-stays", "participants": ["+3"], "messages": [{"at": at(3), "text": "z"}]},
]}
st4 = {"threads": [{"chat_id": "judged", "watermark": at(3), "reviewed": at(1), "conclusion": {"open": False}}]}
first = dif.note_escapes(seen, st4, lastp, escp)
check("the first complete extract records ids and escapes nothing", first == [] and lastp.exists() and not escp.exists())
later = {"generated_at": at(0), "threads": [t for t in seen["threads"] if t["chat_id"] != "vanishes" and t["chat_id"] != "judged"]}
esc = dif.note_escapes(later, st4, lastp, escp)
check("a thread that left unjudged is recorded, with its last messages", len(esc) == 1 and esc[0]["chat_id"] == "vanishes" and any("dock" in m["text"] for m in esc[0]["messages"]), str(esc))
check("  ...a judged one that left is not", not any(e["chat_id"] == "judged" for e in esc))
eout = dif.diff(later, st4, None, gnames, escaped=esc, last_ids=json.loads(lastp.read_text()) if False else None)
ent = next((e for e in eout["needs_judgement"] if e["chat_id"] == "vanishes"), None)
check("  ...and is on the work list once, named, with the messages to judge from", ent is not None and ent.get("escaped") and ent["who"] == "Dana" and ent["last_messages"], str(ent))
check("  ...counted", eout["counts"]["escaped_unjudged"] == 1)
st4b = {"threads": st4["threads"] + [{"chat_id": "vanishes", "watermark": at(3), "reviewed": at(0), "conclusion": {"open": True, "what": "call about the dock"}}]}
check("once judged it drops off the list by itself", dif.note_escapes(later, st4b, lastp, escp) == [])
partial = {"generated_at": at(0), "partial": True, "threads": [seen["threads"][2]]}
before = lastp.read_text()
dif.note_escapes(partial, st4, lastp, escp)
check("a partial extract escapes nothing and leaves the id record alone", lastp.read_text() == before)

print("\nthe cap, and the ask that does not burn")
big = {"generated_at": at(0), "threads": [thread(f"n{k}", at(1)) for k in range(45)] + [thread("s1", at(400)), thread("s2", at(400))]}
bst = {"threads": [{"chat_id": "s1", "watermark": at(400), "reviewed": day(30), "conclusion": {"open": True, "what": "o", "since": at(400)}},
                   {"chat_id": "s2", "watermark": at(400), "reviewed": day(30), "conclusion": {"open": True, "what": "o", "since": at(400)}}]}
basked = {}
bout = dif.diff(big, bst, None, {}, asked_out=basked)
check("at most MAX_JUDGEMENT are shown and the rest are a number", len(bout["needs_judgement"]) == dif.MAX_JUDGEMENT and bout["counts"]["not_shown"] == 7, str(bout["counts"]))
check("  new first: the stale pair were cut", not any(e["chat_id"] in ("s1", "s2") for e in bout["needs_judgement"]))
check("  ...and their ask did not burn", basked == {}, str(basked))
small = dif.diff(big, bst, None, {}, asked_out=basked, limit=99)
check("with room they are shown and asked", any(e["chat_id"] == "s1" for e in small["needs_judgement"]) and "s1" in basked)

print("\na complete extract that lost half its threads is partial")
ids = {f"t{k}": {} for k in range(20)}
check("half gone is partial", dif.is_partial({"threads": [thread("a", at(1))] * 6}, ids))
check("most still there is not", not dif.is_partial({"threads": [thread("a", at(1))] * 15}, ids))
check("no history: never by the heuristic", not dif.is_partial({"threads": [thread("a", at(1))]}, {}))
dout = dif.diff({"generated_at": at(0), "threads": [thread("a", at(1))] * 6}, bst, None, {}, asked_out={}, last_ids=ids)
check("  ...so nothing ages out and the count says why", dout["counts"]["aged_out_still_open"] == 0 and dout["counts"]["partial_by_drop"] is True and dout["counts"]["aged_out_skipped_partial"] == 2, str(dout["counts"]))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
