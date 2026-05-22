# Execution window policy

A contract may declare zero or more execution windows. A window is a wall-clock local-time tuple:

- `day_of_week` — 0 = Sunday … 6 = Saturday (matches JS `Date.getDay()`)
- `start_time` — `"HH:MM"` (inclusive)
- `end_time` — `"HH:MM"` (exclusive)

An action is inside the window if its local moment lies in at least one declared window. Outside any declared window, the evaluator returns `soft_block` with `reason_code = outside_execution_window` and `suggested_action = reschedule`.

## No-windows = always-on

If a contract declares zero windows, the engine treats the schedule as
unrestricted: the contract envelope itself is the gate. This is the
right default for operators who want full coverage and rely on the
cadence ceilings instead.

## Timezone resolution

Windows are stored without a timezone — they're wall-clock tuples. The runner resolves them against the workspace's IANA timezone (from `workspace_settings.timezone`) when evaluating an action's local moment. The helper `toLocalMoment(iso, timezone)` in `src/core/weekly-contract/execution-window.ts` does the conversion.

If the workspace has no timezone set, the host timezone is used as a
fallback. This is best-effort for the boundary check; once
`workspace_settings.timezone` is set, the authoritative answer is
durable.

## Daily key for cadence

The same timezone is used to compute the local-day key
(`"YYYY-MM-DD"`) that drives the per-day and per-platform-per-day
cadence caps. This keeps the cadence and window math consistent — both
the cap and the window land on the operator's day.

## Edge cases

- `end_time <= start_time` — rejected at the CHECK constraint level (well, the form does this; the DB enforces only the pattern). The form rejects empty / malformed entries before insert.
- Windows that span midnight — split into two rows (e.g. Mon 22:00–24:00 + Tue 00:00–06:00) by the operator. The engine does not auto-split.
- Multiple overlapping windows — fine. The engine asks "is the moment in *any* window?" so overlap is harmless.

## See also

- [./weekly-operating-contract.md](./weekly-operating-contract.md)
- [./cadence-and-risk.md](./cadence-and-risk.md)
