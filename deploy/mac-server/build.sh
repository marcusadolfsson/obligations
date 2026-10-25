#!/usr/bin/env bash
#
# Build Obligations Server.app. Run on the Mac.
#
#   ./build.sh                build, sign, install to /Applications
#   ./build.sh --no-install   build and sign only, leave it in .build/
#
# This installs the bundle and nothing more. It does NOT register the launchd
# agents and does NOT turn the server on: that is the cutover, done from the
# Obligations menu ("Install server", then "Start"), and only after linuxbox has
# stopped — two servers running the same jobs is the failure this whole
# migration is ordered around.
#
# Signing identity comes from OBLIGATIONS_SIGN_ID, or the Apple Development identity
# Obligations.app uses. Same team as Obligations.app; a DIFFERENT bundle id, which is the
# point — this app must never share Obligations.app's privacy grants.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/.build/Obligations Server.app"
INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

say "1/5  The sandbox, before anything ships with it"
# The profile is the reason this app exists. Building a bundle around a
# profile that no longer holds would ship the hole with a signature on it.
"$HERE/sandbox.test.sh" "$HERE/server.sb" | tail -1

say "2/5  Compile"
cd "$HERE"
swift build -c release --product ObligationsServer
BIN="$(swift build -c release --product ObligationsServer --show-bin-path)/ObligationsServer"
[ -x "$BIN" ] || { echo "  no binary at $BIN" >&2; exit 1; }

say "3/5  Assemble"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Library/LaunchAgents"
cp "$BIN" "$APP/Contents/MacOS/obligations-server"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/server.sb" "$APP/Contents/Resources/server.sb"
cp "$HERE"/LaunchAgents/*.plist "$APP/Contents/Library/LaunchAgents/"
note "$(cd "$APP/Contents" && find . -type f | sort | tr '\n' ' ')"

say "4/5  Sign"
IDENTITY="${OBLIGATIONS_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Apple Development:/ {print $2; exit}')}"
[ -n "$IDENTITY" ] || { echo "  no signing identity; set OBLIGATIONS_SIGN_ID" >&2; exit 1; }
note "identity: $IDENTITY"
# Hardened runtime, and NO entitlements file: this app asks for nothing —
# no Contacts, no Calendars, no Apple Events. Obligations.app has those; this must not.
codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"
if codesign -d --entitlements - "$APP" 2>/dev/null | grep -q 'com.apple.security'; then
  echo "  the signed bundle carries entitlements — it must carry none" >&2; exit 1
fi

if [ "$INSTALL" = 0 ]; then
  say "Done (not installed)"; note "$APP"; exit 0
fi

say "5/5  Install"
DEST="/Applications/Obligations Server.app"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
note "installed to $DEST"
note "status: $("$DEST/Contents/MacOS/obligations-server" status | tr -d '\n' | tr -s ' ')"
cat <<EOF

  Installed, not started. At cutover, from the Obligations menu:
    Server > Install server   registers the two launchd agents
    Server > Start            turns this Mac into the assistant's server

  Approve "Obligations Server" under System Settings > General > Login Items if
  macOS asks — the agents do not run until it is approved.
EOF
