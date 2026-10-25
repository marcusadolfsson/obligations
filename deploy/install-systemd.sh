#!/usr/bin/env bash
# Install the timers. Run on the server, as the user who owns the assistant repo:
#   OBLIGATIONS=~/obligations ./deploy/install-systemd.sh
set -euo pipefail

OBLIGATIONS="${OBLIGATIONS:-$HOME/obligations}"
RUN_AS="$(id -un)"

command -v systemctl >/dev/null || { echo "no systemd here — use jobs/crontab.example instead" >&2; exit 1; }

for f in "$OBLIGATIONS"/deploy/systemd/*; do
  sed -e "s|__USER__|$RUN_AS|g" -e "s|__OBLIGATIONS__|$OBLIGATIONS|g" "$f" \
    | sudo tee "/etc/systemd/system/$(basename "$f")" >/dev/null
done

sudo systemctl daemon-reload
sudo systemctl enable --now obligations-dispatch.timer
sudo systemctl enable --now obligations-agent.service

echo
systemctl list-timers 'obligations-*' --no-pager
echo
echo "Scheduled jobs run inside obligations-agent, not as systemd units."
echo "  journalctl -u obligations-agent -n 50        # what the service is doing"
echo "  cat .log/job-runs.json                 # when each job last fired"
echo "  ./deploy/run-job.sh morning            # break-glass: run one without the service"
