/**
 * Phase F0 — MCP server permission vocabulary.
 *
 * Scopes are explicit strings stored on `mcp_operator_tokens.scopes[]`.
 * Each tool declares the scopes it requires; the dispatcher refuses to
 * run any tool whose required scopes are not all present on the
 * caller's token.
 *
 * Blocked scopes appear here only so the docs can render the boundary
 * — Signal's UI refuses to mint a token containing any of them.
 */

import type {
  McpToolApprovalMode,
  McpToolRiskLevel,
} from "@/lib/supabase/types";

export type { McpToolApprovalMode, McpToolRiskLevel };

export const ALLOWED_SCOPES = [
  "workspace:read",
  "products:read",
  "products:write_pending",
  "accounts:read",
  "accounts:write_pending",
  "weekly_plans:read",
  "weekly_plans:write_pending",
  "contracts:read",
  "execution:read",
  "execution:dry_run",
  "verification:run",
  "imports:prepare",
  "reports:write",
] as const;
export type AllowedScope = (typeof ALLOWED_SCOPES)[number];

export const BLOCKED_SCOPES = [
  "publishing:live",
  "social_accounts:create",
  "secrets:read",
  "database:unrestricted",
  "billing:write",
] as const;
export type BlockedScope = (typeof BLOCKED_SCOPES)[number];

export const SCOPE_LABELS: Record<AllowedScope, string> = {
  "workspace:read": "Read workspace, user role, settings",
  "products:read": "Read products",
  "products:write_pending": "Create products as pending_review",
  "accounts:read": "Read accounts",
  "accounts:write_pending": "Create accounts as pending_review",
  "weekly_plans:read": "Read weekly plans + items",
  "weekly_plans:write_pending": "Create plan items as draft / pending_review",
  "contracts:read": "Read active weekly contract",
  "execution:read": "Read execution queues + logs",
  "execution:dry_run": "Run execution dry-run (no external calls)",
  "verification:run": "Run verification checks",
  "imports:prepare": "Submit import mapping requests",
  "reports:write": "Submit operator-side reports",
};

export const BLOCKED_SCOPE_REASONS: Record<BlockedScope, string> = {
  "publishing:live": "Live publishing must go through the execution engine, not the MCP server.",
  "social_accounts:create": "Signal never automates external social account creation.",
  "secrets:read": "Token / cookie / session data is never readable through the MCP layer.",
  "database:unrestricted": "Arbitrary SQL is not exposed; only the audited tool surface is.",
  "billing:write": "Billing state is operator-only and never callable from MCP.",
};

export function isAllowedScope(s: string): s is AllowedScope {
  return (ALLOWED_SCOPES as ReadonlyArray<string>).includes(s);
}

export function isBlockedScope(s: string): s is BlockedScope {
  return (BLOCKED_SCOPES as ReadonlyArray<string>).includes(s);
}

export function hasAllScopes(
  granted: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): boolean {
  return required.every((r) => granted.includes(r));
}
