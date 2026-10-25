# The pipeline — which piece does what

Alex, 2026-09-20, after a day of finding the same class of bug in four
different places: "summarize all the bridge and triage functions."

This is the map. `CLAUDE.md` says what the assistant may do and why; `deploy/README.md`
says how to deploy and test it. Neither says which of the forty scripts in
`deploy/` is responsible for what, and every session has had to reconstruct it.

It is a map, not a rule. When it disagrees with the code, the code is right and
this file needs fixing.

---

> The rules are `CLAUDE.md` (short); the reasoning is `docs/why.md` (long);
> this file is the map of the code. Split 2026-09-20.

## Six layers

| layer | what it does | model? |
|---|---|---|
| **Extract** | the Mac pushes iMessage, contacts and calls; Google pushes mail and calendar | no |
| **Differ** | decides what *needs* judging, every minute | no |
| **Triage** | reads the thread, writes a conclusion | **yes** |
| **Merge** | one obligation list from five sources | no |
| **Passes** | act on, or propose against, that list | no |
| **Brief** | reports it to him | **yes** |

### Where the model runs sit

Three of the four are *in* the flow, at two different layers. The fourth is a
reader off the side of it.

```
      Mac  ·  Google
           │  extract — no judgement, just what is there
           ▼
  integrations/gmail.json · imessage.json · calls.json · contacts.json
           │  differ — every minute, deterministic
           ▼
  gmail-changed.json                    imessage-changed.json
           │                                      │
   ① MAIL TRIAGE  (Sonnet)               ② MESSAGE TRIAGE  (Sonnet)
     gated by mail-gate.mjs                gated by message-gate.mjs
           │                                      │
           ▼                                      ▼
   email-state.json                       imessage-state.json
           └──────────────┬───────────────────────┘
                          │  + todo.md · reminders.md · recurring.md
                          │  + Apple Reminders · decisions.md · birthdays
                          │  + conditions open past a day (from email-state)
                          ▼
                 obligations.mjs — ONE LIST
                          │
        ┌─────────────────┼──────────────────────┐
        ▼                 ▼                      ▼
   the passes       brief-input.mjs          the pages
  (arithmetic)             │              /todo /today /people
        │                  ▼
        │        ③ BRIEF   (Opus)  07:00, the only one
        │                  │
        │                  ▼
        │           messages/*.md ──► the push channel
        │
        └── review.mjs ──► findings go back INTO ① ② ③
                           (the run that is already happening)
```

**④ the written mail digest is not in this flow at all.** It reads conclusions
after the fact, writes prose to `.log/mail-digest.json`, and feeds one page:

```
  email-state.json ──► digestlist.mjs ──► ④ DIGEST (Sonnet, in the service)
                                              └──► /mail
```

Nothing downstream reads it, which is why it can be regenerated lazily on a page
load and why losing it costs nothing but a rewrite. It is also why the brief and
the digest must not describe the same set — see the tier rules.

**The reconciliation is deliberately not a fifth run.** `review.mjs` is
arithmetic, and its findings are appended to the prompt of ① ② and ③ — the runs
that are already happening, already warm, already re-reading that thread. The
triage always had the authority to close; what it lacked was the knowledge.

The division the whole repo rests on: **arithmetic is code, judgement is the
agent.** A model asked each morning to "look for conflicts" finds different ones
every time and cannot be tested; a date-overlap check finds the same ones every
time and fails loudly when its parsing breaks.

---

## The model runs, and what gates each

Everything else in `deploy/` is arithmetic. These are the only things that cost
money per run, and three of the four fire from **work rather than the clock**.

| run | model | fires when |
|---|---|---|
| `jobs/mail.md` | Sonnet | `agent-service/mail-gate.mjs` — at most hourly, sooner on three or more waiting or one that has waited three hours |
| `jobs/messages.md` | Sonnet | `agent-service/message-gate.mjs` — at most hourly, **twenty minutes** when a waiting thread is from someone he knows |
| `jobs/morning.md` | Opus | 07:00 every day — the one brief (since 2026-10-24) |
| `jobs/evening.md` | Opus | 18:00 every day — journal, reminder sweep, Sunday compaction; writes no brief |
| the written mail digest | Sonnet | inside the service, lazily on page load when the unread set has changed |
| the urgency question | Haiku | the second lane, below |
| *Draft reply* on a task | Sonnet | his tap — `reply-draft.mjs`, one call, `reply` in the gate |
| a session readied | Sonnet | his *Work through these N* on a reply, decide or pay lane — `prepare.mjs`, one call a task, twenty a session, none for a task whose thread has not moved (`.log/prepared.json`, `prepare` in the gate) |

Triage is on Sonnet because it is rule-following against a written policy and it
is where the money went — fourteen mail runs a day at a $1.78 floor was about
$1,300 a month. `JOB_MODELS` in `server.mjs` is the one place that decides.

**Mail is judged in exactly one place.** The brief does not triage mail and must
not: a second reading by a job with less context produces a second opinion he
has to reconcile.

---

## The second lane — what runs now instead of on the gate

`agent-service/urgency.mjs`, every tick before the gates (2026-09-20): new
threads from people he knows → one Haiku question (*within the hour?*) → the
triage runs at once → its open-action verdict is pushed. Known people only,
asked once per thread, quiet hours, eight a day; `.log/urgency.json`.
`hook/classify.mjs` is the other lane, deterministic, for login codes.

## The differs — what reaches a triage at all

`deploy/integrations/email-diff.py` → `integrations/gmail-changed.json`
`deploy/integrations/imessage-diff.py` → `integrations/imessage-changed.json`
(since 2026-09-20 with mail's plumbing: `MAX_JUDGEMENT = 40` and `not_shown`
counted; an escape tripwire — `.log/imessage-last-ids.json` against this run,
`integrations/imessage-escaped.json` keeping the last five messages of a thread
that left unjudged, because a text cannot be fetched back; participants taken
from the state record or the escape record once the thread is gone; and an
extract that has lost more than half its threads treated as partial)

Both run on the dispatcher's minute tick, both are pure state machines, and both
decide the same four things: what is new, what changed, what has gone quiet
(`STALE_DAYS = 7`), and what aged out of the extract window while still open.

**Every branch that re-offers a thread needs a `reviewed` guard**, and this has
been got wrong twice:

- `spoke_since` compared a connected call against the obligation's own start, so
  once he had rung someone the thread was re-offered on *every* run until it
  closed. Fixed 2026-09-16, after one conclusion collected 33 entries in two days.
- The aged-out branch had no guard at all — and an aged-out thread can never
  come back into the window, so nothing could ever stop it. Fixed 2026-09-20.
  `email-diff.py` had the guard; `imessage-diff.py` never got the copy.

- The generic `stale` branch never checked `open`, so an agent close was
  re-offered every seven days for ever — and the aged-out branch skipped closed
  conclusions, so an agent close whose thread had left the extract (which mail
  policy guarantees within a run or two) was never looked at again. 54 of 75
  were permanent. Fixed 2026-09-20 with `reoffer_close()` in both differs —
  and **deleted the same evening**: 140 looks over its life reopened nothing,
  and it needed a ledger, a per-run cap and a parity test to hold still. A
  closed conclusion is left alone by the differ now; the guards on a wrong
  close are the evening cross-check, Reopen, and obligation-state.json.

- Both differs measure every stale branch from `max(reviewed, when we last
  asked)` since 2026-09-20 — email's `.log/gmail-aged-asked.json`, the message
  side's `.log/imessage-asked.json`. `reviewed` alone was the guard on three
  branches and the message skill said not to write it.
- (Close re-offers: deleted 2026-09-20, see above.)

The shape to watch for: **a condition that cannot become false on its own is a
loop, not a check.** And its mirror: **a promise in prose with no branch that
keeps it is a rule nobody enforces** — "an agent close comes back after seven
days" was one for seventeen days.

---

## The joins

Seven places read two sources together. The distinction that matters is when
they run and what happens if they are wrong:

- **prevent** — runs at the point of action, and stops something wrong going out.
  Being late is the failure.
- **reconcile** — runs over the whole state afterwards, and fixes what is no
  longer true. Being wrong is the failure.

| join | connects | when | kind |
|---|---|---|---|
| `open_elsewhere` (in `email-diff.py`) | a mail thread ↔ other open obligations on EITHER channel — mail by domain, texts by person (2026-09-20) | into the work list, at diff time | prevent |
| `open_elsewhere` (in `imessage-diff.py`) | a text thread ↔ other open obligations on EITHER channel, by person (2026-09-20) | into the work list, at diff time | prevent |
| `agent-service/contact.mjs` | an obligation ↔ texts, sent mail and connected calls, **both directions** | before a chase sends; in brief input | prevent |
| drafts *dealt-with* (`drafts.mjs`) | a draft ↔ its thread, and whether its obligation closed | hourly and after each triage | prevent |
| `conflicts.mjs` | obligations ↔ trips ↔ calendar — AWAY, CLASH, PROMISED, CROWDED | the brief input | reconcile |
| `agent-service/similar.mjs` | an obligation ↔ another obligation, or an Apple reminder | the algorithm; read by `/todo` **and** `review.mjs`. A tie at ≥0.95 is copies, not a family (2026-09-20) | reconcile |
| `lint.mjs` | `people/`, `projects/`, `decisions.md` ↔ journal and filesystem | Sunday evening | reconcile |
| **`review.mjs`** | open obligations ↔ trips, bookings, the Outbox, the logbook, the calendar, what they wrote elsewhere, and their own update log | **in the triage's own prompt** | reconcile, and corrects |

Two more join without reconciling: `agent-service/task-drafts.mjs` (which task a
waiting draft answers) and `agent-service/projects.mjs` (which project an item
belongs to, from his own `match-people` / `match-words` rules).

`similar.mjs` is the one that has already folded: it stays as the ALGORITHM —
the tokeniser, the likeness score, the refusals — and `review.mjs` reads it
rather than writing a second copy of "what counts as a distinctive word". Two
functions deciding the same thing will one day disagree about one word, and the
bug is invisible because both look right.

### `context.mjs` — one answer, not one schedule

Added 2026-09-20. Four passes each assembled their own slice of "what does the
rest of the assistant know about this obligation", and none could see the others'.
`deploy/context.mjs` loads the shared sources once — obligations, the address
book, contact files, trips, bookings, twins — and answers `about(o)`.

**It knows things; it decides nothing.** Holding a chase, discarding a draft and
rewriting a headline are three acts with three different costs of being wrong,
and they stay with the passes that own them and run on their own clocks.

The one rule it did unify is `RECENT_DAYS` — "have they been in touch" had three
implementations and would have grown a fourth. A test pins it against the chase
gate's `REPLY_RECENT`, because that one sends mail over his name.

Writing it turned up the divergence it exists to prevent: the two `days()`
helpers looked identical and were not (`Math.floor` versus plain division), so a
reply 3.7 days old held a chase under one and not the other.

### Why there are seven, and why not an eighth

Each was built after a specific failure, and each joins exactly two named
sources. There are about eight sources, so twenty-eight possible pairs — six of
these arrived in ten days, and every new failure bought one more.

The defect underneath them: **an obligation is created by one evidence stream,
and forever after only that stream can change it.** The triage re-reads the
thread; if the thread has not moved, the conclusion is re-confirmed as written.
Nothing asked whether the rest of the assistant now contradicted it. So these sat
side by side for six days, and the to-do list was the one that reached him:

```
"nothing in reference/bookings.md records lodging for him"   imessage-state.json
"Summit Lodge Pinecrest, 09-24 → 09-29, conf CX7QZRTA"             reference/bookings.md
```

`review.mjs` is the answer to that, and the rule it carries: **a new failure of
this kind gets a check inside the review pass, not a seventh bridge.** It reads
`trips()`, `parseBookings()` and `listOpen()` rather than reimplementing them,
so there is still one parser per fact.

**It does not replace the three that prevent.** `contact.mjs` in the chase path
stops an email leaving; a reconciliation pass would find a chase already sent.

---

## The passes that act

All arithmetic, none of them a model call.

| pass | does |
|---|---|
| `drafts.mjs` | stale drafts · promises with no draft · chases: one a week per person, ranked by the projects he is for, held while a reply of theirs elsewhere is still unjudged |
| `prep.mjs` | a meeting prep note ~60 min before, pushed |
| `debrief.mjs` | 20 min after a meeting with someone else in it |
| `stale.mjs` | what has gone quiet and who to nudge |
| `review.mjs` | is what the assistant believes still true · `apply()` closes what an explicit `closes_when` says is settled |
| `conflicts.mjs` | things only wrong when two sources are read together |
| `bookings-events.mjs` · `calendar-dupes.mjs` · `gym.mjs` | his diary, through `calendar-write.mjs` |
| `reminders-bridge.mjs` | what the Obligations list on his phone should hold |
| `brief-audit.mjs` | reads a written brief back against the record it came from |
| `trust.mjs` | the assistant's own scorecard, one line a day: opened / closed by whom / corrected / reopened / dismissed / findings acted vs standing / the wait on others; `.log/trust.jsonl`, recorded by the evening input, told in the morning brief, shown on `/system` |
| `brief-input.mjs` | assembles the one document a brief starts from |
| `priorities.mjs` · `projects-propose.mjs` · `lint.mjs` | the project registry and its drift |

### The one-door rules

Several things have exactly one writer, and going round it is how two writers
start disagreeing about the same state:

| door | the only way to |
|---|---|
| `close.mjs` | close an obligation — outcome required, `closed_by: agent:<name>`, agent closes expire after 7 quiet days |
| `decide.mjs` | write `decisions.md` |
| `verdict.mjs` | record one of his judgement calls |
| `integrations/calendar-write.mjs` | touch his calendar — refuses attendees except through the Outbox |
| `integrations/mail-draft.mjs` | write a Gmail draft the assistant can later tidy |
| `review.mjs --correct` | rewrite a conclusion's headline |
| `sources/todo.mjs` `addTask` | add a line to `todo.md` |

---

## Where a conclusion lives, and which part may change

`integrations/email-state.json` and `integrations/imessage-state.json`, one
record per thread, `conclusion.what` carrying the reasoning.

`what` is **a headline followed by an append-only log**:

```
<the current statement>  UPDATE 2026-09-16: <what that run found>  UPDATE …
```

- The **headline** — everything before the first `UPDATE` — states what is true
  now, and `review.mjs --correct` may rewrite it. Leaving a false one at the top
  for ever is exactly how the Pinecrest task told him for six days that he had no room.
- The **log** is the audit trail and is never edited. A correction is another
  line, the same rule the journal has.
- `agent-service/web/what.mjs` splits the two so the page shows the headline and
  folds the rest. Its marker must accept every shape the triage actually writes —
  it silently matched none of them for twelve days, and a 949-word field rendered
  whole.

### One state per obligation (`obligation-state.mjs`, 2026-09-20)

A conclusion says what a *source* thinks. Whether the **obligation** is open is
its own record — `integrations/obligation-state.json`, keyed by the merged id
— and `closeObligation` writes that first, then propagates to each source as
best it can. A source that refuses (an agent may not tick his Apple list) is
reported, not a veto; the logbook line records the decision either way.

The merge rule in `fold` used to be *open if ANY member is open*, which let an
Apple reminder the Mac never completed, or a todo line, silently reopen a
closed item — every un-close the review found traced to it. Now, with a dated
close on record, **only evidence newer than the close reopens it** (a mail or
text conclusion `reviewed` after it; a todo line or reminder created after
it). Undated or older evidence cannot. `reconcileState`, run before every
drafts pass, drops a record that newer evidence has outvoted and logs the
reopen to `obligation-changes.jsonl` as by `evidence`.

The same file holds the obligation's other facts — `links` (merges, via
`deploy/link.mjs`), `tags`, `snoozed`, `chased` — since the evening review
found them spread over five files that could disagree. The old files are read
as a fallback while a slice is absent; the first write carries everything.

Reopening on purpose is a decision with a name and a reason on it:
`POST /api/obligations/reopen` (his identity), `close.mjs <id> --reopen --why`,
or `rejudge.mjs`, which clears the record for every thread it rolls back.

**Do not append an entry when nothing happened.** CLAUDE.md already forbids this
shape for `messages/` — "a queue of 'nothing happened' stops being read" — and
the same is true here. `review.mjs` flags a conclusion whose recent entries all
report a no-op, because that is a differ loop showing through.

---

## What `review.mjs` checks

Twelve, all arithmetic, ordered worst-first because the list goes into a prompt
and a prompt has a budget (capped at 12, remainder counted).

| check | finds |
|---|---|
| `closes-met` | what the triage said would close it has happened. `closes_when` on the conclusion (`reply-from` · `sent-by-me` · `receipt` · `event` · `booking` · `logbook`, any-of, `words` narrowing) is **closed by `apply()`** with `agent:review` and the evidence as the outcome, five a run. The prose `closes` is never parsed. `deploy/closes.mjs` |
| `closes-met-stale` | `closes_when` is met, but only by evidence from before the obligation's last reopen (`integrations/obligation-changes.jsonl`). **Never closed by `apply()`**: a reopen says the record so far does not settle it, so the record so far cannot close it again. Goes to the triage to rewrite the stale `closes_when`. Alex, 2026-10-02 — the Nate quote, fifteen closes on one 09-26 email. `deploy/review.mjs` |
| `doubt-expired` | opened on doubt (`confidence: low`) and nothing confirmed it in 14 quiet days — **closed by `apply()`** as never confirmed |
| `closed-in-logbook` | the logbook has a close for this id after the debt began, and it is open — a source re-reported it; or another item's close carries the same invoice number (`INV…`), at any date — a vendor's reminder for a bill already paid. Never a `closes_when: logbook` close |
| `already-filed` | the conclusion says nothing is on file for a trip, and the bookings file holds lodging under it |
| `they-replied` | something they owe, and they wrote on another conversation since it began (invitations and bounces excluded) |
| `dead-window` | it asserts a date range the trip's own heading has moved on from |
| `spinning` | its last five or more updates all report that nothing changed, **and the run is still live** — a pile that stopped days ago is a dirty record, not a loop |
| `duplicate` | two rows for one thing, from `similar.mjs` — **proposes, never merges** |
| `paid-on-file` | something he owes money on, and a receipt filed after it began from a sender sharing its distinctive word — the invoice itself never counts |
| `on-the-calendar` | an arranging obligation (schedule, book, confirm…) and an event after it began sharing its distinctive words |
| `sent-from-outbox` | he sent a text or mail on this obligation's own conversation after it began, and it carried no `promised` date — was that the answer? (a kept promise closes itself in the drafts pass) |
| `relative-date` | the headline says "in two days" or "tomorrow" with no absolute date beside it |

That last one came from the first live correction: the model fixed the Pinecrest
window from 09-22 to 09-24 and carried "and the trip begins in two days" through
untouched, when it was four. **A headline is written once and read for weeks, so
any relative expression in it has a shelf life of a day.**

## Still missing

Worth knowing before adding anything:

- `review.mjs` reads trips and bookings only. `logbook.md`, the calendar and
  `reference/statements.md` are right there and it does not look at them, so
  "this closed a fortnight ago under a different id" is still invisible.
- `drafts.mjs`'s **tidy** and **putText** still load contacts themselves. They
  ask a per-DRAFT question rather than a per-obligation one, so they were left
  out of `context()` on purpose; fold them in only if a third rule about
  recency appears.
- `open_elsewhere` is Python inside the differ. Leave it there unless the differ
  moves anyway; porting it buys nothing that `context()` does not.
- `review.mjs` reads the logbook, the calendar and `statements.md` (2026-09-20).
  A new failure of this kind is a check inside it, **not an eighth join.**
- `closes_when` (2026-09-20) is read from the conclusion and closes on its own;
  before it, 202 `closes` sentences were read by nothing but the page. The
  triage writes it; prose is never parsed. `review.mjs --apply` runs before
  each triage and before every drafts pass so a settled debt is neither
  re-judged nor chased.
- **A triage prompt carries only findings on its own threads** (`forPrompt`,
  `PROMPT_CHECKS`), because twelve runs of the whole list produced no action.
- Three joins — `open_elsewhere`, `contact.mjs`, drafts *dealt-with* — are the
  same question ("did this already happen somewhere else?") asked against three
  different evidence sets.
