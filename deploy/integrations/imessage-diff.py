#!/usr/bin/env python3
"""Work out what actually changed since the agent last looked at the messages.

The agent re-judging all 94 threads every run is slow, expensive, and — worse —
non-deterministic: the same thread can be an obligation on Tuesday and not on
Wednesday for no reason anyone can point at. So the mechanical half is done here,
in code, and the agent judges only what is new.

Reads:
  integrations/imessage.json         the extract, pushed from the Mac
  integrations/imessage-state.json   the agent's previous conclusions

Writes:
  integrations/imessage-changed.json a work list: what needs judging, and why

Deterministic and stateless in itself — it never decides whether something is an
obligation, only whether the evidence moved. Deciding is the agent's job and
must stay that way; a script that inferred intent from message text would be
guessing, and guessing quietly.
"""
import json
import re
import os
import sys
from datetime import datetime
from pathlib import Path

# The repo this file lives in, unless OBLIGATIONS says otherwise. It used to be
# ~/obligations, true on linuxbox and wrong on the Mac mini, where the working copy
# is ~/Developer/obligations (2026-10-01) — a test run without OBLIGATIONS read the old
# path and failed. Where the script is, is where the repo is.
OBLIGATIONS = Path(os.environ.get("OBLIGATIONS") or Path(__file__).resolve().parents[2])
EXTRACT = OBLIGATIONS / "integrations" / "imessage.json"
CALLS = OBLIGATIONS / "integrations" / "calls.json"
CONTACTS = OBLIGATIONS / "integrations" / "contacts.json"
PEOPLE = OBLIGATIONS / "people"

STATE = OBLIGATIONS / "integrations" / "imessage-state.json"
# The other channel's conclusions. Read here for open_elsewhere and never
# written: the mail triage owns that file.
MAIL_STATE = OBLIGATIONS / "integrations" / "email-state.json"
CHANGED = OBLIGATIONS / "integrations" / "imessage-changed.json"

# An OPEN conclusion nobody has revisited in this long gets re-judged even with
# no new messages. Guards against a wrong call becoming permanent because the
# thread went quiet.
#
# A conclusion Alex closed himself is never re-judged on age. Marking something
# done is a decision, and a decision that expires after a week is not a decision
# — he would close the same item every Monday and stop trusting the list. The
# only thing that reopens it is a message arriving after he closed it, which
# shows up as `new messages` below like any other new evidence.
#
# A conclusion the *agent* closed is a judgement, not a decision, and judgements
# are exactly the thing that should get a second look. `closed_by` is what tells
# them apart: it is only written when a human closes something.
STALE_DAYS = 7
# When we last ASKED about a quiet thread — the message side's copy of
# email-diff's gmail-aged-asked.json, added 2026-09-20 after the re-audit found
# both message branches still keyed on `reviewed` alone while the skill told
# the model to carry entries forward verbatim.
ASKED = OBLIGATIONS / ".log" / "imessage-asked.json"

# THE WORK LIST HAS A CEILING, AND THE REMAINDER IS A NUMBER. Review item 4,
# 2026-09-20. email-diff has capped its queue since the inbox window came off;
# this side had none, so a Mac that woke up after a week could hand the job
# every thread at once — the prompt is ~64KB before it sees a message. New and
# updated first, then what he spoke about, then escapes, then the stale
# cadence and the close re-offers, which can wait an hour.
MAX_JUDGEMENT = 40

# THE ESCAPE TRIPWIRE, for texts. gmail-escaped.json has caught mail that left
# the extract unjudged since 2026-09-02; a text thread could do the same —
# the Mac's window rolls, the job did not run, the thread is gone — and
# nothing counted it. Unlike mail, a text cannot be fetched back by id, so the
# record keeps the last few messages: the job judges from what is here.
LAST_IDS = OBLIGATIONS / ".log" / "imessage-last-ids.json"
ESCAPED = OBLIGATIONS / "integrations" / "imessage-escaped.json"
ESCAPE_KEEP = 5                  # messages kept per escaped thread
# A complete extract that has lost more than half its threads since the last
# complete one is a partial extract that forgot to say so — the Mac mid-sync.
PARTIAL_DROP = 0.5


def note_escapes(extract, state, last_ids_path=LAST_IDS, escaped_path=ESCAPED, now=None):
    """Record threads that left the extract without ever being judged, and
    return everything recorded and still unjudged, oldest first.

    Runs before the diff. A partial extract reports what is already recorded
    and rewrites nothing — absence only means something in a complete picture.
    The record keeps the thread's last few messages because, unlike mail,
    nothing can fetch a text back once the Mac's window has rolled past it.
    """
    now = now or datetime.now().strftime("%Y-%m-%d %H:%M")
    judged = {e["chat_id"] for e in state.get("threads", []) if "chat_id" in e}
    escaped = load(escaped_path, {})
    if is_partial(extract, load(last_ids_path, {})):
        return [e for cid, e in sorted(escaped.items()) if cid not in judged]
    current = {t["chat_id"]: t for t in extract.get("threads", []) if t.get("chat_id")}
    previous = load(last_ids_path, {})
    fresh = 0
    for cid, meta in previous.items():
        if cid in current or cid in judged or cid in escaped:
            continue
        escaped[cid] = {"chat_id": cid, "name": meta.get("name"), "participants": meta.get("participants") or [],
                        "watermark": meta.get("watermark"), "messages": meta.get("messages") or [],
                        "noticed": now, "reason": "left the extract before it was ever judged"}
        fresh += 1
    if fresh:
        escaped_path.parent.mkdir(parents=True, exist_ok=True)
        escaped_path.write_text(json.dumps(escaped, indent=1, sort_keys=True) + "\n")
    last_ids_path.parent.mkdir(parents=True, exist_ok=True)
    last_ids_path.write_text(json.dumps({
        cid: {"name": t.get("name"), "participants": t.get("participants") or [], "watermark": newest(t),
              "messages": [{"at": m.get("at"), "from_me": bool(m.get("from_me")), "text": str(m.get("text") or "")[:120]}
                           for m in (t.get("messages") or [])[-ESCAPE_KEEP:]]}
        for cid, t in current.items()}, indent=1) + "\n")
    return [e for cid, e in sorted(escaped.items()) if cid not in judged]


def is_partial(extract, last_ids=None):
    """Flagged partial, empty, or — the heuristic — a complete-looking extract
    that has lost more than half the threads the last complete one had."""
    threads = extract.get("threads") or []
    if bool(extract.get("partial")) or not threads:
        return True
    before = len(last_ids or {})
    return before >= 4 and len(threads) < before * PARTIAL_DROP


def load(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def newest(thread):
    """Watermark for a thread: the timestamp of its most recent message."""
    msgs = thread.get("messages") or []
    return max((m.get("at", "") for m in msgs), default="")


def days_since(stamp):
    try:
        return (datetime.now() - datetime.strptime(stamp, "%Y-%m-%d %H:%M")).days
    except (ValueError, TypeError):
        return 10**6            # unparseable means "review it"


def phone_key(handle):
    """Last ten digits, the key contacts.json and calls.json both use."""
    digits = "".join(c for c in str(handle or "") if c.isdigit())
    return digits[-10:] if len(digits) >= 10 else ""


def spoke_since(calls, thread, conclusion, reviewed=""):
    """Did a real conversation happen after this obligation started, that the
    triage has not looked at yet?

    Plenty of obligations are discharged by picking up the phone, and that
    leaves no trace in a message thread. Without this, an item asking Alex to
    call someone back stays open forever even though he rang them a minute
    later — which is what happened: the call log landed and nothing re-judged,
    because watermarks only move when a MESSAGE arrives.

    Deterministic, so it belongs here. Whether the call actually settled the
    thing is judgement and stays with the agent.

    `reviewed` is what stops it repeating. Until 2026-09-16 this compared the
    call only against the obligation's own start, so once he had rung someone
    the thread was flagged on EVERY run until the item closed — six of them at
    once by 09-16, and the triage kept writing "reconfirmed as the known diff
    defect re-surfacing already-seen calls" and concluding nothing. A job fired,
    a model ran, and the only output was a note saying nothing had changed. The
    question this asks is "is there a call the triage has not seen", so it is
    answered against the last time the triage looked.
    """
    since = conclusion.get("since") or ""
    if not since or not calls:
        return None

    by_handle = calls.get("by_handle") or {}
    keys = {phone_key(h) for h in (thread.get("participants") or [])}
    keys.add(phone_key(conclusion.get("who")))
    keys.discard("")

    for k in keys:
        spoke = (by_handle.get(k) or {}).get("last_connected_at")
        # Both are "YYYY-MM-DD HH:MM" local, so a string compare is a time
        # compare — the same trick the watermarks use.
        if spoke and spoke > since and spoke > (reviewed or ""):
            return spoke
    return None


def email_key(handle):
    s = str(handle or "").strip().lower()
    return s if "@" in s else ""


def person_keys(handle, names):
    """Every key under which this handle is the same person: the resolved name
    from Contacts or people/, plus the handle itself normalised. Two handles
    that resolve to one name are one person — which is how a text thread and a
    mail thread about the same debt are joined."""
    out = set()
    pk, ek = phone_key(handle), email_key(handle)
    for k in (pk, ek):
        if k:
            out.add(k)
            nm = (names.get(k) or {}).get("name") if isinstance(names, dict) else None
            if nm:
                out.add(str(nm).strip().lower())
    raw = str(handle or "").strip().lower()
    if raw and not pk and not ek:
        out.add(raw)                       # the triage sometimes writes a bare name as `who`
    return out


def open_elsewhere(participants, exclude_chat, state, mail_state, names, limit=4):
    """Other OPEN obligations with the same person, on either channel.

    Review item 6, 2026-09-20. email-diff.py has had this since 09-17 — the
    Northwind failure: an answer arriving on a different thread was judged on
    its own and became a second obligation — but it was mail-only and keyed on
    the sender's domain. The message differ had no cross-thread view at all.
    So the failure it was built for was unaddressed the moment the second
    piece of evidence arrived as a text, and Alex's counterparties routinely
    span both: two "Chase Go Charity for the villa" from two addresses, both
    open, the day this was written.

    Keyed on the PERSON, because a phone number has no domain. It decides
    nothing — merging and closing stay judgement — it puts the other debt in
    front of the model that is already reading this thread.
    """
    mine = set()
    for h in participants or []:
        mine |= person_keys(h, names)
    if not mine:
        return []
    out = []
    for t in (state or {}).get("threads", []):
        c = t.get("conclusion") or {}
        if not c.get("open") or t.get("chat_id") == exclude_chat:
            continue
        theirs = person_keys(c.get("who"), names)
        for h in t.get("participants") or []:
            theirs |= person_keys(h, names)
        if mine & theirs:
            out.append({"ref": f"im:{t.get('chat_id')}", "channel": "text",
                        "title": (c.get("title") or c.get("what") or "")[:90],
                        "since": c.get("since"), "owed_by": c.get("owed_by", "me")})
    for t in (mail_state or {}).get("threads", []):
        c = t.get("conclusion") or {}
        if not c.get("open"):
            continue
        if mine & person_keys(c.get("who"), names):
            out.append({"ref": f"mail:{t.get('account', 'gmail')}:{t.get('thread_id')}", "channel": "mail",
                        "title": (c.get("title") or c.get("what") or "")[:90],
                        "since": c.get("since"), "owed_by": c.get("owed_by", "me")})
    out.sort(key=lambda r: r.get("since") or "", reverse=True)
    return out[:limit]



# His note on a close, for the thread that comes back. Alex, 2026-09-30:
# "when I close a task with a note, is that note helpful for future actions?"
# It was shown back to him in the evening brief and the closed view, and the
# triage was told only THAT he had closed a thread when new mail arrived on it
# — never what he wrote, which is the one thing that decides whether the new
# mail reopens it ("Not interested", "paid by check 9/12"). The note lives in
# obligation-state.json; a merged item's close is on its parent.
OBLIGATION_STATE = OBLIGATIONS / "integrations" / "obligation-state.json"


def load_close_notes(path=None):
    try:
        d = json.loads((path or OBLIGATION_STATE).read_text())
    except (OSError, ValueError):
        return {}
    closed = d.get("closed") or {}
    links = d.get("links") or {}
    out = {k: (v or {}).get("outcome") for k, v in closed.items() if (v or {}).get("outcome")}
    for child, link in links.items():
        parent = (link or {}).get("into") if isinstance(link, dict) else None
        if child not in out and parent in out:
            out[child] = out[parent]
    return out


def load_names(contacts_path=None, people_dir=None):
    """handle-key -> {name, relation, file}: Contacts first, then people/.

    Alex, 2026-09-05, after the evening brief called his brother "the 702
    number" while Ben Rivera sat in Contacts with a people/ file: the
    lookup the skill asked the model to do was skipped, so it is done here,
    every minute, before any model sees a thread. A bare handle reaching a job
    now means the person is genuinely unknown, and that gets counted.
    """
    names = {}
    try:
        data = json.loads((contacts_path or CONTACTS).read_text())
    except (OSError, ValueError):
        data = []
    rows = data if isinstance(data, list) else data.get("contacts", [])
    for c in rows:
        for h in c.get("handles") or []:
            key = phone_key(h.get("key") or h.get("raw")) or email_key(h.get("key") or h.get("raw"))
            if key and key not in names:
                names[key] = {"name": c.get("name"), "relation": None, "file": None}
    # people/ adds relation and the file; a phone:/email: line there also names
    # a handle Contacts does not have.
    by_name = {}
    for f in sorted((people_dir or PEOPLE).glob("*.md")) if (people_dir or PEOPLE).exists() else []:
        if f.name.startswith("_"):
            continue
        try:
            head = f.read_text().split("---")[1]
        except (OSError, IndexError):
            continue
        fm = {}
        for line in head.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
        if fm.get("type", "person") != "person" or not fm.get("name"):
            continue
        rec = {"name": fm["name"], "relation": fm.get("relation") or None, "file": f"people/{f.name}"}
        by_name[fm["name"].lower()] = rec
        for field in ("phone", "email"):
            # Comma-separated; a number may carry its own spaces.
            for h in fm.get(field, "").split(","):
                key = phone_key(h) or email_key(h)
                if key:
                    names[key] = {**names.get(key, {}), **rec}
    for key, rec in names.items():
        p = by_name.get(str(rec.get("name") or "").lower())
        if p and not rec.get("file"):
            rec.update(relation=p["relation"], file=p["file"])
    return names


def who(handle, names):
    key = phone_key(handle) or email_key(handle)
    rec = names.get(key) if names else None
    if not rec:
        return {"handle": handle, "name": None, "relation": None, "file": None}
    return {"handle": handle, **rec}


def label(participants):
    """One line a model can use as-is: 'Ben Rivera (brother), Clara Rivera, +13525550000'."""
    parts = []
    for p in participants:
        if p.get("name"):
            parts.append(p["name"] + (f" ({p['relation']})" if p.get("relation") else ""))
        else:
            parts.append(p["handle"])
    return ", ".join(parts)


def diff(extract, state, calls=None, names=None, mail_state=None, asked_before=None, asked_out=None,
         escaped=(), last_ids=None, limit=MAX_JUDGEMENT, close_notes=None):
    known = {e["chat_id"]: e for e in state.get("threads", []) if "chat_id" in e}
    close_notes = load_close_notes() if close_notes is None else close_notes
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    new, updated, unchanged, stale, gone, spoke = [], [], [], [], [], []
    settled = 0                 # closed, quiet, and deliberately left alone
    asked_before = {} if asked_before is None else asked_before
    asked_now = {} if asked_out is None else asked_out
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    # A partial extract — the Mac mid-sync, or nothing at all — says nothing
    # about what aged out. email-diff has guarded this since the escape
    # tripwire; the re-audit found this side treated an empty extract as
    # "everything aged out" and, since fix 1, burned every closed thread's one
    # look on it. Honour the flag, and treat no threads at all as partial.
    partial = is_partial(extract, last_ids)
    partial_by_drop = partial and not bool(extract.get("partial")) and bool(extract.get("threads"))

    for t in extract.get("threads", []):
        cid = t.get("chat_id")
        if not cid:
            continue
        prev = known.get(cid)
        mark = newest(t)

        conclusion = prev.get("conclusion") or {} if prev else {}
        closed = prev is not None and not conclusion.get("open", False)
        # Only a human close is permanent. See STALE_DAYS.
        # `agent:` marks a close the assistant made, and those are judgements
        # that get another look on age — which is what the comment above
        # STALE_DAYS has always claimed this line does. It did not: any truthy
        # closed_by counted as settled by hand, which was harmless only while
        # the triage left the field unset and the web page (a human) was its
        # only writer. deploy/close.mjs gave jobs a close path on 2026-09-03 and
        # broke that assumption in the same commit that created it.
        by = conclusion.get("closed_by") or ""
        settled_by_hand = closed and bool(by) and not by.startswith("agent:")

        if prev is None:
            new.append({"chat_id": cid, "reason": "not seen before"})
        elif mark > prev.get("watermark", ""):
            entry = {
                "chat_id": cid,
                "reason": "new messages",
                "since": prev.get("watermark", ""),
                "previous_conclusion": conclusion,
            }
            # An item Alex closed coming back needs a louder label than "new
            # messages": the agent has to decide whether this genuinely reopens
            # a thing he settled, and the answer is usually no.
            if settled_by_hand:
                entry["reason"] = "new messages on a thread that was closed"
                entry["closed_at"] = conclusion.get("closed_at")
                entry["closed_by"] = conclusion.get("closed_by")
                note = close_notes.get(f"im:{cid}") or conclusion.get("outcome")
                if note:
                    entry["closed_note"] = note
            updated.append(entry)
        elif settled_by_hand:
            # Closed by Alex and quiet since. Left alone on purpose.
            settled += 1
            unchanged.append(cid)
        elif closed:
            # A closed conclusion, agent's or his, is left alone — see
            # email-diff.py for why the one second look was deleted.
            unchanged.append(cid)
        elif conclusion.get("open") and spoke_since(calls, t, conclusion, prev.get("reviewed", "")):
            at = spoke_since(calls, t, conclusion, prev.get("reviewed", ""))
            spoke.append({
                "chat_id": cid,
                "reason": "spoke by phone after this obligation started",
                "spoke_at": at,
                "previous_conclusion": conclusion,
            })
        elif days_since(max(prev.get("reviewed", ""), (asked_before.get(cid) or {}).get("at", ""))) >= STALE_DAYS:
            asked_now[cid] = {"at": now, "title": (conclusion.get("title") or "")[:80]}
            stale.append({
                "chat_id": cid,
                "reason": f"conclusion not revisited in {STALE_DAYS}+ days",
                "previous_conclusion": prev.get("conclusion"),
            })
        else:
            unchanged.append(cid)

    # A thread that dropped out of the 14-day window. Its conclusion should not
    # simply vanish — an obligation that aged out is still an obligation, and
    # silently forgetting it is the failure this whole cache is meant to avoid.
    #
    # ON THE SAME CLOCK AS `stale`, AND THIS IS THE SECOND TIME. Until
    # 2026-09-20 there was no `reviewed` guard here at all, so an open
    # obligation whose thread had left the window was offered for judgement on
    # EVERY run, for ever — the thread can never come back, so nothing could
    # ever stop it. Alex, 2026-09-20, looking at a conclusion carrying forty
    # entries: "Why does it keep running if there is no new info? Maybe it
    # should have some follow up but not that frequently."
    #
    # It is the identical bug `spoke_since` had fifteen lines above, found and
    # fixed on 2026-09-16 — "once he had rung someone the thread was flagged on
    # EVERY run until the item closed" — and this copy was left. Troy Shaw's
    # thread and Pete Rourke's each collected ten entries saying "re-checked,
    # still outside the extract window, no new messages, no call. Unchanged."
    #
    # An aged-out thread IS a stale conclusion; the only difference is that its
    # evidence is no longer on screen. So it gets the stale cadence — a look
    # every STALE_DAYS — rather than a cadence of its own.
    present = {t.get("chat_id") for t in extract.get("threads", [])}
    skipped_partial = 0
    for cid, prev in ({} if partial else known).items():
        if cid in present:
            continue
        c = prev.get("conclusion") or {}
        if not c.get("open"):
            continue
        if days_since(max(prev.get("reviewed", ""), (asked_before.get(cid) or {}).get("at", ""))) < STALE_DAYS:
            unchanged.append(cid)
            continue
        asked_now[cid] = {"at": now, "title": (c.get("title") or "")[:80]}
        gone.append({"chat_id": cid, "reason": "aged out of the extract while still open",
                     "previous_conclusion": prev.get("conclusion")})
    if partial:
        skipped_partial = sum(1 for cid, prev in known.items() if cid not in present and (prev.get("conclusion") or {}).get("open"))

    # Who is in each thread, resolved. Attached to every entry the model will
    # read, so the name is in front of it before it judges anything.

    # Escapes: recorded threads nobody judged, still unjudged. Once, at the
    # front of the cadence work; a judged one drops out by itself.
    esc = [{"chat_id": e["chat_id"], "reason": e.get("reason") or "left the extract before it was ever judged",
            "escaped": True, "thread_name": e.get("name"), "last_messages": e.get("messages") or [],
            "watermark": e.get("watermark")} for e in escaped if e.get("chat_id") and e["chat_id"] not in known]

    # THE CAP. Ordered by what can least wait; the remainder is counted, never
    # dropped — the next run sees it again. A stale or aged-out entry that is
    # cut must not burn its ask, or it would wait a whole cadence unseen.
    ordered = new + updated + spoke + esc + stale + gone
    queue = ordered[:limit]
    overflow = len(ordered) - len(queue)
    shown_ids = {e["chat_id"] for e in queue}
    for cid in list(asked_now):
        if cid not in shown_ids:
            del asked_now[cid]

    threads = {t.get("chat_id"): t for t in extract.get("threads", [])}
    unresolved = set()
    for entry in queue:
        t = threads.get(entry["chat_id"], {})
        # Who is in it: from the extract while the thread is there; from the
        # state record — the skill copies `participants` onto it — or the
        # escape record once it is not. Until 2026-09-20 an aged-out thread
        # was offered with nobody in it, so "who" was blank exactly when the
        # model had least else to go on.
        handles = (t.get("participants") or (known.get(entry["chat_id"]) or {}).get("participants")
                   or next((e.get("participants") for e in escaped if e.get("chat_id") == entry["chat_id"]), None) or [])
        parts = [who(h, names) for h in handles]
        entry["participants"] = parts
        entry["who"] = label(parts)
        # The other open debts with these people, on either channel — see
        # open_elsewhere(). Absent when there are none, so the model does not
        # read an empty list as "nothing to check".
        others = open_elsewhere(handles, entry["chat_id"], state, mail_state, names)
        if others:
            entry["open_elsewhere"] = others
        if t.get("name"):
            entry["thread_name"] = t["name"]
        elif (known.get(entry["chat_id"]) or {}).get("name"):
            entry["thread_name"] = known[entry["chat_id"]]["name"]
        unresolved.update(p["handle"] for p in parts if not p["name"])

    return {
        "generated_at": now,
        "extract_generated_at": extract.get("generated_at"),
        "unresolved_handles": sorted(unresolved),
        "counts": {
            "new": len(new), "updated": len(updated), "stale": len(stale),
            "unchanged": len(unchanged), "aged_out_still_open": len(gone),
            "settled": settled, "spoke_by_phone": len(spoke),
            "unresolved_handles": len(unresolved),
            "aged_out_skipped_partial": skipped_partial,
            # Loudly: threads that would otherwise have disappeared unnoticed.
            "escaped_unjudged": len(esc),
            # Named, so a short list never reads as "that is all there was".
            "not_shown": overflow,
            # The extract looked complete and was not: more than half the
            # threads of the last complete one are missing.
            "partial_by_drop": partial_by_drop,
        },
        "needs_judgement": queue,
        "unchanged": unchanged,
    }


def main():
    extract = load(EXTRACT, None)
    if extract is None:
        print(f"no extract at {EXTRACT}", file=sys.stderr)
        return 2
    state = load(STATE, {})
    asked_before = load(ASKED, {})
    asked_now = {}
    last_ids = load(LAST_IDS, {})
    escaped = note_escapes(extract, state)      # rewrites LAST_IDS unless partial
    out = diff(extract, state, load(CALLS, None), load_names(),
               mail_state=load(MAIL_STATE, None),
               asked_before=asked_before, asked_out=asked_now,
               escaped=escaped, last_ids=last_ids)
    # The ask ledger keeps only what is still inside the cadence window — the
    # same retention email-diff uses, for the same reason.
    keep_asked = {k: v for k, v in asked_before.items() if days_since((v or {}).get("at", "")) < STALE_DAYS}
    keep_asked.update(asked_now)
    ASKED.parent.mkdir(parents=True, exist_ok=True)
    ASKED.write_text(json.dumps(keep_asked, indent=1, sort_keys=True) + "\n")
    CHANGED.parent.mkdir(parents=True, exist_ok=True)
    CHANGED.write_text(json.dumps(out, indent=1) + "\n")
    os.chmod(CHANGED, 0o600)
    c = out["counts"]
    print(f"{c['new']} new, {c['updated']} updated, {c['spoke_by_phone']} spoken to by "
          f"phone, {c['stale']} stale, {c['unchanged']} unchanged "
          f"({c['settled']} closed and left alone), "
          f"{c['aged_out_still_open']} aged out still open, "
          f"{c['unresolved_handles']} handle(s) nobody can name, "
          f"{c['not_shown']} not shown")
    if c["escaped_unjudged"]:
        print(f"  {c['escaped_unjudged']} thread(s) left the extract unjudged and are on the work list; "
              f"see integrations/imessage-escaped.json")
    if c["partial_by_drop"]:
        print("  the extract lost more than half its threads since the last complete one — treated as partial")
    return 0


if __name__ == "__main__":
    sys.exit(main())
