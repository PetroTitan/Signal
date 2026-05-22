/**
 * Phase E2.6 — runtime capability matrix.
 *
 * Each connector advertises a fixed set of capabilities. The runtime
 * checks compare advertised capabilities against what an action needs
 * and return `capability_mismatch` when the connector is reachable but
 * the capability is missing.
 *
 * No write-side capability unlocks publishing — those land in a
 * separate phase under explicit approval gates.
 */

import type { AssistantKind } from "./runtime-types";

export const RUNTIME_CAPABILITIES = [
  // Claude Code
  "repo_read",
  "repo_write_local",
  "terminal_run",
  "test_run",
  "git_commit_prepare",
  "mcp_tool_use",
  // Codex
  "repo_patch",
  "code_review",
  "test_plan",
  "pr_summary",
  // Claude Opus
  "reasoning_audit",
  "architecture_review",
  "risk_review",
  "prompt_planning",
  // Supabase MCP
  "schema_read",
  "migration_apply_request",
  "rls_check",
  "table_read",
  "test_data_cleanup",
  // GitHub MCP
  "branch_read",
  "pr_prepare",
  "pr_status_read",
  "issue_create",
  "repo_status_read",
  // Vercel
  "env_manual_check",
  "deployment_manual_check",
  "logs_manual_review",
] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

export const RUNTIME_CAPABILITY_LABELS: Record<RuntimeCapability, string> = {
  repo_read: "Read repository",
  repo_write_local: "Write to the local working tree",
  terminal_run: "Run terminal commands",
  test_run: "Run tests",
  git_commit_prepare: "Prepare a git commit",
  mcp_tool_use: "Use MCP tools",
  repo_patch: "Apply repository patches",
  code_review: "Review code changes",
  test_plan: "Write a test plan",
  pr_summary: "Draft a PR summary",
  reasoning_audit: "Audit reasoning trail",
  architecture_review: "Review architecture",
  risk_review: "Review risk implications",
  prompt_planning: "Plan prompts",
  schema_read: "Read database schema",
  migration_apply_request: "Request migration apply",
  rls_check: "Check RLS policies",
  table_read: "Read tables",
  test_data_cleanup: "Clean up test data",
  branch_read: "Read branch state",
  pr_prepare: "Prepare a PR",
  pr_status_read: "Read PR status",
  issue_create: "Create an issue",
  repo_status_read: "Read repository status",
  env_manual_check: "Manual env check",
  deployment_manual_check: "Manual deployment check",
  logs_manual_review: "Manual log review",
};

export const RUNTIME_ASSISTANT_CAPABILITIES: Record<
  AssistantKind,
  RuntimeCapability[]
> = {
  claude_code: [
    "repo_read",
    "repo_write_local",
    "terminal_run",
    "test_run",
    "git_commit_prepare",
    "mcp_tool_use",
  ],
  codex: ["repo_patch", "code_review", "test_plan", "pr_summary"],
  claude_opus: [
    "reasoning_audit",
    "architecture_review",
    "risk_review",
    "prompt_planning",
  ],
  supabase_mcp: [
    "schema_read",
    "migration_apply_request",
    "rls_check",
    "table_read",
    "test_data_cleanup",
  ],
  github_mcp: [
    "branch_read",
    "pr_prepare",
    "pr_status_read",
    "issue_create",
    "repo_status_read",
  ],
  vercel_manual: [
    "env_manual_check",
    "deployment_manual_check",
    "logs_manual_review",
  ],
};

/**
 * True if a capability requires write access to an external system.
 * Used by the runtime policy to enforce approval gates.
 */
export const RUNTIME_WRITE_CAPABILITIES = new Set<RuntimeCapability>([
  "migration_apply_request",
  "pr_prepare",
  "issue_create",
  "repo_write_local",
  "test_data_cleanup",
]);
