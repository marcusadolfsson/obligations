# integrations

Data pushed in from machines that hold something the assistant cannot reach itself.

`imessage.json` — a bounded extract of iMessage threads, pushed from the Mac
Studio every 15 minutes. **Gitignored and never committed**: it is other
people's message content, and git history is not a place you can take something
back out of. See `deploy/integrations/README.md` for the shape, the caps, and
setup.

If a file here is missing or stale, that is a fact to report, not to paper over
— the Mac being off is normal and the brief should say so.

## gmail-filters.xml

Gmail → Settings → Filters and Blocked Addresses → select all → Export. Tracked
in git on purpose: 122 of these archive mail on arrival, which makes them the
already-ratified statement of what Alex thinks each sender is worth, and
`rules/email-triage.md` reads the forwarding target as the name he gave each
group. Versioning them means a change is visible.

Exported by hand rather than read through the API: the only scope that lists
filters is `gmail.settings.basic`, which is the same scope that creates them,
and keeping it ungranted is what makes "never create standing rules" a
capability rather than a promise. Re-export when they change.
