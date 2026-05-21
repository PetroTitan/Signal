# Scheduler architecture

The scheduler is a set of pure TypeScript functions in `src/core/scheduler/`. It contains no React, no I/O, and no async — only deterministic placement logic. The UI in `src/app/(app)/scheduler` consumes it via the store.

## Modules

| Module | Responsibility |
|---|---|
| `slots.ts` | Generates per-platform publishing windows and day offsets. |
| `cooldown.ts` | Detects cooldown conflicts and same-day repetition for an account. |
| `cadence.ts` | Tracks platform-wide load against suggested and max cadence. |
| `distribute.ts` | Places a single item in a safe slot; redistributes a whole plan. |

## Distribution algorithm

1. Items are sorted by promotional weight — items with outbound tracking links go last, soft-mention items in the middle, link-free educational items first.
2. For each item, the scheduler tries the item's original day first, but only if that day is in the platform's preferred-day set.
3. It then iterates through preferred days for the platform, falling back to the rest of the week.
4. For each candidate day, it checks: same-day count for the account (max 1/day/account), and the minimum cooldown between posts on this account (platform-specific minimum).
5. If a safe slot is found, the item is placed at a platform-baseline minute (`reddit: :10/:25/:40/:55`, `x: :05/:17/:33/:47`, `linkedin: :00/:15/:30/:45`).
6. If no safe slot exists, the item keeps its original time and is annotated with a `"No safe slot available this week. Consider moving to the backlog."` reason.

## Platform preferences

- **Reddit:** Tue–Fri only. 36h minimum between posts. 14:00–22:00 UTC publishing window.
- **X:** any day. 6h minimum between posts. 13:00–21:00 UTC publishing window.
- **LinkedIn:** Tue–Thu preferred. 24h minimum between posts. 08:00–16:00 UTC publishing window.

These constants live in `slots.ts`, `cooldown.ts`, and `distribute.ts`. They are intentionally explicit, not learned from a database, so the scheduler is reproducible.

## What the scheduler never does

- Multi-account concurrent posting in the same minute.
- Same-day double-posting from one account.
- Cooldown-violating placements.
- Increasing the volume to "fill" the week — it only places items the founder approved.

## Redistribute

The `redistributeAll` function places every item from scratch in promotional-weight order and returns the list of moves. Each move includes the original time, the new time, and a calm reason string that the UI surfaces as cadence-protection messaging.

## Reading the schedule in the UI

The scheduler page consumes live state through `useSignal()` from the store. The grid groups items by day (default), by account, or by product. A separate backlog rail shows items being held. Cadence load bars summarize how full each platform is this week.
