# Obligations for iPhone, iPad and Mac

A WKWebView around https://obligations.example.com, with push notifications.

```
cd deploy/ios-app
./build.sh sim                           # simulator: build, install, launch
./build.sh push-sim                      # deliver apns-sample.json to it
./build.sh device "Alex iPhone 17 Air" # signed build onto a paired iPhone or iPad
./build.sh mac --install                 # the Mac app, into /Applications
```

`xcodegen` is the only tool beyond Xcode (`brew install xcodegen`).

## What it is, and is not

Alex, 2026-09-05: "for now it will mostly be a wrapper for the webUI, but
with push notification support … eventually we will have a native
implementation of the webui, but not until we have locked the feature set."

So: the web UI, exactly as served, in a web view that keeps its own cookies.
Two things the home-screen bookmark could not do — a real push channel, and
an app icon with no Safari chrome — and nothing else. There is no native
screen, no native call to `/api/*` beyond the one below, no caching layer.
When the feature set is locked, the native UI replaces the web view here;
the push plumbing stays.

Not a second copy of `deploy/mac-app`. That is the menu-bar extractor
(`com.example.obligations`, `Obligations.app`) and keeps its own repo directory and
SwiftPM build. This is `com.example.obligations.app`, and on the Mac it is
`Obligations Web.app`, so the two never share a bundle name in `/Applications`.

## Identifiers

| | |
|---|---|
| bundle id | `com.example.obligations.app` — same on iOS and macOS, so one APNs topic |
| team | your team, `ABCDE12345` |
| signing | automatic, `Apple Development: Your Name (XXXXXXXXXX)` |
| targets | iOS 17 (iPhone + iPad, one target), macOS 14 (native, not Catalyst) |
| APNs | `development` entitlement in both builds → the **sandbox** gateway |

Automatic signing registered the App ID with the push capability on the
first device build (2026-09-05); the team provisioning profiles for both
platforms carry `aps-environment`.

## Sign-in

Cloudflare Access fronts the site and sends unauthenticated requests through
Google. The web view uses the persistent default data store, so the
`CF_Authorization` cookie survives relaunches and the app never handles a
credential itself. One thing had to be arranged for that to work: Google
refuses embedded web views by inspecting the user agent, so
`ObligationsConfig.userAgentSuffix` makes WebKit's user agent end the way Safari's
does. Without it the first launch is a `disallowed_useragent` page and no
cookie is ever set.

Login codes keep arriving by SMS. WKWebView offers one-time-code autofill for
an `autocomplete=one-time-code` field the same as Safari does.

## Push

**Registration** — `DeviceRegistration.swift`. On launch the app asks for
permission, asks APNs for a token, and after the next obligations page finishes
loading runs a `fetch` *inside the page*:

```
POST /api/devices
{ "platform": "ios" | "ipados" | "macos", "token": "<hex>",
  "bundle": "com.example.obligations.app", "env": "sandbox" | "production",
  "name": "<device name>", "app": "1.0 (1)" }
```

Through the page rather than URLSession because the page already holds the
Access cookie, so the server takes the identity from the same verified JWT
it takes everything else from. It is re-sent on every launch (idempotent),
retried on later page loads until a 2xx, and stops for the launch on a 404 —
the server without the endpoint yet, pushes still coming via ntfy.
`DELETE /api/devices {token}` unregisters; only the Mac's status window calls it.

**Delivery** — `PushCoordinator.swift`. The payload the server sends:

```
{ "aps": { "alert": { "title", "body" }, "sound": "default",
           "interruption-level": "active" | "time-sensitive", "thread-id": "<kind>" },
  "obligations": { "kind": "brief" | "reminder" | "prep" | "debrief" | "note" | "failure",
             "url": "/outbox" | "/digest#pane=<id>", "id": "<message id>" } }
```

A tap loads `obligations.url` in the web view: a path is resolved against the
origin, an absolute URL is accepted only on the assistant's host. A tap that
launches the app is held until the web view exists. Banners show even while
the app is in front.

**What the page can see** — `window.obligationsApp` is defined at document start:
`{ platform, version, build, push: { state, token, env } }`, and `<html>`
gets the class `obligations-app`. `push.state` is `waiting`, `pending`,
`registered`, `failed: …` or `no token: …`, updated as it changes, so
`/system` can show whether this device is registered without a native view.

**Testing without a server** — `./build.sh push-sim` hands
`apns-sample.json` to the simulator, which is enough to exercise the tap →
page route. The simulator issues no real token.

## Location

Alex, 2026-09-06: "send a location every so often from it … helpful for
the assistant to understand where Alex is and where he has been."

`LocationReporter.swift`. The OS decides when: iOS's **significant-change**
service (a fix on moving roughly 500 m, at most every few minutes) and
**visits** (arrival at and departure from a place he stayed), plus **one fix
at launch** on both platforms and a **manual** one from the Mac's Go menu or
the page (`window.obligationsApp.sendLocation()`). A handful to a few dozen points
a day, none while he sits still. No timer, no continuous updates — there is
no code path that asks more often than the system offers.

```
POST /api/location   { "points": [ { lat, lon, accuracy_m, at_ms, place,
                                     source: "significant"|"visit"|"launch"|"manual",
                                     platform } ] }
```

`at_ms` is the fix's time, not the send's. `place` is named **on the
device** by CLGeocoder (a point of interest, else the geocoder's name for
the spot, else the town), so the server never has to send a coordinate of
his anywhere to learn what it is. Points queue on disk until a 2xx, are
sent in batches of up to 200, and a 400 drops the batch (the server named a
bad field; resending it would fail forever).

Unlike device registration this **cannot go through the page**: iOS wakes
the app in the background for a location event with no web view loaded. So
the POST is native, carrying the assistant's cookies copied out of the web
view's store — the same Access session, sent by URLSession. The
`location` background mode and a background task give the wake enough time
to geocode and POST. Permission: When-In-Use first, then Always is asked
once; without Always the app still reports a fix each time it is opened.

The Mac reports too (a launch fix and significant changes by Wi-Fi), under
the sandbox's location entitlement. The Mac status window shows what the
obligations currently believes (`GET /api/location`'s `now`).

## The APNs key (server side)

The server sends with token-based auth and needs, once:

1. developer.apple.com → Certificates, Identifiers & Profiles → **Keys** →
   `+` → name it, tick **Apple Push Notifications service (APNs)** →
   Register → **Download** (`AuthKey_<KEYID>.p8`, offered exactly once).
2. `scp AuthKey_<KEYID>.p8 linuxbox:obligations/deploy/apns/` — that directory is
   gitignored on the server; the key must never be committed.
3. Tell the server session the **Key ID**, the Team ID `ABCDE12345`, the
   bundle id above, and that the current builds are **sandbox**.

## Layout

```
project.yml              the project; xcodegen generates the gitignored .xcodeproj
build.sh                 generate → build → install, per destination
apns-sample.json         a payload in the server's shape, for the simulator
Resources/
  Assets.xcassets        AppIcon (iOS 1024 + the ten Mac sizes), PageBackground
  make-icon.py           draws the icon; the PNGs are its output, not hand art
Sources/Shared/
  ObligationsConfig.swift      origin, identifiers, platform, APNs env, user agent
  WebController.swift    the one web view; navigation policy; the page bridge
  DeviceRegistration.swift  the token, and POST /api/devices through the page
  PushCoordinator.swift  permission, token request, tap → URL
  LocationReporter.swift significant changes, visits, launch fix; queue; POST /api/location
  ErrorOverlay.swift     "can't reach the assistant", with retry
  Log.swift              unified log + a tail for the status window
Sources/iOS/             @main, the UIViewRepresentable with pull-to-refresh
Sources/macOS/           @main with a Go menu, the NSViewRepresentable, the Status window
```

## Decisions worth knowing before changing things

**Top safe area is respected natively, bottom is the page's.** The page's
header is sticky at `top:0` and does not pad for a status bar, because
until now it always had Safari's chrome above it; the bottom already pads
with `env(safe-area-inset-bottom)`. So the web view starts below the status
bar (the strip is painted in the page's own background colour) and runs
under the home indicator. If the page ever pads its top with
`env(safe-area-inset-top)`, drop the `.top` exclusion in `ContentView`.

**Links off the assistant open in the browser; everything else stays.** Only a
*tapped link* from a *obligations page* to another host leaves. Redirects, form
posts and script navigations are left alone, because sign-in bounces
through `cloudflareaccess.com` and `accounts.google.com` and the cookie has
to land in this web view. `target=_blank` and `window.open` never open a
second window: obligations URLs load here, others go to the browser.

**One web view for the app's lifetime.** The cookie, the chat drawer's
transcript and the back stack all live in it. Multiple windows on iPad are
off for that reason.

**`env` is read from the embedded provisioning profile**, not from `DEBUG`.
A Debug build exported through TestFlight is production, and a server
sending to the wrong gateway gets `BadDeviceToken` and nothing else. The
simulator reports `sandbox`.

**Not yet:** `remote-notification` in `UIBackgroundModes` (silent pushes), a
badge count, photo upload for journal context, and any native page. Each is a small addition when the server
has a reason to want it.
