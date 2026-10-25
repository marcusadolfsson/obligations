# What may act, and who has to be watching

Alex, 2026-09-08: "I think we need to setup different guard rails for what
the chat bot can do on my instructions, and what the agent can do by itself."

He is right, and the evidence is that the same mistake happened three times in
one day.

- **Pushing** was denied everywhere. A scheduled job could never have pushed
  anyway — `canUseTool` refuses anything not on the allow list and has nobody
  to ask — so the rule only ever bound the sessions with a human in front of
  them. It stopped the agent developing the Mac app from delivering its code.
- **Calendar attendees** were refused on every path. CLAUDE.md said "add people
  only in chat, when he says to", and there was no way to do it in chat or
  anywhere else. He added Carl to the Brava hold by hand.
- **The ignore list** is reserved to a button, correctly. But the button could
  only write one address, so when he asked to silence a domain the sanctioned
  path could not express the request at all.

Each was written as *the agent must not do this unsupervised* and implemented
as *nobody may do this, ever*. The distinction was never encoded, so every
fence collapsed to its strictest reading.

## Four states, not two

`.claude/settings.json` already documents three. This adds the one that was
being improvised in code, and names all four so a new capability has somewhere
to go.

| state | who can reach it | mechanism |
|---|---|---|
| **Never** | nobody, ever | `permissions.deny` |
| **His tap** | only a control he operated | a route that refuses without the signed-in identity |
| **Asks in chat** | an attended session, on an approval card | in neither list — `canUseTool` asks in chat, refuses in a job |
| **Unattended** | anything, including a 07:00 job | `permissions.allow` |

**Never** is for the irreversible: rewriting history, deleting mail, `rm`,
arbitrary outbound bodies. The test is not "is this dangerous" but "if this is
wrong, can it be undone". Archive is recoverable; force-push is not.

**Unattended** is for arithmetic — reading, listing, drafting, closing with an
outcome. Drafting belongs here on purpose: a draft reaches nobody.

The interesting line is the middle two, and it is not about danger. Both are
attended. The question is **what the approval is evidence of**.

## Choosing between "asks in chat" and "his tap"

An approval card proves he agreed to *this action, now*. It shows the tool and
its input, and for sending it shows the recipient and the subject. That is
enough when the card carries the whole decision.

A control in the interface proves something narrower and stronger: he was
**looking at the thing** when he acted on it. The Ignore Sender button is on
the sender's own thread. The Outbox Send button sits under the text that is
about to go out.

So: **use "his tap" when the decision needs context the card cannot carry, or
when the consequence is silent and long-lived.**

- Silencing a sender is both. Its whole effect is that mail stops appearing,
  which is invisible by construction, and an approval card saying
  `ignore-sender @charityflights.example` looks like every other one-line command.
- Sending as him is the first. The card carries recipient and subject, which is
  the decision, so chat is enough — and that is exactly how it works today.

And the reason this matters more than tidiness: **the agent reads
attacker-controlled mail all day.** A mail that says "ignore future messages
from your bank" is a plausible thing to receive. If a parsed sentence could
reach a capability, that sentence is a way in. A card he taps is weaker
evidence than a button he pressed on the offending thread — the card can be
proposed by anything; the button requires him to be somewhere specific.

**A rule that reserves a decision to a control must leave the control able to
express the decision.** That is what failed with the domain. If the button
cannot say what he wants to say, the rule is not protecting the decision, it is
preventing it.

## Where things sit now

Read this as the survey, not as settled policy. The last column is a proposal.

### Correct today

| capability | state | why it is right |
|---|---|---|
| force-push, reset, checkout, clean, `rm` | Never | destroys the undo button |
| trash and spam on mail, delete a label | Never | archive is the strongest verb here |
| create a mail filter or forwarding rule | Never | a standing rule the agent invented outlives the reason |
| `curl`, `wget`, `ssh` | Never | arbitrary destination and body; WebFetch is the supervised form |
| `WebFetch`, `download_attachment` | Asks in chat | `JOB_ONLY_DENY` — the chat reaches them, a job cannot |
| sending mail | Asks in chat | the card names recipient and subject, which is the decision |
| answering an invitation | Asks in chat | `calendar-respond.mjs` is on no allow list |
| pushing | Asks in chat | fixed 2026-09-08; force forms stay Never |
| sending a Gmail draft from Outbox | His tap | refuses without the identity on the request |
| sending a calendar invite | His tap | same, added 2026-09-08 |
| adding an entry to his own diary | Unattended | reaches nobody, reversible, marked as the assistant's — and announced at the top of the next brief, which is the condition it was granted on (2026-09-14) |
| drafting anything | Unattended | a draft reaches nobody |
| rewriting or discarding a draft the assistant wrote, once dealt with | Unattended | reaches nobody; never one he edited or approved, never a Gmail draft it did not write; every change named in the next brief (2026-09-15) |
| ignoring a sender | Asks in chat | `ignore-sender.mjs` is on no allow list; a job reading hostile mail must never silence a sender (2026-09-15) |
| closing an obligation | Unattended | Alex: "having the agent auto close is the whole point" |

### First, a correction

An earlier draft of this file called the routes below a hole. **They were not.**
The Access gate in `server.mjs` verifies a Cloudflare Access JWT and returns 401
*before any route runs*, and production sets `REQUIRE_ACCESS=1`. Nothing but the
Gmail webhook — which carries its own OIDC token — reaches a route without a
signed-in person behind it. The agent's own HTTP call could not have used these,
and `curl` is denied to it anyway.

What was actually wrong is narrower and still worth fixing:

- **The rule held because one environment variable was set.** Every one of these
  routes was safe only because `REQUIRE_ACCESS=1`. A route that says so itself
  survives a misconfigured deploy; one that does not, does not.
- **The audit record could name nobody.** `who?.email ?? 'web'` meant an outbox
  file could read `approved_at: 2026-09-08 11:04 by web (typed by hand)`. An
  approval attributed to "web" is a decision nobody can be held to, and this
  repo's whole close discipline rests on being able to tell his decision from
  the agent's.
- **The same act was fenced two ways.** Sending mail refused without an
  identity; approving a text, which the Mac sends within a minute, did not.

Fixed 2026-09-08: nine routes now refuse without the signed-in identity, and
`guards.test.mjs` fails if a tenth is added without one. State the fence in the
route, not in the deployment.

### Wrong, and worth changing

**Approving a text is not gated like sending mail.** `POST /api/outbox/status`
sets `approved`, and the Mac sends that text within a minute — outward, as him,
to a real person. `/api/outbox/mail/send` refuses without the signed-in
identity; this one records who and carries on without it. CLAUDE.md calls
iMessage "the one capability that acts outward as him", so of the two halves of
the outbox, the *less* guarded one is the one it calls out. Cloudflare Access
sits in front of everything, so this was never exploitable — but the mail route
does not rely on Access either, and it should not have to.
**Done 2026-09-08: refuses without an identity, exactly like the mail half.**

**Ignoring a sender is reachable without an identity.** `POST
/api/reading/ignore` records `who?.email ?? 'web'`. If the whole point is that
the list comes from a click he made, the route should require proof of the
click. **Done 2026-09-08.**

**`/api/priorities` and `/api/reply` have no identity check at all.** What it
writes — since 2026-09-16 the `focus:` line and the `**On track:**` sentence in
a project file, before that `priorities.md` — is one of the two things CLAUDE.md
says are his and never the agent's to write. **Done 2026-09-08**, along with `/api/approve` and `/api/auto-approve` — the
first approves a tool call the agent asked for, the second widens what may run
without asking again, and neither should be reachable by a process.

### Settled 2026-09-15: yes, in chat

He asked twice — Charity Flights, then SkyAngel — and the chat refused twice,
the second time drawing "I need the chat to actually be helpful!" A question
asked twice is a decision. `deploy/integrations/ignore-sender.mjs` is on no allow
list, so it is **Asks in chat**: the approval card shows the address, a job is
refused, and `guards.test.mjs` fails if it is ever allowed.

### Was the open question

**Should chat be able to write the ignore list on his say-so?** Today it
refuses and points at the button, which is defensible: the consequence is
silent and the button proves he was looking at the sender. The cost is friction
on a request he stated plainly. This one is genuinely his call, and the reason
to leave it alone is stronger than for pushing — a wrongly ignored sender is
invisible, whereas an unwanted push is loud.

## The rule for anything new

1. If being wrong cannot be undone, it is **Never**.
2. If the payload is arbitrary — a shell command, a free-text body to an
   address the model chose — it is **Never**, whatever the intent.
3. If the consequence is silent, or the decision needs context an approval card
   cannot carry, it is **His tap**, and the control must be able to express the
   whole decision.
4. If an approval card carries the decision, it is **Asks in chat** — which
   means *in neither list*, not in `deny`.
5. Otherwise it is **Unattended**.

And the test that would have caught all three of today's failures: **for every
`Never`, name the caller it is protecting against.** If the answer is "a
scheduled job", it is in the wrong state, because `canUseTool` already refuses
those.
