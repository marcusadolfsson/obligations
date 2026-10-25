#!/usr/bin/env bash
#
# Build Obligations.app. Run on the Mac.
#
#   ./build.sh                     build, sign, and install to /Applications
#   ./build.sh --no-install        build and sign only, leave it in .build/
#   ./build.sh --uninstall-agents  unload the old LaunchAgents this replaces
#
# Signing identity comes from OBLIGATIONS_SIGN_ID, or the first Developer ID
# Application identity in the keychain. The TCC grants (Full Disk Access,
# Contacts) are keyed to the bundle id AND the signature, so signing with a
# stable Developer ID is what stops macOS re-asking after every rebuild.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/.build/Obligations.app"
INSTALL_DIR="/Applications"
INSTALL=1

for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    --uninstall-agents) UNINSTALL_AGENTS=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------- old agents

# The four LaunchAgents this app replaces. Leaving them loaded means both the
# app and launchd extract on their own schedules and race on the same output
# paths — the app would report a successful sync over a file the plist had just
# rewritten, which is the kind of bug that looks like flakiness for weeks.
AGENTS=(
  com.example.obligations.imessage
  com.example.obligations.contacts
  com.example.obligations.calls
)

# NOT in that list, on purpose: com.example.obligations.imessage-send.
#
# The app does not replace it and must not appear to. That agent polls the
# repo every 60s and SENDS approved outbox drafts as Alex — the one
# capability on this Mac that acts outward as him, and the one carrying the two
# refusals in imessage-send.py's docstring (only `status: approved`, and only to
# a handle already seen in a recent thread).
#
# Unloading it here would stop approved messages going out with no error
# anywhere: Alex would approve a message in the chat UI and nothing would
# happen. Porting it is separate, careful work — those refusals have to move
# across exactly — so until then it keeps running as it is.

uninstall_agents() {
  say "Unloading the LaunchAgents this app replaces"
  for label in "${AGENTS[@]}"; do
    plist="$HOME/Library/LaunchAgents/$label.plist"
    if [ -f "$plist" ]; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      mv "$plist" "$plist.replaced-by-app"
      note "unloaded and kept as $(basename "$plist").replaced-by-app"
    else
      note "$label — not installed"
    fi
  done
  note ""
  note "Kept rather than deleted: if the app turns out not to work, renaming"
  note "them back and running launchctl bootstrap restores the old setup."
}

if [ "${UNINSTALL_AGENTS:-0}" = 1 ]; then
  uninstall_agents
  exit 0
fi

# -------------------------------------------------------------------- build

say "1/5  Compile"
cd "$HERE"
swift build -c release --product Obligations
BINARY="$(swift build -c release --product Obligations --show-bin-path)/Obligations"
[ -x "$BINARY" ] || { echo "  no binary at $BINARY" >&2; exit 1; }
note "$BINARY"

say "2/5  Assemble the bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/Obligations"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

# The extractors, verbatim from deploy/integrations. Copied rather than
# symlinked: a symlink out of an app bundle breaks the code signature, and the
# whole point is that the signed bundle is what macOS grants access to.
#
# handles.py is imported by the other two — omitting it is an ImportError at
# sync time rather than at build time, which is the wrong end.
for script in imessage-extract.py contacts-extract.py call-log-extract.py handles.py; do
  src="$HERE/../integrations/$script"
  [ -f "$src" ] || { echo "  missing: $src" >&2; exit 1; }
  cp "$src" "$APP/Contents/Resources/$script"
done
note "$(ls "$APP/Contents/Resources" | tr '\n' ' ')"

say "3/5  Sign"
IDENTITY="${OBLIGATIONS_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Developer ID Application/ {print $2; exit}')}"
if [ -z "$IDENTITY" ]; then
  echo "  No Developer ID Application identity found." >&2
  echo "  Set OBLIGATIONS_SIGN_ID, or sign ad-hoc with: OBLIGATIONS_SIGN_ID=- ./build.sh" >&2
  echo "  Ad-hoc works, but the signature changes on every build, so macOS" >&2
  echo "  will ask for Full Disk Access again each time." >&2
  exit 1
fi
note "identity: $IDENTITY"

# --options runtime is the Hardened Runtime. Required for notarisation, and it
# is what the entitlements file leans on given the app is not sandboxed.
codesign --force --deep --options runtime \
  --entitlements "$HERE/Obligations.entitlements" \
  --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"

say "4/5  Check what it will be able to do"
note "bundle id:  $(defaults read "$APP/Contents/Info" CFBundleIdentifier)"
note "menu bar only (LSUIElement): $(defaults read "$APP/Contents/Info" LSUIElement)"
note ""
note "Full Disk Access must be granted to the APP, not to python. That is the"
note "point of bundling: the signed app is the responsible process, so the"
note "grant survives an OS Python update. The old plists needed it on"
note "/usr/bin/python3, and that is what broke twice."

if [ "$INSTALL" = 0 ]; then
  say "Done (not installed)"
  note "$APP"
  exit 0
fi

say "5/5  Install"
# Must live in /Applications for SMAppService login-item registration to be
# reliable; from a build directory it registers and then quietly does not fire.
if [ -d "$INSTALL_DIR/Obligations.app" ]; then
  osascript -e 'quit app "Obligations"' 2>/dev/null || true
  sleep 1
  rm -rf "$INSTALL_DIR/Obligations.app"
fi
cp -R "$APP" "$INSTALL_DIR/Obligations.app"
note "installed to $INSTALL_DIR/Obligations.app"

cat <<EOF

  Next, once, by hand:

  1. Open it:            open "$INSTALL_DIR/Obligations.app"
  2. Grant Full Disk Access — System Settings > Privacy & Security >
     Full Disk Access > + > Applications > Obligations. The menu links straight there.
  3. Grant Contacts when it asks.
  4. Retire the old agents:   ./build.sh --uninstall-agents
     Until you do, launchd and the app both sync and race on the same files.

  The outbox sender (com.example.obligations.imessage-send) is deliberately left
  alone — this app does not replace it yet, and it is what actually sends the
  messages you approve.

EOF
