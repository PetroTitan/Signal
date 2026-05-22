/**
 * MCP connector status model.
 *
 * Signal does not run an MCP client itself — Claude Code, Codex, and
 * Claude Opus connect from outside. The product cannot inspect the
 * remote process state from here, so connection status is intentionally
 * limited to a small set of self-declared values:
 *
 *   not_configured — the workspace has no record of this connector.
 *   configured     — the connector is set up but not actively pinging.
 *   connected      — verified within the recent observation window.
 *   unavailable    — the connector reported an outage.
 *   manual         — humans drive this surface; no automation expected.
 *   placeholder    — the UI shows this slot but it isn't wired yet.
 *
 * We never lie. If we can't observe the state, the value is
 * `placeholder` and the UI says so.
 */

export const MCP_CONNECTOR_STATUSES = [
  "not_configured",
  "configured",
  "connected",
  "unavailable",
  "manual",
  "placeholder",
] as const;
export type McpConnectorStatus = (typeof MCP_CONNECTOR_STATUSES)[number];

export const MCP_CONNECTOR_STATUS_LABELS: Record<McpConnectorStatus, string> = {
  not_configured: "Not configured",
  configured: "Configured",
  connected: "Connected",
  unavailable: "Unavailable",
  manual: "Manual",
  placeholder: "Placeholder",
};

export const MCP_CONNECTOR_STATUS_HINTS: Record<McpConnectorStatus, string> = {
  not_configured: "No setup detected for this connector yet.",
  configured: "Configuration present, awaiting verification.",
  connected: "Verified within the recent observation window.",
  unavailable: "The connector reported an outage.",
  manual: "Operated by humans through this UI — no remote tool needed.",
  placeholder:
    "Connection status placeholder — not verified automatically yet.",
};

export type McpConnectorCategory =
  | "assistant"
  | "data_plane"
  | "deploy_plane"
  | "vcs";

export interface McpConnectorDef {
  key: string;
  label: string;
  category: McpConnectorCategory;
  status: McpConnectorStatus;
  description: string;
}

/**
 * Today's connector inventory. None are auto-verified yet — every
 * status is "placeholder" or "manual" by design. As soon as we wire
 * real probes, we replace the literal here.
 */
export const MCP_CONNECTORS: McpConnectorDef[] = [
  {
    key: "claude_code",
    label: "Claude Code",
    category: "assistant",
    status: "placeholder",
    description:
      "Anthropic's CLI assistant. Operator runs it locally; Signal sees its outputs through this surface.",
  },
  {
    key: "codex",
    label: "Codex",
    category: "assistant",
    status: "placeholder",
    description:
      "OpenAI Codex CLI / agent surface. Connects from the operator's environment.",
  },
  {
    key: "claude_opus",
    label: "Claude Opus",
    category: "assistant",
    status: "placeholder",
    description:
      "Direct Anthropic API usage for high-reasoning checks. Configured via Anthropic key, never stored in Signal.",
  },
  {
    key: "supabase_mcp",
    label: "Supabase MCP",
    category: "data_plane",
    status: "placeholder",
    description:
      "Read schema, list tables, prepare migrations. Apply requires explicit text confirmation.",
  },
  {
    key: "github_mcp",
    label: "GitHub MCP",
    category: "vcs",
    status: "placeholder",
    description:
      "Inspect repo state, draft PRs. Push / merge always requires approval.",
  },
  {
    key: "vercel",
    label: "Vercel",
    category: "deploy_plane",
    status: "manual",
    description:
      "Build logs and env presence are read manually. Production redeploy is approval-gated.",
  },
];
