/**
 * Default connector inventory used by /settings/mcp until a real probe
 * is wired. Every entry is honest about its observability: Claude Code
 * / Codex / Opus run outside Signal and stay `placeholder`; Vercel is
 * `manual`; Supabase MCP and GitHub MCP are `placeholder` because the
 * app cannot detect the operator's MCP client from here.
 *
 * To upgrade one to `connected`, swap the literal status here for a
 * value returned by an actual probe function. We never lie.
 */

import type { ConnectorRuntimeSnapshot } from "./runtime-types";
import {
  RUNTIME_ASSISTANT_CAPABILITIES,
} from "./connector-capabilities";

export function buildDefaultConnectorSnapshots(
  observedAt: string,
): ConnectorRuntimeSnapshot[] {
  return [
    {
      kind: "claude_code",
      status: "placeholder",
      lastCheckedAt: observedAt,
      capabilities: RUNTIME_ASSISTANT_CAPABILITIES.claude_code,
      note: "Operator-connected outside Signal. Not directly probeable yet.",
    },
    {
      kind: "codex",
      status: "placeholder",
      lastCheckedAt: observedAt,
      capabilities: RUNTIME_ASSISTANT_CAPABILITIES.codex,
      note: "Operator-connected outside Signal. Not directly probeable yet.",
    },
    {
      kind: "claude_opus",
      status: "placeholder",
      lastCheckedAt: observedAt,
      capabilities: RUNTIME_ASSISTANT_CAPABILITIES.claude_opus,
      note: "API-key driven. Key never lives in Signal env.",
    },
    {
      kind: "supabase_mcp",
      status: "placeholder",
      lastCheckedAt: observedAt,
      capabilities: RUNTIME_ASSISTANT_CAPABILITIES.supabase_mcp,
      note: "Configured via the operator's assistant; Signal cannot detect it directly.",
    },
    {
      kind: "github_mcp",
      status: "placeholder",
      lastCheckedAt: observedAt,
      capabilities: RUNTIME_ASSISTANT_CAPABILITIES.github_mcp,
      note: "Configured via the operator's assistant; Signal cannot detect it directly.",
    },
    {
      kind: "vercel_manual",
      status: "manual",
      lastCheckedAt: observedAt,
      capabilities: RUNTIME_ASSISTANT_CAPABILITIES.vercel_manual,
      note: "Build logs / env / redeploys are checked by a human via the Vercel dashboard.",
    },
  ];
}
