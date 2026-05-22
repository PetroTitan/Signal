import "server-only";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  closeOperationRun,
  openOperationRun,
} from "@/repositories/admin-operations/mcp-operation-repository";
import { recordActivity } from "@/repositories/activity-repository";
import {
  summarizePrReadiness,
  type CheckResult,
  type VerificationReport,
} from "@/core/verification";
import {
  runAuthCheck,
  runDbIntegrityCheck,
  runDemoBoundaryCheck,
  runEnvCheck,
  runProductionSmokeTest,
  runRlsCheck,
  runRouteProtectionCheck,
} from "./checks";
import {
  runExecutionSafetyCheck,
  runOAuthSafetyCheck,
  runWeeklyContractCheck,
} from "./safety-checks";
import { runE2ESmokeTest } from "./e2e-pipeline";

/**
 * Run a single check by key. Used by the per-check buttons on
 * /settings/mcp.
 */
export async function runSingleCheck(
  check:
    | "env_check"
    | "auth_check"
    | "rls_check"
    | "db_integrity_check"
    | "route_protection_check"
    | "demo_boundary_check"
    | "oauth_safety_check"
    | "execution_safety_check"
    | "weekly_contract_check"
    | "execution_dry_run_smoke"
    | "production_smoke_test",
): Promise<CheckResult> {
  switch (check) {
    case "env_check":
      return runEnvCheck();
    case "auth_check":
      return runAuthCheck();
    case "rls_check":
      return runRlsCheck();
    case "db_integrity_check":
      return runDbIntegrityCheck();
    case "route_protection_check":
      return runRouteProtectionCheck();
    case "demo_boundary_check":
      return runDemoBoundaryCheck();
    case "oauth_safety_check":
      return runOAuthSafetyCheck();
    case "execution_safety_check":
      return runExecutionSafetyCheck();
    case "weekly_contract_check":
      return runWeeklyContractCheck();
    case "production_smoke_test":
      return runProductionSmokeTest();
    case "execution_dry_run_smoke": {
      const { result } = await runE2ESmokeTest();
      return result;
    }
  }
}

/**
 * Run the full verification pipeline. Persists an
 * mcp_operation_runs row, walks every check, and returns the
 * collected report with the PR readiness verdict.
 */
export async function runFullVerificationPipeline(): Promise<VerificationReport> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    const verificationRunId = "no-workspace";
    return {
      runId: "no-run",
      verificationRunId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      results: [
        {
          check: "auth_check",
          label: "Auth check",
          status: "fail",
          summary: "No workspace to verify against.",
          details: ["Create a workspace before running the pipeline."],
          requiresUserAction: true,
          blocksMerge: true,
          durationMs: 0,
        },
      ],
      prVerdict: "blocked",
    };
  }
  const workspaceId = membership.workspaceId;

  // Open the operation run so the audit row is there even if a step
  // throws. We close it in a finally block.
  const operationRun = await openOperationRun({
    workspaceId,
    operationType: "smoke_test_run",
    initialStatus: "running",
    inputSummary: "Phase E2.5 full verification pipeline",
  });

  const results: CheckResult[] = [];
  let verificationRunId = operationRun.id;

  try {
    results.push(await runEnvCheck());
    results.push(await runAuthCheck());
    results.push(await runRlsCheck());
    results.push(await runDbIntegrityCheck());
    results.push(await runRouteProtectionCheck());
    results.push(await runDemoBoundaryCheck());
    results.push(await runWeeklyContractCheck());
    results.push(await runExecutionSafetyCheck());
    results.push(await runOAuthSafetyCheck());
    results.push(await runProductionSmokeTest());

    const e2e = await runE2ESmokeTest();
    verificationRunId = e2e.verificationRunId;
    results.push(e2e.result);

    const verdict = summarizePrReadiness(results);

    // PR readiness check appears as its own result so the UI can
    // render a single row for the final gate.
    results.push({
      check: "pr_readiness_check",
      label: "PR readiness gate",
      status:
        verdict.verdict === "ready_to_merge"
          ? "pass"
          : verdict.verdict === "needs_review"
          ? "warning"
          : "fail",
      summary:
        verdict.verdict === "ready_to_merge"
          ? "All checks passed. Branch is ready to merge."
          : verdict.verdict === "needs_review"
          ? "Warnings present. A human should review before merging."
          : `Blocked by ${verdict.blockers.length} check(s).`,
      details:
        verdict.verdict === "blocked"
          ? verdict.blockers
          : verdict.verdict === "needs_review"
          ? verdict.warnings
          : ["No blockers detected."],
      requiresUserAction: verdict.verdict !== "ready_to_merge",
      blocksMerge: verdict.verdict === "blocked",
      durationMs: 0,
    });

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;

    await closeOperationRun({
      workspaceId,
      runId: operationRun.id,
      status: verdict.verdict === "blocked" ? "failed" : "completed",
      outputSummary: `verdict=${verdict.verdict}; ${results
        .map((r) => `${r.check}=${r.status}`)
        .join("; ")}`,
      metadata: {
        verification_run_id: verificationRunId,
        verdict: verdict.verdict,
        results: results.map((r) => ({
          check: r.check,
          status: r.status,
          summary: r.summary,
        })),
      },
    });

    try {
      await recordActivity({
        workspaceId,
        eventType: "verification.pipeline_completed",
        entityType: "mcp_operation_run",
        entityId: operationRun.id,
        title: `Verification pipeline ${verdict.verdict}`,
        description: `${results.length} check(s) in ${durationMs}ms.`,
        metadata: {
          verification_run_id: verificationRunId,
          verdict: verdict.verdict,
        },
      });
    } catch (err) {
      console.error("[verification] activity log failed", err);
    }

    return {
      runId: operationRun.id,
      verificationRunId,
      startedAt,
      finishedAt,
      durationMs,
      results,
      prVerdict: verdict.verdict,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Pipeline failure.";
    await closeOperationRun({
      workspaceId,
      runId: operationRun.id,
      status: "failed",
      errorSummary: message,
    }).catch(() => {});
    throw err;
  }
}
