# Weekly operating contract

Signal's core operational model is: **the user approves once per week, and Signal may then operate for 7 days within explicitly approved boundaries.** The weekly contract is the envelope that describes those boundaries.

## What a contract is

A `weekly_approval_contracts` row plus its scope tables:

- `weekly_contract_accounts` — which growth accounts the contract covers
- `weekly_contract_products` — which products the contract covers
- `weekly_contract_platforms` — which platforms (reddit / x / linkedin) the contract covers
- `weekly_contract_allowed_actions` — which action types are permitted
- `weekly_contract_execution_windows` — day-of-week + time-of-day windows during which execution is authorized

A contract is the *only* thing that authorizes write-side execution. With no active contract, every write attempt is hard_blocked at the boundary.

## What a contract is not

A contract is **not** a key to anything Signal couldn't do before. It does not unlock:

- account creation
- platform login automation
- browser automation
- password / cookie / session-token storage
- AI freeform execution
- billing / payment changes

Those are blocked unconditionally in `src/core/weekly-contract/contract-policy.ts` and have no code path behind them in the runner.

## Lifecycle

`draft → pending_approval → approved → active → (expired | paused | revoked)`

- A user with role `owner` or `admin` may create, submit, approve, activate, pause, resume, or revoke a contract.
- Only one contract is `active` at a time per workspace (enforced by a partial unique index).
- Activating a contract automatically expires the previous one.
- Transitions are validated in `contract-status.ts`; bad transitions throw `ContractStatusError`.

See [./weekly-approval-lifecycle.md](./weekly-approval-lifecycle.md) for the operator-facing walk-through.

## What an active contract grants

Listed in `src/core/weekly-contract/contract-policy.ts` and surfaced in the `/weekly-contracts` UI:

- Publish the scheduled posts and comments listed in the weekly plan.
- Skip or rotate to backlog plan items that no longer fit.
- Send engagement signals (likes / saves / follow-ups) on approved accounts.
- Open a PR for review (Claude / Codex) on the listed scope.

## What stays restricted, always

- Only within the per-day / per-week cadence ceiling.
- Only on the accounts and products explicitly in scope.
- Only on the platforms explicitly in scope.
- Only at risk level ≤ the contract ceiling.
- Only within the declared execution windows.
- If anything fails, the contract auto-pauses until you re-approve.

## See also

- [./execution-authorization.md](./execution-authorization.md) — the per-action gate
- [./cadence-and-risk.md](./cadence-and-risk.md) — how cadence and risk ceilings interact
- [./weekly-approval-lifecycle.md](./weekly-approval-lifecycle.md) — operator walk-through
- [./emergency-pause-model.md](./emergency-pause-model.md) — what triggers an auto-pause
- [./execution-window-policy.md](./execution-window-policy.md) — window resolution
