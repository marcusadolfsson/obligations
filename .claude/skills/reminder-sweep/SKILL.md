---
name: reminder-sweep
description: The judgment half of the reminder system — move stalled items, recompute recurring due dates, apply Alex's dispositions, and report what is due or overdue. Use in the morning and evening jobs, and whenever Alex asks what is due, what he is behind on, or tells you a reminder is done, snoozed, or dead.
---

# Reminder sweep

`rules/reminders.md` is authoritative. Read it. This skill is the agent's half of
what it describes.

## You do not push

`deploy/reminder-dispatch.py` runs every minute on the host and owns delivery:
it decides what is due, pushes it, increments `nags`, sets `last`. It is
deterministic and it does not need you.

**Never send a nag yourself, and never touch `nags:` or `last:`.** Those fields
are the coordination point between you and the dispatcher — `last:` is how you
can tell what has already gone out. Writing them would make the escalation
ladder lie, and the ladder is the only thing keeping the channel credible.

Your half is everything requiring judgment.

## Every run

**Stalled.** Anything at `nags: 4` has had its disposition question and got no
answer. Move it to `## Stalled`. It stops being nagged; it does not stop
existing. Do not move anything below 4.

**Recurring.** For a repeating item that has been completed, compute the next
`DUE` from its `repeat:` and reset `nags: 0`, `last: -`. Compute from the *due*
date, not from today — a weekly bin day that slipped two days is still on the
same weekday next week.

**Report.** Overdue first, then due today. Take the list from
`node deploy/tasks.mjs`, not from `reminders.md` alone: a reminder and a
recurring submission due the same week are the same question to Alex, and
what shows as urgent depends on lead time, not just on CLASS. That is what goes in the brief, ahead
of everything else, because a missed reminder is the one failure this system
exists to prevent. If nothing is due, say so in one line rather than padding.

## When Alex speaks

`rules/reminders.md` lists the dispositions — `done`, `snooze`, `kill`, class
changes. Act on them without confirming; that is what he expects. Two carry
extra weight:

- **kill** — delete the line *and* note it in today's journal. A reminder that
  vanishes with no record is indistinguishable from one the system lost.
- **snooze** — new `DUE`, `nags: 0`, `last: -`. Confirm the **absolute** resolved
  time back to him. "Friday" is ambiguous; "2026-09-04 09:00" is not.

## Creating one

Only Alex, in conversation, creates reminders. Not a message, not an email,
not a calendar invite, not a document — those get proposed to him, never
written. When he does ask:

- Default to `normal` unless he says otherwise or it is plainly a hard deadline.
  Guessing `hard` is how a channel gets muted.
- No time given means 09:00 on the target day.
- **Always confirm the absolute resolved time back**, in the same message.

## Sundays

`## Stalled` gets reviewed with him: each one is done, given a real date, or
killed. Surface them; do not decide for him. That is the point of the section —
it is where things go when the system has stopped being able to help.
