#!/usr/bin/env bash
# Host-side wrapper for obligations-agent. systemd calls this; see
# deploy/systemd/obligations-agent.service.
#
# Published on loopback only: cloudflared, running with --network host, is the
# only thing that can reach it, and Cloudflare Access authenticates every request
# before it gets that far. Not 0.0.0.0 — this box shares a GCE VPC with other
# services, and this endpoint drives an agent that can write the repo.
#
# ESCAPE HATCH: if Cloudflare, the tunnel, or the Access config breaks, the web
# UI is unreachable until you change this. Set OBLIGATIONS_BIND=tailnet in
# deploy/.env and restart obligations-agent and obligations-web; the direct tailnet path
# comes back. That path is NOT behind Google sign-in, so put it back afterwards.
set -euo pipefail

OBLIGATIONS="${OBLIGATIONS:-$HOME/obligations}"
PORT="${PORT:-7683}"

# Read the bind mode from deploy/.env so one file controls it. Only this key is
# pulled out — the rest of that file is secrets, and sourcing it here would put
# them in this script's environment for no reason.
if [[ -z "${OBLIGATIONS_BIND:-}" && -f "$OBLIGATIONS/deploy/.env" ]]; then
  OBLIGATIONS_BIND="$(sed -n 's/^[[:space:]]*OBLIGATIONS_BIND[[:space:]]*=[[:space:]]*//p' "$OBLIGATIONS/deploy/.env" | tail -1)"
fi

if [[ "${OBLIGATIONS_BIND:-loopback}" == "tailnet" ]]; then
  BIND_IP="$(tailscale ip -4 2>/dev/null | head -1)"
  [[ -n "$BIND_IP" ]] || { echo "OBLIGATIONS_BIND=tailnet but no tailscale IPv4 address" >&2; exit 1; }
  echo "WARNING: binding the tailnet address — this path is NOT behind Google sign-in" >&2
else
  BIND_IP=127.0.0.1
fi

# Containers default to UTC. Without this the in-process scheduler fires every
# job four hours early — the 18:00 evening job ran at 14:00 — and every
# timestamp the agent writes into messages/, journal/ and outbox/ is in a
# different timezone from everything the host writes.
TZ_HOST="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"

# Joins the shared `edge` network instead of publishing a host port: the
# Cloudflare connector lives there and reaches this as obligations-agent:$PORT.
# Nothing on the host binds a port for it any more.
exec docker run --rm \
  --name obligations-agent \
  -e "TZ=$TZ_HOST" \
  --env-file "$OBLIGATIONS/deploy/.env" \
  -e "OBLIGATIONS=/obligations" \
  -e "PORT=$PORT" \
  -v "$OBLIGATIONS:/obligations" \
  -v "$OBLIGATIONS/deploy/claude-home:/home/agent/.claude" \
  --network edge \
  --network-alias obligations-agent \
  --memory 4g --cpus 2 \
  --security-opt no-new-privileges \
  --entrypoint node \
  obligations:latest /obligations/deploy/agent-service/server.mjs
