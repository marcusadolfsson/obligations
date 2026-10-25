# Messages

Everything the system says to Alex unprompted lands in `messages/` — briefs,
reminder pushes, failure alerts. One file per message.

This is a **delivery record**, not a conversation. If Alex asks a question in
the chat UI and gets an answer, that is not a message. If the system decided to
interrupt him, that is.

## Why files and not a log

Same reason as the rest of this repo. A message is something the system claimed
was worth Alex's attention; that claim should survive losing the box, be
greppable a year later, and show up in `git log` next to the reminder or journal
entry that caused it. `.log/` is gitignored scratch — messages are not scratch.

## Format

`messages/YYYY-MM-DD-HHMM-<kind>.md`, with a `-2`, `-3` suffix if that minute
already has one. Filename sorts chronologically; don't get clever with it.

```markdown
---
type: message
kind: brief | reminder | failure | note | prep | debrief | urgent | digest
at: YYYY-MM-DD HH:MM
title: One line, shown in the list
read: false
delivered: ntfy | none
---

Body in markdown. This is what Alex reads.
```

- **`kind`** — `brief` (a scheduled brief), `reminder` (a nag that went out),
  `failure` (a job died), `note` (written only when a job turned up something
  he needs to see), `prep` (before a meeting), `debrief` (after one), `urgent`
  (the realtime lane), `digest` (a mail digest archived by hand between briefs
  — an **Interim digest**; the automatic ones are appended to the brief they
  were written beside and are not files of their own). `contract.mjs` is the
  authority on this list, and this prose was four values behind it until
  2026-09-21. On the web, everything except `reminder` and `failure` is the
  **briefs** page; those two are **notifications**.
- **`delivered`** — how it actually reached him. It names whichever channel
  worked: `ntfy` for a push, `sms` for a login code relayed to his phone, `none`
  if it only exists here. Never claim a channel for a delivery that failed; a
  delivery record that lies is worse than no record.

  Do not write this by hand. `deploy/notify.py`'s `send()` returns the channel it
  actually used, and that is what belongs here — hardcoding it at a call site is
  how a record starts claiming `ntfy` after the channel has changed.
- **`read`** — flipped to `true` by the web UI. The only field that mutates.

## Who writes what

| Writer | Kind | When |
|---|---|---|
| `deploy/reminder-dispatch.py` | `reminder` | a push actually went out |
| `deploy/notify-failure.sh` | `failure` | a job unit failed |
| `jobs/morning.md` | `brief` | the weekday brief |
| `jobs/evening.md`, `jobs/weekly.md` | `note` | only if there's something to say |
| `archiveDigest` in `mail-digest.mjs` | `digest` | he archived a digest by hand between briefs; the automatic ones append to the brief instead of writing a file |

Deterministic writers use `deploy/messages.py`. Agent jobs write the file
directly — the frontmatter above is the whole contract.

## Rules

- **Never write a message for a routine no-op.** An evening run with nothing to
  report writes nothing. A queue of "nothing happened" is how a channel stops
  being read, which is the same failure mode `rules/reminders.md` exists to
  prevent.
- **One message per event.** The dispatcher writes on delivery, so the message
  count and the nag count agree. If a push fails, there is no message — the
  reminder is still in `reminders.md` and still visible on the dashboard.
- **Never delete a message.** They are a record of what the system claimed.
  Archive old ones to `archive/messages/` if the directory gets unwieldy.
- Bodies are markdown and are rendered as markdown. Keep them phone-sized.

## `delivered:` names the channel that carried it

`none`, `ntfy`, `sms`, or `apns` (2026-09-05, the iOS/iPad/Mac app), and
nothing else — write `none`; the dispatcher replaces it when the push goes.
"pending" on eight briefs (2026-09-17 to 2026-10-05) kept every one of them off
his phone. Whichever
`notify.send()` returned as having worked — never the channel that was
configured. With `PUSH_CHANNEL=apns` and no registered device the push goes
by ntfy and the file says `ntfy`.
