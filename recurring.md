# Recurring

> Obligations that come back every period. **Each period is its own item**, so
> August's submission and September's are different things with different
> records — a line whose due date just gets bumped forward loses the only fact
> worth keeping.
>
> Nothing here is ever rewritten by the system. This is a definition; the state
> lives in `logbook.md`, and the tasks page derives the current period from the
> calendar.
>
> ```
> ## Title                    !every:1m !by:8 !from:2026-08
>
> A note about the block, shown with the task.
>
> - [ ] one part of it        !closes:what done looks like
> ```
>
> `!every:` `1w` | `1m` | `3m` | `1y` — the reporting period.
> `!by:`    day of the month it is due *after* the period ends (a weekday name
>           for `1w`). Clamped to the month's length, so `31` in February is the 28th.
> `!from:`  the first period to track. Without it only the period that just
>           ended is shown, so writing a block down does not invent a backlog.
> `!closes:` what discharge looks like. Must be last on the line.
>
> This models **a completed period reported on shortly after it ends**. For
> "do X on the 15th of every month" — no period, no per-period record — use
> `reminders.md` with `repeat:1m` instead.

## Example: monthly expense report       !every:1m !by:5 !from:2026-01

Delete this block, or replace it with your own.

- [ ] Submit the expense report          !closes:confirmation email from accounting
