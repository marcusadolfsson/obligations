#!/usr/bin/env bash
# Fired by systemd's OnFailure= when a job unit fails. The one message that must
# get through: the assistant is broken. Everything else can fail quietly; this can't.
set -uo pipefail

UNIT="${1:-unknown}"
OBLIGATIONS="${OBLIGATIONS:-$(cd "$(dirname "$0")/.." && pwd)}"   # the repo this lives in; ~/obligations was linuxbox's

MSG="obligations job FAILED: $UNIT on $(hostname). Last log lines:
$(journalctl -u "$UNIT" -n 5 --no-pager -o cat 2>/dev/null || tail -5 "$OBLIGATIONS/.log/"*.log 2>/dev/null)"

# Through the one sender, which prints the channel that actually worked. This
# used to inline its own curl against .env, which meant two implementations of
# delivery and two places that could disagree about what `delivered:` should say.
DELIVERED=$(printf '%s\n' "$MSG" | OBLIGATIONS="$OBLIGATIONS" python3 "$OBLIGATIONS/deploy/notify.py" \
  --title "obligations job failed" --priority high --tag rotating_light --body-file - \
  2>/dev/null) || DELIVERED=none
[ -n "$DELIVERED" ] || DELIVERED=none

# Record it in the messages queue regardless of whether the push landed. Unlike a
# reminder, a dead assistant must not depend on one channel working — this is the
# message that matters most and the one most likely to fire when things are broken.
printf '%s\n' "$MSG" | python3 "$OBLIGATIONS/deploy/messages.py" \
  --kind failure --title "job failed: $UNIT" --delivered "$DELIVERED" >/dev/null 2>&1 || true

# Any channel that worked is enough; only "none" means nothing reached him.
[ "$DELIVERED" != none ] && exit 0

# No channel, or the push failed: leave a marker file the next successful job run
# will see and surface in its brief.
echo "$(date -Iseconds) $UNIT failed"   # -Iseconds: -Is is GNU-only >> "$OBLIGATIONS/.log/FAILURES"
