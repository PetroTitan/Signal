# Incident — Bluesky post blocked, card contradicted itself

Date: 2026-08-15. Workspace `f92ade76-7516-47db-9f88-2080ce0a1ea0`.
Branch: `fix/publishing-blocker-source-of-truth`. Baseline `b17fba9`.

The operator saw a card that said **"Creative approved"** and, directly
beneath it, **"Creative must be approved before the post itself can be
approved."** The post was `Paused`, the Failed tab said *"Bluesky didn't
publish this post. Blocked"*, and a **Schedule retry** button was offered.

Nothing in that description was actionable and one half of it was false.

---

## 1. Database truth

Read before any code was changed. Read-only; nothing was mutated.

| Record | Value |
|---|---|
| `weekly_plan_items` | `7be1588e-1421-4b15-bae5-00cbe87de61c`, platform `bluesky`, status `paused`, title NULL, body 275 chars, `account_id` = `8096e0b4…` |
| `weekly_plan_item_creatives` | `cb61b3ff…` — **status `approved`**, asset URL present, alt text `"#myiosapps"`, image/jpeg 188 028 bytes |
| `growth_accounts` | `8096e0b4…` bluesky — **`review_status` = `confirmed`**, `connection_status` = `connected` |
| `platform_connections` | `5dc28b75…` — `connected` / `healthy`, provider account id present, tokens present, `atproto.server.createSession` |
| `execution_items` | `9d2c576c…` and `88be67cc…` — **both `blocked`**, `attempt_count` 0, **`account_id` = NULL** |
| `metadata.publish_outcome` | `{status: "blocked", reason_code: "account_not_confirmed", reason_detail: "Account review_status must be 'confirmed' (is 'unknown')."}` |
| `publish_history` | two rows, both `outcome: blocked`, `provider_post_id` / `provider_permalink` / `http_status` **all NULL** |

Every other execution item in the table has `exec.account_id == plan.account_id`.
Only these two are NULL.

**The provider was never called. Retry class A.** The only published row in
the workspace belongs to a different plan item on X
(`c0c0ae12…` → `https://x.com/PetroHrys/status/2088628143733023154`).

---

## 2. The contradiction

Two strings, two different sources:

- **"Creative approved"** — `describeCreativeState()`, derived from the
  creative row. Correct.
- **"Creative must be approved…"** — `WorkflowBanner()` in
  `_creative-approval-controls.tsx`: a function taking **no parameters**,
  with **no conditional**, rendered whenever a creative existed. It pointed
  at approve/reject buttons that were correctly hidden because the creative
  was already approved.

Hypothesis 1 from the incident brief, with a specific mechanism: one label
derived from state, one hardcoded.

It was also wrong in general, not just here. `requiresCreative()` returns
false for Bluesky, so creative approval has never blocked a Bluesky post.

## 3. Why it did not publish

No approval gate has ever required a publishing identity.
`assessItemApprovalReadiness` checked status, risk, approvable object,
creative, contract scope, schedule and Reddit target — never `account_id`.

`defaultAccountId` on `/weekly-plan` is computed from confirmed **Reddit**
accounts only. The compose sheet defaults to Reddit, so switching the
destination to Bluesky left the draft with an empty identity and nothing
asked for one. The item was approved and scheduled with `account_id = null`.

At the tick, `publishOne` looked the account up by
`execution_items.account_id`, found nothing, resolved `accountReviewStatus`
to `null`, and `evaluatePublishingPolicy` refused with
`account_not_confirmed` — *"Account review_status must be 'confirmed' (is
'unknown')"*. A message describing a confirmation problem when the truth was
that there was no identity at all.

`friendlyFailure()` had no case for that code, so it fell through to the
generic *"Bluesky didn't publish this post. Try again in a moment"* — wrong
twice over: nothing was sent, and retrying changes nothing.

## 4. State transition, actual vs expected

```
draft ─ creative uploaded ─ creative approved ─ sent for approval
  └─ approved + scheduled          ← STOPPED BEING CORRECT HERE
       (execution_item created with account_id = NULL;
        no gate required an identity)
  └─ scheduled ─ tick ─ policy gate ─ blocked(account_not_confirmed)
  └─ plan item mirrored to paused
  └─ "Schedule retry" ─ second execution_item ─ identical refusal
```

Expected: approval refuses at *approved + scheduled* with
`identity_not_attached`, naming the action, before any execution item exists.

---

## 5. Recovery procedure

**Do not run any of this until the fix is deployed.** Recovery is entirely
operator-driven through the UI; no SQL is required and none should be run.

**Duplicate-publication safety — cleared.** `publish_history` holds two rows
for this item, both `blocked`, with `provider_post_id`, `provider_permalink`
and `http_status` all NULL, and `attempt_count` 0. `resolvePublishingState`
classifies the outcome `refused_before_provider` and
`evaluateRetryEligibility` returns `safe_or_conditional_retry` (class A).
Bluesky cannot contain this post. Republishing cannot duplicate anything.

Steps:

1. Open the post on `/weekly-plan`. The card now states the real blocker:
   *"Publishing blocked — nothing was sent · Bluesky publishing is not set up
   for this identity."*
2. Open the post, expand **Advanced**, and confirm **Identity** shows
   `@petrohrys.bsky.social`. On a fresh destination switch this is now
   selected automatically; on this existing row it must be set once by hand,
   because the row predates the fix.
3. Save (autosave writes `account_id`).
4. Click **Schedule retry**. It remains offered — correctly, this is class A.
   The approval gate will now refuse instead if the identity is still
   missing, rather than minting a third dead execution item.
5. Confirm the new execution item carries a non-null `account_id` before the
   tick runs.

Nothing needs to be deleted, reset or rewritten. The two blocked execution
items and their publish history are audit records of a real refusal and are
retained deliberately.

## 6. What was NOT done

No production row was mutated. No execution history was deleted, no
`publish_outcome` erased, no `attempt_count` reset, no approval event
overwritten. The affected post was not published during the investigation.
No migration. No other platform touched.

## 7. Follow-ups not taken here

- **Bulk approve still runs pre-F7.4 rules.** `approveWeeklyPlanAction` and
  `approveAndHoldAction` inline `contentType !== "post"` and call
  `creativeReadinessReason` without consulting `requiresCreative`, so they
  skip optional-creative platforms for a creative they do not need. They are
  more conservative than the canonical evaluator, not less, so they cannot
  approve something they should not — but they are a second implementation of
  the same question and should be migrated.
- **`describeSkip` funnels operators to Schedule retry** with copy that is
  wrong for a class-C outcome (*"Use Schedule retry to create a fresh
  publish"*). The button is now outcome-gated, so the advice can point at a
  control that is absent.
- **"Previous attempt" is defined differently in two places** — the UI takes
  the last element of a `scheduled_at ASC` list (NULLs sort last, so a
  manual-prepared row can outrank a later attempt), while MCP orders by
  `created_at DESC LIMIT 1`. Benign here; both incident rows are class A.
- **No attempt budget for `blocked` outcomes.** `attempt_count` is only
  written for `failed`, so identical blocked rows can be minted without limit.
