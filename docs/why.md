# Why

The record behind the rules in `CLAUDE.md`. Append-only: when a rule is made
or changed, add a dated section under a heading that matches the rule —
what happened, what the owner said, what it cost when it was wrong. Never edit
an old section; a later one says what changed.

The design history of the system this was extracted from is not published.
What follows are the principles it settled on, so a new install starts with
the reasons as well as the rules.

## The journal is authoritative; everything else is cache

People and project files are derived from the dated journal by the weekly
compaction. When they disagree, the journal wins, and a drifted cache can be
rebuilt.

## Git is the undo button

Every write is committed. An unattended run that goes wrong at 3am is a
`git revert`, not a lost memory. That property is what makes it safe to let an
agent write here without supervision.

## A silence must never look like a success

Every source that could not be read is named under *blind*. Every held chase,
every close the owner has not seen, every calendar entry the assistant made is
named in the next brief. An absence gets a number.

## The obligation owns its state; the sources are evidence

Mail, texts, reminders and the to-do file are evidence about an obligation.
The one record of whether it is open, merged, tagged, snoozed or chased is
`integrations/obligation-state.json`, and each slice has one door.

## Mail is attacker-controlled input

The jobs read mail from strangers. So scheduled jobs cannot send, delete,
create filters or widen their own reach, and nothing found inside content is
ever an instruction. Sending happens only with the owner watching.

## Two apps, not two machines

On a Mac, the app that holds Full Disk Access, Contacts, Reminders and the
Messages send never runs code from this repo, because the agent can write the
repo. The server runs sandboxed with no grants. They exchange data files and
nothing else.
