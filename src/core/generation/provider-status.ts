import "server-only";
/**
 * Phase F4.5 — generation provider status.
 *
 * Signal does not currently have an LLM provider wired. The brief
 * explicitly allows the form to render "AI draft generation is not
 * connected yet" while still preparing a draft via the manual seed
 * path (so an external Claude/Codex or MCP agent can fulfill it
 * later using the same GenerationPromptContext).
 *
 * When/if a provider is added, set OPENAI_API_KEY or
 * ANTHROPIC_API_KEY in the workspace env and update the
 * `readProviderStatus()` switch. No client code should ever read
 * these values; only the server-side generate-draft.ts module
 * dispatches to them.
 */

export type GenerationProviderName = "anthropic" | "openai" | null;

export interface GenerationProviderStatus {
  /** True when at least one provider is configured AND enabled. */
  available: boolean;
  /** Active provider name when one is configured. */
  provider: GenerationProviderName;
  /** Founder-readable label, never exposes env-var names. */
  label: string;
}

function safe(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readGenerationProviderStatus(): GenerationProviderStatus {
  // Anthropic preferred when both are set — Signal's own voice is
  // closest to Claude's natural register.
  if (safe(process.env.ANTHROPIC_API_KEY)) {
    return { available: true, provider: "anthropic", label: "AI drafts ready" };
  }
  if (safe(process.env.OPENAI_API_KEY)) {
    return { available: true, provider: "openai", label: "AI drafts ready" };
  }
  return {
    available: false,
    provider: null,
    label: "AI drafts not connected yet",
  };
}
