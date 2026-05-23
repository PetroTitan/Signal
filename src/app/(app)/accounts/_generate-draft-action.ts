"use server";
/**
 * Phase F4.5 — generateDraftAction.
 *
 * Founder-facing server action invoked from the identity card's
 * "Generate draft" sheet. Loads the publishing identity context,
 * runs generate-draft (which either calls the provider or returns a
 * manual seed), and persists the result into weekly_plan_items as
 * status='draft'. Founder is then redirected into the compose sheet
 * to edit, schedule, and approve.
 *
 * Generated drafts never auto-approve, auto-schedule, or auto-publish.
 *
 * Metadata captured:
 *   generated_by              = 'identity_aware_generation'
 *   identity_id
 *   product_id                = (resolved)
 *   generation_topic
 *   generation_goal
 *   generation_cta
 *   generation_source_url
 *   generation_tone_adjustment
 *   generation_schedule_pref
 *   safety_notes              = [] | [violations]
 *   provider_used             = boolean
 *   requires_founder_review   = true
 */

import { revalidatePath } from "next/cache";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getAccountById } from "@/repositories/account-repository";
import {
  createPlanItem,
  createWeeklyPlan,
  getCurrentWeeklyPlan,
} from "@/repositories/weekly-plan-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { generateDraft } from "@/core/generation/generate-draft";
import type { GenerationInput } from "@/core/generation/generation-types";
import {
  checkWorkspaceAiUsage,
  usageLimitMessage,
} from "@/core/generation/usage-limit";
import { RepositoryError } from "@/repositories/errors";
import {
  actionFail,
  actionOk,
  type ActionResult,
} from "@/lib/forms/action-result";

export type GenerateDraftResult = ActionResult<{
  itemId: string;
  similarityWarning: string | null;
  providerUsed: boolean;
  status:
    | "provider_generated"
    | "manual_seed_created"
    | "provider_unavailable"
    | "provider_refused";
}>;

const MAX_TOPIC_LEN = 500;
const MAX_FREEFORM_LEN = 1000;
const MAX_URL_LEN = 600;

function trimToLen(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function isoMondayUtc(d: Date): string {
  const day = d.getUTCDay() || 7;
  const monday = new Date(d);
  if (day !== 1) monday.setUTCDate(monday.getUTCDate() - (day - 1));
  return monday.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function generateDraftAction(
  _prev: GenerateDraftResult,
  formData: FormData,
): Promise<GenerateDraftResult> {
  const identityId = String(formData.get("identity_id") ?? "").trim();
  const topic = String(formData.get("topic") ?? "").trim();
  if (!identityId) return actionFail("Pick a publishing identity first.");
  if (topic.length === 0)
    return actionFail("Give the draft a topic or idea to start from.");

  const input: GenerationInput = {
    weeklyPlanId: null,
    identityId,
    platform: String(formData.get("platform") ?? "").trim() || null,
    productId: String(formData.get("product_id") ?? "").trim() || null,
    topic: trimToLen(topic, MAX_TOPIC_LEN),
    goal:
      trimToLen(String(formData.get("goal") ?? ""), MAX_FREEFORM_LEN) || null,
    cta:
      trimToLen(String(formData.get("cta") ?? ""), MAX_FREEFORM_LEN) || null,
    sourceUrl:
      trimToLen(String(formData.get("source_url") ?? ""), MAX_URL_LEN) || null,
    toneAdjustment:
      trimToLen(
        String(formData.get("tone_adjustment") ?? ""),
        MAX_FREEFORM_LEN,
      ) || null,
    schedulePreference:
      trimToLen(
        String(formData.get("schedule_preference") ?? ""),
        MAX_FREEFORM_LEN,
      ) || null,
  };

  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) return actionFail("No workspace found.");
    const workspaceId = membership.workspace.id;

    // F4.6.1 — workspace-level rolling 24h limit. Same helper used
    // by the rewrite path. Checked BEFORE calling the provider so
    // we don't burn quota on a request we'd refuse.
    const usage = await checkWorkspaceAiUsage(workspaceId);
    if (usage.exceeded) {
      return actionFail(usageLimitMessage(usage));
    }

    // Verify the identity belongs to this workspace and is usable.
    let identity;
    try {
      identity = await getAccountById(workspaceId, identityId);
    } catch {
      return actionFail("Couldn't find this publishing identity.");
    }
    const effectivePlatform =
      input.platform && input.platform.length > 0
        ? input.platform
        : identity.platform;
    const effectiveProductId =
      input.productId && input.productId.length > 0
        ? input.productId
        : identity.productId;

    // Ensure there's a current weekly plan to attach the draft to.
    // Create one for this week if none exists.
    let plan = await getCurrentWeeklyPlan(workspaceId);
    if (!plan) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const monday = isoMondayUtc(new Date(todayIso));
      const sunday = addDaysIso(monday, 6);
      void sunday;
      plan = await createWeeklyPlan({
        workspaceId,
        title: `Week of ${monday}`,
        weekStart: monday,
      });
    }

    // Run the generator.
    const result = await generateDraft({
      workspaceId,
      generation: {
        ...input,
        platform: effectivePlatform,
        productId: effectiveProductId,
      },
    });

    // Map status onto founder-visible status returned to the UI.
    const friendlyStatus =
      result.status === "provider_generated"
        ? "provider_generated"
        : result.status === "provider_refused"
          ? "provider_refused"
          : result.status === "provider_unavailable"
            ? "provider_unavailable"
            : "manual_seed_created";

    const metadata: Record<string, unknown> = {
      generated_by: "identity_aware_generation",
      identity_id: identityId,
      product_id: effectiveProductId,
      generation_topic: input.topic,
      generation_goal: input.goal,
      generation_cta: input.cta,
      generation_source_url: input.sourceUrl,
      generation_tone_adjustment: input.toneAdjustment,
      generation_schedule_pref: input.schedulePreference,
      generation_provider_used: result.providerUsed,
      generation_status: friendlyStatus,
      safety_notes: result.draft.safetyNotes,
      requires_founder_review: true,
    };
    if (input.sourceUrl) {
      metadata.canonical_url = input.sourceUrl;
    }
    if (result.draft.summary) {
      metadata.summary = result.draft.summary;
    }
    if (result.draft.tags.length > 0) {
      metadata.tags = result.draft.tags;
    }

    const created = await createPlanItem({
      workspaceId,
      weeklyPlanId: plan.id,
      title: result.draft.title,
      body: result.draft.bodyMarkdown,
      platform: effectivePlatform,
      contentType: effectivePlatform === "bluesky" ? "post" : "post",
      productId: effectiveProductId,
      accountId: identity.id,
      // Always lands as draft. The founder reviews + sends for approval.
      status: "draft",
      metadata,
    });

    try {
      await recordActivity({
        workspaceId,
        eventType: "draft.generated",
        entityType: "weekly_plan_item",
        entityId: created.id,
        title: `Draft generated for ${identity.displayName ?? identity.platform}`,
        description: result.providerUsed
          ? "AI-assisted draft created. Founder review required."
          : "Draft seeded (no AI provider connected). Founder review required.",
        metadata: {
          identity_id: identityId,
          platform: effectivePlatform,
          provider_used: result.providerUsed,
          generation_status: friendlyStatus,
        },
      });
    } catch (err) {
      console.error("[generateDraftAction] activity log failed", err);
    }

    revalidatePath("/weekly-plan");
    revalidatePath("/dashboard");
    revalidatePath("/accounts");

    return actionOk({
      itemId: created.id,
      similarityWarning: result.similarityWarning,
      providerUsed: result.providerUsed,
      status: friendlyStatus,
    });
  } catch (error) {
    const message =
      error instanceof RepositoryError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not generate the draft.";
    console.error("[generateDraftAction] failed", error);
    return actionFail(message);
  }
}
