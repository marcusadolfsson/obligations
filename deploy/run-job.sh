#!/usr/bin/env bash
# Host-side wrapper. Cron calls this. One ephemeral container per run — nothing
# long-lived to babysit, no state drift between runs.
set -euo pipefail

JOB="${1:?usage: run-job.sh <morning|evening|weekly>}"
OBLIGATIONS="${OBLIGATIONS:-$(cd "$(dirname "$0")/.." && pwd)}"

# On the Mac mini there is no docker and no flock binary. The break-glass there
# is the one the service has always honoured: `touch .log/run-<job>`, picked up
# on the next idle minute, under the same sandbox and lock as a scheduled run.
if [ "$(uname)" = Darwin ]; then
  mkdir -p "$OBLIGATIONS/.log"
  touch "$OBLIGATIONS/.log/run-$JOB"
  echo "asked the server on this Mac to run $JOB on its next idle minute (.log/run-$JOB)"
  exit 0
fi

mkdir -p "$OBLIGATIONS/.log"

# One writer at a time. Jobs are minutes long and twice daily, so waiting is
# fine; -w 1500 gives up before systemd's 30-min timeout would kill us anyway.
exec 9>"$OBLIGATIONS/.log/write.lock"
flock -w 1500 9 || { echo "$(date -Iseconds) $JOB: another job held the lock >25min, giving up" >&2; exit 1; }

TZ_HOST="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"

docker run --rm \
  --name "obligations-$JOB" \
  -e "TZ=$TZ_HOST" \
  --env-file "$OBLIGATIONS/deploy/.env" \
  -v "$OBLIGATIONS:/obligations" \
  -v "$OBLIGATIONS/deploy/claude-home:/home/agent/.claude" \
  --memory 2g --cpus 2 \
  --security-opt no-new-privileges \
  obligations:latest "$JOB" \
  >> "$OBLIGATIONS/.log/$JOB.log" 2>&1
