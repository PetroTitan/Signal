"use server";

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  activateContract,
  approveContract,
  createWeeklyContract,
  pauseContract,
  resumeContract,
  revokeContract,
  submitContractForApproval,
} from "@/repositories/weekly-contract-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";
import type {
  WeeklyContractActionType,
  WeeklyContractRiskCeiling,
} from "@/core/weekly-contract";

export type CreateContractResult = ActionResult<{ contractId: string }>;
export type LifecycleActionResult = ActionResult<{ contractId: string }>;

async function logActivityBestEffort(
  input: Parameters<typeof recordActivity>[0],
) {
  try {
    await recordActivity(input);
  } catch (err) {
    console.error("[weekly-contracts] activity log failed", err);
  }
}

function parseIntField(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseList(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

export async function createContractAction(
  _prev: CreateContractResult,
  formData: FormData,
): Promise<CreateContractResult> {
  const title = String(formData.get("title") ?? "").trim() || "Weekly contract";
  const weekStart = String(formData.get("week_start") ?? "").trim();
  const weekEnd = String(formData.get("week_end") ?? "").trim();

  if (!weekStart || !weekEnd) {
    return actionFail("Both week_start and week_end are required.");
  }

  const maxRiskLevel = (String(
    formData.get("max_risk_level") ?? "medium",
  ).trim() as WeeklyContractRiskCeiling);

  const accountIds = parseList(formData, "account_ids");
  const productIds = parseList(formData, "product_ids");
  const platforms = parseList(formData, "platforms");
  const allowedActions = parseList(formData, "allowed_actions") as WeeklyContractActionType[];

  // Execution windows arrive as parallel arrays.
  const dayList = parseList(formData, "window_day");
  const startList = parseList(formData, "window_start");
  const endList = parseList(formData, "window_end");
  const executionWindows = dayList
    .map((d, i) => {
      const day = parseInt(d, 10);
      const start = startList[i];
      const end = endList[i];
      if (
        !Number.isFinite(day) ||
        day < 0 ||
        day > 6 ||
        !start ||
        !end ||
        !/^[0-2]\d:[0-5]\d$/.test(start) ||
        !/^[0-2]\d:[0-5]\d$/.test(end) ||
        end <= start
      ) {
        return null;
      }
      return { dayOfWeek: day, startTime: start, endTime: end };
    })
    .filter(
      (w): w is { dayOfWeek: number; startTime: string; endTime: string } =>
        w !== null,
    );

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");

    const contract = await createWeeklyContract({
      workspaceId: membership.workspace.id,
      title,
      weekStart,
      weekEnd,
      maxRiskLevel,
      maxActionsTotal: parseIntField(formData.get("max_actions_total")),
      maxActionsPerDay: parseIntField(formData.get("max_actions_per_day")),
      maxActionsPerPlatformPerDay: parseIntField(
        formData.get("max_actions_per_platform_per_day"),
      ),
      pauseOnFirstFailure: formData.get("pause_on_first_failure") !== "off",
      pauseOnRiskEvent: formData.get("pause_on_risk_event") !== "off",
      notes: String(formData.get("notes") ?? "").trim() || null,
      accountIds,
      productIds,
      platforms,
      allowedActions,
      executionWindows,
    });

    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "weekly_contract.created",
      entityType: "weekly_contract",
      entityId: contract.id,
      title: `Weekly contract "${contract.title}" drafted`,
      description: `Covers ${contract.weekStart} → ${contract.weekEnd}.`,
    });

    revalidatePath("/weekly-contracts");
    revalidatePath("/activity");
    return actionOk({ contractId: contract.id });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : "Could not create weekly contract.";
    console.error("[createContractAction] failed", error);
    return actionFail(message);
  }
}

export async function submitContractAction(
  _prev: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const contractId = String(formData.get("contract_id") ?? "").trim();
  if (!contractId) return actionFail("Missing contract id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const contract = await submitContractForApproval(
      membership.workspace.id,
      contractId,
    );
    revalidatePath("/weekly-contracts");
    revalidatePath(`/weekly-contracts/${contractId}`);
    return actionOk({ contractId: contract.id });
  } catch (error) {
    return actionFail(
      error instanceof RepositoryError ? error.message : "Submit failed.",
    );
  }
}

export async function approveContractAction(
  _prev: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const contractId = String(formData.get("contract_id") ?? "").trim();
  const phrase = String(formData.get("approval_phrase") ?? "").trim();
  const expected = String(formData.get("expected_phrase") ?? "").trim();

  if (!contractId) return actionFail("Missing contract id.");
  if (!phrase || phrase !== expected) {
    return actionFail("Confirmation phrase did not match.");
  }
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const contract = await approveContract({
      workspaceId: membership.workspace.id,
      contractId,
      approvalTextPhrase: phrase,
    });
    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "weekly_contract.approved",
      entityType: "weekly_contract",
      entityId: contract.id,
      title: `Weekly contract "${contract.title}" approved`,
      description: `Approved at ${contract.approvedAt ?? "now"}.`,
    });
    revalidatePath("/weekly-contracts");
    revalidatePath(`/weekly-contracts/${contractId}`);
    revalidatePath("/activity");
    return actionOk({ contractId: contract.id });
  } catch (error) {
    return actionFail(
      error instanceof RepositoryError ? error.message : "Approval failed.",
    );
  }
}

export async function activateContractAction(
  _prev: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const contractId = String(formData.get("contract_id") ?? "").trim();
  if (!contractId) return actionFail("Missing contract id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const contract = await activateContract(
      membership.workspace.id,
      contractId,
    );
    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "weekly_contract.activated",
      entityType: "weekly_contract",
      entityId: contract.id,
      title: `Weekly contract "${contract.title}" activated`,
      description: `Signal may now operate within this envelope.`,
    });
    revalidatePath("/weekly-contracts");
    revalidatePath(`/weekly-contracts/${contractId}`);
    revalidatePath("/activity");
    return actionOk({ contractId: contract.id });
  } catch (error) {
    return actionFail(
      error instanceof RepositoryError ? error.message : "Activate failed.",
    );
  }
}

export async function pauseContractAction(
  _prev: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const contractId = String(formData.get("contract_id") ?? "").trim();
  if (!contractId) return actionFail("Missing contract id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const contract = await pauseContract({
      workspaceId: membership.workspace.id,
      contractId,
      reason: String(formData.get("reason") ?? "").trim() || undefined,
    });
    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "weekly_contract.paused",
      entityType: "weekly_contract",
      entityId: contract.id,
      title: `Weekly contract "${contract.title}" paused`,
      description: null,
    });
    revalidatePath("/weekly-contracts");
    revalidatePath(`/weekly-contracts/${contractId}`);
    revalidatePath("/activity");
    return actionOk({ contractId: contract.id });
  } catch (error) {
    return actionFail(
      error instanceof RepositoryError ? error.message : "Pause failed.",
    );
  }
}

export async function resumeContractAction(
  _prev: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const contractId = String(formData.get("contract_id") ?? "").trim();
  if (!contractId) return actionFail("Missing contract id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const contract = await resumeContract(
      membership.workspace.id,
      contractId,
    );
    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "weekly_contract.activated",
      entityType: "weekly_contract",
      entityId: contract.id,
      title: `Weekly contract "${contract.title}" resumed`,
      description: null,
    });
    revalidatePath("/weekly-contracts");
    revalidatePath(`/weekly-contracts/${contractId}`);
    revalidatePath("/activity");
    return actionOk({ contractId: contract.id });
  } catch (error) {
    return actionFail(
      error instanceof RepositoryError ? error.message : "Resume failed.",
    );
  }
}

export async function revokeContractAction(
  _prev: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const contractId = String(formData.get("contract_id") ?? "").trim();
  if (!contractId) return actionFail("Missing contract id.");
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const contract = await revokeContract({
      workspaceId: membership.workspace.id,
      contractId,
      reason: String(formData.get("reason") ?? "").trim() || undefined,
    });
    await logActivityBestEffort({
      workspaceId: membership.workspace.id,
      eventType: "weekly_contract.revoked",
      entityType: "weekly_contract",
      entityId: contract.id,
      title: `Weekly contract "${contract.title}" revoked`,
      description: null,
    });
    revalidatePath("/weekly-contracts");
    revalidatePath(`/weekly-contracts/${contractId}`);
    revalidatePath("/activity");
    return actionOk({ contractId: contract.id });
  } catch (error) {
    return actionFail(
      error instanceof RepositoryError ? error.message : "Revoke failed.",
    );
  }
}
