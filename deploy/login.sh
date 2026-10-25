#!/usr/bin/env bash
# One-time interactive login. Credentials land in deploy/claude-home/, which is
# gitignored and mounted into every job container as ~/.claude.
# Re-run if jobs start failing with auth errors.
set -euo pipefail
OBLIGATIONS="${OBLIGATIONS:-$HOME/obligations}"

mkdir -p "$OBLIGATIONS/deploy/claude-home"

# A previous login left at "Press Enter to continue" keeps its container, and
# the fixed name below then refuses to start a new one. Alex, 2026-09-21:
# 'The container name "/obligations-login" is already in use'. It has already saved
# its credentials by that point, so removing it loses nothing.
docker rm -f obligations-login >/dev/null 2>&1 || true

docker run -it --rm \
  --name obligations-login \
  -v "$OBLIGATIONS:/obligations" \
  -v "$OBLIGATIONS/deploy/claude-home:/home/agent/.claude" \
  --entrypoint claude \
  obligations:latest /login
