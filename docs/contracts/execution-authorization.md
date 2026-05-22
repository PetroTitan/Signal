# Execution authorization

Every time the runner is about to take a write-side action — publish a post, send a comment, fire an engagement signal — it first asks: **is this authorized under the active weekly contract?**

The answer is computed by `evaluateExecutionAuthorization(input)` in `src/core/weekly-contract/contract-evaluator.ts` and persisted to `execution_authorizations` regardless of the verdict.

## The shape of the answer

```ts
interface AuthorizationResult {
  authorized: boolean;
  outcome: "allowed" | "soft_block" | "hard_block";
  reasonCode: ExecutionAuthorizationReasonCode;
  reasonDetail: string | null;
  severity: "allow" | "soft_block" | "hard_block";
  suggestedAction:
    | "proceed"
    | "send_to_backlog"
    | "reschedule"
    | "pause_contract"
    | "request_new_approval"
    | null;
  shouldBacklog: boolean;
  shouldPause: boolean;
}
```

- `allowed` — the action may run.
- `soft_block` — recoverable. The runner moves on (reschedule, send to backlog) without alarming the operator.
- `hard_block` — the contract does not authorize this. The runner refuses and surfaces the result to the operator.

## Evaluation order

The first failing rule wins. Order matters:

1. **Demo mode** — demo workspaces always hard_block.
2. **No active contract** — hard_block, suggest `request_new_approval`.
3. **Contract paused / expired** — soft_block or hard_block depending on status.
4. **Action type allowed?** — hard_block if the action isn't in `allowed_actions`.
5. **Account / product / platform in scope?** — hard_block if any is out of scope.
6. **Risk under ceiling?** — `risk_above_ceiling` hard_block.
7. **Cadence ceilings** — soft_block (total, per-day, per-platform-per-day).
8. **Execution window check** — soft_block if outside any declared window.

The evaluator is **pure**. It does not call the database. The repository
layer loads the contract, builds the cadence snapshot, and feeds the
result in.

## Persistence

Every evaluation is written to `execution_authorizations` with the
verdict, the reason code, and the resolved suggested action. The table
is workspace-scoped, append-only, and RLS-protected — members can read,
inserts are gated by `is_workspace_member`.

## See also

- [./weekly-operating-contract.md](./weekly-operating-contract.md)
- [./cadence-and-risk.md](./cadence-and-risk.md)
- [./emergency-pause-model.md](./emergency-pause-model.md)
