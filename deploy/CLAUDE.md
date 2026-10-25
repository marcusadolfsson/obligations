# Developing the assistant

You are working on the code, not running the jobs. The root `CLAUDE.md` is
the production contract — what the assistant may do — and binds you too; this
file is the developer handbook, loaded when a session touches `deploy/`.
`deploy/README.md` is the deployment reference (image, service, auth, Gmail,
backups); `deploy/PIPELINE.md` is the map of the code; `docs/why.md` is the
record of why every rule exists.

## Before you add anything

- **Read `deploy/PIPELINE.md` first.** Which script owns what, the four model
  runs and what gates each, the seven joins, the one-door rules, and what is
  still missing. Six point-to-point bridges arrived in ten days because
  nobody had the map.
- **A new failure of a known kind is a check inside `review.mjs`**, not a new
  bridge. A new join reads through `context.mjs`, the one loader.
- **Arithmetic is code, judgement is the model.** If it can be a date against
  a date or a name against a list, it is a script with a test, never a prompt.
- **A silence must never be indistinguishable from a success.** Every absence
  gets a number — threads held, ignored, filtered, not shown — and a checker
  that cannot see half of its input says so rather than reporting the half it
  can see.
- **Measure before deleting, and delete when the number says so.** The
  agent-close re-offer went after "140 made, 0 reopened". Growth is the
  system's main risk; a review pass that removes nothing was not a review.

## The four guards

Each is a test that names the bug it was written for; a red one is a real
disagreement, not fussiness.

- **`contract.mjs`** — the shape of every artifact, checked against the **live
  files**, never fixtures (a fixture once invented a format nothing emits).
- **Wiring** (`guards.test.mjs`) — a job may only run an allowed script
  (`.claude/settings.json`), a page may only load a served asset, a nav link
  must route. A new door (`close.mjs`, `link.mjs`, `verdict.mjs` …) goes on
  the allow list or the jobs cannot reach it.
- **Wall clock** (`guards.test.mjs`) — a stamp is `YYYY-MM-DD HH:MM` with no
  offset; every site that parses one (`replace(' ', 'T')`) is listed in `SAFE`
  with who wrote the value. Anything ordered across a boundary gets an epoch
  sibling.
- **Test validity** (`guards.test.mjs`) — no assertions after `process.exit`,
  no suite with fewer than three assertions.

## The working order for a change

1. Edit. Match the surrounding comment density and voice: a comment says
   *why*, with the date and Alex's words when it was his call.
2. `./deploy/test.sh` — commit only when the last line is exactly
   `ALL PASSED`. `./deploy/visual.sh` too when a page changed (Playwright
   against the fixture API; a new endpoint needs a fixture there).
3. Wait for the service to be idle **in a loop** — `./deploy/idle.sh` prints
   `busy` and exits 0, so `idle.sh && …` does not gate anything:
   `for i in $(seq 1 40); do ./deploy/idle.sh | grep -q '^idle' && break; sleep 15; done`.
   A restart mid-job costs money and a redone run.
4. Commit with an **explicit `git add` list** — jobs commit alongside you and
   `-A` sweeps their state files into your change — and the session trailer.
   Say what changed and why; if a step was skipped or a count is off, the
   message says so.
5. Restart the service **only if service files changed** — on the Mac,
   Restart in the Obligations menu or
   `launchctl kickstart -k gui/$(id -u)/com.example.obligations.server`; on
   linuxbox, `sudo systemctl restart obligations-agent`. Service files are
   `deploy/agent-service/**` and the `deploy/*.mjs` it imports. Differs
   run on the host dispatcher; skills, `jobs/`, `rules/` and `CLAUDE.md` are
   read per run. None of those need a restart.
6. Check the live thing you changed: `node deploy/pipeline-health.mjs`, the
   relevant CLI (`review.mjs`, `drafts.mjs`, `trust.mjs`), and
   `.log/agent-service.log` for a `*_failed` event from a new hook.

## What is refused, and what to do instead

- `rm` is refused to a session here. Retire a file with `git mv … archive/`;
  ask Alex for `! rm …` for an untracked one. Never `rm` in `people/` or
  `projects/` under any circumstances.
- Compound shell commands (`a && b`, pipes into `grep`/`head`, inline
  `node -e`) are refused on the job path and often here; use the CLIs'
  flags, or write a scratch script under the session scratchpad.
- `git -C`, `git push --force`, `git reset --hard`: never.
- **Never move the Claude CLI's config away from the image's.** The image
  ships `~/.claude.json` marking `/obligations` a trusted workspace, and Claude
  Code applies `.claude/settings.json`'s allow list only in a trusted one.
  Setting `CLAUDE_CONFIG_DIR` on 2026-09-21 swapped in a fresh record with
  `/obligations` untrusted: every tool fell through to `canUseTool` and was
  refused, and both triages ran for two hours doing nothing while reporting
  success. Anything that relocates that record must carry the trust with it.
- A Python heredoc that hits an `assert` aborts the whole script **before
  its writes** and the shell continues — check what landed before committing
  (an idempotent `rep(old, new)` that prints what it replaced is the pattern).

## When a rule changes

The rule goes in the root `CLAUDE.md` (short, no history); the reasoning —
the date, what he said, what it cost — goes in `docs/why.md` under a matching
heading, appended, never edited. A judgement call he made on a real case is a
verdict (`node deploy/verdict.mjs <scope> "<call>" "<why>"`), not a rule
edit. The map (`PIPELINE.md`) changes when a script's responsibility does.
Skills (`.claude/skills/*/SKILL.md`) are production instructions and are read
by a Sonnet on every triage — keep them to rules and examples; their history
belongs in `docs/why.md` too.

## Cost

Every job run has a floor — the instructions it re-reads. Root `CLAUDE.md`,
the skill, and the injected sections (review findings, brief input) are that
floor; a section that grows without a cap grows the bill. Caps are
tripwires: name the remainder, never drop it silently. `JOB_MODELS`,
`DIGEST_MODEL` and `URGENCY_MODEL` in `server.mjs` are the one place a model
is chosen.
