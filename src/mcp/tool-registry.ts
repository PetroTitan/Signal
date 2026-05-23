import "server-only";
import type { McpToolApprovalMode, McpToolRiskLevel } from "@/lib/supabase/types";
import type { ToolContext } from "./tool-context";
import type { McpToolResponse } from "./responses";
import { blocked } from "./responses";
import {
  parseAccountsPrepare,
  parseEmptyArgs,
  parseExecutionAuthorizeItem,
  parseExecutionDryRun,
  parseExecutionManualPublishPreview,
  parseExecutionPublishPreview,
  parseExecutionRecordManualPublish,
  parseImportsPrepareMapping,
  parseProductsPrepare,
  parseReportsSubmit,
  parseVerificationRunCheck,
  parseWeeklyPlanAttachCreative,
  parseWeeklyPlanPrepareItem,
  type Parse,
} from "./schemas";
import {
  accountsList,
  activityLatest,
  contractsActive,
  executionQueueStatus,
  oauthConnectionsList,
  productsList,
  verificationLatest,
  weeklyPlanCurrent,
  workspaceGet,
} from "./tools/read-tools";
import {
  accountsPrepare,
  importsPrepareMapping,
  productsPrepare,
  reportsSubmit,
  weeklyPlanAttachCreative,
  weeklyPlanPrepareItem,
} from "./tools/prepare-tools";
import {
  executionAuthorizeItem,
  executionDryRun,
  executionManualPublishPreview,
  executionPublishPreview,
  executionRecordManualPublish,
  verificationRun,
  verificationRunCheck,
} from "./tools/verification-tools";

export interface ToolDefinition {
  name: string;
  description: string;
  requiredScopes: ReadonlyArray<string>;
  riskLevel: McpToolRiskLevel;
  approvalMode: McpToolApprovalMode;
  writesDatabase: boolean;
  touchesProduction: boolean;
  parseArgs: (input: unknown) => Parse<unknown>;
  handler: (ctx: ToolContext, args: unknown) => Promise<McpToolResponse>;
}

function wrap<TArgs>(
  fn: (ctx: ToolContext, args: TArgs) => Promise<McpToolResponse>,
): (ctx: ToolContext, args: unknown) => Promise<McpToolResponse> {
  return (ctx, args) => fn(ctx, args as TArgs);
}

export const TOOLS: ToolDefinition[] = [
  // Read tools ---------------------------------------------------------
  {
    name: "signal.workspace.get",
    description: "Read workspace, settings, demo-mode flag, operator scopes.",
    requiredScopes: ["workspace:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(workspaceGet),
  },
  {
    name: "signal.products.list",
    description: "List products (active + pending). No secrets.",
    requiredScopes: ["products:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(productsList),
  },
  {
    name: "signal.accounts.list",
    description: "List growth accounts. Never returns tokens.",
    requiredScopes: ["accounts:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(accountsList),
  },
  {
    name: "signal.weekly_plan.current",
    description: "Read the current weekly plan and items.",
    requiredScopes: ["weekly_plans:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(weeklyPlanCurrent),
  },
  {
    name: "signal.contracts.active",
    description: "Read the active weekly operating contract and scope.",
    requiredScopes: ["contracts:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(contractsActive),
  },
  {
    name: "signal.execution.queue_status",
    description: "Read execution queues, items, and recent log events.",
    requiredScopes: ["execution:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(executionQueueStatus),
  },
  {
    name: "signal.verification.latest",
    description: "Read recent verification/operation runs.",
    requiredScopes: ["verification:run"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(verificationLatest),
  },
  {
    name: "signal.oauth.connections.list",
    description:
      "List platform OAuth connections in the workspace. Returns connection_status, health_status, scopes, expires_at, has_access_token/has_refresh_token booleans. NEVER returns the encrypted token envelopes or any token plaintext.",
    requiredScopes: ["accounts:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(oauthConnectionsList),
  },
  {
    name: "signal.activity.latest",
    description: "Read recent activity_events.",
    requiredScopes: ["workspace:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(activityLatest),
  },
  // Prepare tools ------------------------------------------------------
  {
    name: "signal.products.prepare",
    description: "Create a product with review_status='pending_review'.",
    requiredScopes: ["products:write_pending"],
    riskLevel: "remote_write",
    approvalMode: "approval_required",
    writesDatabase: true,
    touchesProduction: false,
    parseArgs: parseProductsPrepare,
    handler: wrap(productsPrepare),
  },
  {
    name: "signal.accounts.prepare",
    description: "Create a growth_account with review_status='pending_review'.",
    requiredScopes: ["accounts:write_pending"],
    riskLevel: "remote_write",
    approvalMode: "approval_required",
    writesDatabase: true,
    touchesProduction: false,
    parseArgs: parseAccountsPrepare,
    handler: wrap(accountsPrepare),
  },
  {
    name: "signal.weekly_plan.prepare_item",
    description:
      "Create a weekly_plan_item (default pending_approval) and optionally attach a creative plan. Posts default to creative_required=true; if no creative fields are supplied a 'planned' placeholder is dropped so the approval queue shows 'creative missing'. Cannot publish — operator approval still required.",
    requiredScopes: ["weekly_plans:write_pending"],
    riskLevel: "remote_write",
    approvalMode: "approval_required",
    writesDatabase: true,
    touchesProduction: false,
    parseArgs: parseWeeklyPlanPrepareItem,
    handler: wrap(weeklyPlanPrepareItem),
  },
  {
    name: "signal.weekly_plan.attach_creative",
    description:
      "Attach (or update) a creative on an existing weekly_plan_item. Source types: generated, uploaded, wikimedia, official_source, manual_url, planned. External sources require source_url; generated requires prompt. Approve via /approval-queue or /weekly-plan UI.",
    requiredScopes: ["weekly_plans:write_pending"],
    riskLevel: "remote_write",
    approvalMode: "no_approval_needed",
    writesDatabase: true,
    touchesProduction: false,
    parseArgs: parseWeeklyPlanAttachCreative,
    handler: wrap(weeklyPlanAttachCreative),
  },
  {
    name: "signal.imports.prepare_mapping",
    description:
      "Record a product/account import mapping as pending_approval. Does not create confirmed records.",
    requiredScopes: ["imports:prepare"],
    riskLevel: "remote_write",
    approvalMode: "approval_required",
    writesDatabase: true,
    touchesProduction: false,
    parseArgs: parseImportsPrepareMapping,
    handler: wrap(importsPrepareMapping),
  },
  {
    name: "signal.reports.submit",
    description:
      "Submit an operator-side report (smoke test results, audit notes, recommendations).",
    requiredScopes: ["reports:write"],
    riskLevel: "local_write",
    approvalMode: "no_approval_needed",
    writesDatabase: true,
    touchesProduction: false,
    parseArgs: parseReportsSubmit,
    handler: wrap(reportsSubmit),
  },
  // Verification / dry-run tools --------------------------------------
  {
    name: "signal.verification.run",
    description:
      "Surface the latest full verification pipeline run (read-only).",
    requiredScopes: ["verification:run"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseEmptyArgs,
    handler: wrap(verificationRun),
  },
  {
    name: "signal.verification.run_check",
    description: "Surface the latest result for a single named check.",
    requiredScopes: ["verification:run"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseVerificationRunCheck,
    handler: wrap(verificationRunCheck),
  },
  {
    name: "signal.execution.dry_run",
    description:
      "Read the latest dry-run logs for an execution queue or item. New dry-runs are triggered from /execution.",
    requiredScopes: ["execution:dry_run"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseExecutionDryRun,
    handler: wrap(executionDryRun),
  },
  {
    name: "signal.execution.manual_publish_preview",
    description:
      "Read-only preview for the F2.6 manual-publish workflow. Returns title, body, subreddit, creative URL, alt text, open-Reddit-submit URL, and a copy-paste-friendly payload string plus the manual-publish policy verdict. Manual mode does not require Reddit API approval. MCP cannot record the publish on its own from this tool — use signal.execution.record_manual_publish or paste the permalink in /execution/items/<id>.",
    requiredScopes: ["execution:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseExecutionManualPublishPreview,
    handler: wrap(executionManualPublishPreview),
  },
  {
    name: "signal.execution.record_manual_publish",
    description:
      "Record a manually-published Reddit post. The operator publishes on Reddit themselves; this tool just stores the audit row. Runs the manual-publish policy (every gate except OAuth/token), validates the permalink (reddit.com/r/<sub>/comments/<id>/ or redd.it/<id>), refuses duplicates, inserts publish_history (mode='manual'), walks the execution_item to completed, mirrors the plan_item to published. Does NOT call Reddit. Does NOT bypass any other safety gate.",
    requiredScopes: ["execution:dry_run"],
    riskLevel: "remote_write",
    approvalMode: "no_approval_needed",
    writesDatabase: true,
    touchesProduction: true,
    parseArgs: parseExecutionRecordManualPublish,
    handler: wrap(executionRecordManualPublish),
  },
  {
    name: "signal.execution.publish_preview",
    description:
      "Read-only preview of the controlled-publish gate for an execution_item. Runs evaluateSafeTestPolicy and returns every check + the Reddit payload preview. MCP CANNOT publish — only the operator can confirm at /execution/items/<id>.",
    requiredScopes: ["execution:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseExecutionPublishPreview,
    handler: wrap(executionPublishPreview),
  },
  {
    name: "signal.execution.authorize_item",
    description:
      "Read the most recent authorization for an execution item. New authorizations are minted from /execution.",
    requiredScopes: ["execution:read"],
    riskLevel: "safe_read",
    approvalMode: "no_approval_needed",
    writesDatabase: false,
    touchesProduction: false,
    parseArgs: parseExecutionAuthorizeItem,
    handler: wrap(executionAuthorizeItem),
  },
];

export const TOOLS_BY_NAME: Record<string, ToolDefinition> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);

/**
 * Tools the MCP policy explicitly forbids. If a client calls one of
 * these, the dispatcher returns a structured `blocked` response
 * without consulting the registry.
 */
export const BLOCKED_TOOL_NAMES = new Set<string>([
  "signal.publish.live",
  "signal.comment.live",
  "signal.social.create_account",
  "signal.social.login",
  "signal.cookies.import",
  "signal.sessions.import",
  "signal.tokens.read",
  "signal.database.raw_sql",
  "signal.billing.modify",
  "signal.pr.merge",
  "signal.production.deploy",
]);

export function buildBlockedResponse(toolName: string): McpToolResponse {
  return blocked({
    tool: toolName,
    summary:
      "This tool is explicitly blocked by the Signal MCP policy. See docs/mcp-server/security-model.md.",
  });
}
