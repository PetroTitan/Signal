/**
 * Phase F4.6 — founder-readable generation failure copy.
 *
 * Provider modules return normalized reason codes
 * (`no_credentials`, `rate_limited`, `overloaded`, `timeout`, etc.).
 * This helper turns each into a calm sentence the founder can act
 * on — never exposes HTTP status codes, never quotes provider raw
 * messages, never mentions API keys or models.
 *
 * Mirrors src/core/publishing/founder-error.ts for the publishing
 * side; keep tone consistent.
 */

export interface FriendlyGenerationFailure {
  title: string;
  advice: string;
}

export type GenerationFailureReason =
  | "no_credentials"
  | "no_provider_configured"
  | "unauthorized"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "empty_response"
  | "provider_refused"
  | "no_body"
  | "provider_unavailable";

export function friendlyGenerationFailure(
  reason: GenerationFailureReason,
  providerLabel?: string,
): FriendlyGenerationFailure {
  const label = providerLabel ?? "the AI provider";
  switch (reason) {
    case "no_credentials":
    case "no_provider_configured":
      return {
        title: "AI drafts aren't connected yet.",
        advice:
          "Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment to enable rewrites.",
      };
    case "unauthorized":
      return {
        title: `${label} rejected the API key.`,
        advice: "Re-check the key or workspace it belongs to, then try again.",
      };
    case "rate_limited":
      return {
        title: `${label} asked us to slow down.`,
        advice: "Try again in a minute.",
      };
    case "overloaded":
      return {
        title: `${label} is overloaded right now.`,
        advice: "Try again in a moment.",
      };
    case "timeout":
      return {
        title: `${label} didn't respond in time.`,
        advice: "Try again — the request was cancelled cleanly.",
      };
    case "network_error":
      return {
        title: `Couldn't reach ${label}.`,
        advice: "Check the network and try again.",
      };
    case "empty_response":
      return {
        title: `${label} returned an empty response.`,
        advice: "Try again, or rewrite manually.",
      };
    case "provider_refused":
      return {
        title: "The rewrite tripped a safety rule.",
        advice:
          "Try a different action or edit the draft manually. Signal won't save unsafe content.",
      };
    case "no_body":
      return {
        title: "Nothing to rewrite yet.",
        advice: "Write something first, then try again.",
      };
    case "provider_unavailable":
    case "provider_error":
    default:
      return {
        title: `${label} couldn't finish this rewrite right now.`,
        advice: "Try again, or rewrite manually.",
      };
  }
}
