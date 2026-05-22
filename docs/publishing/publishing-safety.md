# Publishing Safety Gates (Phase F1)

Before Signal posts anything to a third-party platform, the request
must pass every gate in
[`publishing-policy.ts`](../../src/core/publishing/publishing-policy.ts).
A single failure short-circuits the rest and marks the item
`skipped` or `blocked` with a reason code.

## Gate order

```
1. Mode gate         dry_run → publishOk (fake URL, no network call)
2. Workspace gate    publishing_enabled == true
3. Contract gate     active weekly contract exists
4. Account gate      account.review_status == 'confirmed'
5. Product gate      product.review_status == 'confirmed'
6. Connection gate   platform_connection.status == 'connected'
7. Cipher gate       access_token_encrypted IS NOT NULL
8. Risk gate         risk_level != 'blocked'
9. Time gate         scheduled_for <= now
```

If gate 1 returns `dry_run`, the publisher is **never called**.
The runner produces a synthetic `publishOk` with
`url: "dry-run://<platform>/<execution_item_id>"` and an
`execution_log` row marked `severity='info'`.

## Reason codes

These are the only values written to `execution_logs.reason_code`.
The set is fixed in
[`publishing-types.ts`](../../src/core/publishing/publishing-types.ts).

| Code | Used when |
|------|-----------|
| `dry_run` | Workspace `execution_mode='dry_run'` |
| `publishing_disabled` | Workspace `publishing_enabled=false` |
| `no_contract` | No active weekly contract |
| `account_not_confirmed` | Account `review_status != 'confirmed'` |
| `product_not_confirmed` | Product `review_status != 'confirmed'` |
| `not_connected` | Platform connection not in `connected` state |
| `no_token` | Connection `connected` but `access_token_encrypted` is NULL |
| `risk_blocked` | Item `risk_level='blocked'` |
| `too_early` | `scheduled_for > now` |
| `not_implemented` | Platform publisher is a stub (x, linkedin, google) |
| `oauth_expired` | Platform returned 401 |
| `oauth_insufficient_scope` | Platform returned 403 |
| `rate_limited` | Platform returned 429 |
| `platform_4xx` | Platform returned other 4xx |
| `platform_5xx` | Platform returned 5xx |
| `platform_error` | Platform returned `errors=[...]` in body |
| `network_error` | fetch threw |
| `internal_error` | Anything else |

## Live mode — what the operator must do

To flip a single item from `dry-run` to `live`:

1. `UPDATE workspace_settings SET execution_mode='live',
   publishing_enabled=true WHERE workspace_id=...`
2. Activate a weekly contract that includes the target account /
   product / platform.
3. Approve account at `/approval-queue`.
4. Approve product at `/approval-queue`.
5. Run OAuth at `/accounts/[id]` and confirm
   `platform_connections.access_token_encrypted IS NOT NULL`.
6. Approve the weekly plan.

If steps 5 or 6 are skipped, the gate stops the publish without
calling Reddit. Signal never silently downgrades to dry-run or
proceeds against a missing connection.

## What's intentionally *not* a gate

- Subreddit rules (responsibility of the operator).
- Content quality / tone (responsibility of the author).
- Audience targeting (responsibility of the weekly contract).
- Posting frequency (responsibility of the scheduler — one tick =
  one batch, items naturally space themselves by `scheduled_at`).

These are deliberately out of scope to keep Signal a thin,
reviewable delivery layer rather than a content platform.
