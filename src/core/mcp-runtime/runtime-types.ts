/**
 * Phase E2.6 — MCP runtime types.
 *
 * The runtime model is what Signal *would* call into. Today nothing in
 * `src/core/mcp-runtime/` makes a network call to a connected assistant;
 * the types describe the contract so a future PR can drop in real
 * transport code without rewriting the surface.
 */

export const ASSISTANT_KINDS = [
  "claude_code",
  "codex",
  "claude_opus",
  "supabase_mcp",
  "github_mcp",
  "vercel_manual",
] as const;
export type AssistantKind = (typeof ASSISTANT_KINDS)[number];

export const ASSISTANT_LABELS: Record<AssistantKind, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  claude_opus: "Claude Opus",
  supabase_mcp: "Supabase MCP",
  github_mcp: "GitHub MCP",
  vercel_manual: "Vercel (manual)",
};

export const ASSISTANT_CATEGORIES: Record<AssistantKind, "assistant" | "data_plane" | "vcs" | "deploy_plane"> = {
  claude_code: "assistant",
  codex: "assistant",
  claude_opus: "assistant",
  supabase_mcp: "data_plane",
  github_mcp: "vcs",
  vercel_manual: "deploy_plane",
};

/**
 * One-shot snapshot of a connector at a moment in time. Used by
 * `/settings/mcp` and the verification pipeline.
 */
export interface ConnectorRuntimeSnapshot {
  kind: AssistantKind;
  status: import("./connector-status").RuntimeConnectorStatus;
  /** ISO timestamp when the status was last computed. */
  lastCheckedAt: string | null;
  /** Capabilities the connector is currently expected to support. */
  capabilities: import("./connector-capabilities").RuntimeCapability[];
  /** Free-form note rendered next to the status chip. */
  note: string;
}
