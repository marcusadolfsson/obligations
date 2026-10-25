#!/usr/bin/env bash
# Exit 0 when the agent service is idle — no chat turn and no job in flight —
# so a restart does not cut a turn or a job in half. Reads the service log,
# which is the only place the state is recorded outside the process.
# Alex, 2026-09-06, after two restarts landed on running turns.
OBLIGATIONS="${OBLIGATIONS:-$(cd "$(dirname "$0")/.." && pwd)}"
# post_job_start: a brief's digest and audit run AFTER its job_done. On
# 2026-09-30 a restart landed eleven seconds into that window and the evening
# brief went out without its mail digest.
last="$(grep -h '"event":"\(turn_start\|turn_ok\|turn_stopped\|turn_failed\|job_start\|job_done\|job_failed\|post_job_start\|post_job_done\)"' "$OBLIGATIONS/.log/agent-service.log" 2>/dev/null | tail -1 | grep -o '"event":"[a-z_]*"')"
case "$last" in
  *turn_start*|*job_start*) echo "busy: $last"; exit 1 ;;
  *) echo "idle"; exit 0 ;;
esac
