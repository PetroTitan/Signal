/**
 * Phase F2.5 — controlled live-publish policy.
 *
 * The safe-test policy runs the moment an operator clicks "Publish"
 * on the preview screen. It is layered on top of the F1
 * `publishing-policy` (which is itself layered on top of the
 * approval and contract gates) — every previous gate must still
 * pass; this one adds the F2.5-specific guards:
 *
 *   1. SAFE_TEST_MODE=true
 *   2. content_type='post' + platform='reddit'
 *   3. subreddit present + whitelisted
 *   4. operator confirmation phrase matches exactly
 *   5. OAuth connected + healthy + token decryptable
 *   6. rate limit not exceeded (1 / 60min, 3 / 24h)
 *   7. no duplicate fingerprint within 30 days
 *   8. creative readiness from F1
 *   9. account + product confirmed
 *
 * The policy is pure-async (takes a Supabase client) but does no
 * mutations. Callers consume the verdict and act accordingly.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { creativeReadinessReason } from "@/repositories/weekly-plan-creative-repository";
import {
  countPublishesSince,
  findRecentDuplicate,
} from "@/repositories/publish-history-repository";
import { computeFingerprint } from "./publish-fingerprint";
import {
  isSubredditAllowed,
  matchesConfirmationPhrase,
  readAllowedTestSubreddits,
  safeTestModeEnabled,
} from "./safe-test-env";

export type SafeTestReasonCode =
  | "safe_test_mode_disabled"
  | "not_a_post"
  | "wrong_platform"
  | "subreddit_missing"
  | "subreddit_not_whitelisted"
  | "confirmation_phrase_mismatch"
  | "account_not_confirmed"
  | "product_not_confirmed"
  | "creative_missing"
  | "creative_not_ready"
  | "connection_missing"
  | "connection_not_healthy"
  | "token_not_decryptable"
  | "rate_limit_hourly"
  | "rate_limit_daily"
  | "duplicate_within_30_days"
  | "no_active_contract"
  | "missing_schedule"
  | "scheduled_in_future"
  | "internal_error";

export interface SafeTestPolicyVerdict {
  ok: boolean;
  reasonCode: SafeTestReasonCode | null;
  reasonDetail: string | null;
  /** Sub-checks the operator can see in the preview. */
  checks: Array<{ name: string; status: "pass" | "fail" | "warn"; detail: string | null }>;
  /** Computed payload preview the operator approves. */
  preview: PublishPayloadPreview | null;
}

export interface PublishPayloadPreview {
  platform: "reddit";
  subreddit: string;
  title: string;
  body: string | null;
  linkUrl: string | null;
  /** kind=self for text posts, link for URL posts. */
  kind: "self" | "link";
  apiPayload: Record<string, string>;
  fingerprint: string;
  account: { id: string; handle: string | null; displayName: string | null };
  product: { id: string; name: string } | null;
  creative: {
    id: string;
    type: string;
    sourceType: string;
    altText: string | null;
    license: string | null;
    attribution: string | null;
    sourceUrl: string | null;
    assetUrl: string | null;
  } | null;
  scheduledAt: string | null;
}

export interface SafeTestPolicyInput {
  supabase: SupabaseClient;
  workspaceId: string;
  executionItem: {
    id: string;
    accountId: string | null;
    productId: string | null;
    platform: string | null;
    title: string | null;
    body: string | null;
    linkUrl: string | null;
    scheduledAt: string | null;
    actionType: string;
    metadata: Record<string, unknown>;
  };
  /** From the form. Required; an empty string fails. */
  confirmationPhrase: string;
  /** Resolved from form > metadata > product default. Required. */
  subreddit: string | null;
  /** "now" injected for determinism. */
  nowIso: string;
}

const HOURLY_MS = 60 * 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;
const DUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Evaluate every safe-test gate. The verdict's `checks` array is
 * surfaced verbatim in the preview UI, so each `detail` should be
 * operator-readable.
 */
export async function evaluateSafeTestPolicy(
  input: SafeTestPolicyInput,
): Promise<SafeTestPolicyVerdict> {
  const checks: SafeTestPolicyVerdict["checks"] = [];
  const fail = (
    name: string,
    reasonCode: SafeTestReasonCode,
    reasonDetail: string,
  ): SafeTestPolicyVerdict => {
    checks.push({ name, status: "fail", detail: reasonDetail });
    return { ok: false, reasonCode, reasonDetail, checks, preview: null };
  };

  // 1. SAFE_TEST_MODE
  if (!safeTestModeEnabled()) {
    return fail(
      "Safe-test mode",
      "safe_test_mode_disabled",
      "SAFE_TEST_MODE is not 'true'. Controlled publishing is disabled.",
    );
  }
  checks.push({
    name: "Safe-test mode",
    status: "pass",
    detail: "SAFE_TEST_MODE=true",
  });

  const item = input.executionItem;

  // 2. content_type + platform
  if (item.platform !== "reddit") {
    return fail(
      "Platform",
      "wrong_platform",
      `Only Reddit is supported in F2.5 (item.platform='${item.platform ?? "null"}').`,
    );
  }
  if (item.actionType !== "publish_scheduled_post") {
    return fail(
      "Action type",
      "not_a_post",
      `Only scheduled posts publish in F2.5 (action_type='${item.actionType}').`,
    );
  }
  checks.push({
    name: "Platform + action",
    status: "pass",
    detail: "reddit · publish_scheduled_post",
  });

  // 3. subreddit + whitelist
  const subreddit = input.subreddit ? input.subreddit.trim().replace(/^\/?r\//i, "") : null;
  if (!subreddit) {
    return fail(
      "Subreddit",
      "subreddit_missing",
      "No subreddit specified.",
    );
  }
  if (!isSubredditAllowed(subreddit)) {
    const allowed = readAllowedTestSubreddits();
    return fail(
      "Subreddit whitelist",
      "subreddit_not_whitelisted",
      `r/${subreddit} is not in ALLOWED_TEST_SUBREDDITS. Currently allowed: ${
        allowed.length === 0 ? "(none)" : allowed.map((s) => "r/" + s).join(", ")
      }.`,
    );
  }
  checks.push({
    name: "Subreddit whitelist",
    status: "pass",
    detail: `r/${subreddit} allowed`,
  });

  // 4. confirmation phrase
  if (!matchesConfirmationPhrase(input.confirmationPhrase)) {
    return fail(
      "Confirmation phrase",
      "confirmation_phrase_mismatch",
      'Type "publish live reddit post" exactly into the confirmation field.',
    );
  }
  checks.push({
    name: "Confirmation phrase",
    status: "pass",
    detail: "matched",
  });

  // 5. title required (Reddit forces a non-empty title)
  if (!item.title || item.title.trim().length === 0) {
    return fail("Title", "internal_error", "Item has no title.");
  }

  // 6. account confirmed + connected + healthy + token decryptable
  if (!item.accountId) {
    return fail(
      "Account",
      "account_not_confirmed",
      "Item has no account_id.",
    );
  }
  const { data: account } = await input.supabase
    .from("growth_accounts")
    .select("id, handle, display_name, review_status, connection_status")
    .eq("workspace_id", input.workspaceId)
    .eq("id", item.accountId)
    .maybeSingle();
  const acctRow = account as
    | {
        id: string;
        handle: string | null;
        display_name: string | null;
        review_status: string;
        connection_status: string;
      }
    | null;
  if (!acctRow || acctRow.review_status !== "confirmed") {
    return fail(
      "Account confirmed",
      "account_not_confirmed",
      `growth_accounts.review_status must be 'confirmed' (is '${acctRow?.review_status ?? "missing"}').`,
    );
  }
  checks.push({
    name: "Account",
    status: "pass",
    detail: `${acctRow.handle ? "u/" + acctRow.handle : acctRow.display_name ?? acctRow.id} confirmed`,
  });

  // 7. product confirmed (if present)
  let productInfo: { id: string; name: string } | null = null;
  if (item.productId) {
    const { data: product } = await input.supabase
      .from("products")
      .select("id, name, review_status")
      .eq("workspace_id", input.workspaceId)
      .eq("id", item.productId)
      .maybeSingle();
    const prodRow = product as
      | { id: string; name: string; review_status: string }
      | null;
    if (!prodRow || prodRow.review_status !== "confirmed") {
      return fail(
        "Product confirmed",
        "product_not_confirmed",
        `products.review_status must be 'confirmed' (is '${prodRow?.review_status ?? "missing"}').`,
      );
    }
    productInfo = { id: prodRow.id, name: prodRow.name };
    checks.push({
      name: "Product",
      status: "pass",
      detail: `${prodRow.name} confirmed`,
    });
  } else {
    checks.push({
      name: "Product",
      status: "warn",
      detail: "No product attached to item.",
    });
  }

  // 8. active contract
  const { data: contract } = await input.supabase
    .from("weekly_approval_contracts")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (!contract) {
    return fail(
      "Active contract",
      "no_active_contract",
      "No active weekly_approval_contracts row for this workspace.",
    );
  }
  checks.push({
    name: "Active contract",
    status: "pass",
    detail: "active",
  });

  // 9. creative readiness
  const { data: creatives } = await input.supabase
    .from("weekly_plan_item_creatives")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq(
      "weekly_plan_item_id",
      (item.metadata as { plan_item_id?: string })?.plan_item_id ?? "",
    )
    .order("created_at", { ascending: true });
  // Mirror the repository's domain projection.
  const firstRow = (creatives ?? [])[0] ?? null;
  const creative = firstRow
    ? {
        id: firstRow.id,
        workspaceId: firstRow.workspace_id,
        weeklyPlanItemId: firstRow.weekly_plan_item_id,
        creativeType: firstRow.creative_type,
        sourceType: firstRow.source_type,
        sourceUrl: firstRow.source_url,
        assetUrl: firstRow.asset_url,
        prompt: firstRow.prompt,
        altText: firstRow.alt_text,
        license: firstRow.license,
        attribution: firstRow.attribution,
        riskNotes: firstRow.risk_notes,
        status: firstRow.status,
        storagePath: firstRow.storage_path ?? null,
        mimeType: firstRow.mime_type ?? null,
        sizeBytes: firstRow.size_bytes ?? null,
        uploadedBy: firstRow.uploaded_by ?? null,
        uploadedAt: firstRow.uploaded_at ?? null,
        metadata: firstRow.metadata,
        createdAt: firstRow.created_at,
        updatedAt: firstRow.updated_at,
      }
    : null;
  const creativeReason = creativeReadinessReason(creative);
  if (creativeReason) {
    return fail(
      "Creative",
      creativeReason === "creative_missing"
        ? "creative_missing"
        : "creative_not_ready",
      `Creative gate failed: ${creativeReason.replace(/_/g, " ")}.`,
    );
  }
  checks.push({
    name: "Creative",
    status: "pass",
    detail: `${creative!.creativeType} · ${creative!.sourceType}`,
  });

  // 10. OAuth connection + health + decryptable token
  const { data: conn } = await input.supabase
    .from("platform_connections")
    .select(
      "id, connection_status, health_status, access_token_encrypted, expires_at",
    )
    .eq("workspace_id", input.workspaceId)
    .eq("account_id", item.accountId)
    .eq("platform", "reddit")
    .maybeSingle();
  const connRow = conn as
    | {
        id: string;
        connection_status: string;
        health_status: string;
        access_token_encrypted: string | null;
        expires_at: string | null;
      }
    | null;
  if (!connRow) {
    return fail(
      "OAuth connection",
      "connection_missing",
      "No platform_connections row for this account.",
    );
  }
  if (connRow.connection_status !== "connected") {
    return fail(
      "OAuth connection",
      "connection_missing",
      `Connection status is '${connRow.connection_status}', not 'connected'.`,
    );
  }
  if (connRow.health_status !== "healthy") {
    return fail(
      "OAuth health",
      "connection_not_healthy",
      `Health status is '${connRow.health_status}', not 'healthy'. Re-run health check or reauthorize.`,
    );
  }
  if (!connRow.access_token_encrypted) {
    return fail(
      "OAuth token",
      "token_not_decryptable",
      "No stored encrypted access token.",
    );
  }
  const { decryptForOutboundUse } = await import("@/core/platform-oauth");
  const plain = decryptForOutboundUse(connRow.access_token_encrypted);
  if (!plain) {
    return fail(
      "OAuth token",
      "token_not_decryptable",
      "Stored token failed to decrypt under the current TOKEN_ENCRYPTION_KEY.",
    );
  }
  checks.push({
    name: "OAuth",
    status: "pass",
    detail: "connected · healthy · token decryptable",
  });

  // 11. scheduled time
  if (!item.scheduledAt) {
    return fail(
      "Schedule",
      "missing_schedule",
      "Item has no scheduled_at.",
    );
  }
  const scheduledMs = new Date(item.scheduledAt).getTime();
  const nowMs = new Date(input.nowIso).getTime();
  if (scheduledMs > nowMs) {
    return fail(
      "Schedule",
      "scheduled_in_future",
      `Scheduled for ${item.scheduledAt}; wait until then.`,
    );
  }
  checks.push({
    name: "Schedule",
    status: "pass",
    detail: `scheduled at ${item.scheduledAt}`,
  });

  // 12. rate limits
  const sinceHourly = new Date(nowMs - HOURLY_MS).toISOString();
  const sinceDaily = new Date(nowMs - DAILY_MS).toISOString();
  const sinceDup = new Date(nowMs - DUP_WINDOW_MS).toISOString();
  const [hourly, daily] = await Promise.all([
    countPublishesSince(input.workspaceId, sinceHourly),
    countPublishesSince(input.workspaceId, sinceDaily),
  ]);
  if (hourly >= 1) {
    return fail(
      "Rate limit (1/hour)",
      "rate_limit_hourly",
      `${hourly} publish(es) in the last 60 minutes. Wait at least an hour.`,
    );
  }
  if (daily >= 3) {
    return fail(
      "Rate limit (3/day)",
      "rate_limit_daily",
      `${daily} publish(es) in the last 24 hours.`,
    );
  }
  checks.push({
    name: "Rate limits",
    status: "pass",
    detail: `${hourly}/hour, ${daily}/day used`,
  });

  // 13. duplicate fingerprint
  const fp = await computeFingerprint({
    platform: "reddit",
    subreddit,
    title: item.title,
    body: item.body,
    linkUrl: item.linkUrl,
  });
  const dup = await findRecentDuplicate({
    workspaceId: input.workspaceId,
    fingerprint: fp.fingerprint,
    sinceIso: sinceDup,
  });
  if (dup) {
    return fail(
      "Duplicate content",
      "duplicate_within_30_days",
      `Same content was published on ${dup.finishedAt} (permalink: ${dup.providerPermalink ?? "n/a"}).`,
    );
  }
  checks.push({
    name: "Duplicate check (30d)",
    status: "pass",
    detail: "no recent duplicate",
  });

  // ── build the preview payload
  const isLink = Boolean(item.linkUrl && !item.body);
  const apiPayload: Record<string, string> = {
    sr: subreddit,
    title: item.title,
    api_type: "json",
    sendreplies: "false",
    kind: isLink ? "link" : "self",
  };
  if (isLink) {
    apiPayload.url = item.linkUrl!;
  } else if (item.body) {
    apiPayload.text = item.body;
  } else {
    apiPayload.text = "";
  }

  const preview: PublishPayloadPreview = {
    platform: "reddit",
    subreddit,
    title: item.title,
    body: item.body,
    linkUrl: item.linkUrl,
    kind: isLink ? "link" : "self",
    apiPayload,
    fingerprint: fp.fingerprint,
    account: {
      id: acctRow.id,
      handle: acctRow.handle,
      displayName: acctRow.display_name,
    },
    product: productInfo,
    creative: creative
      ? {
          id: creative.id,
          type: creative.creativeType,
          sourceType: creative.sourceType,
          altText: creative.altText,
          license: creative.license,
          attribution: creative.attribution,
          sourceUrl: creative.sourceUrl,
          assetUrl: creative.assetUrl,
        }
      : null,
    scheduledAt: item.scheduledAt,
  };

  return {
    ok: true,
    reasonCode: null,
    reasonDetail: null,
    checks,
    preview,
  };
}
