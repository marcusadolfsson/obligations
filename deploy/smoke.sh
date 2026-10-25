#!/usr/bin/env bash
# Boot the agent service exactly as systemd does — same image, same env, same
# mounts — with OBLIGATIONS_SMOKE=1 so it exits after one scheduler tick instead of
# listening, and without firing any job — the scheduler skips its work in
# OBLIGATIONS_SMOKE mode. Exit status is the test. No network: nothing here needs it.
set -uo pipefail
OBLIGATIONS="${OBLIGATIONS:-$(cd "$(dirname "$0")/.." && pwd)}"
# On the Mac: boot it the way launchd does — through Obligations Server's launcher,
# inside the sandbox, with the clean environment it builds. Smoke mode never
# starts work, so this runs whether or not this Mac is the server yet.
if [ "$(uname)" = Darwin ]; then
  LAUNCHER="/Applications/Obligations Server.app/Contents/MacOS/obligations-server"
  [ -x "$LAUNCHER" ] || LAUNCHER="$OBLIGATIONS/deploy/mac-server/.build/Obligations Server.app/Contents/MacOS/obligations-server"
  if [ ! -x "$LAUNCHER" ]; then
    echo "  FAIL no Obligations Server launcher — ./deploy/mac-server/build.sh"; exit 1
  fi
  out="$(OBLIGATIONS_SMOKE=1 "$LAUNCHER" run server 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && grep -q "smoke ok" <<<"$out"; then
    echo "  ok   the service boots and ticks once (smoke, sandboxed, via the launcher)"; exit 0
  fi
  echo "  FAIL the service does not boot cleanly (rc=$rc)"
  echo "$out" | tail -12 | sed 's/^/         /'
  exit 1
fi

TZ_HOST="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
out="$(timeout 60 docker run --rm --network none \
  -e "TZ=$TZ_HOST" --env-file "$OBLIGATIONS/deploy/.env" -e OBLIGATIONS=/obligations -e OBLIGATIONS_SMOKE=1 \
  -v "$OBLIGATIONS:/obligations" -v "$OBLIGATIONS/deploy/claude-home:/home/agent/.claude" \
  --memory 1g --cpus 1 --security-opt no-new-privileges \
  --entrypoint node obligations:latest /obligations/deploy/agent-service/server.mjs 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && grep -q "smoke ok" <<<"$out"; then
  echo "  ok   the service boots and ticks once (smoke)"
  exit 0
fi
echo "  FAIL the service does not boot cleanly (rc=$rc)"
echo "$out" | tail -12 | sed 's/^/         /'
exit 1
