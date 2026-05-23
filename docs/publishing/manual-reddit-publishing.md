# Manual Reddit Publishing (Phase F2.6)

Signal-prepared payload, operator-published on Reddit, Signal-recorded
audit. This is not browser automation, not scraping, not API bypass.
It is an operator-assisted workflow that lets Signal be useful while
Reddit's API approval is pending — and remains useful afterward as
a deliberate alternative to the live API path.

## When to use this

- Reddit hasn't approved the OAuth app yet (Responsible Builder
  Policy review pending).
- OAuth credentials are not configured for the workspace.
- The token cipher (`TOKEN_ENCRYPTION_KEY`) isn't set.
- The `submit` scope isn't granted on a connection.
- The operator chooses manual mode for a specific post (e.g. to set
  custom flair, attach a media file Reddit's API doesn't accept, or
  any one-off control the API doesn't give us).

## State machine

```
draft
  └▶ pending_approval     (creative attached, schedule set, approved)
       └▶ scheduled        (approveWeeklyPlanAction)
            └▶ ready       (scheduler tick under SAFE_TEST_MODE)
                 ├─▶ running → completed   (API path, F2.5)
                 └─▶ ready_for_manual_publish   (operator clicked Prepare)
                      └▶ running → completed   (operator pasted permalink)
```

`ready` and `ready_for_manual_publish` are siblings — both are
holding states the scheduler hands off to the operator. The
operator picks which path applies by clicking either:

- **Publish to Reddit** (API path, requires connected OAuth) — on
  `ready` items
- **Prepare for manual publish** (no OAuth required) — moves a
  `ready` item to `ready_for_manual_publish`

Once in `ready_for_manual_publish`, only the manual record-form is
shown.

## Surfaces

### `/execution/items/<id>`

Renders three sections when the item is on the manual track:

1. **Pre-publish checks.** The manual policy (every gate except
   OAuth/token) returns a verdict with per-row pass/fail status.
2. **Payload preview.** subreddit, account, product, creative,
   alt text, scheduled time, and the exact body / link the
   operator should post.
3. **Manual publish form.** Copy buttons for title, body (or link
   URL), full payload, and creative URL. A direct link to Reddit's
   submit page for the target subreddit. Permalink field + operator
   notes + the same confirmation phrase as the API path.

### `/accounts`

When `REDDIT_OAUTH_STATUS=blocked_pending_reddit_api_approval`, a
banner explains the API path is unavailable and points to the
manual workflow. The per-row OAuth Connect button is hidden for
Reddit while blocked.

### MCP

- `signal.execution.manual_publish_preview` — read-only. Returns
  title, body, subreddit, creative_url, alt_text, open_reddit_url,
  copyable_payload, policy verdict.
- `signal.execution.record_manual_publish` — write tool. Same gates
  as the UI form. Validates permalink, refuses duplicates, inserts
  publish_history (mode='manual'), walks the execution_item to
  completed, mirrors plan_item to published.

## Policy gates that still apply

The manual path enforces every safety gate except the two OAuth
gates from the live path. Specifically:

| # | Check | Manual | Live |
|---|---|---|---|
| 1 | `SAFE_TEST_MODE=true` | ✓ | ✓ |
| 2 | platform=reddit, action=publish_scheduled_post | ✓ | ✓ |
| 3 | Subreddit in `ALLOWED_TEST_SUBREDDITS` | ✓ | ✓ |
| 4 | Confirmation phrase matches exactly | ✓ | ✓ |
| 5 | Account `review_status='confirmed'` | ✓ | ✓ |
| 6 | Product `review_status='confirmed'` | ✓ | ✓ |
| 7 | Active weekly contract | ✓ | ✓ |
| 8 | Creative readiness (asset + alt + license) | ✓ | ✓ |
| 9 | OAuth connected + healthy + token decryptable | **skipped** | ✓ |
| 10 | `scheduled_at <= now()` | ✓ | ✓ |
| 11 | Rate limit (1/hour, 3/24h) | ✓ | ✓ |
| 12 | Duplicate fingerprint (30 days) | ✓ | ✓ |
| 13 | Duplicate permalink across all history | ✓ | n/a |

The rate-limit budget is shared with the API path — a manual
publish consumes one hourly + one daily slot. The duplicate
fingerprint check applies before recording. The duplicate
**permalink** check (new in F2.6) is enforced at the database with
a partial unique index on `(workspace_id, provider_permalink)`.

## What gets stored

On a successful manual record:

| Surface | Value |
|---|---|
| `execution_items.status` | `running` → `completed` |
| `execution_items.metadata.publish_outcome.publish_method` | `"manual"` |
| `weekly_plan_items.status` | `published` (mirrored) |
| `publish_history.outcome` | `published` |
| `publish_history.mode` | `manual` |
| `publish_history.provider_post_id` | extracted from permalink |
| `publish_history.provider_permalink` | normalized canonical URL |
| `publish_history.http_status` | `null` (no API call) |
| `publish_history.metadata.recorded_via` | `"mcp"` if via MCP; otherwise unset |
| `execution_logs` | `item.completed` with permalink + provider_post_id |
| `activity_events` | `manual_publish.recorded`, title says "Manual publish recorded" |

## Hard rules

- ❌ No browser automation, login automation, cookie injection, or
  session forwarding.
- ❌ No Reddit API bypass.
- ❌ No fake publish recording without a valid permalink.
- ❌ No duplicate permalink.
- ❌ No manual publish before plan-item approval.
- ❌ No manual publish without a creative + alt text.
- ❌ No manual publish for `content_type='comment'`.
- ❌ No bypass of the rate limit or duplicate fingerprint.

The whole point: Signal stays a calm, deliberate growth tool. The
manual path is slower than an API publish, by design.

## Related

- [reddit-api-approval-fallback.md](./reddit-api-approval-fallback.md)
  — env state + recovery path when approval lands.
- [manual-publish-audit.md](./manual-publish-audit.md) — the audit
  trail you can expect.
- [controlled-live-publish.md](./controlled-live-publish.md) — the
  API path this complements.
