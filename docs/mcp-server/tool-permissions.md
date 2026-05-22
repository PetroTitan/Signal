# Tool permissions

Every Signal MCP tool declares the same metadata: a name, the scopes it requires, a risk level, an approval mode, and two booleans (`writes_database`, `touches_production`).

## Approval modes

| approval_mode | What it means |
| --- | --- |
| `no_approval_needed` | Tool runs immediately if the scope check passes. |
| `approval_required` | Tool runs and produces a pending row; an operator must approve before any downstream confirmed action. |
| `explicit_text_confirmation_required` | Reserved for production-impacting tools. None ship in Phase F0; the slot exists for migration apply, redeploy, etc. |
| `blocked` | Tool refuses unconditionally. |

## Risk levels

| risk_level | Examples |
| --- | --- |
| `safe_read` | Every read tool. |
| `local_write` | `signal.reports.submit` (writes an operation-run row, no downstream effect). |
| `remote_write` | `signal.products.prepare`, `signal.accounts.prepare`, `signal.weekly_plan.prepare_item`, `signal.imports.prepare_mapping`. |
| `production_impacting` | None in F0. |
| `blocked` | The deny-list (`signal.publish.live`, `signal.social.create_account`, …). |

## Scope-to-tool table

| Tool | required_scopes |
| --- | --- |
| `signal.workspace.get` | `workspace:read` |
| `signal.products.list` | `products:read` |
| `signal.products.prepare` | `products:write_pending` |
| `signal.accounts.list` | `accounts:read` |
| `signal.accounts.prepare` | `accounts:write_pending` |
| `signal.weekly_plan.current` | `weekly_plans:read` |
| `signal.weekly_plan.prepare_item` | `weekly_plans:write_pending` |
| `signal.contracts.active` | `contracts:read` |
| `signal.execution.queue_status` | `execution:read` |
| `signal.execution.dry_run` | `execution:dry_run` |
| `signal.execution.authorize_item` | `execution:read` |
| `signal.verification.latest` | `verification:run` |
| `signal.verification.run` | `verification:run` |
| `signal.verification.run_check` | `verification:run` |
| `signal.imports.prepare_mapping` | `imports:prepare` |
| `signal.reports.submit` | `reports:write` |
| `signal.activity.latest` | `workspace:read` |

The dispatcher refuses any tool call whose token does not contain **all** required scopes; the response is `status="unauthorized"` with `error_code="scope_insufficient"`.

## Blocked tools

```
signal.publish.live · signal.comment.live · signal.social.create_account ·
signal.social.login · signal.cookies.import · signal.sessions.import ·
signal.tokens.read · signal.database.raw_sql · signal.billing.modify ·
signal.pr.merge · signal.production.deploy
```

Calling any of these returns a structured `status="blocked"` response with HTTP 403. The audit row records the attempt with `risk_level="blocked"` and `status="blocked"`.

## See also

- [./security-model.md](./security-model.md)
- [./tool-reference.md](./tool-reference.md)
