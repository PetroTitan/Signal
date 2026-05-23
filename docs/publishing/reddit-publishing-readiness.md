# Reddit Publishing Readiness (Phase F2)

> ⚠️ **Phase F2.5 update — Reddit API approval pending.** OAuth-based
> publishing is currently blocked by Reddit's Responsible Builder
> Policy. The controlled-publish pipeline is intact and exercised via
> a manual fallback. See
> [docs/oauth/reddit-api-approval-pending.md](../oauth/reddit-api-approval-pending.md).

Phase F2 makes a real Reddit OAuth connection possible. It does
**not** ship live publishing. This document lists every gate that
must still close before a single `POST /api/submit` goes out.

## Status after F2

| Gate | F2 | Notes |
|---|---|---|
| Token cipher implemented | ✅ AES-256-GCM v1 | [token-encryption-key.md](../oauth/token-encryption-key.md) |
| Reddit OAuth round-trip | ✅ | `identity` scope only |
| Encrypted token persistence | ✅ | `v1:<iv>:<tag>:<ct>` envelope |
| Refresh-on-401 in health check | ✅ | |
| Disconnect + revoke + clear | ✅ | Best-effort revoke; local clear is authoritative |
| `signal.oauth.connections.list` MCP read tool | ✅ | Booleans only, never tokens |
| `oauth_token_security_check` verification | ✅ | Runtime + DB inspection |
| Publisher decrypt path | ✅ wired | Refuses null + non-live mode |
| `submit` scope | ❌ deferred to F3 | |
| `workspace_settings.execution_mode='live'` | ❌ blocker | Column doesn't exist; F1 follow-up |
| Controlled test publish path | ❌ deferred to F3 | |
| Vercel cron `SCHEDULER_TICK_TOKEN` env | ❌ unset | F1 follow-up |

## The full gate chain (live publish)

A real Reddit POST happens iff **every** condition is true:

1. **Connection** — `platform_connections.connection_status='connected'`
   AND `health_status='healthy'`.
2. **Encrypted token** — `access_token_encrypted IS NOT NULL` AND
   decrypts to a non-null plaintext under the current
   `TOKEN_ENCRYPTION_KEY`.
3. **Scope** — `scopes` contains `submit`. (Deferred to F3 — F2
   only requests `identity`.)
4. **Workspace** — `execution_mode='live'` AND `publishing_enabled=true`.
   (Both columns missing today — F1 follow-up adds the migration.)
5. **Contract** — there's an active `weekly_approval_contracts` row
   whose scope includes the item's account, product, platform, and
   `publish_scheduled_post` action.
6. **Account / product** — both `review_status='confirmed'`.
7. **Plan item** — `content_type='post'` and a publish-ready
   creative attached (`weekly_plan_item_creatives` row with alt
   text + license/attribution where required by source type).
8. **Schedule** — `scheduled_at <= now()`.
9. **Risk** — `risk_level != 'blocked'`.
10. **Scheduler tick** — `/api/scheduler/tick` is reachable with the
    `SCHEDULER_TICK_TOKEN` shared secret.

If **any** condition fails, the scheduler writes an
`execution_logs.reason_code` and the item stays in
`status='scheduled'` (skipped) or `status='blocked'`. Nothing leaves
Vercel toward Reddit.

## What F2 actually proves

Run the F2 test path:

1. Set `TOKEN_ENCRYPTION_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`,
   `REDDIT_REDIRECT_URI` in Vercel.
2. `/accounts/[id]` → "Connect via OAuth" → Reddit authorize page.
3. Approve. Redirect back to `/accounts?oauth=connected`.
4. Row in `platform_connections` has:
   - `connection_status='connected'`
   - `health_status='healthy'`
   - `access_token_encrypted` starts with `v1:`
   - `refresh_token_encrypted` starts with `v1:` (Reddit gives one
     because we asked for `duration=permanent`)
   - `scopes = ["identity"]`
   - `handle` populated from `/api/v1/me`
5. Click "Check connection" → activity row
   `platform_connection.health_checked`, `health=healthy`.
6. Click "Disconnect" → encrypted columns cleared,
   `connection_status='revoked'`, activity row
   `platform_connection.disconnected`.

If the operator approves a post via `/weekly-plan` and the scheduler
ticks, the policy gate will still refuse because of gates 3, 4, and
10 above. Verified: F2 does not change the dry-run posture.

## Why we don't ship F2 with `submit`

Two reasons:

1. **Authorization surface**: Reddit's `submit` scope authorizes
   real, public posts. Granting it before the publisher is fully
   trusted is asymmetric risk — there's nothing the operator can do
   to "see" what Signal might post without going through the
   weekly-plan + creative + approval gates that F1 already enforces.
   We want those gates to be tested end-to-end *before* the scope
   that lets us post is in the OAuth grant.

2. **Audit narrative**: when a real Reddit post goes out, we want to
   be able to point at a discrete migration that added the scope
   and ran a controlled test in F3. Mixing it into F2 muddles the
   audit story.

## Operator checklist before F3

- [ ] F1 follow-up merged: `execution_mode` column added,
      `SCHEDULER_TICK_TOKEN` set in Vercel.
- [ ] F2 merged: encrypted tokens stored; health check passes for
      at least one account.
- [ ] `oauth_token_security_check` passes in `/settings/mcp`.
- [ ] At least one weekly_plan_item ready: post, scheduled,
      creative attached with alt text + license, contract active.
- [ ] Operator agreed in writing on the test subreddit.

When all checked, F3 will add `submit` scope to the provider
config, ship the controlled test path described in the F2 brief
Part 9, and require an explicit confirmation phrase before the
first real publish.

## Related

- [docs/oauth/token-encryption-key.md](../oauth/token-encryption-key.md)
- [docs/oauth/reddit-live-connection.md](../oauth/reddit-live-connection.md)
- [docs/oauth/reddit-token-lifecycle.md](../oauth/reddit-token-lifecycle.md)
- [docs/oauth/reddit-connection-troubleshooting.md](../oauth/reddit-connection-troubleshooting.md)
- [docs/publishing/publishing-safety.md](./publishing-safety.md)
- [docs/publishing/oauth-requirements.md](./oauth-requirements.md)
