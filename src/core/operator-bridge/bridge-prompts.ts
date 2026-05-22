/**
 * Phase E2.8 — copyable task prompts for operator assistants.
 *
 * Pure string builders. The /operator-bridge/[id] page renders the
 * output in a monospace block; the operator copies it into Claude
 * Code / Codex / Opus.
 */

import type {
  OperatorBridgeRequest,
  BridgeResultEnvelope,
} from "./bridge-types";
import { BRIDGE_REQUEST_TYPE_LABELS } from "./bridge-types";

export interface TaskPromptInput {
  request: OperatorBridgeRequest;
  nonce: string;
}

/**
 * Builds the operator-facing prompt. The prompt is deliberately
 * declarative: it tells the assistant *what* to do, *what* it may not
 * do, and *exactly* what JSON shape to return. No model-specific
 * markup — works the same for Claude Code, Codex, and Opus.
 */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const { request, nonce } = input;
  const lines: string[] = [];

  lines.push(
    "You are acting as an operator-side assistant for Signal.",
    "Perform only the requested checks.",
    "Do not mutate production unless explicitly allowed.",
    "Return the result envelope JSON exactly as specified below.",
    "",
    `Task: ${request.title}`,
    `Type: ${BRIDGE_REQUEST_TYPE_LABELS[request.requestType]}`,
    `Risk level: ${request.riskLevel}`,
    `Approval mode: ${request.approvalMode}`,
    "",
    "----- Instructions -----",
    request.taskPrompt,
    "",
  );

  if (request.allowedCapabilities.length > 0) {
    lines.push("Allowed capabilities:");
    for (const cap of request.allowedCapabilities) lines.push(`  - ${cap}`);
    lines.push("");
  }
  if (request.blockedCapabilities.length > 0) {
    lines.push("Blocked capabilities (never use these):");
    for (const cap of request.blockedCapabilities) lines.push(`  - ${cap}`);
    lines.push("");
  }

  lines.push(
    "Identifiers (return verbatim in the result):",
    `  request_id: ${request.id}`,
    `  nonce: ${nonce}`,
    `  expires_at: ${request.expiresAt}`,
    "",
    "Return ONLY the JSON envelope. Do not include code fences, prose, or",
    "anything outside the JSON. The envelope MUST match this shape:",
    "",
    JSON.stringify(buildExampleEnvelope(request, nonce), null, 2),
    "",
    "Forbidden in the result_payload (will reject the submission):",
    "  passwords, cookies, session_tokens, access_tokens, refresh_tokens,",
    "  service_role, private_keys, recovery_codes, secrets, API keys.",
    "",
    "When you are done, return the JSON exactly. The operator will paste it",
    "back into Signal.",
  );

  return lines.join("\n");
}

function buildExampleEnvelope(
  request: OperatorBridgeRequest,
  nonce: string,
): BridgeResultEnvelope {
  return {
    request_id: request.id,
    nonce,
    assistant_type: request.assistantType,
    status: "completed",
    summary: "Short single-sentence summary of what you verified.",
    checks: [
      {
        name: "example_check_name",
        status: "pass",
        details: ["short detail line", "another detail line"],
      },
    ],
    artifacts: [],
    recommended_next_action: "describe the suggested follow-up, if any",
    requires_user_approval: false,
  };
}
