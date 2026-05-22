# Operational safety layer

The operational safety layer is the set of deterministic helpers that protect account health at the application's edges. Each helper is small and pure.

Source: [src/core/operational-safety/](../../src/core/operational-safety/).

## Modules

- `account-health-policy.ts` — the named constants and principles. The single source of truth for `maxDirectLinkRatio`, `warmUpDays`, etc.
- `cadence-safety.ts` — `recommendCadenceDelay`, `calculateAccountCalmScore`.
- `link-suppression.ts` — `shouldSuppressLink`.
- `silence-policy.ts` — `shouldRecommendSilence`, `countQuietDays`.
- `cross-platform-drift.ts` — `detectCrossPlatformSimilarity` (Jaccard).

## How they fit into the existing engines

The risk engine, the approval queue, and the scheduler already enforce most of these rules indirectly. The operational safety layer makes them callable as named helpers so future surfaces (the cadence dashboard, future AI prompts, future cron summaries) can reuse the same checks without re-deriving them.

The helpers are intentionally **lightweight**. They don't paginate, they don't cache, they don't write state. Inputs in, signal out.

## Determinism

Every helper is a pure function of its inputs. No clocks beyond `Date.now()` for staleness checks, no randomness, no fetches.

This makes them easy to test and easy to audit.

## What this layer never does

- It never auto-applies a fix. It surfaces a recommendation; the founder decides.
- It never logs to an external sink.
- It never depends on a database — the inputs are passed in.
- It never knows about AI. Operational safety is an account-health concern, not an AI concern.

## See also

- [account-health-first.md](./account-health-first.md)
- [../ai/safety-policy.md](../ai/safety-policy.md)
- [../architecture/scheduler.md](../architecture/scheduler.md)
- [../risk-engine/risk-scoring-v1.md](../risk-engine/risk-scoring-v1.md)
