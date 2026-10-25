# Realtime push — what may ring his phone

> Moved out of `rules/email-triage.md` on 2026-09-02. Two different concerns
> were sharing a file, with two different readers.
>
> **Nothing here is read by the mail triage.** This is the policy behind
> `deploy/agent-service/hook/classify.mjs` and `hook/policy.mjs` — deterministic
> code deciding whether an arriving message may interrupt Alex. The triage
> agent decides what mail *means*, which is a different question, and it was
> reading these ten kilobytes on every run and using none of them.
>
> `hook/policy.mjs` parses the ratified table below. The section heading is
> matched exactly; changing it silently empties the allowlist.

## The second lane — people he knows (2026-09-20)

The section below this one is the first lane: deterministic, for login codes,
where a stranger's action is allowed to buzz the phone under caps. This is the
second, added when Alex asked "could we make it more realtime?", and it is
narrower in the opposite way: **only someone he knows can reach it**, and what
it buys is speed, not a new kind of interrupt.

`deploy/agent-service/urgency.mjs`, on the minute tick, before the triage
gates:

1. **Candidates**: new threads on the work lists (never stale or aged-out
   ones) where the other party is a resolved contact — a one-to-one text from
   a named participant, or a mail whose sender the address book can name and
   which is not a list, not auto-submitted, not failing DMARC, and not his own
   last word. A stranger cannot enter this lane.
2. **One question, on the cheap model** (Haiku), once per thread per new
   message: *does he need to see this within the hour?* — a person asking him
   something, a time proposed or confirmed, a problem at a property, aircraft
   or account, money moving. The classifier has no tools and decides nothing
   else; a failure means "later" and is not retried every minute.
3. **On yes, the triage runs now** instead of on its gate — the same skill,
   the same judgement, just sooner. A stale pipeline still refuses.
4. **The push carries the triage's verdict**, not the classifier's: only an
   OPEN, ACTION conclusion is pushed, as a `note` with the to-do link. Quiet
   hours 21:00–07:00 hold it for the morning brief; at most eight a day; a
   thread is pushed once a day. `.log/urgency.json` is the ledger.

The Mac app pushing its extract on change (rather than on a timer) is what
makes the text side realtime end to end; the service side is ready for it.

## Realtime — what may ring the phone

Everything in this section is an exception to *the assistant does not interrupt*. A
sender listed here can wake Alex at 03:00, which is a capability, so the list
is his and only his.

**Nothing is added because a mail asked, because a pattern looked promising, or
because a triage run suggested it.** He adds a row, in a session, with the date.
The row survives in git, which is the audit trail.

A message qualifies when **all** of these hold. Any one failing means it is not
a code and nothing happens in the moment:

1. `Authentication-Results` says `dmarc=pass`. Gmail writes that header on
   receipt, and it is what answers *is this actually from the domain it claims*.
2. The subject matches one of the patterns below.
3. It arrived within the last 10 minutes.
4. It was addressed to one of his own addresses — not to a list.
5. The sender is not on the blocklist.

### The sender list is a fast lane, not a gate

Alex's decision, 2026-08-30: **anything matching a login pattern comes
through**, ratified sender or not. A missed code is the failure he actually
cares about, and maintaining a list of thirty services by hand is a chore that
ends with the list stale and the feature distrusted.

What the risk actually is, stated plainly so it is a decision and not an
accident: **DMARC does not help here.** It proves a mail is from the domain it
claims — not that the domain is one he trusts. An attacker simply sends from
their own domain, with valid DMARC, and a subject reading "Your verification
code is 123456". So under this setting **anyone who knows his address can make
his phone buzz**, up to the caps below. He mutes SMS overnight, which removes
the 3am case that most of the strictness was buying.

The levers if it is ever abused, in order: the blocklist, then the caps, then
`REALTIME_MODE=strict` in `deploy/notify.env`, which restores the sender list as
a hard gate.

**One exception is refused even under the open setting: a near-miss of a listed
domain.** `goog1e.com` when `google.com` is listed. A legitimate service he has
not got round to listing looks nothing like one he has; a domain within an edit
or two of a listed one is deliberate impersonation, and registering it and
passing DMARC on it is trivial. The cost is a real code from a genuinely similar
domain, which he fixes by listing it — after which it matches exactly.

Being on the list still buys two things:

- **The domain-bound autofill line.** A ratified row carries the login domain,
  so the code offers on the right site. An unratified sender gets the plain
  form, which always offers but is not site-specific.
- **A looser rate limit.** Ratified senders are things he actually logs into;
  unratified ones share a tighter budget.

**The list should be derived, not remembered.** The triage reads his mail
history, finds the senders that have actually sent him login codes, and proposes
rows — see *Learning the sender list* below. Nothing is added without him saying
yes, but he should never have to think one up from scratch.

### Senders

`login domain` is what goes in the `@domain #code` line, and it is **looked up
here, never parsed from the sender** — codes routinely arrive from
`no-reply@e.slack.com` or `security@mail.notion.so`, and a domain-bound code
naming the wrong domain silently never offers. Leave it blank to send the plain
form instead, which always offers but is not site-specific.

| sender domain | login domain | what it is | date ratified |
|---|---|---|---|

<!-- Nothing yet. One row per service, added by Alex, in a session. -->

### His addresses

<!-- One per line. A code addressed to a list is not a code. -->

```
alex@rivera.example
```

### Subject patterns

One anchored regex per line, case-insensitive. **Include Swedish** — he is on
`.se` services and a monolingual set will miss.

`authentication` added 2026-09-08. Alex: "recent ones came from Northwind."
FlyNorthwind sends "FlyNorthwind - Authentication Code", and the alternation had
verification, security, login, sign-in, one-time and access but not the word
Northwind actually uses — so every one of his aviation-portal codes was refused
as "subject matched no ratified pattern" and none of them ever rang. It does
not widen much: their invoices, receivable reports and password-updated mail
still match nothing.

**A miss is currently invisible**, which is how this went unnoticed. Subjects
are never written to disk, deliberately, so a refused code and a refused
newsletter look identical in the log. Logging the subject with `\d` stripped
would make the next narrow pattern findable without ever recording a code.

```
\b(verification|authentication|security|login|sign[- ]?in|one[- ]?time|access) code\b
\b(verifierings|engångs|inloggnings|säkerhets)kod\b
^\s*\d{4,8}\b.*\bis your\b.*\bcode\b
\b(magic|sign[- ]?in|login) link\b
^Verify your
^Confirm your (email|sign[- ]?in)
```

### Blocklist

A sender here never rings the phone, whatever it matches. This is the first lever
to pull if something abuses the open setting.

```
```

### Learning the sender list

Once mail is connected, the triage should periodically search his history for
messages that were plainly login codes — the same subject patterns, from senders
not already listed — and propose the rows in the weekly brief, with the count:

> `stripe.com` has sent 14 login codes in 90 days and is not on the realtime
> list. Add it? It would get the domain-bound autofill line.

That is judgement, so it is the agent's, and it happens offline where a model
call is affordable. What may ring the phone is still only what Alex ratified —
adding a row remains his edit.

### Vetoes

Any of these drops a message back to "not a code", whatever else matched:

```
List-Id present
Auto-Submitted: auto-replied
subject matches: receipt|invoice|newsletter|digest|weekly|unsubscribe
```

### The limits that keep it from becoming a siren

- **At most 30 sender rows and 20 patterns.** Over that, the whole list is
  refused and a failure is raised. A runaway edit fails closed.
- **One push per sender per 5 minutes, 3 per hour. Six an hour overall, twelve a
  day.** Over the cap it says so once — *"code pushes suppressed (N in the last
  hour); someone may be trying to sign in as you"* — and then goes quiet. The
  burst is itself the signal.
- **A change to this section is announced.** The assistant notices the edit and
  writes a note saying what moved. An allowlist that can be changed silently is
  not an allowlist.

**The residual risk, plainly:** anyone who knows his address and can reach a
login form at a listed service can make his phone ring. The caps bound that to a
handful of buzzes rather than a night of them. It cannot be zero — "a stranger's
action causes an interrupt" is the feature and the attack in one sentence. The
complete mitigation is deleting a row.

## How a code reaches him — tested, not assumed

**iMessage from his own Mac does not work.** Tested 2026-08-30: a message sent
from any device on his own Apple ID lands in the self-thread as *sent* on every
one of his devices, and iOS only offers security-code autofill on a message it
considers *received*. The relay-via-the-Mac idea is dead, and it is worth writing
down because it is an obvious design and the reason it fails is not obvious.

Re-tested 2026-09-01, this time sent by Obligations.app rather than Messages, on the
theory that a different sender might land differently. It does not: QuickType
offered nothing. **The sender is irrelevant; the Apple ID is what decides.** That
run happened because `deploy/agent-service/otp-ui.mjs` still posed the question
as open and its existence read as evidence nobody had answered it. The rig now
carries the answer at the top. A test rig outliving its experiment is a
reasonable trap, and the cheaper order is to check this file first.

**An SMS from a number that is not his does work.** Tested the same day through
his own Twilio account, and again through voip.ms from DID 555-200-0021: the code
arrives as genuinely received and Safari offers it in QuickType. voip.ms is the
provider in use.

So the realtime channel for codes is **SMS via Twilio to a phone number fixed in
config**, never a number derived from a message. Two consequences worth keeping
in view:

- It sidesteps `rules/outbox.md` entirely. That rule exists because iMessage acts
  outward *as Alex*; an SMS from a service number to his own phone impersonates
  nobody and reaches nobody else.
- Twilio then holds his codes in its message logs. Turn on body redaction in the
  Twilio console, and treat the account credentials as a bearer secret — host
  only, never in the container that reads his mail.

**Sending is not idempotent, and the failure is silent.** The voip.ms API
returns `{"status":"success","sms":<id>}` on a plain 200, and a call that
succeeds can still look like it failed — that happened on the very first test:
the response was not captured, the send was retried, and Alex's phone buzzed
twice with the same code. Whatever relays a code must therefore **deduplicate on
the Gmail message id before sending, not after**, and treat an ambiguous
response as *probably sent*. A retry is worse than a miss here: a code that
arrives twice is one the recipient starts distrusting, and the whole channel
depends on being believed.

**Use Apple's domain-bound form.** Confirmed working 2026-08-30: a relayed SMS
ending `@obligations.example.com #730155` autofilled on that page. The message
carries both lines — the sentence so it is legible on the lock screen, and the
`@domain #code` line so QuickType offers it:

```
Your verification code is 730155

@obligations.example.com #730155
```

**The domain is looked up, never parsed.** A sender's domain is often not the
login domain — codes arrive from `no-reply@e.slack.com`, `security@mail.notion.so`,
sometimes from an ESP's own domain — and a domain-bound code naming the wrong
domain does not fall back, it simply never offers. That fails silently, which is
worse than the plain form.

So the ratified realtime list carries the login domain as a column, alongside the
sender domain that lets it through at all. It is one more field in a row Alex
is already writing, and it is the field that decides whether autofill lands.
**No mapping, no domain-bound line** — send the plain form instead, which always
offers, just not site-specifically.

`/otp-test` on the web UI is the rig this was measured with. It stays for
re-testing when iOS changes.
