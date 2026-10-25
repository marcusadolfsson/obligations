#!/usr/bin/env bash
set -euo pipefail

: "${VNC_PASSWORD:?set VNC_PASSWORD in deploy/.env}"

mkdir -p "$HOME/.vnc"
x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do sleep 0.2; done

fluxbox >/dev/null 2>&1 &

# -localhost keeps VNC off the container's external interface. Reach it via the
# host's loopback publish + an SSH tunnel. See deploy/README.md.
x11vnc -display "$DISPLAY" -rfbauth "$HOME/.vnc/passwd" \
       -forever -shared -localhost -rfbport 5900 &

websockify --web=/usr/share/novnc 6080 localhost:5900 &

echo "desktop up — DISPLAY=$DISPLAY, vnc:5900, novnc:6080"
wait -n
