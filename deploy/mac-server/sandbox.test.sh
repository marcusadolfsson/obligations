#!/bin/bash
#
# Does the assistant server's sandbox actually hold?
#
#   ./deploy/mac-server/sandbox.test.sh [profile]
#
# Runs probes under the Seatbelt profile (default: the one shipped inside
# /Applications/Obligations Server.app, else the repo's deploy/mac-server/server.sb)
# and asserts that every deny denies and every allow allows. Ends with
# exactly "ALL PASSED" or exits non-zero.
#
# Why a test rather than a careful reading. Seatbelt is deprecated and its
# behaviour is learned by running it, not from documentation — and the first
# probe written for this file was wrong in a way a reading would never catch:
# `tell application "Finder" to get name` succeeded under a profile that
# denied every Apple Event, because AppleScript answers an application's name
# locally and sends nothing. Every probe below was checked against a profile
# with its rule removed, so a PASS means the rule is what refused it.
#
# The paths chosen for the read probes are ones macOS's own privacy controls
# do NOT protect (the Obligations app's log, ~/.ssh, another project), so a refusal
# there is the sandbox's and nobody else's. The TCC-protected stores are
# probed too, but a refusal there would happen anyway; they are listed so the
# day one starts SUCCEEDING is loud.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OBLIGATIONS="$(cd "$HERE/../.." && pwd)"
SHIPPED="/Applications/Obligations Server.app/Contents/Resources/server.sb"
PROFILE="${1:-}"
if [ -z "$PROFILE" ]; then
  if [ -f "$SHIPPED" ]; then PROFILE="$SHIPPED"; else PROFILE="$HERE/server.sb"; fi
fi
SCRATCH="${TMPDIR%/}"
WORK="$(mktemp -d "$SCRATCH/obligations-sandbox-test.XXXXXX")"
PASS=0
FAIL=0

sb() {
  sandbox-exec -f "$PROFILE" -D OBLIGATIONS="$OBLIGATIONS" -D HOME="$HOME" -D TMPDIR="$SCRATCH" "$@"
}

ok()   { PASS=$((PASS + 1)); printf '  pass  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

# expect_denied "what" cmd...   — must fail
expect_denied() {
  local what="$1"; shift
  if sb "$@" >/dev/null 2>&1; then bad "$what — was ALLOWED"; else ok "$what — denied"; fi
}

# expect_allowed "what" cmd...  — must succeed
expect_allowed() {
  local what="$1"; shift
  if sb "$@" >/dev/null 2>&1; then ok "$what — allowed"; else bad "$what — was DENIED"; fi
}

echo "profile: $PROFILE"
echo "repo:    $OBLIGATIONS"
echo

echo "Reading what is his (the sandbox's own refusals):"
APPLOG="$HOME/Library/Application Support/Obligations/obligations-app.log"
if [ -f "$APPLOG" ]; then
  expect_denied "Obligations.app's log" /bin/cat "$APPLOG"
else
  bad "Obligations.app's log — not present on this machine, so this cannot be checked"
fi
[ -d "$HOME/.ssh" ] && expect_denied "~/.ssh" /bin/ls "$HOME/.ssh"
expect_denied "the home directory listing" /bin/ls "$HOME"
expect_denied "another project in ~/Developer" /bin/ls "$HOME/Developer"
expect_denied "the Claude token folder" /bin/ls "$HOME/.obligations-server"
expect_denied "~/.local (the claude Obligations.app runs)" /bin/ls "$HOME/.local"

echo
echo "Reading what macOS also protects (both layers refuse):"
expect_denied "Messages database" /bin/cat "$HOME/Library/Messages/chat.db"
expect_denied "Contacts store" /bin/ls "$HOME/Library/Application Support/AddressBook"
expect_denied "Keychains" /bin/ls "$HOME/Library/Keychains"

echo
echo "Writing outside the repo:"
expect_denied "a file in the home directory" /usr/bin/touch "$HOME/.obligations-sandbox-probe"
expect_denied "~/.local/bin" /usr/bin/touch "$HOME/.local/bin/.obligations-sandbox-probe"
expect_denied "/opt/homebrew (where node lives)" /usr/bin/touch "/opt/homebrew/.obligations-sandbox-probe"

echo
echo "Acting as him:"
expect_denied "running osascript" /usr/bin/osascript -e 'return 1'
expect_denied "running open" /usr/bin/open -Ra Finder
expect_denied "running shortcuts" /usr/bin/shortcuts list
# Obligations.app's switches — outboxEnabled among them — are preferences, written
# through cfprefsd rather than to a file the write deny would catch.
expect_denied "writing Obligations.app's preferences (the sender's switch)" \
  /usr/bin/defaults write com.example.obligations sandboxProbe -bool true
expect_denied "writing Obligations Server's own preferences" \
  /usr/bin/defaults write com.example.obligations.server sandboxProbe -bool true

# A real Apple Event, sent without osascript. The question asked of Finder
# must need an event: an application's `name` does not (see the header).
cat > "$WORK/ae.swift" <<'SWIFT'
import Foundation
let s = NSAppleScript(source: "tell application \"Finder\" to get name of startup disk")
var err: NSDictionary?
if s?.executeAndReturnError(&err) != nil { print("SENT"); exit(0) }
let code = (err?["NSAppleScriptErrorNumber"] as? Int) ?? 0
print("REFUSED \(code)")
// -600: the sandbox stopped delivery. Anything else means the event left the
// process and something further on refused it — that is not this layer working.
exit(code == -600 ? 2 : 1)
SWIFT
if swiftc -o "$WORK/ae" "$WORK/ae.swift" >/dev/null 2>&1; then
  out="$(sb "$WORK/ae" 2>/dev/null)"; code=$?
  case "$code" in
    2) ok "an Apple Event to Finder — refused by the sandbox ($out)" ;;
    0) bad "an Apple Event to Finder — was SENT" ;;
    *) bad "an Apple Event to Finder — left the process and was refused elsewhere ($out)" ;;
  esac
else
  bad "an Apple Event — could not compile the probe (swiftc), so this was not checked"
fi

echo
echo "The working set:"
expect_allowed "reading the repo" /bin/cat "$OBLIGATIONS/CLAUDE.md"
probe="$OBLIGATIONS/.log/sandbox-probe"
mkdir -p "$OBLIGATIONS/.log"
if sb /usr/bin/touch "$probe" >/dev/null 2>&1 && [ -f "$probe" ]; then
  ok "writing the repo — allowed"
else
  bad "writing the repo — was DENIED"
fi
expect_allowed "git in the repo" /usr/bin/git -C "$OBLIGATIONS" rev-parse HEAD
# The node the server runs: Homebrew's node@22, pinned to match the image the
# code is tested on. Not whatever `node` is on PATH today.
NODE="/opt/homebrew/opt/node@22/bin/node"
[ -x "$NODE" ] || NODE=""
if [ -n "$NODE" ]; then
  expect_allowed "node" "$NODE" -e '0'
  expect_allowed "reaching api.anthropic.com" "$NODE" -e \
    'fetch("https://api.anthropic.com").then(()=>process.exit(0),()=>process.exit(1))'
  expect_allowed "reaching oauth2.googleapis.com" "$NODE" -e \
    'fetch("https://oauth2.googleapis.com").then(()=>process.exit(0),()=>process.exit(1))'
  # Seatbelt filters a bind by PORT only (see server.sb), so these assert what
  # it can enforce: the server's port, and nothing else.
  listen='const [h,p]=[process.argv[1],+process.argv[2]];const s=require("net").createServer();s.on("error",()=>process.exit(1));s.listen(p,h,()=>s.close(()=>process.exit(0)))'
  if lsof -nP -iTCP:7683 -sTCP:LISTEN >/dev/null 2>&1; then
    printf '  skip  listening on 7683 — the server already holds it\n'
  else
    expect_allowed "listening on localhost:7683" "$NODE" -e "$listen" 127.0.0.1 7683
  fi
  expect_denied "listening on another port" "$NODE" -e "$listen" 127.0.0.1 7690
  expect_denied "listening on an ephemeral port" "$NODE" -e "$listen" 127.0.0.1 0
else
  bad "node — not on PATH, so the network and listen probes were not run"
fi

echo
echo "$PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then echo "ALL PASSED"; exit 0; fi
exit 1
