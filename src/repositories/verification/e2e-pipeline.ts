import "server-only";
import { randomUUID, webcrypto } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { createProduct, archiveProduct } from "@/repositories/product-repository";
import { createAccount, archiveAccount } from "@/repositories/account-repository";
import {
  createPlanItem,
  createWeeklyPlan,
  updatePlanItemStatus,
} from "@/repositories/weekly-plan-repository";
import {
  activateContract,
  approveContract,
  createWeeklyContract,
  revokeContract,
  submitContractForApproval,
} from "@/repositories/weekly-contract-repository";
import {
  cancelQueue,
  createExecutionQueue,
} from "@/repositories/execution-queue-repository";
import {
  createExecutionItem,
  updateItemStatus,
} from "@/repositories/execution-item-repository";
import {
  recordExecutionAuthorization,
} from "@/repositories/execution-authorization-repository";
import {
  finishAttempt,
  startAttempt,
} from "@/repositories/execution-attempt-repository";
import { recordLogs } from "@/repositories/execution-log-repository";
import { recordActivity } from "@/repositories/activity-repository";
import {
  composeAuthorizationLog,
  composeDryRunLog,
  composeItemLog,
  composeQueueLog,
  type ComposedLog,
} from "@/core/execution-engine";
import {
  ALLOWED_RESULT,
  type AuthorizationResult,
} from "@/core/weekly-contract";
import { fail, pass, type CheckResult } from "@/core/verification";

/**
 * Phase E2.5 — end-to-end execution dry-run smoke test.
 *
 * Walks the whole stack with clearly-tagged test data:
 *   product → account → weekly plan + item → contract (draft → active)
 *   → execution queue → item → authorization → dry-run → cleanup.
 *
 * Every entity carries `metadata.e2e_run_id = <uuid>` so the cleanup
 * step (and any human auditor) can identify and tear down the run.
 *
 * Cleanup strategy:
 *   - Products / accounts: archived (their tables expose archive flows).
 *   - Plan items: status → skipped.
 *   - Contracts: revoked (terminal, history-friendly).
 *   - Execution queues: cancelled.
 *   - Execution items: cancelled.
 *   - Logs / attempts / authorizations: append-only — left in place and
 *     filterable by metadata.e2e_run_id.
 *
 * Failure handling: any step failure short-circuits, marks the result
 * as `fail`, and *still* runs cleanup so test data does not pollute
 * real reads.
 */

const E2E_PREFIX = "[verification]";

function newRunId(): string {
  if (typeof randomUUID === "function") return randomUUID();
  return (webcrypto as { randomUUID(): string }).randomUUID();
}

interface E2EContext {
  workspaceId: string;
  runId: string;
  details: string[];
  createdProductId?: string;
  createdAccountId?: string;
  createdPlanId?: string;
  createdPlanItemId?: string;
  createdContractId?: string;
  createdQueueId?: string;
  createdExecutionItemId?: string;
  startedAt: number;
}

interface PipelineRunOutcome {
  result: CheckResult;
  verificationRunId: string;
}

export async function runE2ESmokeTest(): Promise<PipelineRunOutcome> {
  const startedAt = Date.now();
  const runId = newRunId();
  const detail = (s: string) => `${s}`;
  const ctx: E2EContext = {
    workspaceId: "",
    runId,
    details: [`verification_run_id=${runId}`],
    startedAt,
  };

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) {
      return finalize(
        fail({
          check: "execution_dry_run_smoke",
          label: "End-to-end execution dry-run",
          summary: "No workspace to test against.",
          details: ctx.details,
          durationMs: Date.now() - startedAt,
        }),
        runId,
      );
    }
    ctx.workspaceId = membership.workspaceId;
    ctx.details.push(detail(`workspace=${ctx.workspaceId}`));

    // 1) Product
    const product = await createProduct({
      workspaceId: ctx.workspaceId,
      name: `${E2E_PREFIX} product ${runId.slice(0, 8)}`,
      domain: null,
      summary: "Created by automated verification pipeline.",
      category: null,
    });
    ctx.createdProductId = product.id;
    ctx.details.push(`created product ${product.id}`);

    // 2) Account
    const account = await createAccount({
      workspaceId: ctx.workspaceId,
      platform: "reddit",
      displayName: `${E2E_PREFIX} account ${runId.slice(0, 8)}`,
      productId: product.id,
    });
    ctx.createdAccountId = account.id;
    ctx.details.push(`created account ${account.id}`);

    // 3) Weekly plan + item
    const weekStart = isoMonday(new Date());
    const plan = await createWeeklyPlan({
      workspaceId: ctx.workspaceId,
      title: `${E2E_PREFIX} plan ${runId.slice(0, 8)}`,
      weekStart,
    });
    ctx.createdPlanId = plan.id;
    ctx.details.push(`created weekly_plan ${plan.id}`);

    const planItem = await createPlanItem({
      workspaceId: ctx.workspaceId,
      weeklyPlanId: plan.id,
      title: `${E2E_PREFIX} item ${runId.slice(0, 8)}`,
      body: "Dry-run verification item.",
      platform: "reddit",
      contentType: "post",
      productId: product.id,
      accountId: account.id,
      status: "approved",
      metadata: { e2e_run_id: runId },
    });
    ctx.createdPlanItemId = planItem.id;
    ctx.details.push(`created plan_item ${planItem.id}`);

    // 4) Weekly contract
    const weekEnd = addDaysIso(weekStart, 6);
    const contract = await createWeeklyContract({
      workspaceId: ctx.workspaceId,
      title: `${E2E_PREFIX} contract ${runId.slice(0, 8)}`,
      weekStart,
      weekEnd,
      maxRiskLevel: "medium",
      notes: "Verification pipeline contract.",
      accountIds: [account.id],
      productIds: [product.id],
      platforms: ["reddit"],
      allowedActions: ["publish_scheduled_post"],
      executionWindows: [
        { dayOfWeek: 1, startTime: "00:00", endTime: "23:59" },
        { dayOfWeek: 2, startTime: "00:00", endTime: "23:59" },
        { dayOfWeek: 3, startTime: "00:00", endTime: "23:59" },
        { dayOfWeek: 4, startTime: "00:00", endTime: "23:59" },
        { dayOfWeek: 5, startTime: "00:00", endTime: "23:59" },
        { dayOfWeek: 6, startTime: "00:00", endTime: "23:59" },
        { dayOfWeek: 0, startTime: "00:00", endTime: "23:59" },
      ],
    });
    ctx.createdContractId = contract.id;
    ctx.details.push(`created weekly_contract ${contract.id}`);

    // 5) Submit + approve + activate
    await submitContractForApproval(ctx.workspaceId, contract.id);
    await approveContract({
      workspaceId: ctx.workspaceId,
      contractId: contract.id,
      approvalTextPhrase: `approve ${contract.title}`,
    });
    const activeContract = await activateContract(
      ctx.workspaceId,
      contract.id,
    );
    ctx.details.push(`contract activated (${activeContract.status})`);

    // 6) Execution queue
    const queue = await createExecutionQueue({
      workspaceId: ctx.workspaceId,
      contractId: activeContract.id,
      title: `${E2E_PREFIX} queue ${runId.slice(0, 8)}`,
      weekStart: activeContract.weekStart,
      weekEnd: activeContract.weekEnd,
    });
    ctx.createdQueueId = queue.id;
    ctx.details.push(`created execution_queue ${queue.id}`);

    // 7) Execution item
    const executionItem = await createExecutionItem({
      workspaceId: ctx.workspaceId,
      queueId: queue.id,
      contractId: activeContract.id,
      actionType: "publish_scheduled_post",
      sourceEntityType: "weekly_plan_item",
      sourceEntityId: planItem.id,
      productId: product.id,
      accountId: account.id,
      platform: "reddit",
      title: planItem.title,
      body: planItem.body,
      riskLevel: "low",
      metadata: { e2e_run_id: runId },
    });
    ctx.createdExecutionItemId = executionItem.id;
    ctx.details.push(`created execution_item ${executionItem.id}`);

    // 8) Authorize → dry-run (manual orchestration so the test does not
    //    depend on action wiring elsewhere)
    const allowed: AuthorizationResult = {
      ...ALLOWED_RESULT,
      reasonDetail: "Verification pipeline allow.",
    };
    const auth = await recordExecutionAuthorization({
      context: {
        workspaceId: ctx.workspaceId,
        contractId: activeContract.id,
        actionType: "publish_scheduled_post",
        accountId: account.id,
        productId: product.id,
        platform: "reddit",
        scheduledItemId: null,
        weeklyPlanItemId: planItem.id,
        extraMetadata: {
          e2e_run_id: runId,
          execution_item_id: executionItem.id,
        },
      },
      result: allowed,
    });
    ctx.details.push(`recorded execution_authorization ${auth.id}`);

    const attempt = await startAttempt({
      workspaceId: ctx.workspaceId,
      itemId: executionItem.id,
      attemptNumber: 1,
      metadata: { e2e_run_id: runId, dry_run: true },
    });

    const logs: ComposedLog[] = [
      composeItemLog({
        workspaceId: ctx.workspaceId,
        queueId: queue.id,
        executionItemId: executionItem.id,
        eventType: "item.authorization_requested",
        message: "Verification: evaluating authorization.",
        metadata: { e2e_run_id: runId },
      }),
      composeAuthorizationLog({
        workspaceId: ctx.workspaceId,
        queueId: queue.id,
        executionItemId: executionItem.id,
        result: allowed,
      }),
      composeItemLog({
        workspaceId: ctx.workspaceId,
        queueId: queue.id,
        executionItemId: executionItem.id,
        eventType: "item.dry_run_started",
        message: "Verification: dry-run started.",
        metadata: { e2e_run_id: runId },
      }),
      composeDryRunLog({
        workspaceId: ctx.workspaceId,
        queueId: queue.id,
        executionItemId: executionItem.id,
        dryRunAction: "would_publish_post",
        message: "Verification dry-run: would_publish_post on reddit. No external call.",
        metadata: { e2e_run_id: runId },
      }),
      composeItemLog({
        workspaceId: ctx.workspaceId,
        queueId: queue.id,
        executionItemId: executionItem.id,
        eventType: "item.completed",
        message: "Verification dry-run completed.",
        metadata: { e2e_run_id: runId },
      }),
    ];
    await recordLogs(logs);
    await updateItemStatus({
      workspaceId: ctx.workspaceId,
      itemId: executionItem.id,
      to: "authorized",
      patch: { authorization_id: auth.id, attempt_count: 1 },
    });
    await updateItemStatus({
      workspaceId: ctx.workspaceId,
      itemId: executionItem.id,
      to: "completed",
    });
    await finishAttempt({
      workspaceId: ctx.workspaceId,
      attemptId: attempt.id,
      status: "succeeded",
      metadata: { dryRunKind: "executed", e2e_run_id: runId },
    });
    ctx.details.push(`dry-run completed on execution_item ${executionItem.id}`);

    // 9) Verify the queue's logs contain the expected events.
    const supabase = createSupabaseServerClient();
    const { data: logRows } = await supabase
      .from("execution_logs")
      .select("event_type")
      .eq("workspace_id", ctx.workspaceId)
      .eq("queue_id", queue.id);
    const events = new Set(
      ((logRows ?? []) as Array<{ event_type: string }>).map((r) => r.event_type),
    );
    const missing = [
      "item.authorization_allowed",
      "item.dry_run_finished",
      "item.completed",
    ].filter((e) => !events.has(e));
    if (missing.length > 0) {
      throw new Error(`Missing expected log events: ${missing.join(", ")}`);
    }
    ctx.details.push("verified expected log events present");

    await cleanup(ctx);

    const summary = "End-to-end dry-run succeeded across product → contract → execution.";
    try {
      await recordActivity({
        workspaceId: ctx.workspaceId,
        eventType: "verification.pipeline_completed",
        entityType: "verification_run",
        entityId: null,
        title: "Verification pipeline completed",
        description: summary,
        metadata: { e2e_run_id: runId },
      });
    } catch (err) {
      console.error("[verification] activity log failed", err);
    }
    return finalize(
      pass({
        check: "execution_dry_run_smoke",
        label: "End-to-end execution dry-run",
        summary,
        details: ctx.details,
        durationMs: Date.now() - startedAt,
      }),
      runId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown failure.";
    ctx.details.push(`error: ${message}`);
    try {
      await cleanup(ctx);
      ctx.details.push("cleanup completed despite failure");
    } catch (cleanupErr) {
      ctx.details.push(
        `cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown"}`,
      );
    }
    return finalize(
      fail({
        check: "execution_dry_run_smoke",
        label: "End-to-end execution dry-run",
        summary: message,
        details: ctx.details,
        durationMs: Date.now() - startedAt,
      }),
      runId,
    );
  }
}

function finalize(result: CheckResult, verificationRunId: string): PipelineRunOutcome {
  return { result, verificationRunId };
}

async function cleanup(ctx: E2EContext): Promise<void> {
  if (!ctx.workspaceId) return;
  // Order chosen so foreign keys never block: items → queues → contract
  // → plan items → plan → account → product.
  if (ctx.createdExecutionItemId) {
    try {
      await updateItemStatus({
        workspaceId: ctx.workspaceId,
        itemId: ctx.createdExecutionItemId,
        to: "cancelled",
      });
    } catch {
      // already-final states throw — ignore for cleanup.
    }
  }
  if (ctx.createdQueueId) {
    try {
      await cancelQueue(ctx.workspaceId, ctx.createdQueueId);
    } catch {
      // ignore
    }
  }
  if (ctx.createdContractId) {
    try {
      await revokeContract({
        workspaceId: ctx.workspaceId,
        contractId: ctx.createdContractId,
        reason: "Verification pipeline cleanup.",
      });
    } catch {
      // ignore
    }
  }
  if (ctx.createdPlanItemId) {
    try {
      await updatePlanItemStatus({
        workspaceId: ctx.workspaceId,
        itemId: ctx.createdPlanItemId,
        status: "skipped",
      });
    } catch {
      // ignore
    }
  }
  if (ctx.createdAccountId) {
    try {
      await archiveAccount({
        workspaceId: ctx.workspaceId,
        accountId: ctx.createdAccountId,
      });
    } catch {
      // ignore
    }
  }
  if (ctx.createdProductId) {
    try {
      await archiveProduct({
        workspaceId: ctx.workspaceId,
        productId: ctx.createdProductId,
      });
    } catch {
      // ignore
    }
  }
}

function isoMonday(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
