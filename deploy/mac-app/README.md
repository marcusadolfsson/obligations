# Obligations.app

A menu bar app that replaces the LaunchAgents on Alex's Mac.

```
cd deploy/mac-app
./build.sh                     # compile, sign, install to /Applications
./build.sh --uninstall-agents  # retire the plists it replaces
```

## What it does

| | |
|---|---|
| **iMessage** | every 15 min → `integrations/imessage.json` |
| **Phone Calls** | every 30 min → `integrations/calls.json` |
| **Contacts** | every 6 h → `integrations/contacts.json` |
| **Last sync / Force Sync** | per source, in the menu |
| **Google accounts** | add a grant, upload it, notice when it goes stale |

## Why an app instead of four plists

The plists worked, but they were undiagnosable when they didn't.

**The permission was attached to the wrong thing.** LaunchAgents ran
`/usr/bin/python3`, so Full Disk Access had to be granted to *the interpreter*.
That grant is invisible in the app list, breaks when the OS updates Python, and
is shared with every other script on the machine. A signed app bundle is the
responsible process, so the grant follows *this* app and survives.

**Failure was silent.** `install-mac.sh` probed for the grant by chmod'ing
`/dev/null`, which cannot be chmod'ed — so the probe failed for a reason that
had nothing to do with permissions, printed a confident and wrong diagnosis
about Contacts and FaceTime, and two extractors had never once run. Nobody knew
for days, because the only evidence was four separate files in
`~/Library/Logs`. The menu answers "is the assistant getting what it needs from
this Mac?" in one line, and every check here is done by *doing the thing* —
opening `chat.db`, spending the refresh token — rather than by a proxy.

**OAuth was a script you ran by hand.** Adding a mailbox meant running
`install-gmail.sh`, then `scp`, twice, into a directory that had to already
exist. Now it is a menu item, and staleness is detected before the 07:00 job
finds it.

## What it deliberately does not do

**It sends iMessages — since 2026-09-01, and this section used to say it did
not.** The sender was ported into the app at Alex's request and the
LaunchAgent retired; `launchctl` should show exactly one sender, never two.
Two senders polling one outbox on the same minute can send one approved draft
twice, which is the failure that ends the channel.

Both refusals came across literally, and they are the whole design: only
`status: approved` is sent, re-checked after fetch so a discard wins the race;
and the recipient must already appear in a recent thread, read from the extract
so the allowlist is no wider than what the agent could see. An unreadable
allowlist means *unknown*, not empty, so nothing sends. It never retries — a
message that silently arrives twice is worse than one that visibly did not.

The receipt is written back to `outbox/` and stops there. `deploy/reminder-dispatch.py`
commits it on the next minute tick, so what was sent as Alex is answerable
from `git log`. The Mac does not push commits: it already holds the only
capability that acts outward as him, and a second one on the same machine is
worth avoiding.

**It does not re-implement extraction.** The three extractors are the tested
Python, copied verbatim into `Contents/Resources/` at build time. Their handle
normalisation already caused one wrong-person bug — a text from "Hank" resolving
to a different contact entirely — and re-deriving that in Swift to save a
subprocess is a bad trade. `deploy/test.sh` still covers them.

**It does not pull.** The Mac pushes to the assistant over Tailscale and the assistant
holds no credentials into this machine. That predates the app and should
survive any rewrite of the transport.

**It is not sandboxed.** It can't be: the sandbox denies `chat.db` before TCC is
consulted, and reading it is the app's job. Hardened Runtime is on, and
`Obligations.entitlements` argues the whole trade rather than just declaring it.

## Layout

```
Package.swift            SwiftPM, no .xcodeproj — this repo's history stays readable
Info.plist               bundle id, LSUIElement, the Contacts prompt text
Obligations.entitlements       why it is not sandboxed
build.sh                 compile → assemble → sign → install
Sources/Obligations/
  ObligationsApp.swift         @main, the delegate that starts the engine at launch
  MenuView.swift         the dropdown
  Sync.swift             the three jobs, the schedule, what happened last time
  Runner.swift           subprocesses, with all three answers
  Transport.swift        scp, push-only
  Permissions.swift      FDA and Contacts, checked by doing
  GoogleAuth.swift       loopback OAuth with PKCE; staleness by spending the token
  Accounts.swift         accounts, and the state-dir mapping shared with the server
  Config.swift           host, paths, logging
```

`GoogleAccount.remoteStateDir` must stay in step with `stateDir()` in
`deploy/mcp/google-auth.mjs`. They are the same decision in two languages, and
if they disagree the app uploads a grant the server never reads.

## Building

Needs Xcode command line tools and a Developer ID Application identity.

```
OBLIGATIONS_SIGN_ID="Developer ID Application: ..." ./build.sh
```

Ad-hoc signing (`OBLIGATIONS_SIGN_ID=-`) works for testing, but the signature changes
on every build, so macOS asks for Full Disk Access again each time.

**What is actually installed, and when it will break.** There is no Developer ID
Application identity in the keychain, so the running app is signed with

```
OBLIGATIONS_SIGN_ID="Apple Development: Your Name (XXXXXXXXXX)" ./build.sh
```

That is stable across rebuilds, which is the property TCC cares about — but an
Apple Development certificate expires after a year, and both grants are keyed
to the signature. When it lapses the app will not report a permissions error in
any new way: it will simply say it needs Full Disk Access again, on a machine
where nothing was changed. Re-signing with a **Developer ID Application**
certificate instead avoids the expiry entirely and is available on the existing
paid account. The certificate itself expires a year after it is made;
it signs both the Studio and the Mac mini, so both will ask for Full Disk
Access again on that day.

A fresh machine also needs the **WWDR G3 intermediate** in its keychain, or
codesign stops at "unable to build chain to self-signed root" /
`errSecInternalComponent` with the identity present and valid-looking. macOS
ships only the legacy WWDR (expired 2023). Fix:

```
curl -fLO https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
security add-certificates -k ~/Library/Keychains/login.keychain-db AppleWWDRCAG3.cer
security find-identity -v -p codesigning   # identity now listed
```

Judge that from a GUI terminal: over ssh the login keychain stays locked and
`find-identity` reports 0 identities even when everything is fine.

After the first install, three things by hand, once: Full Disk Access (the menu
links to the pane — macOS gives apps no way to request it), Contacts when it
asks, then `--uninstall-agents`. Until that last step launchd and the app both
extract on their own schedules and race on the same output paths.
