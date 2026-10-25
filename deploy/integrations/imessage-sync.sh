#!/bin/bash
# Runs on the Mac. Extract, then push to the assistant over tailscale.
#
# Push rather than pull on purpose: the assistant never needs credentials into
# Alex's personal machine. The Mac decides what leaves and when.
#
# Install: see README.md in this directory.
set -uo pipefail

OBLIGATIONS_HOST="${OBLIGATIONS_HOST:-linuxbox}"
OBLIGATIONS_PATH="${OBLIGATIONS_PATH:-obligations/integrations/imessage.json}"
DAYS="${IMESSAGE_DAYS:-14}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -t imessage)"

cleanup() { rm -f "$OUT"; }
trap cleanup EXIT

if ! /usr/bin/python3 "$HERE/imessage-extract.py" --days "$DAYS" --out "$OUT"; then
  echo "extract failed; not touching the copy on the assistant" >&2
  exit 1
fi

# scp over the tailnet. If the box is unreachable, leave the previous copy in
# place: stale data the assistant can date is better than no data, and the brief
# reports the staleness itself.
if ! scp -q -o ConnectTimeout=10 -o BatchMode=yes "$OUT" "$OBLIGATIONS_HOST:$OBLIGATIONS_PATH"; then
  echo "could not reach $OBLIGATIONS_HOST; previous extract left as-is" >&2
  exit 1
fi

echo "synced $(wc -c < "$OUT" | tr -d ' ') bytes to $OBLIGATIONS_HOST:$OBLIGATIONS_PATH"
