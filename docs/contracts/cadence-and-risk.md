# Cadence and risk

Two ceilings live inside every contract: how *many* things may happen, and how *risky* they may be.

## Risk ceiling

`max_risk_level` is one of `low | medium | high`. The product's broader risk vocabulary also includes `blocked`, which is never authorized regardless of the contract.

```
RISK_CEILING_RANK:
  low    → 1
  medium → 2
  high   → 3

fitsUnderRiskCeiling(candidate, ceiling) :=
  candidate !== "blocked" && rank(candidate) <= rank(ceiling)
```

- `low` — only the safest content runs automatically.
- `medium` — standard posts and comments may run; sensitive content escalates.
- `high` — most content runs unless flagged by the risk engine.

The risk level on a candidate item comes from the existing risk engine
(`src/core/risk/`). The contract layer does not compute risk; it only
applies the ceiling.

## Cadence ceilings

Three axes, evaluated in order. `null` on any axis = no limit on that axis.

1. `max_actions_total` — over the whole week.
2. `max_actions_per_day` — within a single local day.
3. `max_actions_per_platform_per_day` — per-platform daily cap.

The local-day boundary uses the workspace timezone (when set) so a 10-per-day cap applies to *the operator's* day, not UTC.

## Snapshots

The runner builds an `ActionCountSnapshot` from prior `allowed`
authorizations:

```ts
interface ActionCountSnapshot {
  totalAllowed: number;
  perDay: Record<string, number>;             // "YYYY-MM-DD"
  perPlatformPerDay: Record<string, number>;  // "platform|YYYY-MM-DD"
}
```

The snapshot is built by `loadCadenceSnapshotForContract` in
`src/repositories/execution-authorization-repository.ts` — it filters to
the contract's week range, aggregates the allowed rows, and feeds them
into the evaluator.

## Failures vs. ceilings

Hitting a cadence ceiling is a **soft_block** with `suggested_action =
reschedule` and `should_backlog = true`. The runner is meant to move on
without escalating — a daily cap isn't a safety event, it's a budget.

Risk ceiling violations are **hard_blocks**. They mean the user has not
approved this kind of action under the current envelope.

## See also

- [./weekly-operating-contract.md](./weekly-operating-contract.md)
- [./execution-authorization.md](./execution-authorization.md)
- [./execution-window-policy.md](./execution-window-policy.md)
