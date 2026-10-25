#!/usr/bin/env python3
"""Derive recent call history from the Mac's Continuity call log. Runs on the Mac.

Exists to close callback loops. A message thread cannot tell you that Alex
rang someone back — plenty of obligations are discharged by picking up the phone,
and without this they sit in the "waiting on you" list forever until he closes
them by hand.

**Duration is the whole signal.** A 0-second outgoing call is an attempt; a
four-minute one is a conversation. "You tried Anna" and "you spoke to Anna" are
different facts, and only one of them closes a task.

Bounded like the others, because the output lands on a cloud VM: a fixed window,
no voicemail, no audio, no location, no call content of any kind — there is none
to have. Numbers are normalised with the same key the contacts table uses, so a
call resolves to a name through the shared identity layer rather than a second
mapping of its own.

Usage:  call-log-extract.py [--out PATH | --push HOST:PATH] [--days N]
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from handles import phone_key  # noqa: E402

DB = Path.home() / "Library/Application Support/CallHistoryDB/CallHistory.storedata"
WINDOW_DAYS = 14
MAX_CALLS = 500

# Same epoch as chat.db: seconds since 2001-01-01 UTC.
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

# Below this, an answered call is a misdial or a voicemail beep rather than a
# conversation. Chosen low on purpose: the cost of calling a 20-second exchange
# a conversation is smaller than the cost of missing a real one.
CONNECTED_SECONDS = 15


def apple_time(value):
    if value is None:
        return None
    seconds = value / 1e9 if value > 1e11 else value
    return APPLE_EPOCH + timedelta(seconds=seconds)


def extract(db_path, days):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    since = (datetime.now(timezone.utc) - timedelta(days=days) - APPLE_EPOCH).total_seconds()

    try:
        rows = con.execute(
            """SELECT ZADDRESS, ZDATE, ZDURATION, ZORIGINATED, ZANSWERED, ZCALLTYPE
                 FROM ZCALLRECORD
                WHERE ZDATE > ?
                ORDER BY ZDATE DESC""", (since,)).fetchall()
    except sqlite3.OperationalError as e:
        con.close()
        raise SystemExit(f"unexpected call log schema: {e}")

    calls, by_handle = [], {}
    now = datetime.now().astimezone()

    for r in rows[:MAX_CALLS]:
        when = apple_time(r["ZDATE"])
        if when is None:
            continue
        key = phone_key(r["ZADDRESS"])
        if not key:
            continue                       # blocked/unknown caller: nothing to resolve

        duration = int(r["ZDURATION"] or 0)
        outgoing = bool(r["ZORIGINATED"])
        connected = duration >= CONNECTED_SECONDS
        local = when.astimezone()

        calls.append({
            "at": local.strftime("%Y-%m-%d %H:%M"),
            "key": key,
            "direction": "out" if outgoing else "in",
            "answered": bool(r["ZANSWERED"]),
            "duration_s": duration,
            "connected": connected,
        })

        h = by_handle.setdefault(key, {
            "last_at": None, "last_connected_at": None,
            "connected": 0, "attempts": 0, "missed_incoming": 0,
        })
        if h["last_at"] is None:
            h["last_at"] = calls[-1]["at"]     # rows are newest first
        h["attempts"] += 1
        if connected:
            h["connected"] += 1
            if h["last_connected_at"] is None:
                h["last_connected_at"] = calls[-1]["at"]
        elif not outgoing:
            h["missed_incoming"] += 1

    con.close()
    return {
        "generated_at": now.strftime("%Y-%m-%d %H:%M"),
        "host": os.uname().nodename,
        "window_days": days,
        "connected_threshold_s": CONNECTED_SECONDS,
        "calls_total": len(calls),
        "handles": len(by_handle),
        "by_handle": by_handle,     # the cheap lookup: did we actually speak?
        "calls": calls,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DB))
    ap.add_argument("--days", type=int, default=WINDOW_DAYS)
    ap.add_argument("--out", default="-")
    ap.add_argument("--push", metavar="HOST:PATH")
    args = ap.parse_args()

    if not Path(args.db).exists():
        print(f"no call history at {args.db} — is Continuity calling enabled on "
              "this Mac?", file=sys.stderr)
        return 2
    try:
        data = extract(args.db, args.days)
    except sqlite3.OperationalError as e:
        print(f"cannot read {args.db}: {e}\n"
              "If this says 'authorization denied', the process needs Full Disk "
              "Access (System Settings > Privacy & Security).", file=sys.stderr)
        return 3

    text = json.dumps(data, indent=1, ensure_ascii=False)

    if args.push:
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write(text + "\n")
            tmp = f.name
        os.chmod(tmp, 0o600)
        try:
            r = subprocess.run(["scp", "-q", "-o", "ConnectTimeout=10",
                                "-o", "BatchMode=yes", tmp, args.push],
                               capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                print(f"scp failed: {r.stderr.strip()[:200]}", file=sys.stderr)
                return 4
        finally:
            os.unlink(tmp)
        print(f"pushed {data['calls_total']} calls across {data['handles']} numbers",
              file=sys.stderr)
        return 0

    if args.out == "-":
        print(text)
    else:
        out = Path(args.out)
        out.write_text(text + "\n")
        # Only a regular file we just created. This output is personal data and
        # normally must not be world-readable — but /dev/null and /dev/stdout
        # are legitimate destinations for a probe, and chmod on a device node
        # fails with EPERM. Failing there killed the installer's check for both
        # this and the call log, so neither ever installed and the reason given
        # was a Contacts problem that did not exist.
        if out.is_file():
            os.chmod(out, 0o600)
        print(f"{data['calls_total']} calls, {data['handles']} numbers", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
