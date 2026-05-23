# Reddit API Approval Pending (Phase F2.5)

**Status:** `blocked_pending_reddit_api_approval`

Reddit's [Responsible Builder Policy](https://www.reddit.com/wiki/api/) gates
client-id provisioning for new OAuth apps. Until our app is approved we
cannot complete the OAuth round-trip — Reddit returns `invalid_client_id`
on the authorize step. This is not a Signal bug.

## What's blocked

- `/api/oauth/reddit/start` → Reddit → `invalid_client_id`
- `/api/oauth/reddit/callback` (cannot run without a valid code)
- `/api/oauth/reddit/health` (no token to check)
- The automated publish path on `/execution/items/<id>` (no token to
  decrypt, so the safe-test policy refuses with `token_not_decryptable`)
- The Reddit-side `publish_scheduled_post` execution mode

## What still works

- The entire weekly-plan + creative + approval workflow.
- Scheduler couriering items from `scheduled` → `ready`.
- The full safe-test policy (every gate except the OAuth/token pair).
- The **manual-publish fallback** described below.
- MCP read tools (`signal.oauth.connections.list`,
  `signal.execution.publish_preview`).

## What we explicitly do NOT do

- ❌ Browser automation. We don't drive a Chromium tab to post on
  Reddit; that violates Reddit's TOS and is the antithesis of the
  Signal philosophy.
- ❌ Scraping. We don't read Reddit through unauthenticated channels
  to circumvent the rate limit.
- ❌ Login automation, cookie injection, session forwarding.
- ❌ Using a personal-use script app to bypass the Responsible
  Builder Policy.

## Manual-publish fallback

When `REDDIT_OAUTH_STATUS=blocked_pending_reddit_api_approval`, the
`/execution/items/<id>` page renders a **Manual Reddit publish** panel
instead of the automated **Publish to Reddit** button. The operator:

1. **Reviews the prepared payload** — title, body / link URL,
   subreddit, creative — exactly as it would have been sent to
   `oauth.reddit.com/api/submit`.
2. **Opens Reddit's compose URL.** Signal builds a deep link to
   `https://www.reddit.com/r/<sub>/submit?title=…&text=…` so the
   browser opens with the title + body pre-filled. The operator
   reviews, attaches the creative manually, and clicks **Submit**.
3. **Copies the permalink** from the browser address bar after the
   post lands.
4. **Pastes the permalink + types the confirmation phrase** back in
   Signal.
5. **Signal records the publish_history row** with
   `metadata.publish_method='manual'` so the audit trail stays
   consistent.

### Gates that still apply on the manual path

`evaluateManualPublishPolicy` runs the same checks as the live path
except the two OAuth gates. Specifically:

| # | Check | Manual path | Live path |
|---|---|---|---|
| 1 | `SAFE_TEST_MODE=true` | ✓ | ✓ |
| 2 | platform=reddit, action=publish_scheduled_post | ✓ | ✓ |
| 3 | Subreddit in `ALLOWED_TEST_SUBREDDITS` | ✓ | ✓ |
| 4 | Confirmation phrase matches exactly | ✓ | ✓ |
| 5 | Account `review_status='confirmed'` | ✓ | ✓ |
| 6 | Product `review_status='confirmed'` | ✓ | ✓ |
| 7 | Active weekly contract | ✓ | ✓ |
| 8 | Creative readiness (asset + alt text + license) | ✓ | ✓ |
| 9 | OAuth connected + healthy + token decryptable | **skipped** | ✓ |
| 10 | `scheduled_at <= now()` | ✓ | ✓ |
| 11 | Rate limit (1/hour, 3/24h) | ✓ | ✓ |
| 12 | Duplicate fingerprint (30 days) | ✓ | ✓ |

The rate-limit and duplicate gates apply equally — a manual record
still counts toward the workspace budget. We do not allow the
operator to bypass safety by routing through manual mode.

### Permalink validation

The operator must paste one of:

```
https://www.reddit.com/r/<sub>/comments/<id>/<slug>/
https://www.reddit.com/r/<sub>/comments/<id>/
https://old.reddit.com/r/<sub>/comments/<id>/<slug>/
https://redd.it/<id>
```

`parseRedditPermalink` rejects anything else. The subreddit in the
URL must match the prepared payload's subreddit (no recording a
publish to `r/test` as a publish to `r/testingground4bots`).

### What gets stored on a successful manual record

| Field | Value |
|---|---|
| `publish_history.outcome` | `published` |
| `publish_history.provider_post_id` | `t3_<id>` extracted from the URL |
| `publish_history.provider_permalink` | Normalized canonical URL |
| `publish_history.http_status` | `null` (no API call) |
| `publish_history.metadata.publish_method` | `"manual"` |
| `publish_history.metadata.operator_notes` | optional free-text |
| `execution_items.status` | `completed` |
| `execution_items.metadata.publish_outcome.publish_method` | `"manual"` |
| `weekly_plan_items.status` | `published` (mirrored) |
| `execution_logs` | `item.completed` with permalink + provider_post_id |
| `activity_events` | `reddit.post_published`, title mentions "manual" |

## How to switch back when approval lands

1. Reddit approves the app and supplies the real `client_id` +
   `client_secret`.
2. Set / replace in Vercel Production env:
   - `REDDIT_CLIENT_ID`
   - `REDDIT_CLIENT_SECRET`
   - `REDDIT_REDIRECT_URI` (no change — should already equal
     `https://signal.webmasterid.com/api/oauth/reddit/callback`)
3. Set `REDDIT_OAUTH_STATUS=enabled` (or remove the env var —
   `enabled` is the default).
4. Redeploy.
5. Run the OAuth flow at `/accounts/<accountId>`. The cipher gate +
   profile fetch should land a `connected` + `healthy` row.
6. Subsequent publishes use the automated path; manual fallback
   stays available behind the same UI.

## Surfaces that show the block

- `/accounts` — banner at the top + "Blocked — pending Reddit API
  approval" per provider row + Connect button hidden.
- `/execution/items/<id>` — manual-publish form replaces the
  automated form when the env flag is set.
- MCP `signal.oauth.connections.list` — returns
  `data.provider_status.reddit = "blocked_pending_reddit_api_approval"`
  and a warning describing the fallback.
- MCP `signal.execution.publish_preview` — runs the manual policy
  (gate 9 shown as `warn — skipped`).

## Related

- [docs/publishing/controlled-live-publish.md](../publishing/controlled-live-publish.md)
- [docs/publishing/reddit-publishing-readiness.md](../publishing/reddit-publishing-readiness.md)
- [docs/oauth/reddit-live-connection.md](./reddit-live-connection.md)
