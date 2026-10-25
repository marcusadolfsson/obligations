#!/bin/bash
# One-shot setup for the iMessage sync. Run this ON THE MAC (the Studio — it's
# the one that stays awake).
#
#   bash ~/obligations/deploy/integrations/install-mac.sh
#
# Checks each prerequisite and stops with a specific instruction rather than a
# stack trace. Safe to re-run: it reinstalls the launchd agent in place.
set -uo pipefail

OBLIGATIONS_HOST="${OBLIGATIONS_HOST:-linuxbox}"
REPO="${REPO:-$HOME/obligations}"
PLIST="$HOME/Library/LaunchAgents/com.example.obligations.imessage.plist"
DB="$HOME/Library/Messages/chat.db"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
die()  { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "This is the Mac half. Run it on the Mac Studio."

say "1/6  Repo"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --quiet --ff-only 2>/dev/null && ok "updated $REPO" || ok "$REPO present (pull skipped)"
else
  git clone --quiet "$OBLIGATIONS_HOST:vault.git" "$REPO" \
    && ok "cloned to $REPO" \
    || die "clone failed. Fix SSH first: ssh $OBLIGATIONS_HOST true"
fi

say "2/6  SSH to the assistant"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$OBLIGATIONS_HOST" true 2>/dev/null \
  && ok "ssh $OBLIGATIONS_HOST works without a password" \
  || die "ssh $OBLIGATIONS_HOST needs a password or failed.
     Create a key if you have none:   ssh-keygen -t ed25519
     Then authorise it:               ssh-copy-id $OBLIGATIONS_HOST
     (BatchMode is required — launchd cannot type a passphrase.)"

say "3/6  Full Disk Access"
[ -f "$DB" ] || die "no chat.db at $DB — is Messages set up on this Mac?"
if /usr/bin/python3 - "$DB" <<'PY' 2>/dev/null
import sqlite3, sys
sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True).execute("SELECT 1 FROM message LIMIT 1")
PY
then
  ok "/usr/bin/python3 can read chat.db"
else
  if [ -n "${SSH_CONNECTION:-}" ]; then
    die "cannot read chat.db, and you are over SSH — that is almost certainly why.

     macOS attributes Full Disk Access to the RESPONSIBLE process, not to the
     binary you listed. Over SSH the responsible process is sshd, so granting
     it to python3 changes nothing here even though the checkbox is on.

     Either:
       (a) Run this from a Terminal window on the Mac itself. Recommended —
           Terminal.app becomes the responsible process, and you may already
           have granted it.
       (b) Add /usr/sbin/sshd to Full Disk Access and open a NEW ssh session
           (TCC is decided when the connection is made). Weigh this: anyone who
           can ssh to this Mac then inherits full disk access.

     The launchd agent is unaffected either way — it runs /usr/bin/python3
     directly, so the grant you already made is the one that counts there."
  fi
  die "/usr/bin/python3 cannot read chat.db (macOS TCC).
     System Settings > Privacy & Security > Full Disk Access > + > /usr/bin/python3
     (Press Cmd-Shift-G in the file picker and paste that path.)
     Then re-run this script.

     If it is already listed and still failing, check which python you have:
       which -a python3
     The grant is per-binary, and a Homebrew or pyenv python3 earlier on your
     PATH is a different binary from /usr/bin/python3."
fi

say "4/6  Extract once, by hand"
OUT="$(mktemp -t imessage)"
/usr/bin/python3 "$REPO/deploy/integrations/imessage-extract.py" --out "$OUT" \
  || die "extract failed — see the error above"
/usr/bin/python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"  ✓ {d['thread_count']} threads in the last {d['window_days']} days, "
      f"{d['awaiting_reply']} awaiting your reply")
for t in sorted((t for t in d["threads"] if t["awaiting_reply_hours"]),
                key=lambda t: -t["awaiting_reply_hours"])[:3]:
    print(f"      {t['awaiting_reply_hours']:>6.1f}h  {t['name']}")
PY
rm -f "$OUT"

say "5/6  Install the 15-minute timer"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# /usr/bin/python3 is a shim (com.apple.dt.xcode_select.tool-shim-public) that
# execs the real interpreter (com.apple.python3) at a versioned path. Those are
# different code identities, so a Full Disk Access grant dragged in as
# "/usr/bin/python3" may be inert for the binary that actually reads chat.db.
# Resolve it once here and put the real path in the plist, so the binary launchd
# runs is the same one the grant can name.
REAL_PY="$(/usr/bin/python3 -c 'import sys; print(sys.executable)')"
[ -x "$REAL_PY" ] || REAL_PY=/usr/bin/python3
# The plist keeps the unresolved path: it survives a CommandLineTools upgrade,
# where a version-pinned one would silently point at a binary that no longer
# exists. But the Full Disk Access panel refuses symlinks, so the path a human
# has to drag in is the fully resolved one. They are usually different.
GRANT_PY="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.executable))')"
ok "launchd will run: $REAL_PY"
[ "$GRANT_PY" = "$REAL_PY" ] || ok "if a grant is needed, it must name: $GRANT_PY"

sed -e "s|__HOME__|$HOME|g" -e "s|__PYTHON__|$REAL_PY|g" \
    "$REPO/deploy/integrations/com.example.obligations.imessage.plist" > "$PLIST"
LOG="$HOME/Library/Logs/obligations-imessage.log"
# Byte offset BEFORE starting. The log is append-only and keeps every
# historical failure, so grepping the whole file reports a denial from
# before the grant as if it were now — which is exactly the false alarm
# this check raised the first time it ran.
LOG_WAS=$(wc -c < "$LOG" 2>/dev/null || echo 0)

launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST" || die "launchctl load failed"
launchctl start com.example.obligations.imessage
ok "loaded com.example.obligations.imessage"

# The interactive check above passed under THIS terminal's grant. The scheduled
# run is a different responsible process, so prove it separately rather than
# assuming — a silent daily failure is exactly what this integration must not do.
say "5b/6  Prove the scheduled run can read chat.db too"
sleep 8

# The authoritative signal is a fresh extract on the assistant, not text in a log:
# the run either produced one or it did not. The log is consulted only to
# explain a failure, and only the bytes this run wrote.
FRESH=$(ssh -o BatchMode=yes "$OBLIGATIONS_HOST" \
  "/usr/bin/python3 -c 'import json,datetime
try:
    d=json.load(open(\"obligations/integrations/imessage.json\"))
    g=datetime.datetime.strptime(d[\"generated_at\"],\"%Y-%m-%d %H:%M\")
    print(int((datetime.datetime.now()-g).total_seconds()//60))
except Exception:
    print(99999)'" 2>/dev/null || echo 99999)

if [ "${FRESH:-99999}" -le 5 ]; then
  ok "the scheduled run produced a fresh extract (${FRESH} min old)"
elif tail -c "+$((LOG_WAS + 1))" "$LOG" 2>/dev/null | grep -qi "authorization denied"; then
  die "the launchd run was denied by TCC, even though the interactive check passed.

     This is the shim-vs-real-binary trap. Grant Full Disk Access to exactly:
       $GRANT_PY
     (Fully resolved on purpose — the FDA panel rejects symlinks, so the
     shorter path will not add.)
     System Settings > Privacy & Security > Full Disk Access > + >
     Cmd-Shift-G > paste that path.

     Then re-run this script."
else
  die "the scheduled run produced no fresh extract (newest is ${FRESH} min old).
     What this run logged:
$(tail -c "+$((LOG_WAS + 1))" "$LOG" 2>/dev/null | sed 's/^/       /' | tail -10)"
fi

say "5c/6  Install the outbox sender (every minute)"
SEND_PLIST="$HOME/Library/LaunchAgents/com.example.obligations.imessage-send.plist"
sed -e "s|__HOME__|$HOME|g" -e "s|__PYTHON__|$REAL_PY|g" \
    "$REPO/deploy/integrations/com.example.obligations.imessage-send.plist" > "$SEND_PLIST"
launchctl unload "$SEND_PLIST" 2>/dev/null
launchctl load "$SEND_PLIST" || die "launchctl load failed for the sender"
ok "loaded com.example.obligations.imessage-send"
ok "the first approved draft triggers a one-time Automation prompt for Messages.app"

say "5d/6  Install the contacts sync (every 6 hours)"
CONTACTS_PLIST="$HOME/Library/LaunchAgents/com.example.obligations.contacts.plist"
PROBE="$(mktemp -t obligations-probe)"
if /usr/bin/python3 "$REPO/deploy/integrations/contacts-extract.py" --out "$PROBE" 2>&1 \
   && [ -s "$PROBE" ]; then
  sed -e "s|__HOME__|$HOME|g" -e "s|__PYTHON__|$REAL_PY|g" \
      "$REPO/deploy/integrations/com.example.obligations.contacts.plist" > "$CONTACTS_PLIST"
  launchctl unload "$CONTACTS_PLIST" 2>/dev/null
  launchctl load "$CONTACTS_PLIST" || die "launchctl load failed for contacts"
  ok "loaded com.example.obligations.contacts"
else
  # Silence here was the bug: this step used to skip with no message at all,
  # so "the installer finished" and "contacts are syncing" looked identical.
  ok "SKIPPED — the local Contacts store has no usable records."
  ok "  Add the Google account under System Settings > Internet Accounts with"
  ok "  Contacts enabled, let it sync, then re-run this script."
  ok "  Until then the brief shows phone numbers where it should show names."
  ok "  The actual error:"
  ok "    /usr/bin/python3 $REPO/deploy/integrations/contacts-extract.py --out - | head"
fi
rm -f "$PROBE"          # it is a dump of his address book; do not leave it in /tmp

say "5e/6  Install the call-history sync (every 30 minutes)"
CALLS_PLIST="$HOME/Library/LaunchAgents/com.example.obligations.calls.plist"
PROBE="$(mktemp -t obligations-probe)"
if /usr/bin/python3 "$REPO/deploy/integrations/call-log-extract.py" --out "$PROBE" 2>&1 \
   && [ -s "$PROBE" ]; then
  sed -e "s|__HOME__|$HOME|g" -e "s|__PYTHON__|$REAL_PY|g" \
      "$REPO/deploy/integrations/com.example.obligations.calls.plist" > "$CALLS_PLIST"
  launchctl unload "$CALLS_PLIST" 2>/dev/null
  launchctl load "$CALLS_PLIST" || die "launchctl load failed for calls"
  ok "loaded com.example.obligations.calls"
else
  # This branch used to print the *contacts* message, which sent you to
  # Internet Accounts for a problem that lives in FaceTime and Full Disk Access.
  ok "SKIPPED — no readable call history."
  ok "  Needs BOTH: Continuity calling on (FaceTime > Settings > Calls from"
  ok "  iPhone), and Full Disk Access for the same python3 step 3 authorised —"
  ok "  CallHistory.storedata is protected separately from chat.db."
  ok "  Until then a callback you made by phone will not close the task that"
  ok "  asked for it."
  ok "  The actual error:"
  ok "    /usr/bin/python3 $REPO/deploy/integrations/call-log-extract.py --out - | head"
fi
rm -f "$PROBE"

say "6/6  Confirm it landed on the assistant"
sleep 5
# Existence alone would pass on a file some earlier run left behind; 5b is what
# proves it is current.
ssh "$OBLIGATIONS_HOST" 'test -f obligations/integrations/imessage.json' 2>/dev/null \
  && ok "$OBLIGATIONS_HOST has obligations/integrations/imessage.json (proven fresh in 5b)" \
  || die "nothing arrived. Check: tail -20 $LOG"

printf '\n\033[1mDone.\033[0m Tomorrow'"'"'s 07:00 brief will include who is waiting on you.\n'
printf 'Logs: ~/Library/Logs/obligations-imessage.log\n'
printf 'Stop it any time: launchctl unload %s\n\n' "$PLIST"
