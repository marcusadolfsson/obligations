#!/usr/bin/env bash
# Render every page in a real browser at iPhone width and fail on overflow.
#
# Separate from ./deploy/test.sh because it needs the Playwright image (~2GB)
# and takes seconds rather than milliseconds. Run it after touching anything
# under deploy/agent-service/web/ or any page's markup — "test it on a phone"
# is not something this environment can do, and this is the substitute.
#
# Screenshots land in .log/screens/ and are worth actually looking at.
set -uo pipefail
OBLIGATIONS="${OBLIGATIONS:-$(cd "$(dirname "$0")/.." && pwd)}"

exec docker run --rm --network none \
  -v "$OBLIGATIONS:/obligations" -e OBLIGATIONS=/obligations \
  -w /obligations/deploy/agent-service \
  obligations-visual:latest \
  node /obligations/deploy/agent-service/visual.test.mjs
