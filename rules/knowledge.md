# Shared knowledge across sources

Messages were the first source with a derived cache. Email and calendar are
coming. The decision that mattered was made before there were three
implementations to reconcile — and as of 2026-08-29 it is built.

## Obligations are the object, not threads

**Implemented in `deploy/agent-service/obligations.mjs`.** An obligation is
something that is owed, in one direction or the other, evidenced by any number
of sources. Three exist today: the message triage, `todo.md`, and
`reminders.md`.

The problem it solves — **the same obligation arrives by more than one
channel**:

- Anna texts "can you send the flight dates?" and emails the same question.
- Someone asks by text to be called back, and Alex rings them — the obligation
  is discharged on a channel that carries no text at all.
- A calendar invite lands for a meeting someone already texted about.
- An invoice arrives by email; the chase-up comes by text.

Keyed by thread — as `imessage-state.json` alone was — that is two or three
separate open items. The brief reports the same thing twice, and answering the
email leaves the text still "open" forever.

**One set of obligations, each with evidence from any number of sources:**

```json
{
  "id": "anna-flight-dates",
  "what": "send Anna the October flight dates",
  "who": "anna",
  "since": "2026-08-26 09:00",
  "open": true,
  "surfaced": "2026-08-28",
  "evidence": [
    {"source": "imessage", "ref": "<chat guid>", "at": "2026-08-26 09:00"},
    {"source": "email",    "ref": "<message id>", "at": "2026-08-27 14:02"}
  ]
}
```

Same shape closes it: a reply on *any* channel is evidence the obligation is
discharged. `closeObligation` walks the evidence and discharges each source in
its own idiom — ticking the `todo.md` box, moving the reminder to `## Done`,
writing `open: false` on the thread conclusion — and reports what did not close
rather than claiming the whole thing is done.

## How it is put together

**The sources stay authoritative. Nothing is mirrored.** `todo.md` is the truth
about hand-typed tasks, `reminders.md` about reminders, `imessage-state.json`
about what the triage concluded. The obligation layer joins them on read and
closes across them on write; it is never a fourth copy that can drift.

One adapter per source, in `deploy/agent-service/sources/`, each exporting
`read(obligations)` and `close(obligations, ref, who, outcome)`. Adding email means adding a
file there and nothing else — the tasks page does not know what a reminder is.

### Recurring obligations: one per period, never one that resets

`recurring.md` describes something owed every period; `sources/recurring.mjs`
derives an obligation *per period*, with the period in its ref
(`recur:<hash>:2026-08`). Nothing is generated into another file and no due date
is ever bumped forward — the period advances because the calendar advances.

That is the whole point. A monthly submission held as one line whose `DUE` gets
rewritten each month loses the only fact worth keeping: that August's went in on
the 5th and September's has not. Keyed by period, the history falls out for free
and closing August says nothing about September.

It models **a completed period reported on shortly after it ends** — hours
submissions, expense claims, billing runs. For "do X on the 15th of every month"
there is no period and no per-period record; that is `reminders.md` with
`repeat:1m`.

### Closing outcomes live in `logbook.md`

Ticking a box says an item is no longer outstanding. It does not say when, by
whom, or on what evidence — and for anything a vendor or a regulator might ask
about later, that is the part that matters.

So every close appends one line to `logbook.md`: append-only, like the journal,
and for the same reason. It is also the recurring adapter's memory, which means
the record and the state are the same file and cannot disagree.

An obligation may declare what discharge looks like with `!closes:` — "receipt
email from Northwind". Today that shows on the card and prompts for the outcome
when you close it. Once mail is wired in, it is what lets the triage match an
incoming receipt to the obligation and propose the close with the email as
evidence, exactly as `calls.json` already closes a callback.

### Merging is recorded, never inferred

Code never decides that two pieces of evidence are the same obligation. That
needs to know "the flight dates" and "October travel" are the same question,
which is judgement. **The agent records merges through `node deploy/link.mjs <id> <into> --why
"…"`** (2026-09-20; until then it hand-wrote `integrations/obligation-links.json`).
The record is the `links` slice of `integrations/obligation-state.json` — one
child, one parent, the reason, the day — and nothing hand-writes that file.

`id` must be one of `members` — the canonical one, which decides the wording and
the direction. The rest is folded: earliest start, nearest deadline, strongest
priority, open if any member is open.

A missing, malformed or empty links file means no merges at all. That is the
safe direction to fail: a duplicate in the list is visible and annoying, while a
wrongly merged pair hides one of two real debts behind the other.

## What stays per-source

- **Extraction.** `chat.db` and an IMAP mailbox have nothing in common. One
  extractor each, each bounded by its own caps.
- **Watermarks.** "What is new since I last looked" is per source, because each
  has its own notion of an item and its own clock.

`deploy/integrations/imessage-diff.py` is already almost source-agnostic — it
compares watermarks and hands back a work list. When mail lands, parameterise it
rather than copying it.

## What must be shared

- **The obligation set**, per above.
- **Identity.** A handle, an email address and a calendar attendee are the same
  person. `integrations/contacts.json` is that one resolver — a match key (last
  10 digits of a phone, lowercased email) to a name, synced from the Mac's
  Contacts store every 6 hours. Every source looks names up there; none of them
  keeps its own mapping.

  It is a **lookup table, not knowledge.** `people/` holds what the assistant knows
  about someone — relationship, open threads, what they said about themselves —
  and is curated. Contacts is mechanical and rebuildable. Do not let a contacts
  sync generate `people/` files: an address book is a list of everyone whose
  number you once saved, and `people/` is meant to be the people who matter.

  A key claimed by two contacts resolves to the first, deliberately. Silently
  overwriting would attribute someone's messages to the wrong person, which is
  worse than leaving one of them unresolved.
- **`surfaced`.** Something already reported three days running is not news, no
  matter which channel it arrived on.

## The rule that does not change

Arithmetic is code, judgement is the agent. Deciding whether evidence moved is
deterministic and belongs in a script. Deciding whether two pieces of evidence
are *the same obligation* is judgement — a script matching on subject lines and
phone numbers would merge things that are not the same and split things that
are, quietly. That is why the merge record exists and why nothing writes it
but the agent, through the door.
