#!/usr/bin/env python3
"""Derive a bounded view of iMessage threads from chat.db. Runs on the Mac.

Answers one question: which conversations are waiting on Alex, and what was
being discussed. Nothing else. It never writes to chat.db, never sends anything,
and never copies the database itself.

Deliberately bounded, because the output leaves the Mac. Only the last
WINDOW_DAYS of conversation, only MAX_MESSAGES per thread, only MAX_CHARS per
message. A thread nobody has spoken in for a fortnight is not something the
morning brief needs, and the smaller this file is, the less there is to regret.

Usage:  imessage-extract.py [--db PATH] [--out PATH] [--days N]
Stdlib only — macOS ships python3 and this should not need a venv to survive.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

WINDOW_DAYS = 14
MAX_MESSAGES = 40          # per thread, newest kept
MAX_CHARS = 500            # per message
MAX_THREADS = 200

# chat.db timestamps are seconds (older macOS) or nanoseconds (newer) since
# 2001-01-01 UTC. Detect by magnitude rather than by OS version.
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)


def apple_time(value):
    if not value:
        return None
    seconds = value / 1e9 if value > 1e11 else value
    return APPLE_EPOCH + timedelta(seconds=seconds)


def decode_attributed_body(blob):
    """Recover text from the NSKeyedArchiver blob.

    Modern macOS leaves `message.text` NULL and puts the body in
    `attributedBody`. Without this, a large share of recent messages read as
    empty — which would look like working code producing a thin result, the
    worst kind of bug. This is a heuristic over the archive format, not a real
    parser, so every failure returns None rather than garbage.
    """
    if not blob:
        return None
    try:
        chunk = blob.split(b"NSString")[1][5:]
        if chunk[0] == 0x81:                       # 2-byte length prefix
            length = int.from_bytes(chunk[1:3], "little")
            chunk = chunk[3:]
        else:
            length = chunk[0]
            chunk = chunk[1:]
        text = chunk[:length].decode("utf-8", errors="replace").strip()
        return text or None
    except Exception:                              # noqa: BLE001
        return None


def extract(db_path, days):
    # Read-only URI so a bug here can never damage the real message store.
    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row

    since = datetime.now(timezone.utc) - timedelta(days=days)
    since_apple = (since - APPLE_EPOCH).total_seconds()

    rows = con.execute(
        """
        SELECT c.guid          AS chat_guid,
               c.chat_identifier,
               c.display_name,
               c.style         AS chat_style,
               m.ROWID         AS mid,
               m.text,
               m.attributedBody,
               m.is_from_me,
               m.date,
               h.id            AS handle
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          JOIN chat c                ON c.ROWID = cmj.chat_id
          LEFT JOIN handle h         ON h.ROWID = m.handle_id
         WHERE (m.date / CASE WHEN m.date > 100000000000 THEN 1000000000 ELSE 1 END) > ?
         ORDER BY m.date ASC
        """,
        (since_apple,),
    ).fetchall()

    participants = {}
    for r in con.execute(
        """SELECT c.guid AS chat_guid, h.id AS handle
             FROM chat c
             JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
             JOIN handle h             ON h.ROWID = chj.handle_id"""
    ):
        participants.setdefault(r["chat_guid"], []).append(r["handle"])

    threads = {}
    for r in rows:
        text = r["text"] or decode_attributed_body(r["attributedBody"])
        if not text:
            continue                                # attachments, tapbacks, edits
        when = apple_time(r["date"])
        if when is None:
            continue

        t = threads.setdefault(
            r["chat_guid"],
            {
                "chat_id": r["chat_guid"],
                "name": r["display_name"] or r["chat_identifier"],
                "is_group": r["chat_style"] == 43,
                "participants": sorted(set(participants.get(r["chat_guid"], []))),
                "messages": [],
            },
        )
        t["messages"].append({
            "at": when.astimezone().strftime("%Y-%m-%d %H:%M"),
            "from_me": bool(r["is_from_me"]),
            "who": "me" if r["is_from_me"] else (r["handle"] or "them"),
            "text": text[:MAX_CHARS],
        })

    now = datetime.now().astimezone()
    out = []
    for t in threads.values():
        t["messages"] = t["messages"][-MAX_MESSAGES:]
        last = t["messages"][-1]
        t["last_at"] = last["at"]
        t["last_from_me"] = last["from_me"]
        # The whole point of the file: how long someone has been waiting, in
        # whichever direction. Both are computed here and neither is judged —
        # "the last word was not his" and "he owes a reply" are different
        # claims, and only the agent gets to make the second one.
        delta = now - datetime.strptime(last["at"], "%Y-%m-%d %H:%M").astimezone()
        hours = round(delta.total_seconds() / 3600, 1)
        if last["from_me"]:
            t["awaiting_reply_hours"] = None
            # The mirror: he spoke last and nobody came back. Without this,
            # everything he is *waiting on* is invisible by construction — the
            # only threads ever surfaced were the ones where someone else had
            # the last word, so "waiting on others" could never be populated.
            t["no_answer_hours"] = hours
        else:
            t["awaiting_reply_hours"] = hours
            t["no_answer_hours"] = None
        out.append(t)

    out.sort(key=lambda t: t["last_at"], reverse=True)
    con.close()
    return {
        "generated_at": now.strftime("%Y-%m-%d %H:%M"),
        "host": os.uname().nodename,
        "window_days": days,
        "thread_count": len(out),
        "awaiting_reply": sum(1 for t in out if t["awaiting_reply_hours"] is not None),
        "no_answer": sum(1 for t in out if t.get("no_answer_hours") is not None),
        "threads": out[:MAX_THREADS],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(Path.home() / "Library/Messages/chat.db"))
    ap.add_argument("--out", default="-", help="'-' for stdout")
    ap.add_argument("--days", type=int, default=WINDOW_DAYS)
    ap.add_argument("--push", metavar="HOST:PATH",
                    help="scp the extract to the assistant and delete the local copy")
    args = ap.parse_args()

    if not Path(args.db).exists():
        print(f"no chat.db at {args.db}", file=sys.stderr)
        return 2
    try:
        data = extract(args.db, args.days)
    except sqlite3.OperationalError as e:
        # Overwhelmingly the Full Disk Access case; say so instead of a traceback.
        print(f"cannot read {args.db}: {e}\n"
              "If this says 'authorization denied', grant Full Disk Access to the "
              "program running this (System Settings > Privacy & Security).",
              file=sys.stderr)
        return 3

    text = json.dumps(data, indent=1, ensure_ascii=False)

    if args.push:
        # Done here rather than in a shell wrapper so launchd runs python3
        # directly. macOS attributes Full Disk Access to the process it
        # launches, so a bash wrapper would need its own grant — and granting
        # /bin/bash full disk access is a far wider thing to hand out than
        # granting it to one interpreter.
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write(text + "\n")
            tmp = f.name
        os.chmod(tmp, 0o600)
        try:
            r = subprocess.run(
                ["scp", "-q", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes",
                 tmp, args.push],
                capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                # Leave whatever is already on the assistant alone: stale data it can
                # date beats no data, and the brief reports the staleness itself.
                print(f"scp to {args.push} failed: {r.stderr.strip()[:200]}", file=sys.stderr)
                return 4
        finally:
            os.unlink(tmp)
        print(f"pushed {data['thread_count']} threads "
              f"({data['awaiting_reply']} awaiting) to {args.push}", file=sys.stderr)
        return 0

    if args.out == "-":
        print(text)
    else:
        p = Path(args.out)
        p.write_text(text + "\n")
        os.chmod(p, 0o600)          # other people's messages; not world-readable
        print(f"{p}: {data['thread_count']} threads, "
              f"{data['awaiting_reply']} awaiting a reply", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
