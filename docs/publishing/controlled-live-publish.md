# Controlled Live Reddit Publish (Phase F2.5)

> ⚠️ **Reddit API approval pending.** The automated path documented
> below is gated by a working OAuth token, which Reddit hasn't yet
> approved. Set `REDDIT_OAUTH_STATUS=blocked_pending_reddit_api_approval`
> to route `/execution/items/<id>` to the **manual-publish fallback**
> — same gates, operator publishes via copy/paste, permalink recorded
> back. See [docs/oauth/reddit-api-approval-pending.md](../oauth/reddit-api-approval-pending.md).

Phase F2.5 enables **one** controlled, operator-triggered Reddit
publish. There is no autonomous publishing. There is no scheduler
that calls Reddit on its own. There is no comment automation.

## State machine

```
draft
  └─▶ pending_approval         (operator wrote / MCP suggested)
        └─▶ approved (deprecated; weekly plan items skip this and go
                      straight to scheduled via approveWeeklyPlanAction)
              └─▶ scheduled    (execution_item created from approval)
                    └─▶ ready  (scheduler moved it; SAFE_TEST_MODE on)
                          └─▶ running   (operator clicked Publish)
                                ├─▶ completed   (Reddit returned 200)
                                └─▶ failed      (Reddit returned err)
```

**Scheduler may ONLY move scheduled → ready.** It never calls
`POST /api/submit`. Only the operator-triggered server action
`publishItemAction` makes that call.

## Required env

```
SAFE_TEST_MODE=true
ALLOWED_TEST_SUBREDDITS=test,testingground4bots
TOKEN_ENCRYPTION_KEY=<F2>
REDDIT_CLIENT_ID=<F2>
REDDIT_CLIENT_SECRET=<F2>
REDDIT_REDIRECT_URI=https://signal.webmasterid.com/api/oauth/reddit/callback
CRON_SECRET=<what Vercel Cron sends; required for scheduled runs>
SCHEDULER_TICK_TOKEN=<optional legacy/manual token for curl>
```

When `SAFE_TEST_MODE != 'true'`, the entire controlled-publish path
is closed. The `/execution/items/<id>` page renders a banner
explaining what's off, and `publishItemAction` refuses with
`safe_test_mode_disabled` before any other check runs.

## Gates (in order)

`evaluateSafeTestPolicy` runs every check, every time. Each check
appears in the preview UI with pass/fail status:

| # | Check | Refusal code |
|---|---|---|
| 1 | `SAFE_TEST_MODE=true` | `safe_test_mode_disabled` |
| 2 | `platform='reddit'` AND `action_type='publish_scheduled_post'` | `wrong_platform` / `not_a_post` |
| 3 | Subreddit present AND in `ALLOWED_TEST_SUBREDDITS` | `subreddit_missing` / `subreddit_not_whitelisted` |
| 4 | Operator typed `"publish live reddit post"` exactly | `confirmation_phrase_mismatch` |
| 5 | Account `review_status='confirmed'` | `account_not_confirmed` |
| 6 | Product `review_status='confirmed'` (if attached) | `product_not_confirmed` |
| 7 | Active `weekly_approval_contracts` row | `no_active_contract` |
| 8 | Creative readiness (alt text + asset + license/attribution where required + status='approved') | `creative_*` |
| 9 | `platform_connections.connection_status='connected'` AND `health_status='healthy'` | `connection_missing` / `connection_not_healthy` |
| 10 | Encrypted access token decrypts | `token_not_decryptable` |
| 11 | `scheduled_at <= now()` | `missing_schedule` / `scheduled_in_future` |
| 12 | ≤ 1 publish in last 60 min AND ≤ 3 in last 24 h | `rate_limit_hourly` / `rate_limit_daily` |
| 13 | No same-fingerprint publish in last 30 days | `duplicate_within_30_days` |

Each failure writes a row to `publish_history` with
`outcome='blocked'`. Blocked attempts do **not** consume rate-limit
budget — only `outcome='published'` counts.

## Confirmation phrase

The operator must type exactly:

```
publish live reddit post
```

Case-insensitive, whitespace-tolerant. The Publish button is
client-side disabled until the input matches; the server action
re-validates with `matchesConfirmationPhrase` before any other check.

## What goes out the wire

```
POST https://oauth.reddit.com/api/submit
Authorization: Bearer <decrypted access_token>
User-Agent: web:com.webmasterid.signal:v0.1 (by /u/Webmasterid-core)
Content-Type: application/x-www-form-urlencoded

sr=<subreddit>
kind=self|link
title=<item.title>
text=<item.body>          # for kind=self
url=<item.link_url>       # for kind=link
sendreplies=false
resubmit=false
api_type=json
```

No comments, no votes, no moderation calls, no crossposts.

## What gets stored

On success:

| Table | Update |
|---|---|
| `execution_items.status` | `running` → `completed` |
| `execution_items.metadata.publish_outcome` | `{status, external_id, external_url, published_at}` |
| `weekly_plan_items.status` | `published` (mirrored) |
| `publish_history` | new row with `outcome='published'`, `provider_post_id`, `provider_permalink`, fingerprint, http_status |
| `execution_logs` | `item.completed` with permalink |
| `activity_events` | `reddit.post_published` |

On failure:

| Table | Update |
|---|---|
| `execution_items.status` | `running` → `failed` |
| `publish_history` | new row with `outcome='failed'` |
| `execution_logs` | `item.failed` with reason_code + detail |

## Rate limits + duplicate window

- Hourly: max 1 successful publish per workspace per 60 minutes.
- Daily: max 3 successful publishes per workspace per 24 hours.
- Duplicate: same `(platform, subreddit, canonicalized title+body+link)`
  fingerprint cannot be published twice in 30 days.

Fingerprint canonicalization:
- lowercase
- strip URLs (UTM drift doesn't fool the gate)
- collapse whitespace
- SHA-256, hex

## What MCP can / can't do

| Capability | MCP | Operator |
|---|---|---|
| Prepare post items | ✓ | ✓ |
| Attach creative metadata | ✓ (URL + alt + license — never local file) | ✓ |
| Upload media file | ✗ | ✓ |
| Approve creative | ✗ | ✓ |
| Approve plan | ✗ | ✓ |
| Trigger live publish | ✗ | ✓ (with confirmation phrase) |
| Preview the publish via `signal.execution.publish_preview` | ✓ (read-only) | ✓ |

`signal.execution.publish_preview` runs the same
`evaluateSafeTestPolicy` server-side and returns the verdict +
payload preview. It is read-only — MCP cannot publish.

## Comments still blocked

`content_type='comment'` items never reach the publish pipeline:

1. The F1 approval action skips them with a "not a post" warning.
2. If one somehow reached `ready`, `evaluateSafeTestPolicy` would
   refuse with `wrong_platform` / `not_a_post`.

Future replies-to-our-own-posts may be re-enabled, but only under a
separate gate and never as cold outbound.

## Operator end-to-end

1. Plan item lands `pending_approval`, with creative attached and
   approved + alt text + schedule.
2. Approve weekly plan (F1 action) → execution_item `scheduled`.
3. Wait for scheduler tick (or trigger manually) → execution_item
   `ready`. /weekly-plan shows **READY_FOR_PUBLISH** badge.
4. Click **Ready — open publish preview →**.
5. Review every check on /execution/items/<id>.
6. Type `publish live reddit post`.
7. Click **Publish to Reddit**.
8. Result row + permalink appear inline; `weekly_plan_items.status`
   becomes `published`.

## Related

- [docs/publishing/media-assets.md](./media-assets.md) — creative
  asset rules (mandatory media + license + alt text).
- [docs/publishing/reddit-publishing-readiness.md](./reddit-publishing-readiness.md)
  — the full gate chain.
- [docs/oauth/reddit-live-connection.md](../oauth/reddit-live-connection.md)
  — F2 OAuth flow.
