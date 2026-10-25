#!/usr/bin/env python3
"""Tests for the contacts extractor, against a synthetic AddressBook database.

The failure that matters here is silent. If phone-number normalisation is wrong,
the table builds fine, looks fine, and resolves nothing — every name keeps
rendering as a raw number and it looks like Alex simply has no contacts. So
the matching keys are what these tests are mostly about.

Run:  python3 deploy/integrations/contacts-extract.test.py
"""
import importlib.util
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cx", HERE / "contacts-extract.py")
cx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cx)

passed = failed = 0
def check(label, cond, detail=""):
    global passed, failed
    if cond:
        print(f"  ok   {label}"); passed += 1
    else:
        print(f"  FAIL {label}{(' -> ' + detail) if detail else ''}"); failed += 1


def build(path, rows):
    con = sqlite3.connect(path)
    con.executescript("""
      CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT,
                                ZLASTNAME TEXT, ZORGANIZATION TEXT, ZNICKNAME TEXT);
      CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER,
                                     ZFULLNUMBER TEXT);
      CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER,
                                      ZADDRESS TEXT);
    """)
    for pk, first, last, org, nick, phones, emails in rows:
        con.execute("INSERT INTO ZABCDRECORD VALUES (?,?,?,?,?)", (pk, first, last, org, nick))
        for ph in phones:
            con.execute("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?,?)", (pk, ph))
        for em in emails:
            con.execute("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?,?)", (pk, em))
    con.commit(); con.close()


# --- the part that decides whether any of this works ------------------------
print("Phone matching")
check("US number written three ways collapses to one key",
      cx.phone_key("+17275551234") == cx.phone_key("(727) 555-1234") == cx.phone_key("727-555-1234"),
      f'{cx.phone_key("+17275551234")} / {cx.phone_key("(727) 555-1234")} / {cx.phone_key("727-555-1234")}')
check("an iMessage-style handle matches a Contacts-style one",
      cx.phone_key("+17275551234") == cx.phone_key("727.555.1234"))
check("different numbers do not collide",
      cx.phone_key("+17275551234") != cx.phone_key("+17275551235"))
check("a short number is not padded into a false match",
      cx.phone_key("911") == "911")
check("empty and junk yield no key",
      cx.phone_key("") is None and cx.phone_key("---") is None)
check("email matching is case and whitespace insensitive",
      cx.email_key("  Anna@Example.COM ") == cx.email_key("anna@example.com"))

print("\nExtraction")
with tempfile.TemporaryDirectory() as d:
    db = Path(d) / "AddressBook-v22.abcddb"
    build(db, [
        (1, "Anna", "Rivera", None, None, ["+1 (727) 555-1234"], ["anna@example.com"]),
        (2, None, None, "Acme Plumbing", None, ["7275559999"], []),          # org-only name
        (3, None, None, None, "Bee", ["+447700900123"], []),                 # nickname, intl
        (4, "NoHandles", "Person", None, None, [], []),                      # must be dropped
        (5, "Blank", "Number", None, None, ["   "], []),                     # junk handle
    ])
    people = cx.read_db(str(db))
    names = {p["name"] for p in people}

    check("a normal contact is extracted", "Anna Rivera" in names)
    check("an organisation-only record still gets a name", "Acme Plumbing" in names)
    check("a nickname is used when there is no real name", "Bee" in names)
    check("a contact with no handles is dropped", "NoHandles Person" not in names,
          "it can never resolve anything, so it is noise in the table")
    check("a junk handle does not create a phantom contact", "Blank Number" not in names)

    anna = next(p for p in people if p["name"] == "Anna Rivera")
    keys = {h["key"] for h in anna["handles"]}
    check("Anna is reachable by her iMessage handle",
          cx.phone_key("+17275551234") in keys, str(keys))
    check("Anna is reachable by email", "anna@example.com" in keys)
    check("an international number keeps its full digits",
          any(h["key"] == "7700900123" for p in people for h in p["handles"]))

print("\nMerging and ambiguity")
with tempfile.TemporaryDirectory() as d:
    root = Path(d) / "Sources"
    (root / "A").mkdir(parents=True); (root / "B").mkdir(parents=True)
    build(root / "A" / "AddressBook-v22.abcddb",
          [(1, "Anna", "Rivera", None, None, ["+17275551234"], [])])
    build(root / "B" / "AddressBook-v22.abcddb",
          [(1, "Anna", "Rivera", None, None, ["(727) 555-1234"], ["anna@example.com"]),
           (2, "Someone", "Else", None, None, ["+17275551234"], [])])   # claims Anna's number

    cx.ROOT = Path(d)
    data = cx.extract()
    check("the same person across two address books becomes one entry",
          data["people"] == 2, f"{data['people']} people")
    anna = next(p for p in data["contacts"] if p["name"] == "Anna Rivera")
    check("  ...merging her handles rather than duplicating her",
          len(anna["handles"]) == 2, str(anna["handles"]))
    check("a handle claimed by two people resolves to the first, not the last",
          data["index"][cx.phone_key("+17275551234")] == "Anna Rivera",
          "silently overwriting would attribute messages to the wrong person")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
