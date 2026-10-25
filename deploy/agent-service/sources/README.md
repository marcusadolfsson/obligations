# Obligation sources

One adapter per store. Each exports the same two things:

```js
export const SOURCE = 'todo';
export async function read(obligations)             // → candidate obligations
export async function close(obligations, ref, who)  // → discharge it in its own store
```

**The store stays authoritative.** An adapter reads a file Alex owns and
writes back into that same file — it never mirrors it. `todo.md` is the truth
about hand-typed tasks, `reminders.md` about reminders, and
`integrations/imessage-state.json` about what the triage concluded. The
obligation layer above joins them; it does not replace them.

A candidate is:

| field | meaning |
|---|---|
| `ref` | identifier **within this source** — a chat id, a line hash |
| `what` / `who` | the obligation and the person, already human-readable |
| `since` | when it started, `YYYY-MM-DD` or a full stamp |
| `due` | a deadline, if the source has one. Reminders always do |
| `priority` | `high` \| `normal` \| `low` |
| `owed_by` | `me` (he owes it) or `them` (he is waiting) |
| `open` | false means discharged; closed entries are still returned so the merge layer can see them |
| `detail` | anything source-specific the UI may show |

`close()` must be idempotent and must leave everything else in the file
byte-for-byte alone. It is editing something a human maintains by hand.
