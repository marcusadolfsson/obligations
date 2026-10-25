#!/usr/bin/env python3
"""Work out which mail threads need judging, and what is known about each.

The mail twin of `imessage-diff.py`, and deliberately the same state machine:
new / updated / stale / aged-out / settled. 583 threads re-judged every run
would be slow, expensive, and non-deterministic — the same thread would be an
obligation on Tuesday and not on Wednesday for no reason anyone could point at.

Reads:
  integrations/gmail.json         the extract (metadata only, codes redacted)
  integrations/email-state.json   the agent's previous conclusions
  people/*.md                     whose mail is never merely a newsletter

Writes:
  integrations/gmail-changed.json a work list: what to judge, and why

## Signals, not a floor

Code here never decides what a thread is, and as of 2026-09-02 it no longer
decides what a thread cannot be either. It reports three facts the agent would
otherwise have to compute for itself:

  - the sender has a file in `people/`      — a person he knows, not a list
  - he has replied on the thread            — he engaged; it is a conversation
  - it carries a document                   — a real attachment, not a logo

**They constrain nothing.** They are evidence handed over so a judgement is
made knowing them.

It was a floor once — "this thread is at least action" — and it went wrong the
same way three reviews running. In the last, 14 of 37 proposed obligations
existed only because of it: receipts, auto-charged invoices, contracts already
signed, a question answered in August, and the LFC statement that
`rules/email-triage.md` names by name as the example of *digest with the
number*. It overrode the policy on the policy's own examples, and it overrode a
row Alex wrote by hand in "Not his to do".

Every leg turned out to need a qualifier this file cannot evaluate — *while it
is still live*, *when something is owed*, *when they are writing to him*. All
three are judgements about meaning, which is exactly what this file refuses to
make. A constraint that can only be right when qualified by something it cannot
see is not a constraint; it is a guess with authority.

Alex, 2026-09-02: "Should we just scratch the Floor?" Nearly. The forcing is
gone; the facts stay, because they are cheap here and expensive in a turn —
reading `people/` and fetching a thread to see whether it has a document are
both work the agent should not repeat 80 times.

What stops something being lost now is not this. It is that documents are filed
before their threads are archived, that awareness exists for things worth
knowing which ask nothing, and that nothing is silent but a ratified sender.

## Two watermarks, two layers

`historyId` is a *fetch* cursor and belongs to the extractor. `internalDate` —
via the extract's per-thread `watermark` — is what says a thread moved. Keying
this on `historyId` would re-judge the whole mailbox every time Superhuman
relabelled something, which it does constantly.

## Never guesses from text

No subject is pattern-matched to infer intent, and no body is available to
match against even if it were. Deciding what a thread means from its words is
the agent's job; a script doing it would be guessing, and guessing quietly.
"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# The repo this file lives in, unless OBLIGATIONS says otherwise. It used to be
# ~/obligations, true on linuxbox and wrong on the Mac mini, where the working copy
# is ~/Developer/obligations (2026-10-01) — a test run without OBLIGATIONS read the old
# path and failed. Where the script is, is where the repo is.
OBLIGATIONS = Path(os.environ.get("OBLIGATIONS") or Path(__file__).resolve().parents[2])
EXTRACT = OBLIGATIONS / "integrations" / "gmail.json"
STATE = OBLIGATIONS / "integrations" / "email-state.json"
CHANGED = OBLIGATIONS / "integrations" / "gmail-changed.json"
PEOPLE = OBLIGATIONS / "people"

# Thread ids present in the previous extract. Derived and gitignored: it exists
# only to spot what disappeared between two runs.
LAST_IDS = OBLIGATIONS / ".log" / "gmail-last-ids.json"
# When an aged-out-but-open thread was last put on the work list. Without it
# the seven-day cadence is measured from a field the job does not rewrite when
# it carries a conclusion forward, and the same debt is asked about every run.
ASKED = OBLIGATIONS / ".log" / "gmail-aged-asked.json"
# The other channel's conclusions and the address book, for open_elsewhere.
# Read, never written: the message triage owns the first, the Mac the second.
MSG_STATE = OBLIGATIONS / "integrations" / "imessage-state.json"
CONTACTS = OBLIGATIONS / "integrations" / "contacts.json"

# Threads that left the extract WITHOUT ever being judged.
#
# Alex, 2026-09-02: "We never want emails invisible to the assistant." This file
# is what makes that true. `aged_out_still_open` does not catch these, because
# it is built from threads that already have a conclusion; a thread never judged
# has no state entry, so nothing knows it existed and it vanishes in silence.
#
# The original cause was the 14-day window, which was a cliff: a thread older
# than that simply stopped appearing. Alex had that removed on 2026-09-02 —
# the extract now takes the whole inbox — so an unjudged thread can no longer
# age out of view. What is left is narrower and still real: he archives one
# himself from his phone, a filter moves it, or it is deleted. The mechanism
# does not care which; it compares the ids of the last run against this one and
# reports anything that left unjudged.
#
# Tracked in git, unlike the extract, because it is the one record that cannot
# be regenerated: nothing else remembers a thread that is no longer there.
#
# An escaped thread is still ACTIONABLE. mail-body.mjs fetches any thread by id
# regardless of age, so these go to the front of the work list rather than into
# a graveyard.
ESCAPED = OBLIGATIONS / "integrations" / "gmail-escaped.json"

# Threads already put in front of a REHEARSAL.
#
# A dry run writes no conclusions — that is the whole point of it — so the
# differ has no way to know a thread was looked at, and every rehearsal offers
# the same top 80. That is right for a real run and useless for reviewing a
# backlog: Alex asked to see "the next 80, so we don't loop over the same
# ones again".
#
# Deliberately NOT integrations/email-state.json. That file means "the agent
# reached a conclusion about this thread", and writing rehearsals into it would
# make the first real run skip everything already rehearsed — consuming the
# backlog without ever having acted on it. This is a scratch ledger of what has
# been *shown*, in .log/, gitignored, and safe to delete.
REVIEWED = OBLIGATIONS / ".log" / "triage-reviewed.json"

# Same rule as the message differ: an OPEN conclusion nobody has revisited in
# this long gets another look even with no new mail. A conclusion Alex closed
# himself is never re-judged on age — marking something done is a decision, and
# a decision that expires after a week is not one. A conclusion the *agent*
# closed is a judgement, and judgements are exactly what should be revisited.
# `closed_by` is what tells them apart.
STALE_DAYS = 7

# How many threads the agent is asked to judge in one run.
#
# An LLM turn over this list is the expensive part of the whole pipeline, and
# 583 threads is not a work list, it is a second inbox. Newest first, because a
# thread that moved an hour ago is likelier to need an answer than one that
# moved on the 20th. **Overflow is counted, never dropped silently** — a work
# list that quietly truncates reads as "that is everything", which is the exact
# failure the extract's own cap had.
#
# MEASURED, and read with the variance in view rather than as a clean curve:
#
#   batch   tokens    per thread   duration   turns   peak context
#      40    7.69M      192,232      1092s      —            —
#      80    7.12M       89,004      1209s     144      222,402
#      80    9.40M      117,500      1200s      —            —
#     160   18.46M      115,398      1878s     185      401,182
#
# The two 80-runs differ from each other by 32%, which is about the whole
# distance between 80 and 160. So what the numbers actually support is narrower
# than it first looked:
#
#   - 40 is clearly bad. 192k a thread is twice anything else and the gap is far
#     larger than the spread between runs of the same size.
#   - 80 and 160 are NOT separated by this data. Claiming 80 is the optimum
#     would be reading a two-point difference through one-point noise.
#
# 80 is kept anyway, on the grounds that do not depend on tokens: a run takes 20
# minutes instead of 31, peak context is 222k instead of 401k, and a smaller run
# loses less when one fails. Speed comes from the cadence in mail-gate.mjs, not
# from the batch.
#
# At 40 the FIXED cost of starting dominates — instructions, work list, tool
# arming, the opening survey — paid once whether the run judges 40 threads or
# 160. The marginal thread is cheap; the marginal run is not. That is why 80
# spent fewer tokens in absolute terms than 40 did, which was the opposite of
# what this comment first predicted.
#
# At 160 context accumulation is the plausible mechanism — every turn re-reads
# everything before it, so a run reaching 401k tokens pays that across 185 turns
# — but the token numbers do not prove it, and the honest statement is that it
# was half again as slow for no measured saving. Nothing failed: no compaction,
# the window held 401k comfortably.
#
# So: 80. Raising it does not buy speed either; the cadence does, and that lives
# in mail-gate.mjs, where the gap shortens while a backlog is queued.
#
# Any future change should come with the same columns AND more than one run per
# size. The first version of this comment drew a curve through single samples
# and called 80 the floor; the second 80-run landed 32% away from the first and
# on top of 160. One measurement is an anecdote at this variance.
MAX_JUDGEMENT = 80

# A thread this old is within two days of leaving the 14-day window. Floored
# threads past this point sort ahead of newer ones — see rank() below.
EDGE_DAYS = 12

# ...but the cap is protection for the UNATTENDED path, not a law about how
# much can ever be judged. A deliberate catch-up run with someone watching is a
# different situation from the 07:00 job, and there is no reason a backlog
# should take a week to drain because of a constant meant to stop a runaway
# scheduled job.
#
#   python3 deploy/integrations/email-diff.py --max 200
#   python3 deploy/integrations/email-diff.py --all
#
# Two things to keep in view when raising it. Each judged thread costs model
# time and can end in a real archive, so a first large run is worth reading
# before the next one; and a very long work list in one turn tends to get less
# care per item than a short one, which the signals below help survive rather
# than invite. The scheduled path never passes either flag.

EMAIL = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")


def load(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def own_addresses():
    """Alex's own addresses, from the extract's mailbox list."""
    try:
        d = json.loads(EXTRACT.read_text())
    except (OSError, ValueError):
        return set()
    return {str(m.get("address", "")).lower() for m in d.get("mailboxes", [])
            if m.get("address")}


def known_people():
    """Every address that appears in a `people/` file, except Alex's own.

    Absence is not emptiness. If `people/` cannot be read at all we return None
    and the caller drops that signal rather than treating everyone as
    a stranger — the same fail-closed shape as the outbox allowlist.

    **His own addresses are removed**, and that is not a detail. `people/` files
    quote threads and say things like "emailed alex@rivera.example", so his own
    address is all over them. Without this, every thread he SENT carried the
    signal "sender has a file in people/: alex@rivera.example" — both wrong and
    confusing, since the intended reading is "a person he knows wrote to him".

    It also overlapped the second signal: a thread he sent is a thread he has
    replied on, which is already reported. So it inflated the count while adding
    nothing.
    """
    try:
        files = sorted(PEOPLE.glob("*.md"))
    except OSError:
        return None
    if not files:
        return None
    found = set()
    for f in files:
        try:
            found |= {m.group(0).lower() for m in EMAIL.finditer(f.read_text())}
        except OSError:
            continue
    return found - own_addresses()


def days_since(stamp):
    try:
        return (datetime.now() - datetime.strptime(stamp, "%Y-%m-%d %H:%M")).days
    except (ValueError, TypeError):
        return 10**6            # unparseable means "review it"


AUTOPAY = OBLIGATIONS / "integrations" / "autopay.json"


def autopay_vendors(path=None):
    """His autopay list: key (address or @domain) -> entry. See
    deploy/agent-service/autopay.mjs, which owns the file and the matching the
    review pass closes on; this only has to recognise the sender."""
    try:
        d = json.loads((path or AUTOPAY).read_text())
    except (OSError, ValueError):
        return {}
    v = d.get("vendors") if isinstance(d, dict) else None
    return v if isinstance(v, dict) else {}


def autopay_key(senders, vendors):
    """The autopay entry any of these senders falls under — the address, or
    anyone at the domain or a subdomain, as senderIs() in autopay.mjs."""
    for raw in senders:
        m = re.search(r"<([^>]+)>", raw or "")
        email = (m.group(1) if m else (raw or "")).strip().lower()
        if "@" not in email:
            continue
        host = email.rsplit("@", 1)[-1]
        for key in vendors:
            k = key.lower()
            if (not k.startswith("@") and email == k) or (k.startswith("@") and (host == k[1:] or host.endswith("." + k[1:]))):
                return key
    return None


def signals_for(thread, people, autopay=None):
    """Facts about this thread worth knowing before judging it.

    Reasons rather than a boolean, so the agent is told *what* was noticed.
    "the sender is in people/" and "you replied to this" call for different
    handling, and a flag would flatten them into one.

    Constrains nothing. See the header for why it used to and no longer does.

    One more is added by diff() rather than here, because it needs state this
    function does not have: "he archived this himself", for a thread that left
    the inbox with no conclusion and no filter of his covering it. Telling the
    obligations-archived case from the by-hand case needs the conclusions.
    """
    why = []

    if people:
        senders = {m.get("from", "") for m in thread.get("messages", [])}
        hit = sorted(senders & people)
        if hit:
            why.append(f"sender has a file in people/: {hit[0]}")

    if not thread.get("never_replied", True):
        why.append("he has replied on this thread")

    if thread.get("has_attachment"):
        why.append("carries an attachment")

    # On his autopay list. Alex, 2026-09-30: "I only want to be a task if
    # autopay fails." A statement from this sender is filed with its amount;
    # only a failed or declined payment is an action.
    vendors = autopay_vendors() if autopay is None else autopay
    if vendors:
        key = autopay_key([m.get("from", "") for m in thread.get("messages", [])], vendors)
        if key:
            accts = (vendors.get(key) or {}).get("accounts") or []
            why.append(f"on his autopay list: {key}" + (f" (accounts ending {', '.join(accts)} only)" if accts else ""))

    return why


# A consumer or service domain says nothing about who the counterparty is: two
# threads from gmail.com are not one piece of business. Same list the project
# proposer keeps, and for the same reason.
NOISE_ORGS = {
    "gmail", "googlemail", "google", "apple", "icloud", "me", "mac", "yahoo",
    "hotmail", "outlook", "live", "msn", "aol", "protonmail", "proton", "comcast",
    "amazon", "paypal", "stripe", "docusign", "linkedin", "substack", "beehiiv",
    "mailchimp", "sendgrid", "ccsend", "hubspot", "salesforce", "intuit",
    "quickbooks", "zoom", "calendly", "superhuman",
}


def org_keys(thread, own_domains=()):
    """Who this thread is WITH, as coarse organisation keys.

    The first label of each participant's domain: `eecreportinghours@northwind-aero.example`
    and `accounts.receivable@northwind-aero.example.br` are both "northwind-aero". Coarse on
    purpose — a company writes from whatever address its department uses, and
    those two are one counterparty in every sense that matters here. Consumer
    domains are dropped, because "gmail" is not a counterparty, and so are his OWN
    domains: dana@rivera.example and alex@rivera.example share a surname, not a
    piece of business, and on the first live run that linked his brother's
    utility bill to a K-1 chase. The exact address stays a key, so two threads
    with the same person on them still meet.
    """
    out = set()
    for h in thread.get("participants") or []:
        s = str(h or "").lower()
        if "@" not in s:
            continue
        dom = s.rsplit("@", 1)[1].strip(">").strip()
        first = dom.split(".")[0]
        if first and first not in NOISE_ORGS and dom not in own_domains:
            out.add(first)
        out.add(s.strip("<> "))
    return out


def load_contacts_index(path=None):
    """handle -> display name, from the Mac's contacts extract. Empty if absent."""
    try:
        data = json.loads((path or CONTACTS).read_text())
    except (OSError, ValueError):
        return {}
    return {str(k).strip().lower(): str(v) for k, v in (data.get("index") or {}).items() if v}


def person_of(handle, contacts):
    """The person behind a handle, as a lower-case name — or nothing.

    Only a NAME joins across channels. An address has a domain and a phone has
    ten digits; the one thing they share is who Contacts says they are, and
    that is deliberately the only key: "dana@x.com" and "+1 555 200 0002"
    are one person exactly when the address book says so, never by guess.
    """
    s = str(handle or "").strip().lower().strip("<>")
    if not s:
        return ""
    if "@" in s:
        return contacts.get(s, "").strip().lower()
    digits = "".join(ch for ch in s if ch.isdigit())[-10:]
    if len(digits) == 10:
        return contacts.get(digits, "").strip().lower()
    # A bare name, as the message triage writes `who` ("Ivan Dunn", "Ari").
    # The re-audit, 2026-09-20: this resolved an address or ten digits and
    # nothing else, and message conclusions carry neither — so the join this
    # was written for matched zero text threads on the live data. A name is a
    # person exactly when the address book has it.
    return s if s in {str(v).strip().lower() for v in contacts.values()} else ""


def people_of(text, contacts):
    """Every person in a `who` like "Cody Hurst, Kyle Weller", resolved."""
    out = set()
    for part in re.split(r"\s*(?:,|;|&|\band\b)\s*", str(text or "")):
        person = person_of(part, contacts)
        if person:
            out.add(person)
    return out


def open_elsewhere(threads, conclusions, own_domains=(), msg_state=None, contacts=None):
    """thread id -> the OTHER open obligations with the same counterparty.

    Alex, 2026-09-17, on a four-week-old chase that never closed: "any idea
    why the Northwind reporting hours didn't autoclose?" It could not. He asked
    Northwind on 2026-08-19 to regenerate an invoice; the answer arrived on
    2026-09-14 as a payment notification on a DIFFERENT thread, which was judged
    on its own and became a second obligation. Nothing ever put the two in front
    of the same reader: the triage judges what has new mail, and the old thread
    never gained a message, so every run re-read it and reconfirmed it open.

    So the work list now carries the open items with the same counterparty. It
    decides nothing — merging or closing is judgement, and the skill says when —
    but the reader can no longer fail to know the other one exists.
    """
    by_org = {}
    for t in threads:
        c = (conclusions.get(t.get("thread_id")) or {}).get("conclusion") or {}
        if not c.get("open"):
            continue
        for k in org_keys(t, own_domains):
            by_org.setdefault(k, []).append((t, c))
    # AND THE ONES THE EXTRACT NO LONGER CARRIES. Alex, 2026-10-20: "Todo
    # NKRS should auto close based on the COI I forwarded." Jake Gerber asked
    # for Bayside Plumbing's COI on 2026-09-02; the COI came from the plumber
    # on a new thread on 10-19 and he forwarded it to ONE receiving at once.
    # The index above was built from the extract alone, which reaches back
    # about four weeks, so the 09-03 thread was not in it and the triage
    # judged the COI with no idea anything was waiting on it. That day 33 of
    # 72 open mail obligations were older than the extract. Their `who` is
    # the one address the state keeps, and it is the counterparty.
    in_extract = {t.get("thread_id") for t in threads}
    for tid, e in conclusions.items():
        c = (e or {}).get("conclusion") or {}
        if tid in in_extract or not c.get("open") or "@" not in str(c.get("who") or ""):
            continue
        ghost = {"thread_id": tid, "account": e.get("account"),
                 "watermark": e.get("watermark"), "participants": [c.get("who")]}
        for k in org_keys(ghost, own_domains):
            by_org.setdefault(k, []).append((ghost, c))
    out = {}
    for t in threads:
        tid = t.get("thread_id")
        seen, rows = set(), []
        for k in org_keys(t, own_domains):
            for other, c in by_org.get(k, []):
                oid = other.get("thread_id")
                if oid == tid or oid in seen:
                    continue
                seen.add(oid)
                rows.append({"ref": ref(other), "title": c.get("title") or (c.get("what") or "")[:80],
                             "since": c.get("since") or other.get("watermark"), "with": k})
        # AND THE TEXTS. Review 2026-09-20, the remaining item: this could see
        # other MAIL with the same counterparty and nothing else, so the
        # Northwind failure — an answer landing somewhere the triage was not
        # looking — was unaddressed whenever the somewhere was a text thread.
        # imessage-diff.py got the mirror of this the same day; now both ends
        # see both channels. Joined on the PERSON from Contacts, because a
        # phone number has no domain and an address has no digits.
        if msg_state and contacts:
            people = {person_of(h, contacts) for h in (t.get("participants") or [])} - {""}
            if people:
                for mt in msg_state.get("threads", []):
                    mc = mt.get("conclusion") or {}
                    if not mc.get("open"):
                        continue
                    theirs = people_of(mc.get("who"), contacts) | {person_of(h, contacts) for h in (mt.get("participants") or [])}
                    hit = (theirs - {""}) & people
                    if hit:
                        rows.append({"ref": f"im:{mt.get('chat_id')}", "channel": "text",
                                     "title": mc.get("title") or (mc.get("what") or "")[:80],
                                     "since": mc.get("since") or mt.get("watermark"), "with": sorted(hit)[0]})
        if rows:
            out[tid] = sorted(rows, key=lambda r: str(r.get("since") or ""))[:4]
    return out



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


def ref(thread):
    """`mail:<account>:<threadId>` — the id sources/email.mjs uses.

    Built here so the work list and the obligation model agree on identity
    without the agent constructing it by hand, which is where a typo would
    become a duplicate obligation nobody notices.
    """
    return f"mail:{thread.get('account', 'gmail')}:{thread.get('thread_id')}"


def held_accounts():
    """Accounts whose mail is deliberately not offered for judgement.

    Set in integrations/google-policy.json, which is where per-account decisions
    live and is tracked in git for that reason. Alex put work on hold on
    2026-09-02 to clear six months of newsletters by hand.

    HELD IS NOT HIDDEN, and the distinction is the whole point. The extractor
    still reads the entire mailbox, these threads still appear in `new`, and the
    summary says how many are being held. Nothing about this makes mail
    invisible to the assistant -- it only decides what the agent is asked to spend a
    turn on. Removing the key resumes triage on the next tick.
    """
    try:
        policy = json.loads((OBLIGATIONS / "integrations" / "google-policy.json").read_text())
    except Exception:                                   # noqa: BLE001
        return set()
    return {name for name, cfg in policy.items()
            if isinstance(cfg, dict) and cfg.get("triage") == "hold"}


def kept_in_inbox():
    """Threads Alex asked to Keep in Inbox, as `account:thread` keys.

    integrations/keep-in-inbox.json, written by his tap and by the service pass
    that lets one go (deploy/agent-service/keep-inbox.mjs). Alex, 2026-10-09:
    "moves the message back to Inbox, and keeps it there until I manually
    archive OR we determine that the task is closed." A kept thread is never in
    needs_archive, and in needs_judgement it carries `keep_in_inbox: true` so
    the job judges it and leaves it where it is. The hook in the service is what
    actually refuses the archive call; this is so the job is never asked to.
    """
    try:
        d = json.loads((OBLIGATIONS / "integrations" / "keep-in-inbox.json").read_text())
    except Exception:                                   # noqa: BLE001
        return set()
    return set((d.get("threads") or {}).keys())


def ignored_senders():
    """Senders Alex has told the whole system to stop showing him.

    integrations/ignored-senders.json, written by the Ignore Sender button on the
    reading page. Keys are lower-case addresses or `@domain`.

    IGNORED IS NOT INVISIBLE, same as held. The extractor still reads these
    threads, the summary says how many were ignored, and anything from an
    ignored sender still sitting in an inbox is queued for archive rather than
    dropped. What changes is that no agent turn is ever spent on them and no
    list or digest ever shows them. That is Alex's rule, not the agent's:
    CLAUDE.md forbids the agent creating filters, and this is the ratified-silent
    list the policy always reserved for him, in a form a button can write.
    """
    try:
        d = json.loads((OBLIGATIONS / "integrations" / "ignored-senders.json").read_text())
    except Exception:                                   # noqa: BLE001
        return set()
    return {k.lower() for k in (d.get("senders") or {})}


def sender_ignored(thread, ignore):
    """True when any message on the thread not from Alex is from an ignored
    address or domain. Exact address first, then `@domain`."""
    if not ignore:
        return False
    for m in thread.get("messages", []):
        if m.get("from_me"):
            continue
        a = (m.get("from") or "").lower()
        if not a:
            continue
        if a in ignore:
            return True
        at = a.rfind("@")
        if at != -1 and a[at:] in ignore:
            return True
    return False


def mark_gone(escaped, extract):
    """Stamp `gone` on escape records the extractor asked Gmail about and got a
    404 for. The record stays — it is still the only evidence the thread was
    seen — but a thread that does not exist can never be judged, and leaving it
    on the work list made every mail run retry it. Two did exactly that from
    2026-10-19 09:53 until Alex asked why the morning brief led with them.
    Returns how many were newly marked."""
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    n = 0
    for g in extract.get("gone") or []:
        e = escaped.get(g.get("thread_id"))
        if e is not None and not e.get("gone"):
            e["gone"] = stamp
            n += 1
    return n


def note_escapes(extract, state, hold=None, ignore=None):
    """Record threads that left the extract without ever being judged.

    Runs before the diff and returns what escaped THIS time, so the caller can
    put them at the front of the queue. Nothing is deleted from the record: it
    is the only evidence these threads were ever seen.

    ABSENCE ONLY MEANS SOMETHING IN A COMPLETE EXTRACT. A thread the extractor
    failed to fetch is missing from its output and present in the mailbox, and
    reading that as "it left" would file a false escape for every one of them —
    1,333 in a single run, the day the inbox window came off and rate limiting
    started dropping threads. On a partial extract this reports nothing and,
    just as importantly, does not overwrite the id list: next run compares
    against the last COMPLETE picture rather than against a hole.
    """
    hold = held_accounts() if hold is None else set(hold)
    ignore = ignored_senders() if ignore is None else set(ignore)

    if extract.get("partial"):
        # A thread rolled back by rejudge.mjs counts as UNJUDGED, which is what
        # rejudge means: the conclusion is not to be trusted, look again. Without
        # this, rejudge silently does nothing for any thread that has left the
        # extract — and after the triage archives one, that is most of them. The
        # rollback lands in the state file and no run ever sees it, because the
        # differ can only offer what the extract holds and this set filters out
        # anything already concluded. It worked for the case it was built for, on
        # 2026-09-07, only because those five threads were still in the window.
        # Alex, 2026-09-09.
        judged = {e["thread_id"] for e in state.get("threads", [])
                  if "thread_id" in e and not (e.get("conclusion") or {}).get("rejudge")}
        prior = load(ESCAPED, {})
        # A 404 is evidence whatever else the extract missed.
        if mark_gone(prior, extract):
            ESCAPED.write_text(json.dumps(prior, indent=1, sort_keys=True) + "\n")
        return [e for tid, e in sorted(prior.items())
                if tid not in judged and not e.get("gone")]
    current = {t["thread_id"]: t for t in extract.get("threads", []) if t.get("thread_id")}
    previous = load(LAST_IDS, {})
    # Same rule as above.
    judged = {e["thread_id"] for e in state.get("threads", [])
              if "thread_id" in e and not (e.get("conclusion") or {}).get("rejudge")}

    escaped = load(ESCAPED, {})

    # A HELD MAILBOX IS ONE ALEX IS CLEARING BY HAND, so threads leaving it is
    # the expected outcome rather than an anomaly, and recording each one as an
    # escape is a tripwire firing on the thing it was told to ignore.
    #
    # It did exactly that on 2026-09-02: he archived 846 work threads within
    # twenty minutes of putting that account on hold, and every one landed in
    # this file, where the morning brief would have reported them as mail that
    # vanished unjudged — every day, permanently, in a git-tracked record.
    #
    # Existing records for a held account are dropped for the same reason. A
    # channel that cries wolf 846 times is not a channel, and these are not
    # evidence of anything except him using his own inbox.
    dropped = 0
    if hold:
        for tid in [t for t, e in escaped.items() if e.get("account") in hold]:
            del escaped[tid]
            dropped += 1
    # An ignored sender leaving the inbox is the button working, not a loss.
    if ignore:
        for tid in [t for t, e in escaped.items()
                    if sender_ignored({"messages": [{"from": e.get("sender")}]}, ignore)]:
            del escaped[tid]
            dropped += 1

    marked = mark_gone(escaped, extract)

    fresh = []
    for tid, meta in previous.items():
        if tid in current or tid in judged or tid in escaped:
            continue
        if meta.get("account") in hold:
            continue
        if sender_ignored({"messages": [{"from": meta.get("sender")}]}, ignore):
            continue
        entry = {
            "thread_id": tid,
            "account": meta.get("account"),
            "subject": meta.get("subject"),
            "watermark": meta.get("watermark"),
            "sender": meta.get("sender"),
            "noticed": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "reason": "left the extract before it was ever judged",
        }
        escaped[tid] = entry
        fresh.append(entry)

    if fresh or dropped or marked:
        ESCAPED.parent.mkdir(parents=True, exist_ok=True)
        ESCAPED.write_text(json.dumps(escaped, indent=1, sort_keys=True) + "\n")

    # Remember this run's ids for the next comparison. Only the few fields an
    # escape record needs — this file is a tripwire, not a second extract.
    LAST_IDS.parent.mkdir(parents=True, exist_ok=True)
    LAST_IDS.write_text(json.dumps({
        tid: {"account": t.get("account"), "subject": t.get("subject"),
              "watermark": t.get("watermark"),
              # The first non-Alex sender, so an escape record can be matched
              # against the ignore list after the thread is gone.
              "sender": next((m.get("from") for m in t.get("messages", [])
                              if not m.get("from_me")), None)}
        for tid, t in current.items()}, indent=1) + "\n")

    # Everything recorded and still unjudged, not just this run's — an escape
    # stays on the work list until it is dealt with, or Gmail says it is gone.
    return [e for tid, e in sorted(escaped.items())
            if tid not in judged and not e.get("gone")]


def diff(extract, state, people, limit=MAX_JUDGEMENT, escaped=(), hold=None, ignore=None,
         asked_before=None, asked_out=None, msg_state=None, contacts=None, close_notes=None,
         kept=None):
    known = {e["thread_id"]: e for e in state.get("threads", []) if "thread_id" in e}
    close_notes = load_close_notes() if close_notes is None else close_notes
    autopay = autopay_vendors()   # read once per run, not once per thread
    # Dependency-injected so the tests can drive it; main() reads and writes
    # the file around the call.
    asked_before = {} if asked_before is None else asked_before
    asked_now = {} if asked_out is None else asked_out
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    ignore = ignored_senders() if ignore is None else set(ignore)
    kept = kept_in_inbox() if kept is None else set(kept)
    key_of = lambda t: f"{t.get('account') or 'personal'}:{t.get('thread_id')}"

    new, updated, stale, gone = [], [], [], []
    unchanged = []
    settled = 0
    ignored = 0
    by_filter = 0
    by_hand = 0
    ignored_to_archive = []
    # Other open items with the same counterparty, so a thread is never judged
    # in ignorance of the one it continues. See open_elsewhere().
    own_domains = {str(m.get('address', '')).rsplit('@', 1)[-1].lower()
                   for m in extract.get('mailboxes', []) if m.get('address')}
    elsewhere = open_elsewhere(extract.get('threads', []), known, own_domains, msg_state=msg_state, contacts=contacts)

    for t in extract.get("threads", []):
        tid = t.get("thread_id")
        if not tid:
            continue
        # Ignored senders never reach the agent, whatever state the thread is in.
        # Still in an inbox means the button has not caught up with it yet, so it
        # goes to the archive sweep instead of the judgement queue.
        if sender_ignored(t, ignore):
            ignored += 1
            if t.get("in_inbox"):
                ignored_to_archive.append({
                    "ref": f"mail:{t.get('account', 'gmail')}:{tid}",
                    "thread_id": tid,
                    "account": t.get("account"),
                    "subject": t.get("subject"),
                    "tier": "silent",
                    "open": False,
                    "reason": "ignored sender",
                })
            continue
        prev = known.get(tid)
        mark = t.get("watermark", "")

        def moved():
            """Has this thread gained a message since the conclusion was written?

            Prefer epochs. `watermark` is local wall-clock text with no offset,
            so comparing two runs that used different timezones reports every
            thread as updated -- observed on 2026-09-03, 389 of them, from one
            extract run in a container with no TZ. Falls back to the strings for
            state written before `watermark_at` existed, which is safe because
            those were all written by the same process in the same timezone.
            """
            a, b = t.get("watermark_at"), (prev or {}).get("watermark_at")
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                return a > b
            return mark > (prev or {}).get("watermark", "")

        conclusion = (prev.get("conclusion") or {}) if prev else {}
        closed = prev is not None and not conclusion.get("open", False)
        # `agent:` marks a close the assistant made, and those are judgements
        # that get another look on age — which is what the comment above
        # STALE_DAYS has always claimed this line does. It did not: any truthy
        # closed_by counted as settled by hand, which was harmless only while
        # the triage left the field unset and the web page (a human) was its
        # only writer. deploy/close.mjs gave jobs a close path on 2026-09-03 and
        # broke that assumption in the same commit that created it.
        by = conclusion.get("closed_by") or ""
        settled_by_hand = closed and bool(by) and not by.startswith("agent:")

        base = {
            "ref": ref(t),
            "thread_id": tid,
            "account": t.get("account"),
            "subject": t.get("subject"),
            "watermark": mark,
            "watermark_at": t.get("watermark_at"),
            # Travels with every item so the agent need not re-derive it.
            # Evidence, not a constraint — the field was renamed from `floor`
            # on 2026-09-02 precisely so it cannot be read as one again.
            "signals": signals_for(t, people, autopay=autopay),
        }
        if elsewhere.get(tid):
            base["open_elsewhere"] = elsewhere[tid]

        if prev is None:
            # The extract now reaches beyond the inbox, so "never judged" splits
            # three ways and only one of them is work.
            #
            # A thread one of Alex's own archiving filters covers is already
            # ratified silent -- rules/email-triage.md: "he wrote each one
            # deliberately". Seen and counted, never a model turn; ~56 of a week
            # at last count, and judging them would be exactly the work those
            # filters exist to avoid.
            if not t.get("in_inbox") and t.get("filtered"):
                by_filter += 1
                unchanged.append(tid)
            elif not t.get("in_inbox"):
                # Out of the inbox, no conclusion, no filter of his covering it:
                # HE archived it. Alex, 2026-09-03: "if I manually archived
                # something that can be a signal." It is -- he has seen it and
                # dealt with it -- so it is judged once and judged knowing that,
                # rather than read as fresh mail he has ignored. About eight a
                # day, and previously invisible to the assistant entirely.
                by_hand += 1
                # A signal, not a rule. Alex, 2026-09-03, asked whether his
                # own archiving should close an obligation: "it could be taken
                # into consideration." So it joins the other reasons the agent
                # is told about -- a person in people/, a thread he replied to --
                # and constrains nothing. See signals_for().
                new.append({**base,
                            "reason": "archived by hand, never judged",
                            "signals": base["signals"] + ["he archived this himself"]})
            else:
                new.append({**base, "reason": "not seen before"})
        elif moved():
            entry = {**base, "reason": "new messages",
                     "since": prev.get("watermark", ""),
                     "previous_conclusion": conclusion}
            # Mail arriving on something he closed by hand needs a louder label.
            # The agent has to decide whether this genuinely reopens a thing he
            # settled, and the answer is usually no.
            if settled_by_hand:
                entry["reason"] = "new mail on a thread that was closed"
                entry["closed_at"] = conclusion.get("closed_at")
                entry["closed_by"] = conclusion.get("closed_by")
                note = close_notes.get(f"mail:{t.get('account')}:{tid}") or conclusion.get("outcome")
                if note:
                    entry["closed_note"] = note
            updated.append(entry)
        elif settled_by_hand:
            settled += 1
            unchanged.append(tid)
        elif closed:
            # A closed conclusion, agent's or his, is left alone. The one
            # second look an agent close used to get here — 140 of them over
            # its life, and not one reopened anything — was deleted on
            # 2026-09-20. What guards a wrong close now is the evening's
            # "closed today", the Reopen door, and obligation-state.json.
            unchanged.append(tid)
        elif days_since(max(prev.get("reviewed", ""), (asked_before.get(tid) or {}).get("at", ""))) >= STALE_DAYS:
            # From when the job last reviewed it OR we last asked — the same
            # ledger the aged-out branch has used since 09-18. The re-audit,
            # 2026-09-20: this branch was still guarded by `reviewed` alone,
            # the one field the model has to remember to write, and the skill
            # said the ledger covered it when it did not.
            asked_now[tid] = {"at": now, "title": (conclusion.get("title") or "")[:80]}
            stale.append({**base,
                          "reason": f"conclusion not revisited in {STALE_DAYS}+ days",
                          "previous_conclusion": conclusion})
        else:
            unchanged.append(tid)

    # A thread that fell out of the 14-day window with an obligation still open.
    # Its conclusion must not simply vanish: an obligation that aged out is
    # still an obligation, and silently forgetting it is the failure this cache
    # exists to prevent.
    # Anything judged that is still sitting in the inbox.
    #
    # EVERY tier archives, obligations included. rules/email-triage.md, "Action
    # — becomes an obligation, then archives": "as long as we captured the
    # Obligation we can archive it… The goal Alex stated is that nothing lives
    # in the box." The thread is evidence for an item on /tasks, the obligation
    # carries a link straight back to it, and a new message on an archived Gmail
    # thread returns to the inbox by itself. So an open obligation is not a
    # reason to keep mail in the box — it is the reason the mail was read.
    #
    # The first version of this filter skipped open conclusions, on the belief
    # that an obligation belongs in an inbox. That was the rule until
    # 2026-09-02 and is now precisely inverted; it would have left 20 threads
    # sitting there, each one already on /tasks, listed twice and cleared in
    # neither place.
    #
    # The single exception is a thread with NO conclusion, which the policy
    # covers under "when capture fails, the thread stays" — an inbox item is
    # visible, a dropped obligation is not. That falls out of `known` here.
    #
    # None of these come back any other way: a thread with a conclusion is never
    # `new`, a closed one is never `stale`, and one still in the extract has not
    # aged out. 18 work threads sat filed-but-present because a run archived
    # personal's batch and stopped, and 24 more carried `archive_pending` from
    # /tasks closes waiting on a run that never fired.
    needs_archive = list(ignored_to_archive)
    for t in extract.get("threads", []):
        if not t.get("in_inbox") or sender_ignored(t, ignore):
            continue
        if key_of(t) in kept:
            continue                      # he asked to keep it there
        prev = known.get(t.get("thread_id"))
        if not prev or not (prev.get("conclusion") or {}).get("tier"):
            continue                      # never judged — leave it visible
        c = prev["conclusion"]
        needs_archive.append({
            "ref": f"mail:{t.get('account', 'gmail')}:{t.get('thread_id')}",
            "thread_id": t.get("thread_id"),
            "account": t.get("account"),
            "subject": t.get("subject"),
            "tier": c.get("tier"),
            "open": bool(c.get("open")),
            "reason": "judged but still in the inbox",
        })

    # Same inference, same caveat: "not in the extract" is only evidence of
    # anything when the extract is whole. A partial one leaves these alone.
    present = {t.get("thread_id") for t in extract.get("threads", [])}
    quiet = 0
    for tid, prev in ({} if extract.get("partial") else known).items():
        if tid in present:
            continue
        c = prev.get("conclusion") or {}
        if not c.get("open"):
            continue
        # Aged out AND recently judged is not work. The thread left the 14-day
        # window, which means by definition no new message reached it, so there
        # is nothing to re-read and nothing that could change the answer.
        #
        # These were 32 of 40 slots in a live work list, every one of them
        # reviewed the same day, crowding new mail out of the queue: the run
        # that found them spent most of a turn re-affirming conclusions it had
        # written hours earlier and reached eight new threads.
        #
        # The obligation is not at risk from being left alone. It lives in
        # email-state.json, sources/email.mjs reads it whether or not the thread
        # is still in the extract, and it is on /tasks the whole time. What it
        # does need is an occasional second look — an obligation open for weeks
        # with no evidence may want killing — which is the same argument, and
        # the same STALE_DAYS, that in-window conclusions already get.
        # Measured from the later of "when the job last reviewed it" and "when
        # we last put it on the queue".
        #
        # Alex, 2026-09-18: "why is that old email sitting in waiting to be
        # digest?" The Luxury Brand pickup had been on every work list since
        # 2026-09-11. The job did the right thing each time — read the
        # conclusion, found nothing new, carried it forward and said so in its
        # commit — but carrying forward does not rewrite `reviewed`, so the next
        # run met a thread "not revisited in 7+ days" and asked again. A loop
        # that spends a slot of every mail run re-affirming the same debt, and
        # from the page it reads as a thread that has been waiting a week.
        #
        # Asking from when we last ASKED is what makes it a seven-day cadence
        # rather than an every-run one. The obligation is not at risk either
        # way: it lives in email-state.json, sources/email.mjs reads it whether
        # or not the thread is in the extract, and it is on /tasks throughout.
        offered = (asked_before.get(tid) or {}).get("at", "")
        last_look = max(prev.get("reviewed", ""), offered)
        if days_since(last_look) < STALE_DAYS:
            quiet += 1
            continue
        asked_now[tid] = {"at": now, "title": ((prev.get("conclusion") or {}).get("title") or "")[:80]}
        gone.append({
            "ref": f"mail:{prev.get('account', 'gmail')}:{tid}",
            "thread_id": tid,
            "account": prev.get("account"),
            "reason": f"aged out while still open, not revisited in {STALE_DAYS}+ days",
            "previous_conclusion": prev.get("conclusion"),
        })

    # Newest first. `gone` stays at the front regardless of age: an obligation
    # that fell out of the window is the one thing here nothing else will
    # surface again.
    # Newest first, EXCEPT that a thread about to fall out of the window
    # outranks a fresh one. Newest-first alone is why a 13-day-old aircraft
    # invoice lost to the morning's newsletters and was two days from
    # disappearing: the ones with least time left were sorted last.
    #
    # Signals decide which of those matter. A thread near the edge carrying any
    # of them — a person he knows, a thread he replied to, a document — is the
    # one that must not escape unseen.
    def rank(e):
        days = days_since(e.get("watermark", ""))
        urgent = 1 if (e.get("signals") and days >= EDGE_DAYS) else 0
        return (urgent, e.get("watermark", ""))

    queue = sorted(new + updated + stale, key=rank, reverse=True)

    # Escapes first of all, then aged-out-still-open. Both are threads nothing
    # else will ever surface again; everything below them will come round.
    queue = [{**e, "reason": e["reason"], "escaped": True} for e in escaped] + gone + queue

    # Held accounts leave the queue last, so the counts above still describe the
    # whole mailbox and only the work list is narrowed.
    #
    # Passed in rather than read here: reading the policy file from inside diff()
    # made the test suite depend on production config, and two unrelated tests
    # started failing the moment Alex held work, because their fixtures happened
    # to use that account name. A default of None keeps callers simple.
    hold = held_accounts() if hold is None else set(hold)
    held = sum(1 for e in queue if e.get("account") in hold)
    if hold:
        queue = [e for e in queue if e.get("account") not in hold]
        needs_archive = [e for e in needs_archive if e.get("account") not in hold]
    overflow = max(0, len(queue) - limit)
    shown = queue[:limit]

    return {
        "generated_at": now,
        "extract_generated_at": extract.get("updated"),
        "counts": {
            "new": len(new), "updated": len(updated), "stale": len(stale),
            "unchanged": len(unchanged), "aged_out_still_open": len(gone),
            # Aged out, still open, and judged recently enough to leave alone.
            # Reported so the number is visible: not queued is not forgotten.
            "aged_out_resting": quiet,
            # Real mail, deliberately not queued. Named so a shrinking work list
            # never reads as a shrinking backlog.
            "held": held,
            "held_accounts": sorted(hold),
            # Threads from senders Alex told the system to ignore. Counted so
            # a silence is always a number, never an absence.
            "ignored": ignored,
            # Recent mail that never reached the inbox because one of his own
            # filters archived it. Seen, counted, never judged.
            "filter_archived": by_filter,
            # Recent mail he archived himself. Judged once, knowing that.
            "hand_archived": by_hand,
            # Archiving is work too, and it is the kind nothing else recovers.
            "needs_archive": len(needs_archive),
            "settled": settled,
            # Loudly, and in the counts rather than only in a file: these are
            # threads that would otherwise have disappeared unnoticed.
            "escaped_unjudged": len(escaped),
            "with_signals": sum(1 for e in queue if e.get("signals")),
            # Named, so a short list never reads as "that is all there was".
            "not_shown": overflow,
        },
        "needs_archive": needs_archive,
        "max_judgement": limit,
        # How to drain a backlog, in the file rather than in someone's memory.
        # A work list that reports 543 hidden items and does not say what to do
        # about them is a standing invitation to assume it is stuck.
        **({"drain_with": f"python3 deploy/integrations/email-diff.py --max {len(queue)}"}
           if overflow else {}),
        "needs_judgement": [{**e, "keep_in_inbox": True} if key_of(e) in kept else e for e in queue[:limit]],
        "unchanged": unchanged,
    }


def main():
    limit = MAX_JUDGEMENT
    argv = sys.argv[1:]
    # --fresh  skip threads a previous rehearsal already showed
    # --mark   record the threads this run emits, so the next --fresh skips them
    fresh = "--fresh" in argv
    mark = "--mark" in argv
    if "--all" in argv:
        limit = 10**6
    elif "--max" in argv:
        try:
            limit = max(1, int(argv[argv.index("--max") + 1]))
        except (IndexError, ValueError):
            print("--max needs a number", file=sys.stderr)
            return 2

    extract = load(EXTRACT, None)
    if extract is None:
        print(f"no extract at {EXTRACT}", file=sys.stderr)
        return 2
    # An extract that failed carries its error and stale data. Judging it would
    # mean re-judging an old mailbox as though it were current.
    if extract.get("error"):
        print(f"extract is in error, not diffing: {extract['error']}", file=sys.stderr)
        return 2

    state = load(STATE, {})
    escaped = note_escapes(extract, state)   # reads hold + ignore itself

    reviewed = load(REVIEWED, {})
    if fresh:
        # Hide already-rehearsed threads from the EXTRACT, so every count in the
        # output describes what is left rather than what exists. A run that says
        # "80 shown, 521 not shown" while silently skipping 160 would be lying
        # about the size of the backlog.
        extract = {**extract,
                   "threads": [t for t in extract.get("threads", [])
                               if t.get("thread_id") not in reviewed]}
        escaped = [e for e in escaped if e.get("thread_id") not in reviewed]

    asked_before = load(ASKED, {})
    asked_now = {}
    out = diff(extract, state, known_people(), limit, escaped,
               asked_before=asked_before, asked_out=asked_now,
               msg_state=load(MSG_STATE, None), contacts=load_contacts_index())

    if mark:
        today = datetime.now().strftime("%Y-%m-%d %H:%M")
        for e in out["needs_judgement"]:
            reviewed.setdefault(e.get("thread_id"), today)
        REVIEWED.parent.mkdir(parents=True, exist_ok=True)
        REVIEWED.write_text(json.dumps(reviewed, indent=1, sort_keys=True) + "\n")
        print(f"  marked {len(out['needs_judgement'])} as rehearsed; "
              f"{len(reviewed)} seen in total")
    CHANGED.parent.mkdir(parents=True, exist_ok=True)
    CHANGED.write_text(json.dumps(out, indent=1) + "\n")
    os.chmod(CHANGED, 0o600)

    # Remember which aged-out debts we asked about, and forget the ones no
    # longer being asked — the file is the outstanding question, not a history.
    # A rehearsal (--mark) is a review of the backlog rather than the run the
    # job reads, so it must not move the real cadence.
    if not mark and not fresh:
        # Keep every ask that is still inside the cadence window — dropping the
        # ones we did not repeat this run would reset the clock on exactly the
        # threads the window is holding back, and the loop would come straight
        # back. Entries older than the window fall away on their own, which is
        # what lets a debt be asked about again.
        keep = {tid: v for tid, v in asked_before.items()
                if days_since((v or {}).get("at", "")) < STALE_DAYS}
        keep.update(asked_now)
        ASKED.parent.mkdir(parents=True, exist_ok=True)
        ASKED.write_text(json.dumps(keep, indent=1, sort_keys=True) + "\n")

    c = out["counts"]
    print(f"{c['new']} new, {c['updated']} updated, {c['stale']} stale, "
          f"{c['unchanged']} unchanged ({c['settled']} closed and left alone), "
          f"{c['aged_out_still_open']} aged out still open, "
          f"{c['aged_out_resting']} resting; "
          f"{c['with_signals']} carrying signals, {c['not_shown']} not shown")
    if c.get("needs_archive"):
        print(f"  {c['needs_archive']} judged thread(s) still in the inbox — "
              f"obligations included; every tier archives. See needs_archive")
    if c.get("filter_archived"):
        print(f"  {c['filter_archived']} thread(s) his own filters archived on arrival — "
              f"seen, counted, never judged")
    if c.get("hand_archived"):
        print(f"  {c['hand_archived']} thread(s) he archived by hand — judged once, "
              f"knowing he has already seen them")
    if c.get("ignored"):
        print(f"  ignoring {c['ignored']} thread(s) from senders on "
              f"integrations/ignored-senders.json — read, counted, never judged")
    if c.get("held"):
        print(f"  holding {c['held']} thread(s) from {', '.join(c['held_accounts'])} "
              f"— see integrations/google-policy.json; they are extracted and counted, "
              f"just not queued")
    if c["escaped_unjudged"]:
        print(f"  {c['escaped_unjudged']} thread(s) left the extract unjudged and are "
              f"first in the queue; see integrations/gmail-escaped.json")
    if extract.get("partial"):
        detail = "; ".join(f"{x.get('account')}: {x.get('error')}"
                           for x in extract["partial"])
        print(f"  PARTIAL EXTRACT — {detail}. Nothing is treated as disappeared "
              f"this run; escapes and aged-out are held until it is whole again.",
              file=sys.stderr)
    if out.get("drain_with"):
        print(f"  to work through the backlog in one pass: {out['drain_with']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
