# Weekly approval workflow

Signal compresses every growth decision into a single weekly checkpoint. This document describes how the approval flow works in the MVP.

## Lifecycle

```
draft → pending_approval → approved → scheduled → published
                       ↘ rejected
                       ↘ backlog
                       ↘ paused → pending_approval (on resume)
```

A weekly plan is assembled from the workspace's products and accounts. Items begin life as `pending_approval` and never reach the scheduler until the founder approves them.

## Decisions available in the approval queue

| Decision | Effect |
|---|---|
| Approve | Marks the item `approved`. It becomes eligible for the scheduler. |
| Reject | Marks the item `rejected`. It does not reappear in the plan. |
| Rewrite softer | Runs deterministic tone softening on the body copy. |
| Remove link | Strips the CTA and outbound tracking link. |
| Delay 24h | Shifts the scheduled time forward 24 hours. |
| Convert to comment | Changes content type to `comment_reply` and removes any link/CTA. |
| Save to backlog | Moves the item to the backlog and removes it from the active plan. |
| Pause | Holds the item; can be resumed back into pending. |
| Duplicate next week | Clones the item one week into the future as a `draft`. |
| Approve all low-risk | Bulk action — approves every `pending` item scored as low risk. |

## The single weekly review

Signal is designed so the founder reviews **once** per week. There are no daily notifications, no urgency surfaces, no "publish now" prompts. The dashboard and the approval queue both show a single count of pending items. After one calm review pass, the week is done.

## What happens to risk during approval

Each `pending` item is scored deterministically by the risk engine (see [docs/risk-engine/risk-scoring-v1.md](../risk-engine/risk-scoring-v1.md)). The scoring re-runs after every state mutation — approving, rejecting, delaying, removing a link, or restoring from the backlog all rescore the entire plan. This keeps the displayed risk consistent with the current week's mix.

## What does not happen

- Items are never auto-approved.
- Items in `setup_needed`, `awaiting_manual_creation`, or `planned` accounts cannot reach `scheduled`. Their risk level is `blocked`.
- The approval queue does not have a "publish now" button. Publishing is a separate downstream step that does not exist yet.

## Audit trail

Every decision generates an `ApprovalEvent` with the action, the actor email, and the timestamp. The events are append-only and live on the workspace state.
