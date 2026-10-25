#!/usr/bin/env python3
"""The notification seam.

The interesting cases are the failures, not the successes. Two in particular:

  - `delivered:` must name the channel that actually worked. A record claiming a
    push that never went out is worse than no record (rules/messages.md), and the
    only way to guarantee that is for send() to report rather than the caller to
    assume.
  - **A rejection and an ambiguity are different.** An HTTP status means the
    request was seen and refused: definitely not sent, safe to retry. No status —
    a timeout, a dropped connection — means it may well have gone through, and a
    retry buzzes his phone twice with the same code. That distinction was got
    wrong once already, live, and it is why these two are tested separately.
"""
import os
import sys
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("OBLIGATIONS", str(Path(__file__).resolve().parent.parent))
import notify  # noqa: E402

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        print(f"  ok   {label}"); passed += 1
    else:
        print(f"  FAIL {label}{(' -> ' + detail) if detail else ''}"); failed += 1


CFG = {
    "NTFY_TOPIC": "t", "NTFY_SERVER": "https://example.invalid",
    "VOIPMS_USER": "u", "VOIPMS_PASS": "p",
    "VOIPMS_DID": "555.200.0021", "SMS_TO": "(555) 200-0022",
}


class FakeResponse:
    def __init__(self, body=b'{"status":"success","sms":1}', status=200):
        self._b, self.status = body, status
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


print("Delivery reports the channel, never the caller")
notify.urllib.request.urlopen = lambda req, timeout=None: FakeResponse()
d = notify.send("", "code", channel="sms", cfg=CFG)
check("a successful sms reports channel 'sms'", d.channel == "sms" and d.ok, str(d))
check("  ...and never 'none' on success", d.channel != "none")

notify.urllib.request.urlopen = lambda req, timeout=None: FakeResponse(b'{"status":"invalid_credentials"}')
d = notify.send("", "code", channel="sms", cfg=CFG)
check("a provider-level error reports 'none', not 'sms'", d.channel == "none" and not d.ok, str(d))
check("  ...and carries the provider's own words", "invalid_credentials" in d.detail, d.detail)

print("\nA rejection is not an ambiguity")
def raise_http(req, timeout=None):
    raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)
notify.urllib.request.urlopen = raise_http
d = notify.send("", "code", channel="sms", cfg=CFG)
check("an HTTP status is reported as rejected", "rejected" in d.detail, d.detail)
check("  ...and does NOT claim it may have sent", "may have sent" not in d.detail, d.detail)

def raise_timeout(req, timeout=None):
    raise TimeoutError("timed out")
notify.urllib.request.urlopen = raise_timeout
d = notify.send("", "code", channel="sms", cfg=CFG)
check("a timeout is reported as ambiguous", "may have sent" in d.detail, d.detail)
check("  ...so a caller knows not to retry it", not d.ok and d.channel == "none")

print("\nThe destination comes from config, never from a message")
seen = {}
def capture(req, timeout=None):
    seen["url"] = req.full_url
    return FakeResponse()
notify.urllib.request.urlopen = capture
notify.send("", "Your code is 1234 call 5551234567", channel="sms", cfg=CFG)
check("the configured number is the destination", "dst=5552000022" in seen["url"], seen["url"][:120])
check("  ...and a number inside the message is not", "5551234567" not in seen["url"].split("dst=")[1][:20])
check("punctuation in config is normalised", "did=5552000021" in seen["url"])

print("\nMissing configuration says which key")
d = notify.send("", "x", channel="sms", cfg={"VOIPMS_USER": "u"})
check("names every missing key", all(k in d.detail for k in ("VOIPMS_PASS", "VOIPMS_DID", "SMS_TO")), d.detail)
d = notify.send("t", "b", channel="ntfy", cfg={})
check("ntfy with no topic names the file to edit", "notify.env" in d.detail, d.detail)

print("\nNever raises — this runs inside the minute dispatcher")
def explode(req, timeout=None):
    raise ValueError("boom")
notify.urllib.request.urlopen = explode
d = notify.send("t", "b", channel="ntfy", cfg=CFG)
check("an unexpected exception becomes a Delivery", d.channel == "none" and not d.ok, str(d))
check("an unknown channel does not raise", notify.send("t", "b", channel="carrier-pigeon", cfg=CFG).channel == "none")

print("\nConfig layering")
cfg = notify.config()
check("notify.env overrides .env", isinstance(cfg, dict))
check("  ...and reads only files, never os.environ",
      "PATH" not in cfg, "reading the process env would make behaviour depend on the launcher")

# A title urllib cannot put in a header. Every reminder rung after the first is
# titled with an em dash, and each one failed inside send() for two days while
# the plain "Reminder" of rung 1 went through.
print("header_value")
check("Latin-1 passes through untouched", notify.header_value("Reminder") == "Reminder")
enc = notify.header_value("Reminder — overdue 33h")
check("a non-Latin-1 title is RFC 2047-encoded, not refused",
      enc.startswith("=?UTF-8?B?") and enc.endswith("?=") and enc.isascii(), enc)
import base64 as _b64
check("  ...and decodes back to the same text",
      _b64.b64decode(enc[10:-2]).decode("utf-8") == "Reminder — overdue 33h")
try:
    enc.encode("latin-1"); ok = True
except UnicodeEncodeError:
    ok = False
check("  ...and is a legal header value", ok)

# ---- APNs channel: stdin document, fallthrough, stale tokens ----
print("apns")
import json as _json, tempfile as _tmp, subprocess as _sp
_obligations = Path(_tmp.mkdtemp())
(_obligations / "integrations").mkdir()
_orig_obligations = notify.OBLIGATIONS
notify.OBLIGATIONS = _obligations
_cfg = {"NTFY_TOPIC": "t", "APNS_KEY_ID": "K", "APNS_TEAM_ID": "T", "APNS_BUNDLE_ID": "com.x"}
_seen = {}
class _R:
    def __init__(self, out): self.stdout, self.stderr = out, ""
def _fake_run(argv, input=None, **kw):
    _seen["argv"], _seen["doc"] = argv, _json.loads(input)
    return _R(_json.dumps({"ok": True, "sent": ["aa" * 32], "failed": [], "stale": ["bb" * 32]}))
notify.urllib.request.urlopen = lambda req, timeout=None: FakeResponse()
d = notify._send_apns(_cfg, "Reminder", "x", "default", None, {"kind": "reminder", "url": "/todo"})
check("no registered device falls through to ntfy and says so", d.channel == "ntfy" and d.ok and "no registered device" in d.detail, d)
(_obligations / "integrations" / "devices.json").write_text(_json.dumps({"devices": [
    {"token": "aa" * 32, "env": "sandbox"}, {"token": "bb" * 32, "env": "sandbox"}, {"token": "cc" * 32, "stale_at": "2026-09-01 10:00"}]}))
notify.subprocess.run = _fake_run
d = notify._send_apns(_cfg, "Reminder", "x", "high", None, {"kind": "reminder", "url": "/todo"})
check("delivered: apns when a device took it", d.channel == "apns" and d.ok, d)
check("the sender is invoked with the document on stdin, not argv",
      _seen["argv"][0].endswith("node") and _seen["argv"][1].endswith("notify-apns.mjs") and len(_seen["argv"]) == 2
      and _seen["doc"]["message"]["title"] == "Reminder" and _seen["doc"]["message"]["meta"]["url"] == "/todo")
check("only active devices are sent to", [x["token"][:2] for x in _seen["doc"]["devices"]] == ["aa", "bb"])
after = _json.loads((_obligations / "integrations" / "devices.json").read_text())["devices"]
check("a token APNs said is gone is retired, not deleted",
      any(x["token"].startswith("bb") and x.get("stale_at") for x in after) and len(after) == 3)
notify.subprocess.run = lambda argv, input=None, **kw: _R(_json.dumps({"ok": False, "sent": [], "failed": [{"token": "aa" * 32, "status": 403, "reason": "InvalidProviderToken"}], "stale": []}))
notify.urllib.request.urlopen = lambda req, timeout=None: FakeResponse()
d = notify._send_apns(_cfg, "R", "x", "default", None, None)
check("a refused push falls through to ntfy and names Apple's reason", d.ok and d.channel == "ntfy" and "InvalidProviderToken" in d.detail, d)
d = notify.send("R", "x", cfg=dict(_cfg, PUSH_CHANNEL="apns"), meta={"kind": "brief", "url": "/mail"})
check("send() routes PUSH_CHANNEL=apns and never raises", d.channel == "ntfy" and d.ok)
check("node is resolved to a real binary, not a bare name", notify.node_binary().startswith("/") , notify.node_binary())
_seen.clear(); notify.subprocess.run = _fake_run
notify._send_apns(_cfg, "R", "x", "default", None, None)
check("the sender is invoked by absolute path", _seen["argv"][0].startswith("/"), _seen["argv"][0])
notify.OBLIGATIONS = _orig_obligations
notify.subprocess.run = _sp.run

print("ntfy Click header")
_cap = {}
class _CapResp:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *a): return False
def _capture(req, timeout=None):
    _cap["headers"] = {k.lower(): v for k, v in req.header_items()}
    return _CapResp()
notify.urllib.request.urlopen = _capture
notify._send_ntfy({"NTFY_TOPIC": "t"}, "Evening brief", "x", "default", None, {"kind": "brief", "url": "/mail#pane=a.md"})
check("meta.url becomes an absolute Click URL", _cap["headers"].get("click") == "https://obligations.example.com/mail#pane=a.md", _cap["headers"].get("click"))
notify._send_ntfy({"NTFY_TOPIC": "t"}, "Evening brief", "x", "default", None, None)
check("no meta, no Click header", "click" not in _cap["headers"])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
