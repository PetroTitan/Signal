# Cadence protection

Cadence protection is the part of Signal that says "no" calmly when the founder, the plan, or the scheduler would otherwise overpost. It is the difference between Signal as a growth governor and a growth-hacking dashboard.

## What it watches

- Platform-level load against suggested and max cadence.
- Per-account weekly volume.
- Account readiness (warming, planned, setup-needed).
- The most recent redistribution and the moves it made.

## How it surfaces

Cadence protection messages appear as small calm callouts on:

- The dashboard, above the operations stats.
- The approval queue, above the filter bar and item list.
- The scheduler, above the load strip.

Each message has one of three tones:

- **Info** — informational, no action needed.
- **Warn** — recommended action.
- **Block** — the item should not publish on this account in its current state.

## Voice

The messages are written calmly. Examples that the system can show today:

- "You already scheduled enough X content this week (8 of 7 suggested). Signal will hold further items in the backlog."
- "WebmasterID X is approaching its weekly cap. New items will likely be deferred."
- "Petro · HELPERG has 4 items this week — recommended cooldown: 48 hours between posts."
- "PDF tools support is still in setup. Items on this account should be moved to the backlog until the account is connected."
- "2 items were moved to safer windows during the last redistribution."

The system never says "warning," "danger," or "you must." It surfaces facts and a suggestion.

## Boundary

Cadence protection is advisory, not enforcing. The founder can still approve a borderline item — Signal's job is to make sure the cost of that choice is visible before it ships.
