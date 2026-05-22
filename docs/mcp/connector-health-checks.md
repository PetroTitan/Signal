# Connector health checks

The MCP runtime models six connectors:

| Kind | Category | Default status | Why |
| --- | --- | --- | --- |
| `claude_code` | assistant | `placeholder` | Runs on the operator's machine, outside Signal. |
| `codex` | assistant | `placeholder` | Same. |
| `claude_opus` | assistant | `placeholder` | API-key driven; the key never lives in Signal env. |
| `supabase_mcp` | data_plane | `placeholder` | Configured in the operator's assistant, not in Signal. |
| `github_mcp` | vcs | `placeholder` | Same. |
| `vercel_manual` | deploy_plane | `manual` | Build logs / env / redeploys are inspected by hand. |

## Status vocabulary

```
not_configured | configured | connected | unavailable |
auth_failed   | capability_mismatch | version_mismatch |
placeholder   | manual
```

The runtime adds three states beyond Phase E0:

- **auth_failed** — the connector responded but rejected credentials.
- **capability_mismatch** — connector reachable, but a required capability is missing.
- **version_mismatch** — connector reachable, but on an incompatible version.

These exist so that when real probes are wired, they have a place to land. Today every default snapshot returns `placeholder` or `manual` — we never lie.

## Capabilities

Per-connector capability lists live in `RUNTIME_ASSISTANT_CAPABILITIES`. Each capability is named precisely (`repo_read`, `schema_read`, `pr_prepare`, `env_manual_check`, …) so the policy layer can compare requested operations against advertised capabilities and refuse mismatches.

Write-side capabilities are listed in `RUNTIME_WRITE_CAPABILITIES`. The runtime policy refuses to mark a request as `safe_read` when it touches any of these.

## Health derivation

`deriveHealthFromStatus(status)` returns one of `healthy | degraded | broken | unknown`. Tables:

| status | health |
| --- | --- |
| connected | healthy |
| configured / capability_mismatch / version_mismatch | degraded |
| auth_failed / unavailable | broken |
| not_configured / placeholder / manual | unknown |

## When real probes arrive

Replace the literal `status: "placeholder"` in `buildDefaultConnectorSnapshots()` with a function call into the probe. Every probe must time out fast and never block a page render — the rest of `/settings/mcp` should keep working even when a probe fails.

## See also

- [./real-mcp-runtime-integration.md](./real-mcp-runtime-integration.md)
- [./runtime-checks.md](./runtime-checks.md)
- [./mcp-connector-ui.md](./mcp-connector-ui.md)
