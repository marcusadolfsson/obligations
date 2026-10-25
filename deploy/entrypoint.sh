#!/usr/bin/env bash
# Usage: entrypoint.sh <job>    where <job> is a basename in jobs/ (morning|evening|weekly)
set -euo pipefail

JOB="${1:?usage: entrypoint.sh <morning|evening|weekly>}"
PROMPT_FILE="$OBLIGATIONS/jobs/${JOB}.md"

[[ -f "$PROMPT_FILE" ]] || { echo "no such job: $JOB" >&2; exit 2; }

git config --global --add safe.directory "$OBLIGATIONS"

# Model: OBLIGATIONS_MODEL in deploy/.env is the one knob for the whole system — jobs,
# chat session, and agent service all read it. Alex set the default to Opus 5
# on 2026-08-27. If the 3x/day job cost ever stops being worth it, the fix is a
# OBLIGATIONS_JOB_MODEL override here rather than a second default somewhere else.
# --mcp-config names .mcp.json explicitly instead of relying on it being
# auto-discovered. It was not being: every scheduled run since Gmail was
# connected saw no mcp__gmail__* tools at all and reported the mail as
# "permissions not granted". The 18:00 job blamed the claude.ai connectors,
# which was the wrong diagnosis — the email triage had simply never had the
# tools it was written against.
#
# --strict-mcp-config then limits the job to THAT file. Without it a container
# also inherits the claude.ai connectors from the subscription login, and those
# carry trash_message, mark_thread_spam and send_message under names the deny
# list in .claude/settings.json does not cover — it denies mcp__gmail__*, which
# is a different server. Jobs were saved only by canUseTool's blanket deny.
# Relying on that is relying on the absence of an allow-list entry; this makes
# it structural.
exec claude -p "$(cat "$PROMPT_FILE")" \
  --model "${OBLIGATIONS_MODEL:-claude-opus-5}" \
  --mcp-config "$OBLIGATIONS/.mcp.json" \
  --strict-mcp-config \
  --permission-mode acceptEdits
