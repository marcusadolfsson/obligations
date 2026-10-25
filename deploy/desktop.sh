#!/usr/bin/env bash
# Start / stop / tunnel the interactive desktop container.
# Not meant to run 24/7 — bring it up for setup or a browser task, then stop it.
set -euo pipefail

OBLIGATIONS="${OBLIGATIONS:-$HOME/obligations}"
CMD="${1:-up}"

case "$CMD" in
  build)
    docker build -t obligations-desktop:latest -f "$OBLIGATIONS/deploy/Dockerfile.desktop" "$OBLIGATIONS/deploy"
    ;;
  up)
    docker run -d --rm \
      --name obligations-desktop \
      --env-file "$OBLIGATIONS/deploy/.env" \
      -v "$OBLIGATIONS:/obligations" \
      -v "$OBLIGATIONS/deploy/claude-home:/home/agent/.claude" \
      -p 127.0.0.1:5901:5900 \
      -p 127.0.0.1:6080:6080 \
      --shm-size 1g \
      --memory 4g --cpus 2 \
      --security-opt no-new-privileges \
      obligations-desktop:latest
    echo "up. from your laptop:"
    echo "  ssh -N -L 6080:127.0.0.1:6080 <server>"
    echo "  then open http://127.0.0.1:6080/vnc.html"
    ;;
  down)  docker stop obligations-desktop >/dev/null && echo "stopped" ;;
  shell) docker exec -it obligations-desktop bash ;;
  *)     echo "usage: desktop.sh {build|up|down|shell}" >&2; exit 2 ;;
esac
