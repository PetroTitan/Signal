# Emergency pause model

The weekly contract is a fail-safe envelope. Anything unexpected pauses execution and surfaces the cause to the operator. There is no auto-resume path — the operator decides whether to continue.

## Pause triggers

A contract auto-pauses when *any* of the following happens, provided the matching toggle is on:

1. **`pause_on_first_failure`** (default: on)
   The runner records a failed action while the contract is active.

2. **`pause_on_risk_event`** (default: on)
   A `risk_events` row is recorded for the workspace while the contract is active.

The toggles let an operator opt out of auto-pause for low-stakes accounts (e.g. an internal test workspace). They are stored on the contract row so they apply for the whole week.

## What happens during pause

- `status` flips from `active` → `paused`, `paused_at = now()`.
- The evaluator returns `soft_block` with `reason_code = contract_paused` for any subsequent attempt.
- A `weekly_contract.paused` activity event is emitted.
- The runner does **not** retry. Items that were going to run during the pause are sent to the backlog (the `suggested_action` is `request_new_approval` or `reschedule` depending on the original reason).

## Resume

The operator clicks **Resume** on `/weekly-contracts/[id]`. The transition is `paused → active`. The repository clears `paused_at`. The runner picks up the contract on the next evaluation.

The runner does not auto-resume on its own. This is intentional: an
auto-pause is a "stop and let a human look" signal, not a transient
backoff.

## Hard fails vs. soft fails

A *hard* fail — bug in the runner, missing credentials, network outage — should auto-pause. A *soft* fail — risk engine veto, cadence cap, item already published elsewhere — should not, because those are normal control flow.

The current code treats any caller-reported failure as hard; soft failures don't call the runner at all, they're handled by the planner before evaluation.

## Revoke vs. pause

- **Pause**: temporary, reversible, used for "look at this before continuing."
- **Revoke**: terminal, used for "this contract is wrong and shouldn't exist."

Pause is the default safety behavior. Revoke is the operator's nuclear option and emits `weekly_contract.revoked`.

## See also

- [./weekly-operating-contract.md](./weekly-operating-contract.md)
- [./weekly-approval-lifecycle.md](./weekly-approval-lifecycle.md)
