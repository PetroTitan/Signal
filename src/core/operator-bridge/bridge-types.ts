/**
 * Phase E2.8 — Operator bridge canonical types.
 *
 * Mirrors the CHECK constraints in
 *   supabase/migrations/20260522080001_phase_e2_8_operator_bridge.sql
 */

import type {
  BridgeApprovalMode,
  BridgeAssistantType,
  BridgeNonceStatus,
  BridgeRequestStatus,
  BridgeRequestType,
  BridgeResultStatus,
  BridgeRiskLevel,
  BridgeVerificationStatus,
} from "@/lib/supabase/types";

export type {
  BridgeApprovalMode,
  BridgeAssistantType,
  BridgeNonceStatus,
  BridgeRequestStatus,
  BridgeRequestType,
  BridgeResultStatus,
  BridgeRiskLevel,
  BridgeVerificationStatus,
};

export const BRIDGE_ASSISTANT_TYPES = [
  "claude_code",
  "codex",
  "claude_opus",
  "supabase_mcp",
  "github_mcp",
  "vercel_manual",
] as const satisfies ReadonlyArray<BridgeAssistantType>;

export const BRIDGE_ASSISTANT_LABELS: Record<BridgeAssistantType, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  claude_opus: "Claude Opus",
  supabase_mcp: "Supabase MCP",
  github_mcp: "GitHub MCP",
  vercel_manual: "Vercel (manual)",
};

export const BRIDGE_REQUEST_TYPES = [
  "repo_check",
  "db_check",
  "rls_check",
  "migration_review",
  "pr_readiness_review",
  "import_mapping",
  "smoke_test",
  "deployment_review",
  "architecture_audit",
] as const satisfies ReadonlyArray<BridgeRequestType>;

export const BRIDGE_REQUEST_TYPE_LABELS: Record<BridgeRequestType, string> = {
  repo_check: "Repository check",
  db_check: "Database check",
  rls_check: "RLS check",
  migration_review: "Migration review",
  pr_readiness_review: "PR readiness review",
  import_mapping: "Import mapping",
  smoke_test: "Smoke test",
  deployment_review: "Deployment review",
  architecture_audit: "Architecture audit",
};

export const BRIDGE_REQUEST_STATUS_LABELS: Record<BridgeRequestStatus, string> = {
  draft: "Draft",
  pending_operator: "Pending operator",
  copied: "Copied",
  running: "Running",
  result_submitted: "Result submitted",
  verified: "Verified",
  failed_verification: "Failed verification",
  expired: "Expired",
  cancelled: "Cancelled",
  rejected: "Rejected",
  completed: "Completed",
};

export const BRIDGE_NONCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Domain shape — what callers see. The repository converts DB rows
 * into this shape.
 */
export interface OperatorBridgeRequest {
  id: string;
  workspaceId: string;
  operationRunId: string | null;
  requestedBy: string | null;
  assignedTo: string | null;
  assistantType: BridgeAssistantType;
  requestType: BridgeRequestType;
  riskLevel: BridgeRiskLevel;
  approvalMode: BridgeApprovalMode;
  status: BridgeRequestStatus;
  title: string;
  taskPrompt: string;
  expectedResultSchema: Record<string, unknown>;
  allowedCapabilities: string[];
  blockedCapabilities: string[];
  expiresAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorBridgeResult {
  id: string;
  workspaceId: string;
  requestId: string;
  submittedBy: string | null;
  assistantType: BridgeAssistantType;
  status: BridgeResultStatus;
  resultSummary: string;
  resultPayload: Record<string, unknown>;
  verificationStatus: BridgeVerificationStatus;
  verificationErrors: string[];
  signature: string | null;
  signedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorBridgeNonce {
  id: string;
  workspaceId: string;
  requestId: string;
  nonce: string;
  status: BridgeNonceStatus;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

/**
 * Canonical result envelope returned by the operator. The validator
 * parses incoming JSON against this shape.
 */
export interface BridgeResultEnvelope {
  request_id: string;
  nonce: string;
  assistant_type: BridgeAssistantType;
  status: "completed" | "failed" | "needs_review";
  summary: string;
  checks: BridgeResultCheck[];
  artifacts?: BridgeResultArtifact[];
  recommended_next_action?: string;
  requires_user_approval: boolean;
}

export interface BridgeResultCheck {
  name: string;
  status: "pass" | "warning" | "fail";
  details?: string[];
}

export interface BridgeResultArtifact {
  kind: string;
  label: string;
  body?: string;
}
