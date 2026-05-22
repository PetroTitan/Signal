export type AiErrorCode =
  | "provider_not_connected"
  | "use_case_blocked"
  | "input_validation_failed"
  | "output_validation_failed"
  | "safety_blocked"
  | "rate_limited"
  | "quota_exceeded"
  | "timeout"
  | "internal";

export interface AiError {
  code: AiErrorCode;
  message: string;
  userMessage: string;
}

const userMessages: Record<AiErrorCode, string> = {
  provider_not_connected:
    "AI provider not connected. Using local preview mode.",
  use_case_blocked: "This use case is not allowed in Signal.",
  input_validation_failed: "The request was incomplete.",
  output_validation_failed: "AI returned an unsafe shape. Discarded.",
  safety_blocked: "Output was blocked by the safety policy.",
  rate_limited: "Too many requests right now. Try again in a moment.",
  quota_exceeded: "Workspace AI budget reached. New requests resume next week.",
  timeout: "AI took too long to respond.",
  internal: "Something went wrong on Signal's side.",
};

export function aiError(
  code: AiErrorCode,
  message?: string,
): AiError {
  return {
    code,
    message: message ?? code,
    userMessage: userMessages[code],
  };
}
