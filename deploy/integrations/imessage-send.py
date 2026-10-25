#!/usr/bin/env python3
"""Send approved outbox drafts. Runs on the Mac, every minute via launchd.

Pulls `outbox/*.md` from the assistant over the SSH the extractor already uses,
sends anything Alex approved, and writes the receipt back. The assistant never
reaches into this Mac — the Mac asks.

Two refusals are the point of this script, not decoration:

  1. Only `status: approved` is sent. A draft the agent wrote is never sent,
     no matter what it says about itself.
  2. The recipient must already appear in a recent thread. An injected
     instruction's most likely move is "text this number", and a handle nobody
     has ever messaged Alex from is exactly the shape of that attack.

Never retries. A message that silently arrives twice is worse than one that
visibly did not arrive.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

MAX_PER_RUN = 5            # a runaway loop should not become a hundred texts
MAX_CHARS = 2000


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, timeout=60, **kw)


def parse_front(text):
    m = re.match(r"^---\n(.*?)\n---\n?", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, text[m.end():]


def known_handles(host):
    """Handles the assistant has actually seen a conversation with.

    Read from the extract the assistant already holds rather than from chat.db, so
    the allowlist is the same set of people the agent could see when it drafted
    — no wider.
    """
    r = sh(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
            "cat obligations/integrations/imessage.json"])
    if r.returncode != 0:
        return None                      # unknown, not empty — caller must refuse
    try:
        data = json.loads(r.stdout)
    except ValueError:
        return None
    handles = set()
    for t in data.get("threads", []):
        for h in t.get("participants", []):
            if h:
                handles.add(h.strip().lower())
    return handles


def normalise(handle):
    h = (handle or "").strip().lower()
    return re.sub(r"[\s()\-.]", "", h)


def send_imessage(to, text):
    """AppleScript via osascript. Text and recipient are passed as argv, never
    interpolated into the script source — a message containing a quote or a
    backslash must not be able to change what AppleScript executes."""
    script = (
        'on run argv\n'
        '  set theTo to item 1 of argv\n'
        '  set theText to item 2 of argv\n'
        '  tell application "Messages"\n'
        '    set targetService to 1st account whose service type = iMessage\n'
        '    set targetBuddy to participant theTo of targetService\n'
        '    send theText to targetBuddy\n'
        '  end tell\n'
        'end run\n'
    )
    with tempfile.NamedTemporaryFile("w", suffix=".applescript", delete=False) as f:
        f.write(script)
        path = f.name
    try:
        return sh(["osascript", path, to, text])
    finally:
        os.unlink(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="linuxbox")
    ap.add_argument("--outbox", default="obligations/outbox")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be sent, send nothing")
    args = ap.parse_args()

    listing = sh(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.host,
                  f"grep -l '^status: approved' {args.outbox}/*.md 2>/dev/null || true"])
    if listing.returncode != 0:
        print(f"cannot reach {args.host}: {listing.stderr.strip()[:200]}", file=sys.stderr)
        return 1
    files = [f for f in listing.stdout.split() if f.endswith(".md")]
    if not files:
        return 0

    allowed = known_handles(args.host)
    if allowed is None:
        print("could not read the known-handles list; refusing to send anything",
              file=sys.stderr)
        return 1

    sent = 0
    for path in files[:MAX_PER_RUN]:
        r = sh(["ssh", "-o", "BatchMode=yes", args.host, f"cat {path}"])
        if r.returncode != 0:
            continue
        meta, body = parse_front(r.stdout)
        to, text = meta.get("to", ""), body.strip()[:MAX_CHARS]

        if meta.get("status") != "approved":
            continue                                   # raced with a discard
        if not to or not text:
            fail(args.host, path, "draft has no recipient or no text", args.dry_run)
            continue
        if normalise(to) not in {normalise(h) for h in allowed}:
            # The injection case. Refuse loudly and leave it for Alex.
            fail(args.host, path,
                 f"recipient {to} is not in any recent thread; refusing to send",
                 args.dry_run)
            continue

        if args.dry_run:
            print(f"would send {len(text)} chars to {to} ({path})")
            continue

        res = send_imessage(to, text)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        if res.returncode == 0:
            mark(args.host, path, "sent", f"sent_at: {stamp}")
            print(f"sent {len(text)} chars to {to}")
            sent += 1
        else:
            fail(args.host, path, res.stderr.strip()[:200] or "osascript failed")

    return 0 if sent or args.dry_run else 0


def mark(host, path, status, extra_line):
    """Rewrite status and the receipt line, in place, on the assistant."""
    script = (
        f"sed -i 's/^status: .*/status: {status}/' {path} && "
        f"sed -i 's/^{extra_line.split(':')[0]}: .*/{extra_line}/' {path}"
    )
    sh(["ssh", "-o", "BatchMode=yes", host, script])


def fail(host, path, reason, dry=False):
    """Refuse a draft, and on a dry run refuse it without writing anything.

    `dry` is not decoration. Both refusal paths above run BEFORE the dry-run
    check, so without this a --dry-run marked drafts `failed` on the assistant: it
    rewrote the files it claimed only to report on. A dry run is exactly what
    someone reaches for when they do not yet trust the sender, and it was the
    one mode that quietly changed state.

    Found by the Swift port in Obligations.app, whose own dry run writes nothing.
    """
    safe = reason.replace("/", " ").replace("'", "").replace("\n", " ")[:180]
    if dry:
        print(f"REFUSED (dry run, not marked) {path}: {safe}", file=sys.stderr)
        return
    mark(host, path, "failed", f"error: {safe}")
    print(f"REFUSED {path}: {safe}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
