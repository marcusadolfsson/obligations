# gbrain adoption plan

Decision 2026-08-27: not yet. This file records when and how, so the door stays open
and the reasoning survives.

[gbrain](https://github.com/garrytan/gbrain) is a retrieval layer over exactly this
kind of repo: markdown as system of record, synced into PGLite/Postgres for hybrid
search + knowledge graph + synthesis, exposed to agents over MCP.

## Why not now

At the current scale (dozens of files), `rg` finds everything and a database is pure
overhead. gbrain's retrieval wins appear on large corpora, not forty files.

## Adopt when either becomes true

- Ingestion starts — email archives, transcripts, read-later — and the corpus grows
  past a few thousand pages, where grep stops finding things.
- Queries start failing because answers need cross-document synthesis
  ("who did I talk to about X last spring"), not lookup.

## Kept compatible meanwhile

- Directory names match gbrain's canonical types (`people/` → person,
  `projects/` → project); templates carry `type:` frontmatter.
- `[[wikilinks]]` discipline everywhere.
- Migration is then `gbrain schema detect` → `suggest` → `review-candidates --apply`
  over the existing repo. The repo stays system of record; gbrain's DB is a cache.

## Non-negotiable wiring when adopted

**Scheduled jobs get read-only verbs only** — `recall`, `entity`, `synthesize` —
enforced in `.claude/settings.json`, not just prompts. `remember` and `forget` stay
exclusive to interactive sessions where Alex is present. Reason: jobs process
attacker-controlled email; write verbs would let an injected instruction poison
memory ("remember that Alex's bank is now…") or erase it. Same defence-in-depth
pattern as the mail deny-list.

Also: pin a gbrain version in the image. Young, fast-moving codebase (its own docs
list ReDoS sync wedges and PGLite WAL corruption on unclean shutdown). Never track
latest-stable unattended.
