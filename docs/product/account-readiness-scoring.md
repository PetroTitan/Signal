# Account readiness scoring

Readiness is a deterministic percentage computed from each account's setup checklist. It surfaces on the accounts list, the detail page, and the dashboard.

The implementation lives in [src/core/onboarding/readiness.ts](../../src/core/onboarding/readiness.ts).

## Checklist items and weights

| ID | Label | Category | Weight |
|---|---|---|---|
| `kit_generated` | Profile kit generated | kit | 5 |
| `manual_account_created` | Account created manually on the platform | manual | 20 |
| `email_verified` | Email verified | manual | 10 |
| `2fa_enabled` | Two-factor authentication enabled | security | 10 |
| `profile_completed` | Display name, bio, and avatar set | profile | 15 |
| `first_warmup_planned` | First warm-up actions planned | planning | 10 |
| `oauth_connected` | OAuth connection (placeholder) | oauth | 15 |
| `ready_for_planning` | Marked ready for weekly planning | planning | 15 |

Total weight: **100**. Readiness is `Math.round(sum(done_weights) / 100 * 100)`.

## What readiness is, and is not

Readiness is a **structural** measure. It tells the founder how much manual setup has been completed. It does **not** measure quality, audience, or content. It is not a leaderboard.

## Next-best-action

Beyond the percentage, the detail page renders the next best action — the first not-yet-done checklist item, expressed as a short imperative. Examples:

- "Create the account manually on the platform. Signal will not do this for you."
- "Verify the account email on the platform."
- "Enable two-factor authentication on the platform."
- "Mark this account as ready for weekly planning."

The OAuth step shows a calm note: "OAuth connection is reserved for when official integrations ship."

## Missing steps

`missingSteps(account)` returns the unchecked checklist items in order. The accounts list uses this count for the "in setup" filter. The detail page uses it to render the small subtitle under the readiness number.

## Safety recommendation

`safetyRecommendation(account)` returns a short calm line when the account is in a state that needs explanation — paused, planned, setup_needed, awaiting_manual_creation, or warming. The detail page surfaces it as an amber callout.

## Determinism

The function is pure. Two reads of the same account produce the same number. The checklist drives everything; nothing is derived from the wall clock or external signals.
