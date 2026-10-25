FROM node:22-slim

# python3 is here for deploy/notify.py, which the service shells out to whenever
# anything has to reach Alex's phone — a relayed login code most of all.
# Without it the realtime path classified a code correctly, extracted it from
# the body correctly, and then died on `spawn python3 ENOENT`, recording the
# delivery as 'none'. One sender for every channel is what makes `delivered:`
# trustworthy; a second implementation in JS would be a second answer to "which
# channel actually worked".
#
# The FULL package, not python3-minimal: that ships without the standard
# library and notify.py fails on `import json`. The difference is about 30MB
# and one confusing traceback.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep tini tmux python3 \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Agent SDK for the HTTP/SSE service (deploy/agent-service). Same image as the
# chat session and the jobs, so all three doors are the same assistant at the
# same version — no skew.
#
# Installed at / on purpose. The service's code lives in the mounted repo, not
# in the image, so it must resolve `@anthropic-ai/claude-agent-sdk` from
# /obligations/deploy/agent-service/server.mjs. ESM resolution ignores NODE_PATH and
# only walks parent directories, so /node_modules is the one location that a
# file anywhere under /obligations can reach.
COPY deploy/agent-service/package.json /package.json
RUN npm install --omit=dev --no-audit --no-fund --prefix /

# Non-root. The assistant volume is the only thing this user needs to write.
RUN useradd -m -u 1001 agent

# Pre-trust the workspace. Claude Code keeps this state in ~/.claude.json, which
# lives in the container's writable layer — NOT in the mounted ~/.claude volume —
# so every ephemeral job container started life untrusted and silently dropped
# every permissions.allow entry from .claude/settings.json. The visible symptom
# was scheduled jobs being unable to run git: the 2026-08-27 evening job wrote
# journal/2026-08-27.md and then could not commit it.
#
# Baked into the image rather than shared on the volume on purpose: .claude.json
# is large and rewritten constantly, and one file shared between the long-lived
# chat container and concurrent job containers is a corruption waiting to happen.
RUN printf '{"projects":{"/obligations":{"hasTrustDialogAccepted":true}}}\n' \
      > /home/agent/.claude.json \
 && chown agent:agent /home/agent/.claude.json

USER agent
WORKDIR /obligations

ENV OBLIGATIONS=/obligations \
    GIT_AUTHOR_NAME="obligations" \
    GIT_AUTHOR_EMAIL="obligations@localhost" \
    GIT_COMMITTER_NAME="obligations" \
    GIT_COMMITTER_EMAIL="obligations@localhost"

ENTRYPOINT ["/usr/bin/tini", "--", "/obligations/deploy/entrypoint.sh"]
