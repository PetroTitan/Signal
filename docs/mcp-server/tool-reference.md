# MCP tool reference

The Signal MCP HTTP bridge exposes 17 tools, plus an 11-name explicit deny-list.

## Read tools (safe_read)

### `signal.workspace.get`

Returns the workspace row, settings, demo-mode flag, and the operator's scopes. Useful as the first call to confirm a token is wired correctly.

### `signal.products.list`

Returns active + pending products without secret columns.

### `signal.accounts.list`

Returns growth accounts (platform, handle, display_name, status, connection_status). Never returns encrypted tokens.

### `signal.weekly_plan.current`

Returns the latest weekly plan and its items.

### `signal.contracts.active`

Returns the active weekly operating contract and its full scope (accounts, products, platforms, allowed actions, execution windows).

### `signal.execution.queue_status`

Returns recent execution queues, items, and the last 50 log lines.

### `signal.verification.latest`

Returns the last 5 entries from `mcp_operation_runs` so the operator can read recent verification activity.

### `signal.activity.latest`

Returns the last 50 activity events for the workspace.

## Prepare tools (write_pending)

### `signal.products.prepare`

Input:

```json
{ "name": "...", "domain": "...", "category": "...", "summary": "...", "source_note": "..." }
```

Creates `products` row with `review_status='pending_review'` and `source='mcp_operation'`. Writes a `mcp.product_profile_create_pending` activity event.

### `signal.accounts.prepare`

Input:

```json
{ "platform": "reddit|x|linkedin|google", "display_name": "...", "handle": "...",
  "product_id": "...", "source_note": "..." }
```

Creates `growth_accounts` row with `review_status='pending_review'`, `connection_status='not_connected'`, `source='mcp_operation'`.

### `signal.weekly_plan.prepare_item`

Input:

```json
{
  "product_id": "...", "account_id": "...", "platform": "...",
  "title": "...", "body": "...", "content_type": "post",
  "scheduled_at": "2026-05-24T14:00:00Z", "timezone": "Europe/Berlin",
  "risk_score": 42, "save_as_draft": false,

  "creative_required": true,
  "creative_type": "image|video|animation",
  "creative_source_type": "generated|uploaded|wikimedia|official_source|manual_url|planned",
  "creative_prompt": "…",
  "creative_source_url": "https://commons.wikimedia.org/…",
  "creative_asset_url": "https://…",
  "creative_alt_text": "…",
  "creative_license": "CC-BY-4.0 | Public Domain | © Acme | …",
  "creative_attribution": "by Jane Doe via Wikimedia Commons",
  "creative_risk_notes": "…"
}
```

**Default** (`save_as_draft` absent or `false`): the item lands as `status='pending_approval'` and **appears in `/approval-queue`** under "Weekly plan items awaiting approval." The operator approves, rejects, or moves to backlog from that surface.

**`save_as_draft: true`**: the item lands as `status='draft'` (a private holding pen). It does *not* appear in `/approval-queue` and cannot be scheduled or executed until promoted to `pending_approval` and approved.

**Phase F1 — creative attachment.** If `content_type='post'`, the tool defaults `creative_required=true`. If the caller provides creative fields, a real creative row is inserted; otherwise a `source_type='planned'` placeholder is dropped so the approval queue shows "creative missing." Operator approval still required either way.

**Phase F1 — eligibility.** Approval-queue approval only enqueues an item for scheduled publishing if it is a `post` with a `scheduled_at` and a publish-ready creative (alt text + correct license/attribution for the source type). Comments are draft-only and never enter the publishing queue.

Either way: cannot be scheduled or executed until the operator both approves *and* there is an active weekly contract scoping the account, product, platform, and action type. See [./tool-permissions.md](./tool-permissions.md) for the full approval ladder.

### `signal.weekly_plan.attach_creative`

Input:

```json
{
  "weekly_plan_item_id": "uuid",
  "creative_type": "image|video|animation",
  "source_type": "generated|uploaded|wikimedia|official_source|manual_url|planned",
  "source_url": "…",
  "asset_url": "…",
  "prompt": "…",
  "alt_text": "…",
  "license": "…",
  "attribution": "…",
  "risk_notes": "…"
}
```

Inserts a `weekly_plan_item_creatives` row for an existing item. External sources (`wikimedia`, `manual_url`) require `source_url`; `generated` requires `prompt`. Status is `pending_review` (or `planned` for the placeholder source). The item is still gated by `/approval-queue` — attaching a creative does not approve the item or the creative.

See [docs/publishing/creative-requirements.md](../publishing/creative-requirements.md) for the full creative policy.

### `signal.imports.prepare_mapping`

Input:

```json
{ "import_type": "product|account", "raw_text": "...",
  "extracted_fields": { ... }, "confidence": 0.85, "warnings": [] }
```

Records an `mcp_operation_runs` row with `status='pending_approval'`. Does not create confirmed records.

### `signal.reports.submit`

Input:

```json
{ "report_type": "...", "summary": "...", "checks": [...], "recommended_next_action": "..." }
```

Records an operator-side report as an `mcp_operation_runs` row with `status='completed'`. Useful for surfacing local smoke-test results, audit notes, recommendations.

## Verification / dry-run tools (safe_read)

### `signal.verification.run`

Surfaces the latest full verification pipeline run. Does not invoke the pipeline (that requires the cookie-bound operator session).

### `signal.verification.run_check`

Input: `{ "check_name": "rls_check" }`

Returns the most recent operation run for the named check. Useful for "what did the last RLS check say."

### `signal.execution.dry_run`

Input: `{ "queue_id": "..." }` or `{ "item_id": "..." }`

Returns the most recent execution_logs for the target. Does not start a new dry-run (the runner is operator-driven).

### `signal.execution.authorize_item`

Input: `{ "execution_item_id": "..." }`

Returns the most recent `execution_authorizations` row for the item, or a warning that no authorization exists yet.

## Blocked tools

These names always return `status="blocked"`:

```
signal.publish.live · signal.comment.live · signal.social.create_account ·
signal.social.login · signal.cookies.import · signal.sessions.import ·
signal.tokens.read · signal.database.raw_sql · signal.billing.modify ·
signal.pr.merge · signal.production.deploy
```

## Response envelope

```json
{
  "ok": true,
  "tool": "signal.products.list",
  "status": "completed",
  "summary": "...",
  "data": { ... },
  "warnings": [],
  "requires_user_approval": false,
  "audit_id": "..."
}
```

`audit_id` references the corresponding `mcp_tool_calls` row for traceability.

## See also

- [./tool-permissions.md](./tool-permissions.md)
- [./security-model.md](./security-model.md)
