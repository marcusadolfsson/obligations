# Obligations

A personal chief of staff built on Claude: it reads your mail, texts and
calendar, works out what you owe and what you are owed, keeps one task list
across all of it, drafts the replies, chases what has gone quiet, and sends
you one morning brief a day. Everything it knows lives in this repo as plain
markdown and JSON, versioned in git.

It was extracted from a system one person ran for months on their own mail.
The prompts, rules and tests are written about an example owner, **Alex
Rivera**, and every person, company and address in them is fictional.

## What it does

- **One task list, not five.** Mail, texts, reminders, recurring obligations
  and a hand-kept `todo.md` merge into one list (`node deploy/tasks.mjs`).
  Each obligation has a four-character code and one record of its state.
- **Triage that closes things.** A mail job and a message job judge what came
  in, open obligations for what you owe, and close them when the evidence
  shows they are done (a receipt, a reply, the other side answering).
- **Drafts, never sends.** Replies and chases are drafted for you; your tap
  sends them. Scheduled jobs cannot send, delete or create filters.
- **One brief a day**, at 07:00, written to be read on a phone in ninety
  seconds, leading with what the assistant changed on your behalf.
- **A web app and an iOS/macOS app** for the list, mail, people and chat, with
  push notifications.

## The web UI and the apps

**Web UI** (`deploy/agent-service/web/`). The service serves it on one port,
for a phone browser or the apps:

| Page | What it's for |
|---|---|
| Today `/` | Meetings with prep, decisions, what's due, priorities, what closed, what the assistant said to you |
| To Do `/todo` | Everything you owe, in today's ranked order. Work through it one task at a time, by lane (reply, decide, pay, call, admin) or by project, or as a map |
| People `/people` | The people you deal with, from mail, texts and Contacts |
| Mail `/mail` | The current digest, then everything judged, by tier |
| Briefs `/briefs` | Every message the assistant sent you, briefs included |
| Chat `/chat` | The same assistant as the jobs, with the same rules and files |

**Obligations.app** (`deploy/mac-app`) is a menu bar app for the Mac. It holds
the privacy grants (Full Disk Access, Contacts, Reminders, Messages), runs the
iMessage, call and Contacts extractors, sends the texts you approve, and
manages the Google accounts. It never runs code from the repo.

**Obligations Server.app** (`deploy/mac-server`) runs the service and the
minute dispatcher on a Mac inside a sandbox, with no grants of its own. The two
apps share data files in the repo and nothing else.

**Obligations for iPhone, iPad and Mac** (`deploy/ios-app`) wraps the web UI in
a native shell. It adds real push notifications (APNs) and location reports.

All three ship with placeholder identifiers (`com.example.obligations.*`, team
`ABCDE12345`, host `obligations.example.com`), which you replace when you build.

## Layout

| Path | What |
|---|---|
| `CLAUDE.md` | Operating rules for the assistant. Read this first. |
| `deploy/CLAUDE.md` | Rules for developing it: guards, test gate, working order. |
| `deploy/PIPELINE.md` | The map: which script does what and what gates each model call. |
| `jobs/` | The scheduled jobs' prompts (morning brief, evening, mail, messages). |
| `rules/` | Policies: email triage, reminders, messages, capabilities, verdicts. |
| `.claude/skills/` | The triage skills the jobs run. |
| `deploy/agent-service/` | The server: web UI, API, scheduler, model gate. |
| `deploy/integrations/` | Extractors for Gmail, Calendar, Drive, iMessage, Contacts. |
| `deploy/ios-app/`, `deploy/mac-app/`, `deploy/mac-server/` | The apps. |
| `now.md`, `todo.md`, `reminders.md`, `recurring.md`, `decisions.md`, `logbook.md` | Your state, empty to start. |
| `journal/`, `people/`, `projects/`, `messages/`, `outbox/`, `inbox/`, `reference/` | Your memory, empty to start. |

## Installing

**[docs/INSTALL.md](docs/INSTALL.md)** walks through the whole install: a
private copy, the tools, Claude sign-in, Google accounts, notifications, the
Mac apps or a Linux server, a tunnel to your phone, the iOS app, and the first
week of tuning.

The short version:

1. Clone the repo into a **private** repository of your own. Once it runs, the
   repo holds your mail conclusions, contacts and journal.
2. `cp deploy/.env.example deploy/.env` and set `OWNER_NAME`.
3. Connect Google with `deploy/integrations/google-auth-cli.mjs`.
4. On a Mac, build both apps and turn the server on from the menu. On Linux,
   run `deploy/install-systemd.sh`.
5. `./deploy/test.sh` must end `ALL PASSED`.

The rules in `CLAUDE.md` assume the owner is called Alex and use "he". Edit
them to fit; the code reads the name from `OWNER_NAME`.

## Design

**Hot/cold split.** `now.md` and `todo.md` load every session. Everything else
is grepped on demand.

**The journal is authoritative; everything else is cache.** `journal/` is
append-only. `people/` and `projects/` are derived from it by the weekly
compaction, so if they drift, they can be rebuilt.

**Git is the undo button.** Every write is committed. A bad autonomous run at
3am is `git revert`, not a lost memory.

**A silence must never look like a success.** A source that could not be read
is named under *blind*; every held chase and every change the assistant made
is named in the next brief.

The reasoning behind the rules is in `docs/why.md`.

## License

MIT. See `LICENSE`.
