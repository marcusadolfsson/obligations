#!/usr/bin/env python3
"""Tests for the call-log extractor, against a synthetic CallHistory database.

The value of this integration is one distinction — did Alex actually speak to
them, or only try — so that is what these test. Getting it wrong closes tasks he
never completed, which is worse than not having the integration at all: he would
stop trusting the list rather than stop trusting this file.

Run:  python3 deploy/integrations/call-log-extract.test.py
"""
import importlib.util
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cl", HERE / "call-log-extract.py")
cl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cl)

APPLE = datetime(2001, 1, 1, tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
def secs(h): return (now - timedelta(hours=h) - APPLE).total_seconds()

passed = failed = 0
def check(label, cond, detail=""):
    global passed, failed
    if cond: print(f"  ok   {label}"); passed += 1
    else: print(f"  FAIL {label}{(' -> ' + detail) if detail else ''}"); failed += 1

def build(path, rows):
    con = sqlite3.connect(path)
    con.execute("""CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZADDRESS,
                   ZDATE REAL, ZDURATION INTEGER, ZORIGINATED INTEGER,
                   ZANSWERED INTEGER, ZCALLTYPE INTEGER)""")
    for i, (addr, date, dur, out, ans) in enumerate(rows, 1):
        con.execute("INSERT INTO ZCALLRECORD VALUES (?,?,?,?,?,?,1)",
                    (i, addr, date, dur, out, ans))
    con.commit(); con.close()

with tempfile.TemporaryDirectory() as d:
    db = Path(d) / "CallHistory.storedata"
    build(db, [
        # spoke to them: outgoing, four minutes
        (b"+17275551234", secs(3), 240, 1, 1),
        # tried them: outgoing, rang out
        (b"+17275559999", secs(4), 0, 1, 0),
        # tried them: outgoing, "answered" but 6 seconds — voicemail beep
        (b"+17275558888", secs(5), 6, 1, 1),
        # they called, missed
        (b"+17275557777", secs(6), 0, 0, 0),
        # they called and we spoke
        (b"+17275556666", secs(7), 130, 0, 1),
        # blocked / unknown number: nothing to resolve
        (b"", secs(8), 20, 0, 1),
        # outside the window
        (b"+17275551234", secs(24 * 40), 300, 1, 1),
        # same number as a text handle, written differently
        (b"(727) 555-1234", secs(2), 90, 1, 1),
    ])
    data = cl.extract(str(db), days=14)
    h = data["by_handle"]
    k = cl.phone_key

    # 8 rows in, minus one outside the window, minus the blocked number which is
    # dropped for having no resolvable handle.
    check("calls outside the window are excluded", data["calls_total"] == 6,
          f'{data["calls_total"]} calls')
    check("a blocked/empty number is skipped", k("") not in h)

    spoke = h[k("+17275551234")]
    check("a four-minute outgoing call counts as connected", spoke["connected"] >= 1)
    check("  ...and records when we last actually spoke",
          spoke["last_connected_at"] is not None)

    tried = h[k("+17275559999")]
    check("a rang-out call is an attempt, not a conversation",
          tried["connected"] == 0 and tried["attempts"] == 1,
          "closing a task on an unanswered call is the failure that matters")

    beep = h[k("+17275558888")]
    check("a 6-second 'answered' call is not a conversation",
          beep["connected"] == 0,
          "voicemail pickup marks ZANSWERED=1; duration is the real signal")

    missed = h[k("+17275557777")]
    check("a missed incoming call is counted as missed",
          missed["missed_incoming"] == 1 and missed["connected"] == 0)

    inbound = h[k("+17275556666")]
    check("an incoming call we took counts as connected", inbound["connected"] == 1)

    check("the same number written two ways is one handle",
          h[k("+17275551234")]["attempts"] == 2,
          "the call log and Contacts format numbers differently")
    check("  ...and the key matches the contacts table's key",
          k("(727) 555-1234") == k("+17275551234"))

    outdir = [c for c in data["calls"] if c["direction"] == "out"]
    check("direction is recorded", len(outdir) == 4, f"{len(outdir)} outgoing")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
