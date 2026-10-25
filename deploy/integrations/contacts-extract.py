#!/usr/bin/env python3
"""Derive a handle → name table from the Mac's Contacts store. Runs on the Mac.

Exists so the assistant can say "Anna" where it currently says "+17275551234".
Identity resolution is the one thing that has to be shared across iMessage,
email and calendar — see rules/knowledge.md — so this produces one table that
all of them look up.

Reads macOS Contacts rather than the Google People API. If the Mac has the
Google account added, those contacts are already mirrored locally, which means
no GCP project, no consent screen, no refresh token to expire, and it reuses the
Full Disk Access grant and the scp path that already work for iMessage. If the
local store turns out to be empty this says so loudly rather than shipping an
empty table — an empty lookup fails silently, and every name would just keep
rendering as a phone number.

Deliberately narrow: names, handles, and — since 2026-09-05, at Alex's request
("get the birthdays from my contact list") — the birthday as MM-DD, year dropped.
No addresses, notes,
photos, or relationships. This lands on a cloud VM, and none of that is needed
to answer "who is this number".

Usage:  contacts-extract.py [--out PATH | --push HOST:PATH]
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path.home() / "Library/Application Support/AddressBook"


# Shared with the call-log extractor: all three sources must agree on what makes
# two numbers the same person, or identity resolution half-works silently.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from handles import phone_key, email_key  # noqa: E402


def birthday_md(val):
    """Core Data date -> "MM-DD", or None. The year is dropped on purpose."""
    if val is None:
        return None
    try:
        secs = float(val)
    except (TypeError, ValueError):
        return None
    # Apple's epoch is 2001-01-01 00:00:00 UTC; birthdays are stored at local
    # midnight, so read the date in UTC to avoid sliding a day at the boundary.
    from datetime import datetime, timedelta, timezone
    d = datetime(2001, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=secs)
    return f"{d.month:02d}-{d.day:02d}"


def read_db(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    people = {}
    # ZBIRTHDAY is Core Data seconds since 2001-01-01, or NULL. Selected in its
    # own try so a macOS whose schema lacks the column still yields names.
    try:
        rows = con.execute("""SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION,
                                     ZNICKNAME, ZBIRTHDAY
                                FROM ZABCDRECORD""").fetchall()
        has_bd = True
    except sqlite3.OperationalError:
        rows = con.execute("""SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION,
                                     ZNICKNAME
                                FROM ZABCDRECORD""").fetchall()
        has_bd = False
    for r in rows:
        name = " ".join(x for x in (r["ZFIRSTNAME"], r["ZLASTNAME"]) if x).strip()
        if not name:
            name = (r["ZNICKNAME"] or r["ZORGANIZATION"] or "").strip()
        if not name:
            continue                     # a record with no name resolves nothing
        rec = {"name": name, "handles": []}
        bd = birthday_md(r["ZBIRTHDAY"]) if has_bd else None
        if bd:
            rec["birthday"] = bd         # MM-DD only: when to call, not how old
        people[r["Z_PK"]] = rec

    for table, col, kind, keyfn in (
        ("ZABCDPHONENUMBER", "ZFULLNUMBER", "phone", phone_key),
        ("ZABCDEMAILADDRESS", "ZADDRESS", "email", email_key),
    ):
        try:
            rows = con.execute(f"SELECT ZOWNER, {col} FROM {table}")
        except sqlite3.OperationalError:
            continue                     # schema drift between macOS versions
        for r in rows:
            owner, raw = r["ZOWNER"], r[col]
            if owner not in people or not raw:
                continue
            k = keyfn(raw)
            if k:
                people[owner]["handles"].append({"raw": raw.strip(), "key": k, "kind": kind})

    con.close()
    return [p for p in people.values() if p["handles"]]


def extract():
    dbs = sorted(glob.glob(str(ROOT / "**" / "*.abcddb"), recursive=True))
    if not dbs:
        raise SystemExit(f"no Contacts database under {ROOT}")

    merged, unreadable = {}, []
    for db in dbs:
        try:
            for p in read_db(db):
                # Merge across sources: the same person is often in a local
                # address book and a Google one, and two entries would make the
                # lookup ambiguous rather than richer.
                seen = merged.setdefault(p["name"], {"name": p["name"], "handles": []})
                # Carry the birthday across the merge. read_db() reads it per
                # store, but this dict is rebuilt with name and handles only, so
                # without this every birthday is dropped between the read and
                # the file -- which is how the first run produced a byte-for-byte
                # identical contacts.json and zero birthdays from 37 that were
                # sitting in the store.
                #
                # First source that has one wins: the same person is often in a
                # local address book and a Google one, and only one of them
                # tends to carry the date.
                if p.get("birthday") and not seen.get("birthday"):
                    seen["birthday"] = p["birthday"]
                have = {(h["kind"], h["key"]) for h in seen["handles"]}
                for h in p["handles"]:
                    if (h["kind"], h["key"]) not in have:
                        seen["handles"].append(h)
                        have.add((h["kind"], h["key"]))
        except sqlite3.Error as e:
            unreadable.append(f"{db}: {e}")

    people = sorted(merged.values(), key=lambda p: p["name"])
    index = {}
    for p in people:
        for h in p["handles"]:
            # First writer wins: a key claimed by two people is ambiguous, and
            # silently overwriting would attribute messages to the wrong person.
            index.setdefault(h["key"], p["name"])

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "sources": len(dbs),
        "unreadable": unreadable,
        "people": len(people),
        "handles": sum(len(p["handles"]) for p in people),
        "index": index,          # key -> name, the thing lookups actually use
        "contacts": people,      # kept so a name can be traced back to its handles
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="-")
    ap.add_argument("--push", metavar="HOST:PATH")
    args = ap.parse_args()

    data = extract()
    if data["people"] == 0:
        print("Contacts store has no usable records — is the Google account added "
              "to Contacts on this Mac, and has it finished syncing?", file=sys.stderr)
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
        print(f"pushed {data['people']} contacts, {data['handles']} handles "
              f"to {args.push}", file=sys.stderr)
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
        print(f"{data['people']} contacts, {data['handles']} handles", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
