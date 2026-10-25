#!/usr/bin/env python3
"""Tests for imessage-extract.py against a synthetic chat.db.

Builds a database with Apple's real schema and column semantics — nanosecond
timestamps, NULL `text` with the body in `attributedBody`, group vs DM styles —
and asserts the extractor's output. This exists so the extractor is proven
before it is ever pointed at Alex's actual messages: there is no safe way to
iterate on that file, and a silent miss (every modern message reading as empty
because attributedBody was ignored) would look exactly like a quiet week.

Run:  python3 deploy/integrations/imessage-extract.test.py
"""
import importlib.util
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ext", HERE / "imessage-extract.py")
ext = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ext)

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)


def apple_ns(dt):
    return int((dt - APPLE_EPOCH).total_seconds() * 1e9)


def apple_s(dt):
    return int((dt - APPLE_EPOCH).total_seconds())


def attributed(text):
    """A minimal NSKeyedArchiver-shaped blob of the form the decoder expects."""
    body = text.encode()
    return b"\x04\x0bstreamtypedNSString" + b"\x01\x94\x84\x01+" + bytes([len(body)]) + body


def build(path):
    con = sqlite3.connect(path)
    con.executescript("""
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT,
                         display_name TEXT, style INTEGER, service_name TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
                            attributedBody BLOB, handle_id INTEGER, date INTEGER,
                            is_from_me INTEGER, service TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    """)
    now = datetime.now(timezone.utc)

    con.execute("INSERT INTO handle VALUES (1, '+15551110000', 'iMessage')")
    con.execute("INSERT INTO handle VALUES (2, 'jo@icloud.com', 'iMessage')")
    con.execute("INSERT INTO chat VALUES (1,'g-dm','+15551110000',NULL,45,'iMessage')")
    con.execute("INSERT INTO chat VALUES (2,'g-grp','chat999','Trip planning',43,'iMessage')")
    con.execute("INSERT INTO chat VALUES (3,'g-old','+15559998888',NULL,45,'iMessage')")
    con.executemany("INSERT INTO chat_handle_join VALUES (?,?)",
                    [(1, 1), (2, 1), (2, 2)])

    rows = [
        # DM: they spoke last and are waiting — nanosecond timestamps, NULL text.
        (1, None, attributed("can you send the flight dates?"), 1, apple_ns(now - timedelta(hours=26)), 0, 1),
        (2, "will dig them out", None, 1, apple_ns(now - timedelta(hours=30)), 1, 1),
        # Group: Alex spoke last, so nothing is owed.
        (3, None, attributed("who is booking the car"), 2, apple_ns(now - timedelta(hours=5)), 0, 2),
        (4, "I'll do it tomorrow", None, None, apple_ns(now - timedelta(hours=4)), 1, 2),
        # Old-style second-resolution timestamp, still inside the window.
        (5, "old format still parses", None, 1, apple_s(now - timedelta(days=2)), 0, 1),
        # Outside the window entirely.
        (6, "ancient history", None, 1, apple_ns(now - timedelta(days=90)), 0, 3),
        # A tapback / attachment row: no text anywhere. Must be skipped, not blank.
        (7, None, None, 1, apple_ns(now - timedelta(hours=1)), 0, 1),
        # Over-long message, to prove the cap. From me and earlier than the
        # group's last message, so it exercises truncation without changing who
        # spoke last.
        (8, "x" * 4000, None, None, apple_ns(now - timedelta(hours=6)), 1, 2),
    ]
    for mid, text, blob, handle, date, from_me, chat in rows:
        con.execute("INSERT INTO message VALUES (?,?,?,?,?,?,?,'iMessage')",
                    (mid, f"m{mid}", text, blob, handle, date, from_me))
        con.execute("INSERT INTO chat_message_join VALUES (?,?)", (chat, mid))
    con.commit()
    con.close()


passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        print(f"  ok   {label}")
        passed += 1
    else:
        print(f"  FAIL {label}{(' -> ' + detail) if detail else ''}")
        failed += 1


with tempfile.TemporaryDirectory() as d:
    db = Path(d) / "chat.db"
    build(db)
    data = ext.extract(str(db), days=14)
    threads = {t["chat_id"]: t for t in data["threads"]}

    check("old thread outside the window is excluded", "g-old" not in threads,
          f"got {sorted(threads)}")
    check("DM and group both present", {"g-dm", "g-grp"} <= set(threads))

    dm = threads.get("g-dm", {})
    check("attributedBody decoded (NULL text)",
          any(m["text"] == "can you send the flight dates?" for m in dm.get("messages", [])),
          str([m["text"][:40] for m in dm.get("messages", [])]))
    check("second-resolution timestamp parsed",
          any(m["text"] == "old format still parses" for m in dm.get("messages", [])))
    check("empty tapback/attachment row skipped",
          all(m["text"].strip() for m in dm.get("messages", [])))
    check("DM flagged as awaiting a reply",
          dm.get("awaiting_reply_hours") is not None and dm["awaiting_reply_hours"] > 20,
          str(dm.get("awaiting_reply_hours")))
    check("DM not marked as a group", dm.get("is_group") is False)
    check("participants resolved", dm.get("participants") == ["+15551110000"],
          str(dm.get("participants")))

    grp = threads.get("g-grp", {})
    check("group flagged as group", grp.get("is_group") is True)
    check("group where I spoke last owes nothing",
          grp.get("awaiting_reply_hours") is None, str(grp.get("awaiting_reply_hours")))

    # The mirror. Without it, everything Alex is waiting on is invisible by
    # construction: only threads where someone else spoke last were surfaced.
    check("a thread where he spoke last records how long nobody has answered",
          grp.get("no_answer_hours") is not None and grp["no_answer_hours"] > 0,
          str(grp.get("no_answer_hours")))
    check("  ...and a thread waiting on him does not",
          dm.get("no_answer_hours") is None, str(dm.get("no_answer_hours")))
    check("group display name used", grp.get("name") == "Trip planning", str(grp.get("name")))
    check("long message truncated",
          all(len(m["text"]) <= ext.MAX_CHARS for m in grp.get("messages", [])))

    check("summary counts correct",
          data["thread_count"] == 2 and data["awaiting_reply"] == 1
          and data["no_answer"] == 1,
          f"threads={data['thread_count']} awaiting={data['awaiting_reply']}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
