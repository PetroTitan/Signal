# Reddit API Approval Fallback (Phase F2.6)

Reddit's Responsible Builder Policy gates client-id provisioning.
Until our app is approved we cannot complete the OAuth round-trip.
Signal remains usable via the manual-publishing workflow.

## Status taxonomy

`REDDIT_OAUTH_STATUS` env var controls what the UI surfaces:

| Value | Meaning | UI |
|---|---|---|
| `enabled` (or unset) | OAuth round-trip works | "Connect via OAuth" on `/accounts`, automated publish form on `/execution/items/<id>` |
| `blocked_pending_reddit_api_approval` | Reddit hasn't approved the app | Amber banner on `/accounts`, Connect button hidden, automated form on `/execution/items/<id>` hidden — only manual path shown |

The manual path is **always** available as an explicit operator
choice, regardless of `REDDIT_OAUTH_STATUS`. The env var only
controls whether the API path is surfaced.

## Three triggers that make the manual path the right choice

1. **`reddit_api_approval_pending`** — Reddit hasn't approved the
   app yet. The OAuth `/authorize` endpoint returns
   `invalid_client_id`.
2. **`oauth_not_configured`** — `REDDIT_CLIENT_ID/_SECRET/_REDIRECT_URI`
   env vars are missing. `/api/oauth/reddit/start` returns
   `provider_not_configured`.
3. **`submit_scope_missing`** — A connection exists but doesn't hold
   the `submit` scope. The live policy would refuse with
   `oauth_insufficient_scope` at publish time.

Signal does not auto-detect and auto-route. The operator clicks
**Prepare for manual publish** on `/execution/items/<id>` to opt
in. The button is always present when the item is in `ready` state;
the manual path's policy will refuse the gate that's still
applicable (e.g. creative not ready) if anything else is missing.

## What does NOT trigger the manual path

- A working OAuth connection that just happens to be `degraded`
  (transient 5xx from Reddit). Re-run the health check first.
- A workspace with `SAFE_TEST_MODE=false`. The manual path still
  requires `SAFE_TEST_MODE=true` — every safety gate is shared.
- An unapproved plan item. The approval action is upstream of both
  paths.

## Recovery path (when Reddit approves the app)

1. Reddit's approval email arrives with the real `client_id` +
   `client_secret`.
2. In Vercel → Signal project → Settings → Environment Variables
   (Production scope):
   - Set `REDDIT_CLIENT_ID` to the approved value.
   - Set `REDDIT_CLIENT_SECRET` to the approved value.
   - Confirm `REDDIT_REDIRECT_URI` equals
     `https://signal.webmasterid.com/api/oauth/reddit/callback`.
   - Set `REDDIT_OAUTH_STATUS=enabled` (or remove the env var
     entirely — `enabled` is the default).
3. **Redeploy.** Env-var changes only apply on the next deploy.
4. From `/accounts/<accountId>`, click **Connect via OAuth**. Reddit
   prompts for `identity submit` scope. Approve.
5. After the callback lands, verify:
   - `platform_connections.connection_status = 'connected'`
   - `health_status = 'healthy'`
   - `scopes` contains `submit`
   - `access_token_encrypted` starts with `v1:`
6. Future plan-items get both options on `/execution/items/<id>`:
   the API path and the manual fallback.

The manual workflow remains available even after the API path is
operational — it's not removed; it's an alternative the operator
can pick per-item.

## Audit narrative

`publish_history.mode` distinguishes the two paths unambiguously:

```sql
SELECT mode, count(*)
FROM publish_history
WHERE workspace_id = $1 AND outcome = 'published'
GROUP BY mode;
```

`execution_logs.event_type = 'item.completed'` is shared. The
metadata field on the log carries `publish_method='manual'` and
(for MCP-driven records) `recorded_via='mcp'` so the audit row is
unambiguous.

## Related

- [manual-reddit-publishing.md](./manual-reddit-publishing.md)
- [manual-publish-audit.md](./manual-publish-audit.md)
- [docs/oauth/reddit-api-approval-pending.md](../oauth/reddit-api-approval-pending.md)
  (F2.5 background)
