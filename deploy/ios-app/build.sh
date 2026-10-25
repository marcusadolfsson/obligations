#!/usr/bin/env bash
#
# Build the Obligations app. Run on the Mac.
#
#   ./build.sh generate          regenerate Obligations.xcodeproj from project.yml
#   ./build.sh sim [name]        build for the iOS Simulator, install, launch
#   ./build.sh push-sim [json]   deliver a push to the simulator's copy
#   ./build.sh device [name]     build signed for iOS and install on a paired iPhone/iPad
#   ./build.sh mac [--install]   build the Mac app; --install copies it to /Applications
#
# The .xcodeproj is generated and gitignored; project.yml is the source.
# Signing is automatic under the team in project.yml, so the first device or
# Mac build registers the App ID and its push capability — that needs the
# Apple ID for your team signed in under Xcode > Settings > Accounts.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
BUNDLE=com.example.obligations.app
DERIVED="$HERE/build"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

generate() {
  say "Generate Obligations.xcodeproj"
  xcodegen generate --spec project.yml --quiet
}

case "${1:-generate}" in
  generate)
    generate ;;

  sim)
    generate
    SIM="${2:-iPhone 16e}"
    say "Build for the simulator: $SIM"
    xcodebuild -project Obligations.xcodeproj -scheme Obligations -configuration Debug \
      -destination "platform=iOS Simulator,name=$SIM" -derivedDataPath "$DERIVED" \
      CODE_SIGNING_ALLOWED=NO build | grep -E "error:|warning: .*Obligations|BUILD" || true
    APP="$DERIVED/Build/Products/Debug-iphonesimulator/Obligations.app"
    [ -d "$APP" ] || { echo "  no app at $APP" >&2; exit 1; }
    say "Install and launch"
    xcrun simctl boot "$SIM" 2>/dev/null || true
    open -a Simulator
    xcrun simctl install "$SIM" "$APP"
    xcrun simctl launch "$SIM" "$BUNDLE"
    note "the simulator has no APNs; use ./build.sh push-sim to deliver a payload" ;;

  push-sim)
    # The simulator accepts a payload file directly, which is enough to test
    # the tap → page route without a server or a certificate.
    PAYLOAD="${2:-apns-sample.json}"
    say "Push $PAYLOAD to the booted simulator"
    xcrun simctl push booted "$BUNDLE" "$PAYLOAD" ;;

  device)
    generate
    DEVICE="${2:-}"
    say "Build signed for iOS"
    xcodebuild -project Obligations.xcodeproj -scheme Obligations -configuration Debug \
      -destination "generic/platform=iOS" -derivedDataPath "$DERIVED" \
      -allowProvisioningUpdates build | grep -E "error:|warning: .*Obligations|BUILD|Signing" || true
    APP="$DERIVED/Build/Products/Debug-iphoneos/Obligations.app"
    [ -d "$APP" ] || { echo "  no app at $APP" >&2; exit 1; }
    note "aps-environment: $(codesign -d --entitlements :- "$APP" 2>/dev/null | plutil -extract aps-environment raw - 2>/dev/null || echo none)"
    if [ -n "$DEVICE" ]; then
      say "Install on $DEVICE"
      xcrun devicectl device install app --device "$DEVICE" "$APP"
      xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE" || true
    else
      note "pass a device name to install, e.g. ./build.sh device \"Alex iPhone 17 Air\""
      note "(the device must be unlocked and on this Mac's network or cable)"
    fi ;;

  mac)
    generate
    say "Build the Mac app"
    xcodebuild -project Obligations.xcodeproj -scheme ObligationsMac -configuration Debug \
      -destination "platform=macOS" -derivedDataPath "$DERIVED" \
      -allowProvisioningUpdates build | grep -E "error:|warning: .*Obligations|BUILD|Signing" || true
    APP="$DERIVED/Build/Products/Debug/Obligations Web.app"
    [ -d "$APP" ] || { echo "  no app at $APP" >&2; exit 1; }
    note "aps-environment: $(codesign -d --entitlements :- "$APP" 2>/dev/null | plutil -extract com.apple.developer.aps-environment raw - 2>/dev/null || echo none)"
    if [ "${2:-}" = "--install" ]; then
      say "Install to /Applications/Obligations Web.app"
      osascript -e 'quit app "Obligations Web"' 2>/dev/null || true
      rm -rf "/Applications/Obligations Web.app"
      cp -R "$APP" "/Applications/Obligations Web.app"
      open "/Applications/Obligations Web.app"
    else
      note "$APP"
      note "add --install to copy it to /Applications and open it"
    fi ;;

  -h|--help) sed -n '2,15p' "$0" ;;
  *) echo "unknown command: $1" >&2; exit 2 ;;
esac
