#!/usr/bin/env python3
"""Everything the assistant says to Alex's phone goes through here.

One sender, several callers, in two languages. `reminder-dispatch.py` imports it;
`notify-failure.sh` and the agent service call the CLI. That is deliberate: a
process boundary rather than a library, because the callers do not share a
runtime and the thing they must agree on is *which channel actually worked*.

## Two channels, and why

- **ntfy** — the default. Reminders, failures, anything that is a notification.
- **SMS** — login codes, and only login codes. Not a preference: iOS will only
  offer a verification code for autofill from a message it considers *received*,
  so it has to arrive from a number that is not his. An iMessage from his own Mac
  lands as *sent* on every device on his Apple ID and never autofills. Tested
  2026-08-30; see `rules/realtime-push.md`.

## The rules that are not negotiable

- **The SMS destination comes from config and never from a message.** An email
  must not be able to choose where a code relay goes.
- **`send()` returns the channel that actually worked**, and that string is what
  callers write into `delivered:` in `messages/`. `rules/messages.md`: a delivery
  record that lies is worse than no record. Never hardcode the channel at a call
  site.
- **Sending is not idempotent and success can look like failure.** The voip.ms
  API answers `{"status":"success"}` on a plain 200, and a call that succeeded
  can still time out before the caller sees it. Callers that relay codes must
  deduplicate *before* sending on a stable id, and treat an ambiguous response as
  probably sent. A code that arrives twice is one Alex starts distrusting.
- **stdlib only.** This runs inside the minute dispatcher, where an import error
  would take reminder delivery down with it.
- **`urllib`, not `curl`.** The previous implementation put the topic and the
  message body in argv, visible in `ps` to anything on the box. A login code is
  exactly the payload that must not be in the process table.

## Where the secrets live

`deploy/notify.env`, mode 600, gitignored, host-only — **not** `deploy/.env`,
which is `--env-file`'d into the container that reads Alex's email. A bearer
token there would sit in `/proc/self/environ` of the process handling
attacker-controlled input, readable with the already-allowed `Bash(cat:*)`.

APNs (2026-09-05, the iOS/iPad/Mac app): `PUSH_CHANNEL=apns` plus APNS_KEY_ID,
APNS_TEAM_ID, APNS_BUNDLE_ID (and optionally APNS_KEY_FILE, APNS_ENV) in
notify.env; the .p8 lives in deploy/apns/, gitignored. Devices come from
integrations/devices.json, written by the app through POST /api/devices. With
no device or no key it falls through to ntfy and says so in `detail`.
"""
import argparse
import base64
import json
import os
import sys
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from collections import namedtuple
from pathlib import Path

# The repo this file lives in, unless OBLIGATIONS says otherwise. It used to be
# ~/obligations, true on linuxbox and wrong on the Mac mini, where the working copy
# is ~/Developer/obligations (2026-10-01) — a test run without OBLIGATIONS read the old
# path and failed. Where the script is, is where the repo is.
OBLIGATIONS = Path(os.environ.get("OBLIGATIONS") or Path(__file__).resolve().parents[1])
TIMEOUT = 15

# Both providers sit behind Cloudflare, which 403s urllib's default
# `Python-urllib/3.x`. Identifying ourselves is not politeness, it is the
# difference between working and not.
UA = "obligations/1.0 (+https://obligations.example.com)"

# `channel` is the name of whatever actually delivered — 'ntfy', 'sms', or
# 'none'. It is what goes into `delivered:`, so it must never be optimistic.
Delivery = namedtuple("Delivery", "channel ok detail")


def _read(path):
    out = {}
    if not path.exists():
        return out
    for ln in path.read_text().splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def config():
    """`deploy/.env`, then `deploy/notify.env` on top.

    Deliberately file-only, never `os.environ`: the dispatcher runs from systemd
    with a minimal environment, and reading the process env would make behaviour
    depend on who launched it. notify.env wins so a secret can be moved out of
    the container-visible file without touching anything else.
    """
    cfg = _read(OBLIGATIONS / "deploy" / ".env")
    cfg.update(_read(OBLIGATIONS / "deploy" / "notify.env"))
    return cfg


# --------------------------------------------------------------------- ntfy

def header_value(value):
    """A string that can travel in an HTTP header.

    urllib encodes headers as Latin-1 and raises on anything else — an em dash
    included. The reminder ladder's rungs 2–4 are titled "Reminder — overdue
    33h" and "Reminder — needs a decision", so every one of them failed inside
    send(), returned ok=False, and was retried silently every minute for two
    days while rung 1 ("Reminder") kept working. ntfy decodes RFC 2047 in Title,
    so the dash survives instead of being replaced.
    """
    value = str(value)
    try:
        value.encode("latin-1")
        return value
    except UnicodeEncodeError:
        return "=?UTF-8?B?" + base64.b64encode(value.encode("utf-8")).decode("ascii") + "?="


def _send_ntfy(cfg, title, body, priority, tag, meta=None):
    topic = cfg.get("NTFY_TOPIC")
    if not topic:
        return Delivery("none", False, "NTFY_TOPIC is not set in deploy/notify.env")

    server = cfg.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    headers = {"Title": header_value(title), "Priority": priority}
    if tag:
        headers["Tags"] = header_value(tag)
    # Where a tap goes. The same `meta.url` the APNs payload carries, so the
    # web app and the native app open the same page for the same push.
    if meta and meta.get("url"):
        headers["Click"] = absolute_url(cfg, meta["url"])
    headers["User-Agent"] = UA
    req = urllib.request.Request(f"{server}/{topic}", data=body.encode("utf-8"),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return Delivery("ntfy", 200 <= r.status < 300, f"HTTP {r.status}")
    except urllib.error.HTTPError as e:
        return Delivery("none", False, f"HTTP {e.code}")
    except Exception as e:                            # noqa: BLE001
        return Delivery("none", False, f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------- sms

def _send_sms(cfg, title, body, priority, tag, meta=None):
    """voip.ms. The destination is `SMS_TO` from config, always.

    Title and body are joined because SMS has no title. A code relay should pass
    the whole text as `body` and leave `title` empty, so that what Apple parses
    is exactly what was intended — a stray prefix can stop autofill matching.
    """
    need = ("VOIPMS_USER", "VOIPMS_PASS", "VOIPMS_DID", "SMS_TO")
    missing = [k for k in need if not cfg.get(k)]
    if missing:
        return Delivery("none", False, f"missing in deploy/notify.env: {', '.join(missing)}")

    text = f"{title}\n\n{body}" if title and body else (title or body)
    params = urllib.parse.urlencode({
        "api_username": cfg["VOIPMS_USER"],
        "api_password": cfg["VOIPMS_PASS"],
        "method": "sendSMS",
        "did": "".join(c for c in cfg["VOIPMS_DID"] if c.isdigit()),
        "dst": "".join(c for c in cfg["SMS_TO"] if c.isdigit()),
        "message": text,
    })
    url = cfg.get("VOIPMS_URL", "https://voip.ms/api/v1/rest.php")

    # GET with the credentials in the query string is what this API takes. It is
    # over TLS and the URL is never logged or passed through a shell, which is
    # the reason for urllib rather than curl.
    req = urllib.request.Request(f"{url}?{params}", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            payload = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        # A status code means the request was seen and rejected. Definitely not
        # sent, so a retry is safe — unlike the case below.
        return Delivery("none", False, f"rejected: HTTP {e.code}")
    except Exception as e:                            # noqa: BLE001
        # No status: a timeout, a dropped connection, a DNS failure mid-flight.
        # The send may well have gone through, so this is AMBIGUOUS and the
        # caller must not retry — see the module docstring. Distinguishing this
        # from the case above is the whole point of catching them separately.
        return Delivery("none", False, f"ambiguous, may have sent: {type(e).__name__}: {e}")

    if payload.get("status") == "success":
        return Delivery("sms", True, f"sms {payload.get('sms', '?')}")
    return Delivery("none", False, payload.get("status", "unknown error"))


def absolute_url(cfg, url):
    base = cfg.get("OBLIGATIONS_URL", "https://obligations.example.com").rstrip("/")
    return url if str(url).startswith("http") else base + "/" + str(url).lstrip("/")


def _devices():
    """Active APNs tokens from integrations/devices.json. Empty is a fact, not an error."""
    f = OBLIGATIONS / "integrations" / "devices.json"
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        return []
    return [d for d in data.get("devices", []) if d.get("token") and not d.get("stale_at")]


def _retire(tokens, reason):
    """APNs said these tokens are gone. Mark them; never delete a record."""
    if not tokens:
        return
    f = OBLIGATIONS / "integrations" / "devices.json"
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        return
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    for d in data.get("devices", []):
        if d.get("token") in tokens and not d.get("stale_at"):
            d["stale_at"], d["stale_reason"] = stamp, reason
    f.write_text(json.dumps(data, indent=1) + "\n")


def node_binary():
    """`node`, wherever it is. systemd starts the dispatcher with a minimal PATH
    and node lives under nvm, so a bare "node" is "command not found" there —
    the iOS session found the sender unreachable from the very process that
    was meant to call it. PATH first, then the newest nvm install."""
    found = shutil.which("node")
    if found:
        return found
    versions = sorted((Path.home() / ".nvm" / "versions" / "node").glob("v*/bin/node"),
                      key=lambda x: [int(n) for n in x.parts[-3][1:].split(".")])
    return str(versions[-1]) if versions else "node"


def _send_apns(cfg, title, body, priority, tag, meta=None):
    """Push through Apple, via deploy/notify-apns.mjs (HTTP/2 lives in Node here).

    The document goes over stdin — never argv, never the environment — for the
    same reason the ntfy sender uses urllib and not curl. With no registered
    device, or no key configured, it falls through to ntfy: the app arriving
    later must not make pushes disappear in the meantime, and `delivered:`
    names whichever channel actually carried it.
    """
    devices = _devices()
    if not devices:
        d = _send_ntfy(cfg, title, body, priority, tag, meta)
        return Delivery(d.channel, d.ok, f"apns: no registered device; {d.detail}")
    doc = {
        "cfg": {k: cfg.get(k) for k in ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID", "APNS_KEY_FILE", "APNS_ENV")},
        "devices": [{"token": d["token"], "env": d.get("env")} for d in devices],
        "message": {"title": title, "body": body, "priority": priority, "tag": tag, "meta": meta or {}},
    }
    proc = subprocess.run([node_binary(), str(OBLIGATIONS / "deploy" / "notify-apns.mjs")], input=json.dumps(doc),
                          capture_output=True, text=True, timeout=30, cwd=str(OBLIGATIONS))
    try:
        r = json.loads(proc.stdout or "{}")
    except ValueError:
        return Delivery("none", False, f"apns: unreadable result: {(proc.stderr or proc.stdout)[:120]}")
    _retire(r.get("stale") or [], "APNs: device token gone")
    if r.get("ok"):
        return Delivery("apns", True, f"apns: {len(r.get('sent', []))} device(s)")
    why = "; ".join(f"{f.get('token') or '-'}: {f.get('status')} {f.get('reason')}" for f in r.get("failed", [])) or "no device took it"
    # Apple refused or was unreachable. The push still has to land somewhere:
    # Alex, 2026-09-05, "replace the old notifier with this push" — replace,
    # not "lose reminders whenever Apple hiccups". ntfy carries it and the
    # record says so.
    d = _send_ntfy(cfg, title, body, priority, tag, meta)
    return Delivery(d.channel, d.ok, f"apns failed ({why[:120]}); {d.detail}")


CHANNELS = {"ntfy": _send_ntfy, "sms": _send_sms, "apns": _send_apns}


def send(title, body, priority="default", tag=None, channel=None, cfg=None, meta=None):
    """Deliver one message. Returns a Delivery; never raises.

    Never raising is the point: this is called from the minute dispatcher, and a
    notification failing must not stop reminders being processed.
    """
    cfg = config() if cfg is None else cfg
    name = channel or cfg.get("PUSH_CHANNEL", "ntfy")
    fn = CHANNELS.get(name)
    if fn is None:
        return Delivery("none", False, f"unknown channel: {name}")
    try:
        return fn(cfg, title, body, priority, tag, meta)
    except Exception as e:                            # noqa: BLE001
        return Delivery("none", False, f"{type(e).__name__}: {e}")


def main():
    ap = argparse.ArgumentParser(description="Send one notification.")
    ap.add_argument("--title", default="")
    ap.add_argument("--body", help="message text; use --body-file - for stdin")
    ap.add_argument("--body-file")
    ap.add_argument("--priority", default="default")
    ap.add_argument("--tag")
    ap.add_argument("--channel", choices=sorted(CHANNELS))
    args = ap.parse_args()

    if args.body_file == "-":
        body = sys.stdin.read()
    elif args.body_file:
        body = Path(args.body_file).read_text()
    else:
        body = args.body or ""

    d = send(args.title, body.rstrip(), args.priority, args.tag, args.channel)
    # The channel is on stdout so a shell caller can put it in `delivered:`;
    # the detail is on stderr so it does not get captured by mistake.
    print(d.channel)
    if not d.ok:
        print(d.detail, file=sys.stderr)
    return 0 if d.ok else 1


if __name__ == "__main__":
    sys.exit(main())
