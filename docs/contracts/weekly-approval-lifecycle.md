# Weekly approval lifecycle

The full operator-facing walk-through. Steps below correspond to the buttons in `/weekly-contracts/[id]`.

## 1. Draft

The operator clicks **Save draft** on `/weekly-contracts`. The contract lands as `status='draft'` with:

- title, week_start, week_end
- max_risk_level
- the scope rows (accounts, products, platforms, allowed actions, execution windows)
- the cadence ceilings
- pause-on-failure / pause-on-risk-event toggles

Drafts do not authorize anything. They are visible to all workspace members but only operators (`owner` / `admin`) may edit them; this is enforced by the `weekly_contract_can_approve` RLS helper.

## 2. Submit for approval

`draft → pending_approval`

`pending_approval` means "the operator has finalized the scope and is ready for the final confirmation gate." Nothing executes yet.

## 3. Approve with confirmation phrase

`pending_approval → approved`

The operator must type the confirmation phrase (`approve <title>`) exactly. The phrase is stored on `approval_text_phrase` for the audit trail. This step writes `approved_by` and `approved_at` and is the first irreversible decision in the lifecycle — `approved` contracts can no longer be edited as drafts.

## 4. Activate

`approved → active`

Activation:

- writes `activated_at`
- automatically expires any other `active` contract for the same workspace (the partial unique index would otherwise reject the transition)
- emits `weekly_contract.activated` to `activity_events`

Once `active`, the evaluator (`contract-evaluator.ts`) starts returning `allowed` for in-scope actions.

## 5. Pause (manual or automatic)

`active → paused`

The operator may pause at any time. Auto-pause is triggered when:

- an action fails and `pause_on_first_failure = true`
- a risk_event is recorded and `pause_on_risk_event = true`

While paused, the evaluator returns `soft_block` with `reason_code = contract_paused`.

## 6. Resume

`paused → active`

The operator may resume after addressing the cause. The paused timestamp is cleared.

## 7. Expire

`active | paused → expired`

Happens automatically when the calendar week ends. Expired contracts authorize nothing.

## 8. Revoke

`any non-terminal → revoked`

Manual operator action. Used when a contract was approved in error or when the envelope needs to be torn down before the week ends.

## Activity trail

Every transition writes an `activity_events` row:

- `weekly_contract.created`
- `weekly_contract.approved`
- `weekly_contract.activated`
- `weekly_contract.paused`
- `weekly_contract.revoked`

Together with `execution_authorizations`, this is the full audit story.

## See also

- [./weekly-operating-contract.md](./weekly-operating-contract.md)
- [./emergency-pause-model.md](./emergency-pause-model.md)
