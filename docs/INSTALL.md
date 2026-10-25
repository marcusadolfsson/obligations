# Installing Obligations

This guide takes you from a fresh clone to a first morning brief. Allow an
afternoon. Most of the time goes on Google Cloud and Apple signing, not on
Obligations itself.

There are two ways to run it:

| | Mac (recommended) | Linux server |
|---|---|---|
| Runs the service | Obligations Server.app, sandboxed, native | Docker containers under systemd |
| Reads iMessage, calls, Contacts, Reminders | yes, through Obligations.app | no |
| Sends approved texts | yes | no |
| Needs | macOS 14+, Xcode command line tools, Homebrew | Docker, systemd, a box that stays on |

Mail, calendar, the task list, the brief, drafts and the web UI work the same
on both. Texts and Contacts need a Mac, because the data only exists there.

---

## 1. Make your own private copy

Once Obligations runs, the repo holds your mail conclusions, your contacts, your
journal and everything you owe. **Keep your copy private.**

1. On GitHub, create an empty **private** repository, for example `you/obligations`.
2. Clone this repo and point it at yours:

   ```bash
   git clone https://github.com/marcusadolfsson/obligations.git ~/Developer/obligations
   cd ~/Developer/obligations
   git remote rename origin upstream
   git remote add origin git@github.com:you/obligations.git
   git push -u origin main
   ```

On a Mac, keep the clone at `~/Developer/obligations`, because both apps look
there by default. To use another path, run
`defaults write com.example.obligations localRoot /your/path` and
`defaults write com.example.obligations.server repo /your/path` before the
first start.

## 2. Install the tools

**Mac**

```bash
xcode-select --install
brew install node@22 python@3.12 xcodegen
npm ci --prefix deploy/agent-service
```

The server is pinned to `/opt/homebrew/opt/node@22/bin/node`.

**Linux**

```bash
# Docker and git from your distribution, then:
docker build -t obligations:latest -f deploy/Dockerfile .
```

Then run the tests. The run must end with `ALL PASSED`:

```bash
./deploy/test.sh
```

## 3. Configure the owner and the model

```bash
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env`:

| Key | What to put |
|---|---|
| `OWNER_NAME` | Your full name. The prompts and drafted sign-offs use it. |
| `OWNER_FIRST` | Optional. Defaults to the first word of `OWNER_NAME`. |
| `OBLIGATIONS_MODEL` | Optional. The model for jobs and chat when nothing else says otherwise. |
| `ANTHROPIC_API_KEY` | Only if you'd rather use an API key than a Claude login (step 4). |

`deploy/.env` is gitignored. Never commit it.

Next, make the rules yours. `CLAUDE.md`, `rules/` and `jobs/` are written about
an example owner, Alex Rivera, and refer to the owner as "he". Read
`CLAUDE.md` once end to end and change anything that doesn't fit how you work:
the brief time, the quiet hours, the reminder limits.

## 4. Sign in to Claude

The jobs and the chat run through the Claude Agent SDK.

- **Mac:** do this after step 7. In the Obligations menu choose
  **Sign in with Claude**. The token is kept in
  `~/.obligations-server/claude-token`, outside the repo.
- **Linux:** run `./deploy/login.sh` once. The credentials land in
  `deploy/claude-home/`, which is gitignored and mounted into every job.

A subscription login bills against your plan. An API key bills per token.

## 5. Connect Google (mail, calendar, Drive)

Each Google account is one grant, named by a short slug you choose, such as
`personal` or `work`. Inside a grant you switch capabilities on and off:
`mail`, `calendar` and `drive`.

### 5a. Create the OAuth client, once

1. In the Google Cloud console, create a project.
2. Enable the **Gmail API**, the **Google Calendar API** and, if you want
   filing to Drive, the **Google Drive API**.
3. Set up the OAuth consent screen. If your mail is on Google Workspace,
   choose **Internal**. An External app left in Testing issues refresh tokens
   that expire after seven days, so mail works for a week and then fails with
   `invalid_grant`.
4. Create an OAuth client ID of type **Desktop app** and download the JSON.

A mailbox on a different Workspace tenant needs its own project in that tenant.

### 5b. Grant each account

On a machine with a browser:

```bash
node deploy/integrations/google-auth-cli.mjs --account=personal --enable=mail,calendar,drive
node deploy/integrations/google-auth-cli.mjs --account=work --enable=mail
```

The script asks for the OAuth client JSON from 5a, opens the consent screen,
and writes two files. They belong in `deploy/google/<account>/` on the machine
that runs the server. On a Mac, **Add…** in the Google accounts section of the
Obligations menu does the same thing and puts the grant in place for you.

These scopes are never requested: `gmail.settings.basic` (filters) and
`gmail.labels`. Scheduled jobs can't send mail whatever is granted.

### 5c. Fence each mailbox

Each mailbox is its own MCP server with its own deny rules. The repo ships with
two, `personal` and `work`. If your slugs are different, register each one:

```bash
node deploy/add-mailbox.mjs <account>
```

Then remove any `.mcp.json` entries and `.claude/settings.json` rules for
mailboxes you don't use. `deploy/mcp-check.mjs` asks the Gmail server what it
registered and checks the fences against it. Run it where the server's node
modules are: on Linux inside the container (the command is in
`deploy/README.md`), on a Mac with
`OBLIGATIONS_NODE_MODULES=deploy/agent-service/node_modules node deploy/mcp-check.mjs`.

It exits 2 when it couldn't check anything, which is not the same as passing.

### 5d. Optional: realtime mail

By default mail is polled. For push, create a Pub/Sub topic, give
`gmail-api-push@system.gserviceaccount.com` **Pub/Sub Publisher** on it, and
create a push subscription to `https://<your hook host>/hooks/gmail/<secret>`
with OIDC authentication. Then set `GMAIL_PUSH_SECRET`,
`GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SA` and `GMAIL_PUSH_TOPIC` in
`deploy/.env`. The comments in `deploy/.env.example` cover each one.

## 6. Notifications

Reminders, prep notes and the brief arrive as push notifications. Their
settings live in `deploy/notify.env`, which is host-only and gitignored. Create
it by hand.

**Easiest: ntfy.** Install the ntfy app on your phone and subscribe to a long
random topic name.

```bash
PUSH_CHANNEL=ntfy
NTFY_TOPIC=<a long random name>
# NTFY_SERVER=https://ntfy.sh
OBLIGATIONS_URL=https://obligations.example.com
```

**Native: APNs, with the iOS app from step 9.** In the Apple developer site,
create a key with **Apple Push Notifications service** and download
`AuthKey_<KEYID>.p8`. It's offered exactly once. Put it in `deploy/apns/` and
never commit it. Then:

```bash
PUSH_CHANNEL=apns
APNS_KEY_ID=<key id>
APNS_TEAM_ID=<your team id>
APNS_BUNDLE_ID=com.example.obligations.app
APNS_ENV=sandbox          # production once you ship through TestFlight or the App Store
```

Login codes can also go out by SMS through voip.ms (`SMS_TO`, `VOIPMS_USER`,
`VOIPMS_PASS`, `VOIPMS_DID`). This is optional.

## 7. Run it on a Mac

There are two apps, and the split is the security model:

- **Obligations.app** (`deploy/mac-app`) is the menu bar app. It holds Full
  Disk Access, Contacts, Reminders and Automation for Messages. It runs the
  extractors and the approved-text sender, and it never runs code from the
  repo.
- **Obligations Server.app** (`deploy/mac-server`) runs the service and the
  minute dispatcher inside a sandbox, with no grants at all.

### 7a. Signing

Both apps need a stable signing identity, or macOS asks for Full Disk Access
again after every build. A **Developer ID Application** certificate doesn't
expire with a one-year development certificate, so use one if you have it.
Otherwise use **Apple Development**:

```bash
security find-identity -v -p codesigning
export OBLIGATIONS_SIGN_ID="Developer ID Application: Your Name (TEAMID)"
```

If codesign fails with `unable to build chain to self-signed root`, install
Apple's WWDR G3 intermediate:

```bash
curl -fLO https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
security add-certificates -k ~/Library/Keychains/login.keychain-db AppleWWDRCAG3.cer
```

Check signing identities from a GUI terminal. Over ssh the login keychain stays
locked and shows none.

### 7b. Build and install

```bash
./deploy/mac-app/build.sh
./deploy/mac-server/sandbox.test.sh      # every deny denies, every allow allows
./deploy/mac-server/build.sh
```

### 7c. Grant permissions

Open Obligations.app, and grant what its menu asks for in System Settings →
Privacy & Security:

- **Full Disk Access**, to read `chat.db` (texts) and the call history.
- **Contacts**
- **Reminders**
- **Automation → Messages**, to send texts you approve.

The menu checks each grant by actually using it, so trust what it reports.

### 7d. Turn it on

In the Obligations menu, under **Server**:

1. **Install server** registers the two launch agents.
2. **Sign in with Claude** (step 4).
3. **Turn on…** starts the service and the dispatcher.

The status and logs:

```bash
"/Applications/Obligations Server.app/Contents/MacOS/obligations-server" status
tail -50 ~/Library/Logs/Obligations\ Server/server.log
```

The service listens on `127.0.0.1:7683`. A change under `deploy/agent-service/`
needs only a restart. A change to the sandbox profile or the launcher needs
`./deploy/mac-server/build.sh` again.

**Run only one server.** Two servers run every job twice and push every
reminder twice.

## 8. Run it on Linux

```bash
OBLIGATIONS=~/obligations ./deploy/install-systemd.sh
```

This installs `obligations-agent.service` (the web service and scheduler) and
`obligations-dispatch.timer` (the minute dispatcher). `deploy/README.md` covers
the containers, the optional VNC desktop and GCE notes.

## 9. Reach it from your phone

The service binds to loopback only. Put it behind a tunnel with an identity
check in front. Cloudflare is what this was built against:

1. Create a Cloudflare Tunnel with its connector on the server machine.
2. Add a public hostname for the app, such as `obligations.example.com`
   → `http://localhost:7683`, and put a **Cloudflare Access** application in
   front of it (for example, Google sign-in limited to your address).
3. If you set up realtime mail, add a second hostname for the hook, such as
   `hook.example.com` → `http://localhost:7683`, and leave it **outside**
   Access. Google can't sign in; the OIDC token is its authentication.
4. In `deploy/.env`, set:

   ```bash
   ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
   ACCESS_AUD=<the Access application's AUD tag>
   REQUIRE_ACCESS=1
   ```

   With `REQUIRE_ACCESS=1` the service refuses any request without a valid
   Access token. It also refuses to start if the other two values are missing.

Then open `https://obligations.example.com` on your phone and add it to the
home screen, or install the app.

## 10. The iPhone, iPad and Mac web app (optional)

`deploy/ios-app` wraps the web UI in a native shell. It adds real push
notifications and location reports. It needs XcodeGen (`brew install xcodegen`).

1. Set your own origin in `deploy/ios-app/Sources/Shared/ObligationsConfig.swift`
   (`static let origin`).
2. In `deploy/ios-app/project.yml`, set `DEVELOPMENT_TEAM` to your team id. If
   `com.example.obligations.app` is taken, change the bundle id as well (and
   `APNS_BUNDLE_ID` to match).
3. Build:

   ```bash
   cd deploy/ios-app
   ./build.sh sim                     # simulator
   ./build.sh device "Your iPhone"    # a paired device
   ./build.sh mac --install           # Obligations Web.app on the Mac
   ```

On first launch you sign in through Cloudflare Access. The app registers its
push token with the server by itself.

Development builds use the APNs **sandbox**, and a development certificate
expires after a year. To ship through TestFlight, create an Apple Distribution
certificate and set `APNS_ENV=production`.

## 11. Check it end to end

```bash
node deploy/pipeline-health.mjs    # every source, and when it last ran
node deploy/tasks.mjs              # today, upcoming, waiting on you, waiting on others
node deploy/contract.mjs           # every JSON state file against its contract
```

The first mail triage runs once threads are waiting. The first brief arrives
at 07:00 the next morning. If a source can't be read, the brief says so under
*blind* instead of guessing.

## 12. Make it yours over the first week

- **Correct it in chat.** When it gets a call wrong, say so. It records a
  verdict (`rules/verdicts.md`), and verdicts outrank the prose rules.
- **People and projects:** start a few `people/` and `projects/` files from
  the templates. Give a project `match-people:` and `match-words:` so tasks
  land in it, and `focus: 1` to make it lead the brief.
- **Recurring obligations** go in `recurring.md`. Replace the example block.
- **Standing lists:** autopay vendors, ignored senders and "read in full"
  senders are all set from the web UI.
- **Mail policy:** `rules/email-triage.md` decides what counts as action,
  awareness or digest. Expect to tune it.

## Updating

Your copy tracks this repo as `upstream`:

```bash
git fetch upstream
git merge upstream/main
./deploy/test.sh
```

Your data files never conflict, because upstream ships them empty. The usual
conflicts are in `CLAUDE.md` and `rules/` if you've edited them. Merge those
by hand. After pulling, restart the server, and rebuild an app if its
directory changed.
