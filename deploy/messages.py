#!/usr/bin/env python3
"""Write a message into messages/. See rules/messages.md for the format.

Importable by the dispatcher, and usable from a shell script:

    deploy/messages.py --kind failure --title "obligations-morning failed" \
      --delivered ntfy --body-file - <<'EOF'
    ...body...
    EOF

Deliberately stdlib-only and side-effect-light: this runs inside the minute
dispatcher, where a crash would take the reminder push down with it.
"""
import argparse
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# The repo this file lives in, unless OBLIGATIONS says otherwise. It used to be
# ~/obligations, true on linuxbox and wrong on the Mac mini, where the working copy
# is ~/Developer/obligations (2026-10-01) — a test run without OBLIGATIONS read the old
# path and failed. Where the script is, is where the repo is.
OBLIGATIONS = Path(os.environ.get("OBLIGATIONS") or Path(__file__).resolve().parents[1])
MESSAGES = OBLIGATIONS / "messages"

# `prep` is a meeting-prep note from deploy/prep.mjs: who is in the room and what
# stands between you. Pushable, because its whole value is in its timing.
KINDS = ("brief", "reminder", "failure", "note", "prep", "debrief")


def _escape(value):
    """Frontmatter is hand-parsed by several readers, so keep values on one line
    and never let one close the block early."""
    return re.sub(r"\s+", " ", str(value)).replace("---", "- - -").strip()


def write_message(kind, title, body, delivered="none", when=None):
    """Create messages/<stamp>-<kind>.md and return its path.

    Never overwrites: a second message in the same minute gets a -2 suffix. The
    caller is a delivery path, so silently clobbering a record of something
    Alex was told would be the worst possible failure here.
    """
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r}; expected one of {KINDS}")

    when = when or datetime.now()
    MESSAGES.mkdir(parents=True, exist_ok=True)

    stem = when.strftime("%Y-%m-%d-%H%M") + f"-{kind}"
    path = MESSAGES / f"{stem}.md"
    n = 2
    while path.exists():
        path = MESSAGES / f"{stem}-{n}.md"
        n += 1

    path.write_text(
        "---\n"
        "type: message\n"
        f"kind: {kind}\n"
        f"at: {when.strftime('%Y-%m-%d %H:%M')}\n"
        f"title: {_escape(title)}\n"
        "read: false\n"
        f"delivered: {_escape(delivered)}\n"
        "---\n\n"
        + body.rstrip()
        + "\n"
    )
    return path


def main():
    ap = argparse.ArgumentParser(description="write a message into messages/")
    ap.add_argument("--kind", required=True, choices=KINDS)
    ap.add_argument("--title", required=True)
    ap.add_argument("--delivered", default="none")
    ap.add_argument("--body-file", default="-", help="'-' for stdin")
    args = ap.parse_args()

    body = sys.stdin.read() if args.body_file == "-" else Path(args.body_file).read_text()
    print(write_message(args.kind, args.title, body, args.delivered))


if __name__ == "__main__":
    main()
