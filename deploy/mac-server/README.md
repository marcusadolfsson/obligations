# Obligations Server — the assistant's server on a Mac

The service (`deploy/agent-service/server.mjs`) and the minute dispatcher
(`deploy/reminder-dispatch.py`), run on a Mac, inside
a sandbox, by an app that holds no privacy grants. Why it is shaped this way is
in `docs/why.md`, "Two apps, not two machines".

## Two apps

| | Obligations.app (`deploy/mac-app`) | Obligations Server.app (here) |
|---|---|---|
| UI | the menu — the only one | none |
| Holds | Full Disk Access, Contacts, Reminders, Automation for Messages | nothing |
| Runs | extractors (bundled copies), the outbox sender, the Reminders bridge | the service and the dispatcher, sandboxed |
| Never | runs anything from the repo | reads under `$HOME` but the repo; writes outside it; sends Apple Events; writes preferences |

They exchange data files in the repo (`~/Developer/obligations`) and nothing else.

## Files

| | |
|---|---|
| `server.sb` | the Seatbelt profile; the copy inside the signed bundle is the one used |
| `sandbox.test.sh` | every deny denies, every allow allows — run against the shipped profile by default |
| `Sources/ObligationsServer/main.swift` | `obligations-server`: the launcher, and the commands Obligations.app drives |
| `LaunchAgents/*.plist` | `com.example.obligations.server` (KeepAlive) and `com.example.obligations.dispatch` (every 60s) |
| `build.sh` | sandbox test → compile → assemble → sign (no entitlements, checked) → install |

What the launcher does on every start: reads `deploy/.env` as `docker
--env-file` did, then forces `HOST=127.0.0.1`, `PORT=7683`, `OBLIGATIONS`,
`CLAUDE_CONFIG_DIR=deploy/claude-home`, the git identity `obligations`, and the
system time zone; reads the Claude token from `~/.obligations-server/claude-token`
outside the sandbox; points git at `deploy/github/deploy_key`; merges the trust
record into `deploy/claude-home/.claude.json`; then execs `sandbox-exec` with
the bundle's profile. It refuses — exit 78, with the reason in the log — if the
profile, node@22, the SDK or the repo is missing. It never runs unsandboxed.

## Running it

Everything is in the **Server** section of the Obligations menu: Install server,
Turn on…, Restart, Stop…, Sign in with Claude. Underneath:

```bash
"/Applications/Obligations Server.app/Contents/MacOS/obligations-server" status
```

```bash
launchctl print gui/$(id -u)/com.example.obligations.server
```

```bash
tail -50 ~/Library/Logs/Obligations\ Server/server.log
```

The service's own log is `.log/agent-service.log` as before; its heartbeat,
which the menu reads, is `.log/server-status.json`.

Rebuild after any change here (the profile, the launcher, the plists):

```bash
./deploy/mac-server/build.sh
```

A change to `deploy/agent-service/**` needs only a restart, not a rebuild.

## Exposing it

The server listens on one local port (7683). To reach it from a phone, put it
behind a tunnel with an identity check in front, for example a Cloudflare
Tunnel with two public hostnames, `obligations.example.com` (behind Access)
and `hook.example.com` (left outside Access, because the Gmail push
authenticates itself), both routed to `http://localhost:7683`.

**The rule: never two servers.** Two schedulers run the same jobs; two
dispatchers push the same reminders and both push to the remote. If you move
the server between machines, stop the old one before starting the new one.
