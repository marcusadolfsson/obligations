#!/usr/bin/env bash
#
# Connect Gmail, once.
#
# Run this on a machine with a browser — your Mac, not the server — then copy
# the one file it produces up to linuxbox. The consent screen needs a browser and
# the server does not have one.
#
# What you end up with: the assistant can read your mail, file and archive it, stage
# drafts, and — from the chat, with you approving each one — send.
#
# It cannot spam, delete, or create a filter anywhere, and it cannot send from a
# scheduled job at all: sending falls through to the permission prompt, which
# has nobody to ask at 07:00 and refuses. Note the difference from read-only:
# these tools EXIST and are stopped by the deny list, the permission prompt and
# clamped rate limits, rather than not being registered. .mcp.json explains the
# layers; `node deploy/mcp-check.mjs` verifies them against the running server.
#
#   ./deploy/integrations/install-gmail.sh
#
set -euo pipefail

# --account=NAME connects a second mailbox. This server has no multi-account
# support -- every call is userId:"me" -- so each mailbox is a separate server
# instance with its own credentials, and NAME is what its tools get prefixed
# with (mcp__NAME__search_emails). Keep it short and say whose it is: `phoa`,
# `plugco`. The default, `gmail`, is the mailbox already connected.
ACCOUNT="gmail"
for arg in "$@"; do
  case "$arg" in
    --account=*) ACCOUNT="${arg#--account=}" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
case "$ACCOUNT" in
  [a-z][a-z0-9_]*) ;;
  *) echo "--account must start with a letter and use only [a-z0-9_]: got '$ACCOUNT'" >&2; exit 2 ;;
esac

OBLIGATIONS="${OBLIGATIONS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
if [ "$ACCOUNT" = "gmail" ]; then
  STATE="$OBLIGATIONS/deploy/gmail-state"
else
  STATE="$OBLIGATIONS/deploy/gmail-state-$ACCOUNT"
fi
KEYS="$STATE/gcp-oauth.keys.json"
SERVER="@klodr/gmail-mcp@1.3.3"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

mkdir -p "$STATE"
chmod 700 "$STATE"

[ "$ACCOUNT" = "gmail" ] || say "Connecting a second mailbox: $ACCOUNT"

say "1/4  Create the OAuth client in Google Cloud"
cat <<'EOF'
  Make the app INTERNAL. An External app left in "Testing" issues refresh tokens
  that expire after seven days: mail would work for a week and then fail with a
  bare invalid_grant that says nothing about why.

  Internal means internal to ONE Workspace org. If this mailbox is on a
  different Workspace tenant than the last one, it needs its own Google Cloud
  project inside THAT tenant with its own OAuth client -- the existing client
  cannot consent a user outside its own org. If it is another address or a
  secondary domain on the SAME tenant, reuse the existing client and only the
  sign-in below changes.

  1. https://console.cloud.google.com/ — new project, or reuse one
  2. APIs & Services > Library > enable "Gmail API"
     Enable "Google Calendar API" too if you want the diary connected. It costs
     nothing to enable now and saves a second trip through this screen.
  3. APIs & Services > OAuth consent screen
       User type: Internal
       Scopes, exactly these:
           .../auth/gmail.modify     read, file, archive
           .../auth/gmail.send       send — asks you in the chat, refused in jobs
           .../auth/calendar.events  create and update events (optional)

       And NOT these, whatever the picker suggests:
           gmail.settings.basic  creates FILTERS — standing rules that keep
                                 acting after the session ends. Not negotiable.
           gmail.labels          the six labels are created once, by hand.
           calendar              full calendar access, including other people's.
                                 calendar.events is the narrow one; take it.
  4. Credentials > Create credentials > OAuth client ID
       Application type: Desktop app
  5. Download the JSON
EOF
if [ -f "$KEYS" ]; then
  note "an OAuth client is already saved at $KEYS"
  read -rp "  Press return to reuse it, or give a new path: " src
  [ -n "$src" ] || src="$KEYS"
else
  read -rp "  Path to the downloaded JSON: " src
fi
src="${src/#\~/$HOME}"
[ -f "$src" ] || { echo "  no such file: $src" >&2; exit 1; }

python3 - "$src" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
root = d.get("installed") or d.get("web") or {}
if not root.get("client_id"):
    sys.exit("  that file has no client_id — is it the OAuth client JSON?")
if "web" in d:
    print("  note: this is a Web client. A Desktop client is simpler; Web needs")
    print("        http://localhost:3000/oauth2callback as an authorised redirect URI.")
print(f"  client: {root['client_id'][:24]}...")
PY

[ "$src" = "$KEYS" ] || cp "$src" "$KEYS"
chmod 600 "$KEYS"
note "saved to $KEYS"

say "2/4  Grant access"

# npx is not on PATH in every shell on a Mac — Homebrew installs to
# /opt/homebrew/bin on Apple silicon and /usr/local/bin on Intel, and neither is
# guaranteed to be exported here. Look before failing on `command not found`.
NPX=""
for candidate in npx /opt/homebrew/bin/npx /usr/local/bin/npx "$HOME/.volta/bin/npx"; do
  if command -v "$candidate" >/dev/null 2>&1; then NPX="$candidate"; break; fi
done
if [ -z "$NPX" ] && [ -d /opt/homebrew/opt/node/bin ]; then
  NPX=/opt/homebrew/opt/node/bin/npx
  [ -x "$NPX" ] || NPX=""
fi
if [ -z "$NPX" ]; then
  cat <<'EOF' >&2

  ✗ npx not found. The auth step runs the MCP server once to do the OAuth
    dance, and that needs Node.

    Install it:   brew install node
    Then re-run this script. Everything before this point is already saved,
    so it will pick up where it left off.

    Already have Node somewhere? Put it on PATH first, e.g.
      export PATH="/opt/homebrew/bin:$PATH"
EOF
  exit 1
fi
note "using $NPX"

CRED="$STATE/credentials.json"
if [ -f "$CRED" ] && python3 -c "
import json,sys
d = json.load(open('$CRED'))
sys.exit(0 if (d.get('tokens') or {}).get('refresh_token') else 1)
" 2>/dev/null; then
  note "credentials already saved — skipping the browser step."
  note "Delete $CRED to force a fresh grant."
else
note "A browser will open. Sign in as the owner of THIS mailbox ($ACCOUNT)."
note "Google will ask to 'Read, compose, send and permanently delete all your"
note "email' — that is how Google words gmail.modify, and it is broader than"
note "what the assistant will do with it. The fences are in .mcp.json and"
note "deploy/mcp-check.mjs verifies them."
note ""
note "gmail.send is requested too, granted 2026-09-01. It is what lets the assistant"
note "answer rather than only draft. Sending asks you in the chat first and is"
note "refused outright in the scheduled jobs — see .claude/settings.json."
# GMAIL_MCP_STATE_DIR alone is not enough — it only moves the rate-limit file.
# Without these two the server writes to ~/.gmail-mcp and the container, whose
# home is ephemeral, never sees the token.
GMAIL_OAUTH_PATH="$KEYS" \
GMAIL_CREDENTIALS_PATH="$STATE/credentials.json" \
GMAIL_MCP_STATE_DIR="$STATE" \
    "$NPX" -y "$SERVER" auth --scopes=gmail.modify,gmail.send
fi

[ -f "$CRED" ] || { echo "  auth did not produce $CRED" >&2; exit 1; }
chmod 600 "$CRED"

say "3/4  Check what was actually granted"
python3 - "$CRED" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))

# This server writes {"tokens": {...}, "scopes": ["gmail.modify"]}. `tokens.scope`
# is what Google actually granted and is authoritative; the top-level `scopes` is
# what was asked for. Read the grant, fall back to the request, and say which —
# an earlier version looked for a top-level "scope" that is never written and
# concluded nothing had been granted at all.
granted = (d.get("tokens") or {}).get("scope")
source = "granted"
if not granted:
    granted = d.get("scopes") or []
    source = "requested"
scopes = granted.split() if isinstance(granted, str) else list(granted)
short = [s.rsplit("/", 1)[-1] for s in scopes]
print(f"  scopes ({source}):", ", ".join(short) or "(none recorded)")
if not short:
    sys.exit("  no scope recorded at all — delete the file and re-run.")

# Must stay in step with `--scopes` above and with .mcp.json. A scope granted
# here but absent from .mcp.json is dormant; one in .mcp.json but not granted
# here fails at runtime with a 403 that does not name the missing scope.
allowed = ("gmail.modify", "gmail.send", "gmail.readonly", "userinfo.email", "openid")
extra = [s for s in short if s not in allowed]
if extra:
    print()
    print("  !! MORE WAS GRANTED THAN ASKED FOR:", ", ".join(extra))
    if any("settings" in s for s in extra):
        print("     gmail.settings.basic creates FILTERS — standing rules that keep")
        print("     acting after the session ends. This one is not negotiable.")
    print("     Revoke at https://myaccount.google.com/permissions and re-run this.")
    sys.exit(1)
if "gmail.modify" not in short:
    sys.exit("  gmail.modify was not granted; the assistant cannot file or archive.")
if "gmail.send" not in short:
    # Not fatal: triage is the point and it works without this. But say so
    # loudly, because the symptom otherwise appears much later as a 403 on a
    # send Alex asked for and approved.
    print("  NOTE: gmail.send was not granted. Triage works; sending will 403.")
    print("        Tick it on the consent screen and re-run to fix.")
else:
    print("  gmail.modify + gmail.send. Sending asks in chat, refused in jobs.")
print("  No filters, no label management, no full-account scope.")
PY

say "4/4  Copy it to the server"
cat <<EOF
  scp "$CRED" linuxbox:obligations/deploy/$(basename "$STATE")/credentials.json
  scp "$KEYS" linuxbox:obligations/deploy/$(basename "$STATE")/gcp-oauth.keys.json

  Then on linuxbox:
      chmod 600 obligations/deploy/$(basename "$STATE")/*
      node deploy/add-mailbox.mjs $ACCOUNT     # config + deny rules for this prefix
      sudo systemctl restart obligations-agent
      docker run --rm -v ~/obligations:/obligations -e OBLIGATIONS=/obligations \
          --entrypoint node obligations:latest /obligations/deploy/mcp-check.mjs

  That last one runs IN THE CONTAINER — that is the only place the MCP server
  is installed, so on the host it has nothing to ask and says so. It lists what
  the server actually registered and checks it against the deny list, the rate
  limits and the rule that sending must be in neither permission list. Expect
  "All fences in place"; anything else means read the output before using it.

  deploy/gmail-state/ is gitignored — the refresh token must never reach a
  commit.
EOF
