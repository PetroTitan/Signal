# Account-health-first policy

Signal optimizes for account survivability over growth metrics. The reasoning is operational, not philosophical: a platform-locked account doesn't compound. A quiet account on a real cadence does.

Source: [src/core/operational-safety/account-health-policy.ts](../../src/core/operational-safety/account-health-policy.ts).

## Principles

- **Silence is a valid output.** Quiet weeks protect long-term presence. The product never penalizes the founder for posting less.
- **Comments first.** Posts and links earn their place over time. New accounts comment for weeks before publishing.
- **Warm-up before promotion.** Two weeks of warm-up. No promotional items during that period.
- **Caps before urgency.** A weekly cap beats an impulse to publish more. The cap is structural.
- **Skip is a real action.** Not every thread is worth participating in. The discussion engine returns `skip` more often than `participate`.

## Encoded constants

```ts
ACCOUNT_HEALTH_POLICY = {
  maxDirectLinkRatio: 0.33,
  recommendedNoPostDaysPerWeek: 2,
  warmUpDays: 14,
  highVelocityThreshold: 4,
}
```

- `maxDirectLinkRatio` — no more than a third of a week's items per account carry an outbound product link.
- `recommendedNoPostDaysPerWeek` — at least two days each week without any post on a given platform.
- `warmUpDays` — first 14 days of an account, no promotional content.
- `highVelocityThreshold` — more than four items per account per week triggers a "high velocity" warning.

## Helpers

- `recommendCadenceDelay(account, items, candidateIso)` — when the candidate breaks the cooldown rule, returns the delay in hours and a one-sentence reason.
- `calculateAccountCalmScore(account, items)` — composite 0–100 score with a `level` of `calm` / `active` / `high_velocity` and the reasons that drove the score down.
- `shouldSuppressLink(account, candidate, items)` — returns `{ suppress, reason }`. Used by the approval queue to flag items that should ship link-free.
- `shouldRecommendSilence(account, items, candidateIso)` — returns `{ recommend, reason }` when the system suggests skipping the slot.
- `countQuietDays(items, platform, weekStartIso)` — measures the number of unused days in the week.
- `detectCrossPlatformSimilarity(items, threshold)` — Jaccard token similarity across platforms. Flags when the same content drifts across surfaces.

## What this policy never does

- It never auto-pauses an account.
- It never blocks the founder from approving an item against its recommendation.
- It never fabricates a metric to justify silence.
- It never frames silence as "underperformance."

The policy is a calm operating principle, not a leaderboard.

## See also

- [operational-safety-layer.md](./operational-safety-layer.md)
- [../platforms/oauth-first-principle.md](../platforms/oauth-first-principle.md)
- [../product/onboarding-philosophy.md](../product/onboarding-philosophy.md)
