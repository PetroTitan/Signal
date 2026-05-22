/**
 * Phase E2.8 — operator bridge policy strings.
 */

export const BRIDGE_POLICY_ALLOWED = [
  "Signal generates a request_id + one-shot nonce + expires_at.",
  "Operator copies the task prompt into Claude Code / Codex / Opus.",
  "Assistant performs only the allowed_capabilities listed on the request.",
  "Assistant returns a structured result envelope including request_id + nonce.",
  "Signal verifies the envelope and stores it in operator_bridge_results.",
  "Signal updates the linked mcp_operation_runs row and writes an activity event.",
] as const;

export const BRIDGE_POLICY_REQUIRES_APPROVAL = [
  "Acting on the assistant's recommended next action.",
  "Promoting a screenshot-imported product/account from pending_review to confirmed.",
  "Applying a Supabase migration that the bridge result recommends.",
  "Pushing a branch or opening a PR Signal didn't open itself.",
] as const;

export const BRIDGE_POLICY_NEVER = [
  "Auto-applying any recommended action without explicit user approval.",
  "Storing operator passwords, cookies, session tokens, 2FA codes, or recovery codes.",
  "Reading the service-role key or any column whose name contains `secret` / `password` / `token`.",
  "Reusing a consumed nonce — every result requires a fresh nonce.",
  "Trusting an `assistant_type` field that disagrees with the request.",
  "Bypassing the forbidden-fields scan on result_payload.",
] as const;

/**
 * Forbidden field names. The result validator walks the JSON tree and
 * rejects any leaf path that *matches or contains* any of these
 * tokens, case-insensitive.
 */
export const FORBIDDEN_RESULT_FIELDS = [
  "password",
  "passwords",
  "cookie",
  "cookies",
  "session_token",
  "session_tokens",
  "session_id",
  "access_token",
  "access_tokens",
  "refresh_token",
  "refresh_tokens",
  "bearer_token",
  "service_role",
  "service_role_key",
  "private_key",
  "private_keys",
  "recovery_code",
  "recovery_codes",
  "secret",
  "secrets",
  "client_secret",
  "api_key",
] as const;

/**
 * Maximum bytes accepted for a single result payload. Anything larger
 * is rejected with `verification_errors=['result_too_large']`.
 */
export const BRIDGE_MAX_RESULT_BYTES = 256 * 1024; // 256 KB

/**
 * Maximum string size for the summary on a result. Keeps the activity
 * feed readable and the audit row reviewable.
 */
export const BRIDGE_MAX_SUMMARY_CHARS = 4_000;
