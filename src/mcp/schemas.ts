/**
 * Phase F0 — lightweight input validators for MCP tool arguments.
 *
 * We deliberately avoid a third-party dependency: each tool gets a
 * narrow `parse*` function that returns `{ ok: true, value }` or
 * `{ ok: false, errors }`. The dispatcher converts a fail into an
 * `invalid_arguments` response.
 */

import {
  FOUNDER_PLATFORMS,
  type FounderPlatform,
} from "@/core/publishing/platform-guidance";

type ParseOk<T> = { ok: true; value: T };
type ParseFail = { ok: false; errors: string[] };
export type Parse<T> = ParseOk<T> | ParseFail;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(value: unknown): value is string {
  return typeof value === "string";
}

function isUuidLike(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    s,
  );
}

export function parseEmptyArgs(input: unknown): Parse<Record<string, never>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (isObject(input) && Object.keys(input).length === 0) {
    return { ok: true, value: {} };
  }
  return { ok: false, errors: ["expected_empty_args"] };
}

export interface ProductsPrepareArgs {
  name: string;
  domain?: string | null;
  category?: string | null;
  summary?: string | null;
  source_note?: string | null;
}
export function parseProductsPrepare(input: unknown): Parse<ProductsPrepareArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.name) || input.name.trim().length === 0)
    errors.push("name_required");
  if (input.domain !== undefined && input.domain !== null && !str(input.domain))
    errors.push("domain_must_be_string");
  if (input.category !== undefined && input.category !== null && !str(input.category))
    errors.push("category_must_be_string");
  if (input.summary !== undefined && input.summary !== null && !str(input.summary))
    errors.push("summary_must_be_string");
  if (input.source_note !== undefined && input.source_note !== null && !str(input.source_note))
    errors.push("source_note_must_be_string");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: (input.name as string).trim(),
      domain: input.domain ? String(input.domain).trim() : null,
      category: input.category ? String(input.category).trim() : null,
      summary: input.summary ? String(input.summary).trim() : null,
      source_note: input.source_note ? String(input.source_note).trim() : null,
    },
  };
}

// Voice profile must match the UI's textarea limit so MCP-created
// identities can never carry a longer profile than the operator could
// type in /accounts.
export const VOICE_PROFILE_MAX_CHARS = 1500;

// The MCP allowlist is derived from the founder-UI list so the two
// surfaces can never drift. Adding a platform to the UI automatically
// makes it valid here.
export const ACCOUNTS_PREPARE_PLATFORMS: ReadonlyArray<FounderPlatform> =
  FOUNDER_PLATFORMS;

export type AccountsPrepareReviewHint = "pending_review" | "confirmed";

export interface AccountsPrepareArgs {
  platform: FounderPlatform;
  display_name: string;
  handle?: string | null;
  product_id?: string | null;
  source_note?: string | null;
  voice_profile?: string | null;
  // Optional. When omitted, the handler keeps the safe default
  // (`pending_review`). Operator-driven seeding can pass `confirmed`
  // to skip the review gate; the handler still requires an
  // authenticated operator token + the tool's existing approval mode.
  review_status?: AccountsPrepareReviewHint;
}
export function parseAccountsPrepare(input: unknown): Parse<AccountsPrepareArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.platform)) errors.push("platform_required");
  else if (!ACCOUNTS_PREPARE_PLATFORMS.includes(input.platform as FounderPlatform))
    errors.push("platform_unsupported");
  if (!str(input.display_name) || input.display_name.trim().length === 0)
    errors.push("display_name_required");
  if (input.handle !== undefined && input.handle !== null && !str(input.handle))
    errors.push("handle_must_be_string");
  if (input.product_id !== undefined && input.product_id !== null) {
    if (!str(input.product_id) || !isUuidLike(input.product_id))
      errors.push("product_id_invalid");
  }
  if (input.source_note !== undefined && input.source_note !== null && !str(input.source_note))
    errors.push("source_note_must_be_string");
  if (input.voice_profile !== undefined && input.voice_profile !== null) {
    if (!str(input.voice_profile)) {
      errors.push("voice_profile_must_be_string");
    } else if (input.voice_profile.length > VOICE_PROFILE_MAX_CHARS) {
      errors.push("voice_profile_too_long");
    }
  }
  if (input.review_status !== undefined && input.review_status !== null) {
    if (!str(input.review_status)) {
      errors.push("review_status_must_be_string");
    } else if (
      input.review_status !== "pending_review" &&
      input.review_status !== "confirmed"
    ) {
      errors.push("review_status_unsupported");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  // The parser preserves `undefined` for absent optional fields and
  // converts explicit-null/explicit-empty inputs to `null`. The
  // handler relies on this distinction: undefined means "leave
  // existing value untouched on UPDATE", null means "clear it".
  const value: AccountsPrepareArgs = {
    platform: input.platform as FounderPlatform,
    display_name: (input.display_name as string).trim(),
  };
  if (input.handle !== undefined) {
    value.handle = input.handle === null ? null : String(input.handle).trim();
  }
  if (input.product_id !== undefined) {
    value.product_id =
      input.product_id === null ? null : String(input.product_id);
  }
  if (input.source_note !== undefined) {
    value.source_note =
      input.source_note === null ? null : String(input.source_note).trim();
  }
  if (input.voice_profile !== undefined) {
    if (input.voice_profile === null) {
      value.voice_profile = null;
    } else {
      const trimmed = String(input.voice_profile).trim();
      value.voice_profile = trimmed.length > 0 ? trimmed : null;
    }
  }
  if (input.review_status !== undefined) {
    value.review_status = input.review_status as AccountsPrepareReviewHint;
  }
  return { ok: true, value };
}

export interface WeeklyPlanPrepareItemArgs {
  product_id?: string | null;
  account_id?: string | null;
  platform?: string | null;
  title: string;
  body?: string | null;
  content_type?: string | null;
  scheduled_at?: string | null;
  timezone?: string | null;
  risk_score?: number | null;
  /**
   * Default false → item lands as `pending_approval` and shows up in
   * /approval-queue. Pass `true` to keep it as `draft` (private holding
   * pen that doesn't appear in the approval queue).
   */
  save_as_draft?: boolean;
  // Phase F1 — creative plan attached to the item on creation.
  creative_required?: boolean;
  creative_type?: string | null;
  creative_source_type?: string | null;
  creative_prompt?: string | null;
  creative_source_url?: string | null;
  creative_asset_url?: string | null;
  creative_alt_text?: string | null;
  creative_license?: string | null;
  creative_attribution?: string | null;
  creative_risk_notes?: string | null;
}

const CREATIVE_TYPES = new Set(["image", "video", "animation"]);
const CREATIVE_SOURCE_TYPES = new Set([
  "generated",
  "uploaded",
  "wikimedia",
  "official_source",
  "manual_url",
  "planned",
]);
export function parseWeeklyPlanPrepareItem(
  input: unknown,
): Parse<WeeklyPlanPrepareItemArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.title) || input.title.trim().length === 0)
    errors.push("title_required");
  if (input.product_id !== undefined && input.product_id !== null) {
    if (!str(input.product_id) || !isUuidLike(input.product_id))
      errors.push("product_id_invalid");
  }
  if (input.account_id !== undefined && input.account_id !== null) {
    if (!str(input.account_id) || !isUuidLike(input.account_id))
      errors.push("account_id_invalid");
  }
  if (input.risk_score !== undefined && input.risk_score !== null) {
    if (typeof input.risk_score !== "number" || input.risk_score < 0 || input.risk_score > 100)
      errors.push("risk_score_out_of_range");
  }
  if (
    input.save_as_draft !== undefined &&
    input.save_as_draft !== null &&
    typeof input.save_as_draft !== "boolean"
  ) {
    errors.push("save_as_draft_must_be_boolean");
  }
  if (
    input.creative_required !== undefined &&
    input.creative_required !== null &&
    typeof input.creative_required !== "boolean"
  ) {
    errors.push("creative_required_must_be_boolean");
  }
  if (
    input.creative_type !== undefined &&
    input.creative_type !== null &&
    (!str(input.creative_type) ||
      !CREATIVE_TYPES.has(input.creative_type as string))
  ) {
    errors.push("creative_type_invalid");
  }
  if (
    input.creative_source_type !== undefined &&
    input.creative_source_type !== null &&
    (!str(input.creative_source_type) ||
      !CREATIVE_SOURCE_TYPES.has(input.creative_source_type as string))
  ) {
    errors.push("creative_source_type_invalid");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      product_id: input.product_id ? String(input.product_id) : null,
      account_id: input.account_id ? String(input.account_id) : null,
      platform: input.platform ? String(input.platform) : null,
      title: (input.title as string).trim(),
      body: input.body ? String(input.body) : null,
      content_type: input.content_type ? String(input.content_type) : null,
      scheduled_at: input.scheduled_at ? String(input.scheduled_at) : null,
      timezone: input.timezone ? String(input.timezone) : null,
      risk_score:
        typeof input.risk_score === "number" ? input.risk_score : null,
      save_as_draft:
        typeof input.save_as_draft === "boolean" ? input.save_as_draft : false,
      creative_required:
        typeof input.creative_required === "boolean"
          ? input.creative_required
          : undefined,
      creative_type: input.creative_type
        ? String(input.creative_type).trim()
        : null,
      creative_source_type: input.creative_source_type
        ? String(input.creative_source_type).trim()
        : null,
      creative_prompt: input.creative_prompt
        ? String(input.creative_prompt)
        : null,
      creative_source_url: input.creative_source_url
        ? String(input.creative_source_url).trim()
        : null,
      creative_asset_url: input.creative_asset_url
        ? String(input.creative_asset_url).trim()
        : null,
      creative_alt_text: input.creative_alt_text
        ? String(input.creative_alt_text)
        : null,
      creative_license: input.creative_license
        ? String(input.creative_license)
        : null,
      creative_attribution: input.creative_attribution
        ? String(input.creative_attribution)
        : null,
      creative_risk_notes: input.creative_risk_notes
        ? String(input.creative_risk_notes)
        : null,
    },
  };
}

export interface WeeklyPlanAttachCreativeArgs {
  weekly_plan_item_id: string;
  creative_type: "image" | "video" | "animation";
  source_type:
    | "generated"
    | "uploaded"
    | "wikimedia"
    | "official_source"
    | "manual_url"
    | "planned";
  source_url?: string | null;
  asset_url?: string | null;
  prompt?: string | null;
  alt_text?: string | null;
  license?: string | null;
  attribution?: string | null;
  risk_notes?: string | null;
}

export function parseWeeklyPlanAttachCreative(
  input: unknown,
): Parse<WeeklyPlanAttachCreativeArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.weekly_plan_item_id) || !isUuidLike(input.weekly_plan_item_id))
    errors.push("weekly_plan_item_id_invalid");
  if (!str(input.creative_type) || !CREATIVE_TYPES.has(input.creative_type))
    errors.push("creative_type_invalid");
  if (
    !str(input.source_type) ||
    !CREATIVE_SOURCE_TYPES.has(input.source_type)
  )
    errors.push("source_type_invalid");

  if (input.source_type === "wikimedia" || input.source_type === "manual_url") {
    if (!str(input.source_url) || (input.source_url as string).trim().length === 0)
      errors.push("source_url_required_for_external_source");
  }
  if (input.source_type === "generated") {
    if (!str(input.prompt) || (input.prompt as string).trim().length === 0)
      errors.push("prompt_required_for_generated");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      weekly_plan_item_id: input.weekly_plan_item_id as string,
      creative_type: input.creative_type as WeeklyPlanAttachCreativeArgs["creative_type"],
      source_type: input.source_type as WeeklyPlanAttachCreativeArgs["source_type"],
      source_url: input.source_url ? String(input.source_url).trim() : null,
      asset_url: input.asset_url ? String(input.asset_url).trim() : null,
      prompt: input.prompt ? String(input.prompt) : null,
      alt_text: input.alt_text ? String(input.alt_text) : null,
      license: input.license ? String(input.license) : null,
      attribution: input.attribution ? String(input.attribution) : null,
      risk_notes: input.risk_notes ? String(input.risk_notes) : null,
    },
  };
}

export interface ImportsPrepareMappingArgs {
  import_type: "product" | "account";
  raw_text: string;
  extracted_fields?: Record<string, unknown>;
  confidence?: number | null;
  warnings?: string[];
}
export function parseImportsPrepareMapping(
  input: unknown,
): Parse<ImportsPrepareMappingArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (input.import_type !== "product" && input.import_type !== "account")
    errors.push("import_type_invalid");
  if (!str(input.raw_text) || input.raw_text.trim().length === 0)
    errors.push("raw_text_required");
  if (input.extracted_fields !== undefined && !isObject(input.extracted_fields))
    errors.push("extracted_fields_must_be_object");
  if (input.confidence !== undefined && input.confidence !== null) {
    if (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)
      errors.push("confidence_out_of_range");
  }
  if (input.warnings !== undefined) {
    if (!Array.isArray(input.warnings) || !input.warnings.every(str))
      errors.push("warnings_must_be_string_array");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      import_type: input.import_type as "product" | "account",
      raw_text: (input.raw_text as string).trim(),
      extracted_fields: isObject(input.extracted_fields)
        ? input.extracted_fields
        : {},
      confidence:
        typeof input.confidence === "number" ? input.confidence : null,
      warnings: Array.isArray(input.warnings)
        ? (input.warnings as string[])
        : [],
    },
  };
}

export interface ReportsSubmitArgs {
  report_type: string;
  summary: string;
  checks?: Array<{ name: string; status: "pass" | "warning" | "fail"; details?: string[] }>;
  recommended_next_action?: string | null;
}
export function parseReportsSubmit(input: unknown): Parse<ReportsSubmitArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.report_type)) errors.push("report_type_required");
  if (!str(input.summary) || input.summary.trim().length === 0)
    errors.push("summary_required");
  let checks: ReportsSubmitArgs["checks"] = [];
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) {
      errors.push("checks_must_be_array");
    } else {
      checks = [];
      for (let i = 0; i < input.checks.length; i++) {
        const c = input.checks[i];
        if (!isObject(c) || !str(c.name)) {
          errors.push(`checks[${i}]_invalid`);
          continue;
        }
        if (!str(c.status) || !["pass", "warning", "fail"].includes(c.status)) {
          errors.push(`checks[${i}]_invalid_status`);
          continue;
        }
        let details: string[] | undefined;
        if (c.details !== undefined) {
          if (!Array.isArray(c.details) || !c.details.every(str)) {
            errors.push(`checks[${i}]_invalid_details`);
            continue;
          }
          details = c.details as string[];
        }
        checks.push({
          name: c.name,
          status: c.status as "pass" | "warning" | "fail",
          details,
        });
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      report_type: (input.report_type as string).trim(),
      summary: (input.summary as string).trim(),
      checks,
      recommended_next_action: input.recommended_next_action
        ? String(input.recommended_next_action)
        : null,
    },
  };
}

export interface VerificationRunCheckArgs {
  check_name: string;
}
export function parseVerificationRunCheck(
  input: unknown,
): Parse<VerificationRunCheckArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  if (!str(input.check_name))
    return { ok: false, errors: ["check_name_required"] };
  return { ok: true, value: { check_name: input.check_name } };
}

export interface ExecutionDryRunArgs {
  queue_id?: string | null;
  item_id?: string | null;
}
export function parseExecutionDryRun(input: unknown): Parse<ExecutionDryRunArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  const hasQueue = input.queue_id !== undefined && input.queue_id !== null;
  const hasItem = input.item_id !== undefined && input.item_id !== null;
  if (!hasQueue && !hasItem)
    errors.push("queue_id_or_item_id_required");
  if (hasQueue && (!str(input.queue_id) || !isUuidLike(input.queue_id as string)))
    errors.push("queue_id_invalid");
  if (hasItem && (!str(input.item_id) || !isUuidLike(input.item_id as string)))
    errors.push("item_id_invalid");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      queue_id: hasQueue ? String(input.queue_id) : null,
      item_id: hasItem ? String(input.item_id) : null,
    },
  };
}

export interface ExecutionPublishPreviewArgs {
  execution_item_id: string;
  /** Optional override; defaults to ALLOWED_TEST_SUBREDDITS[0]. */
  subreddit?: string | null;
}
export function parseExecutionPublishPreview(
  input: unknown,
): Parse<ExecutionPublishPreviewArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  if (!str(input.execution_item_id) || !isUuidLike(input.execution_item_id))
    return { ok: false, errors: ["execution_item_id_invalid"] };
  return {
    ok: true,
    value: {
      execution_item_id: input.execution_item_id,
      subreddit: input.subreddit ? String(input.subreddit).trim() : null,
    },
  };
}

export interface ExecutionManualPublishPreviewArgs {
  execution_item_id: string;
  subreddit?: string | null;
}
export function parseExecutionManualPublishPreview(
  input: unknown,
): Parse<ExecutionManualPublishPreviewArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  if (!str(input.execution_item_id) || !isUuidLike(input.execution_item_id))
    return { ok: false, errors: ["execution_item_id_invalid"] };
  return {
    ok: true,
    value: {
      execution_item_id: input.execution_item_id,
      subreddit: input.subreddit ? String(input.subreddit).trim() : null,
    },
  };
}

export interface ExecutionRecordManualPublishArgs {
  execution_item_id: string;
  permalink: string;
  provider_post_id?: string | null;
  notes?: string | null;
}
export function parseExecutionRecordManualPublish(
  input: unknown,
): Parse<ExecutionRecordManualPublishArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.execution_item_id) || !isUuidLike(input.execution_item_id))
    errors.push("execution_item_id_invalid");
  if (!str(input.permalink) || (input.permalink as string).trim().length === 0)
    errors.push("permalink_required");
  if (
    input.provider_post_id !== undefined &&
    input.provider_post_id !== null &&
    !str(input.provider_post_id)
  )
    errors.push("provider_post_id_must_be_string");
  if (input.notes !== undefined && input.notes !== null && !str(input.notes))
    errors.push("notes_must_be_string");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      execution_item_id: input.execution_item_id as string,
      permalink: (input.permalink as string).trim(),
      provider_post_id: input.provider_post_id
        ? String(input.provider_post_id)
        : null,
      notes: input.notes ? String(input.notes) : null,
    },
  };
}

export interface ExecutionAuthorizeItemArgs {
  execution_item_id: string;
}
export function parseExecutionAuthorizeItem(
  input: unknown,
): Parse<ExecutionAuthorizeItemArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  if (!str(input.execution_item_id) || !isUuidLike(input.execution_item_id))
    return { ok: false, errors: ["execution_item_id_invalid"] };
  return { ok: true, value: { execution_item_id: input.execution_item_id } };
}

// =====================================================================
// Planning tools — generation + identity management
// =====================================================================
//
// These tools let Claude prepare drafts, weekly plans, and multi-week
// plans through the same internal services the compose UI uses. They
// never publish — every output lands in draft/pending_review state.
//
// Generation caps enforced in the parsers so over-budget calls fail
// fast with a clear error instead of producing partial state.

export const GENERATE_DRAFT_TOPIC_MAX = 500;
export const GENERATE_DRAFT_FREEFORM_MAX = 1000;
export const GENERATE_DRAFT_URL_MAX = 600;

export const WEEKLY_PLAN_MAX_ITEMS = 12;
export const MULTIWEEK_MAX_WEEKS = 4;
export const MULTIWEEK_MAX_TOTAL_ITEMS = 40;

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function trimTo(value: unknown, max: number): string | null {
  if (!str(value)) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

// ── signal.generate_draft ─────────────────────────────────────────

export interface GenerateDraftArgs {
  identity_id: string;
  topic: string;
  goal: string | null;
  cta: string | null;
  source_url: string | null;
  tone_adjustment: string | null;
  schedule_preference: string | null;
  week_start: string | null;
}

export function parseGenerateDraft(
  input: unknown,
): Parse<GenerateDraftArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.identity_id) || !isUuidLike(input.identity_id))
    errors.push("identity_id_invalid");
  const topic = trimTo(input.topic, GENERATE_DRAFT_TOPIC_MAX);
  if (!topic) errors.push("topic_required");
  if (input.week_start !== undefined && input.week_start !== null) {
    if (!str(input.week_start) || !isIsoDate(input.week_start))
      errors.push("week_start_invalid");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      identity_id: input.identity_id as string,
      topic: topic as string,
      goal: trimTo(input.goal, GENERATE_DRAFT_FREEFORM_MAX),
      cta: trimTo(input.cta, GENERATE_DRAFT_FREEFORM_MAX),
      source_url: trimTo(input.source_url, GENERATE_DRAFT_URL_MAX),
      tone_adjustment: trimTo(input.tone_adjustment, GENERATE_DRAFT_FREEFORM_MAX),
      schedule_preference: trimTo(
        input.schedule_preference,
        GENERATE_DRAFT_FREEFORM_MAX,
      ),
      week_start:
        input.week_start === undefined || input.week_start === null
          ? null
          : (input.week_start as string),
    },
  };
}

// ── signal.generate_weekly_plan ───────────────────────────────────

export interface WeeklyPlanTopic {
  topic: string;
  goal: string | null;
  cta: string | null;
  source_url: string | null;
}

export interface GenerateWeeklyPlanArgs {
  product_id: string;
  week_start: string;
  identity_ids: ReadonlyArray<string>;
  topics: ReadonlyArray<WeeklyPlanTopic>;
  strategic_theme: string | null;
  max_posts_per_platform: number | null;
  include_media_briefs: boolean;
}

export function parseGenerateWeeklyPlan(
  input: unknown,
): Parse<GenerateWeeklyPlanArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.product_id) || !isUuidLike(input.product_id))
    errors.push("product_id_invalid");
  if (!str(input.week_start) || !isIsoDate(input.week_start))
    errors.push("week_start_invalid");

  // Identities are required — the MVP does not auto-pick identities
  // for a product. Caller passes the exact set.
  const identityIds: string[] = [];
  if (!Array.isArray(input.identity_ids)) {
    errors.push("identity_ids_required");
  } else if (input.identity_ids.length === 0) {
    errors.push("identity_ids_empty");
  } else {
    for (const id of input.identity_ids) {
      if (!str(id) || !isUuidLike(id)) {
        errors.push("identity_id_invalid_in_list");
        break;
      }
      identityIds.push(id);
    }
  }

  // Topics: list of canonical ideas. Each topic fans out to each
  // identity, producing |identities| × |topics| items, capped.
  const topics: WeeklyPlanTopic[] = [];
  if (!Array.isArray(input.topics)) {
    errors.push("topics_required");
  } else if (input.topics.length === 0) {
    errors.push("topics_empty");
  } else {
    for (const raw of input.topics) {
      if (!isObject(raw)) {
        errors.push("topics_item_must_be_object");
        break;
      }
      const t = trimTo(raw.topic, GENERATE_DRAFT_TOPIC_MAX);
      if (!t) {
        errors.push("topics_item_topic_required");
        break;
      }
      topics.push({
        topic: t,
        goal: trimTo(raw.goal, GENERATE_DRAFT_FREEFORM_MAX),
        cta: trimTo(raw.cta, GENERATE_DRAFT_FREEFORM_MAX),
        source_url: trimTo(raw.source_url, GENERATE_DRAFT_URL_MAX),
      });
    }
  }

  const totalItems = identityIds.length * topics.length;
  if (totalItems > WEEKLY_PLAN_MAX_ITEMS) {
    errors.push(
      `cap_exceeded:max_${WEEKLY_PLAN_MAX_ITEMS}_items_per_weekly_plan_got_${totalItems}`,
    );
  }

  let maxPostsPerPlatform: number | null = null;
  if (input.max_posts_per_platform !== undefined && input.max_posts_per_platform !== null) {
    if (
      typeof input.max_posts_per_platform !== "number" ||
      !Number.isFinite(input.max_posts_per_platform) ||
      input.max_posts_per_platform <= 0
    ) {
      errors.push("max_posts_per_platform_invalid");
    } else {
      maxPostsPerPlatform = Math.floor(input.max_posts_per_platform);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      product_id: input.product_id as string,
      week_start: input.week_start as string,
      identity_ids: identityIds,
      topics,
      strategic_theme: trimTo(input.strategic_theme, GENERATE_DRAFT_FREEFORM_MAX),
      max_posts_per_platform: maxPostsPerPlatform,
      include_media_briefs: input.include_media_briefs !== false,
    },
  };
}

// ── signal.generate_multiweek_plan ────────────────────────────────

export interface GenerateMultiweekPlanArgs {
  product_id: string;
  start_date: string;
  number_of_weeks: number;
  identity_ids: ReadonlyArray<string>;
  topics_per_week: ReadonlyArray<WeeklyPlanTopic>;
  strategic_theme: string;
  max_posts_per_week: number | null;
  approval_mode: "operator_review_required";
}

export function parseGenerateMultiweekPlan(
  input: unknown,
): Parse<GenerateMultiweekPlanArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.product_id) || !isUuidLike(input.product_id))
    errors.push("product_id_invalid");
  if (!str(input.start_date) || !isIsoDate(input.start_date))
    errors.push("start_date_invalid");

  let numWeeks = 0;
  if (
    typeof input.number_of_weeks !== "number" ||
    !Number.isFinite(input.number_of_weeks) ||
    input.number_of_weeks <= 0
  ) {
    errors.push("number_of_weeks_invalid");
  } else if (input.number_of_weeks > MULTIWEEK_MAX_WEEKS) {
    errors.push(
      `cap_exceeded:max_${MULTIWEEK_MAX_WEEKS}_weeks_per_call_got_${input.number_of_weeks}`,
    );
  } else {
    numWeeks = Math.floor(input.number_of_weeks);
  }

  const identityIds: string[] = [];
  if (!Array.isArray(input.identity_ids)) {
    errors.push("identity_ids_required");
  } else if (input.identity_ids.length === 0) {
    errors.push("identity_ids_empty");
  } else {
    for (const id of input.identity_ids) {
      if (!str(id) || !isUuidLike(id)) {
        errors.push("identity_id_invalid_in_list");
        break;
      }
      identityIds.push(id);
    }
  }

  const topicsPerWeek: WeeklyPlanTopic[] = [];
  if (!Array.isArray(input.topics_per_week)) {
    errors.push("topics_per_week_required");
  } else if (input.topics_per_week.length === 0) {
    errors.push("topics_per_week_empty");
  } else {
    for (const raw of input.topics_per_week) {
      if (!isObject(raw)) {
        errors.push("topics_per_week_item_must_be_object");
        break;
      }
      const t = trimTo(raw.topic, GENERATE_DRAFT_TOPIC_MAX);
      if (!t) {
        errors.push("topics_per_week_topic_required");
        break;
      }
      topicsPerWeek.push({
        topic: t,
        goal: trimTo(raw.goal, GENERATE_DRAFT_FREEFORM_MAX),
        cta: trimTo(raw.cta, GENERATE_DRAFT_FREEFORM_MAX),
        source_url: trimTo(raw.source_url, GENERATE_DRAFT_URL_MAX),
      });
    }
  }

  const strategicTheme = trimTo(input.strategic_theme, GENERATE_DRAFT_FREEFORM_MAX);
  if (!strategicTheme) errors.push("strategic_theme_required");

  if (input.approval_mode !== "operator_review_required") {
    errors.push("approval_mode_must_be_operator_review_required");
  }

  const totalItems = identityIds.length * topicsPerWeek.length * numWeeks;
  if (totalItems > MULTIWEEK_MAX_TOTAL_ITEMS) {
    errors.push(
      `cap_exceeded:max_${MULTIWEEK_MAX_TOTAL_ITEMS}_items_per_call_got_${totalItems}`,
    );
  }

  let maxPostsPerWeek: number | null = null;
  if (input.max_posts_per_week !== undefined && input.max_posts_per_week !== null) {
    if (
      typeof input.max_posts_per_week !== "number" ||
      !Number.isFinite(input.max_posts_per_week) ||
      input.max_posts_per_week <= 0
    ) {
      errors.push("max_posts_per_week_invalid");
    } else {
      maxPostsPerWeek = Math.floor(input.max_posts_per_week);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      product_id: input.product_id as string,
      start_date: input.start_date as string,
      number_of_weeks: numWeeks,
      identity_ids: identityIds,
      topics_per_week: topicsPerWeek,
      strategic_theme: strategicTheme as string,
      max_posts_per_week: maxPostsPerWeek,
      approval_mode: "operator_review_required",
    },
  };
}

// ── signal.schedule_publish ───────────────────────────────────────
//
// Minimum lead time between the API call and the requested
// publish time. The Vercel cron tick interval is 5 minutes; a
// 2-minute floor gives the scheduler enough headroom that the
// scheduled timestamp is always in the past by the next tick.

export const SCHEDULE_MIN_LEAD_MS = 2 * 60 * 1000;

export interface SchedulePublishArgs {
  plan_item_id: string;
  scheduled_at: string;
  confirm_schedule: true;
}

export function parseSchedulePublish(
  input: unknown,
): Parse<SchedulePublishArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.plan_item_id) || !isUuidLike(input.plan_item_id))
    errors.push("plan_item_id_invalid");
  if (!str(input.scheduled_at)) {
    errors.push("scheduled_at_required");
  } else {
    const t = Date.parse(input.scheduled_at);
    if (Number.isNaN(t)) errors.push("scheduled_at_invalid");
    else if (t - Date.now() < SCHEDULE_MIN_LEAD_MS)
      errors.push("scheduled_at_too_soon");
  }
  if (input.confirm_schedule !== true) {
    errors.push("confirm_schedule_must_be_true");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      plan_item_id: input.plan_item_id as string,
      scheduled_at: new Date(input.scheduled_at as string).toISOString(),
      confirm_schedule: true,
    },
  };
}

// ── signal.identities.update ──────────────────────────────────────

export interface IdentitiesUpdateArgs {
  identity_id: string;
  display_name?: string;
  handle?: string | null;
  product_id?: string | null;
  voice_profile?: string | null;
  source_note?: string | null;
}

export function parseIdentitiesUpdate(
  input: unknown,
): Parse<IdentitiesUpdateArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.identity_id) || !isUuidLike(input.identity_id))
    errors.push("identity_id_invalid");

  // At least one updatable field must be present so we don't waste a
  // database round-trip on a no-op update.
  const updatableKeys = [
    "display_name",
    "handle",
    "product_id",
    "voice_profile",
    "source_note",
  ];
  const presentKeys = updatableKeys.filter((k) => input[k] !== undefined);
  if (presentKeys.length === 0) {
    errors.push("at_least_one_field_required");
  }

  if (input.display_name !== undefined) {
    if (!str(input.display_name) || input.display_name.trim().length === 0)
      errors.push("display_name_must_be_non_empty_string");
  }
  if (input.handle !== undefined && input.handle !== null && !str(input.handle))
    errors.push("handle_must_be_string");
  if (input.product_id !== undefined && input.product_id !== null) {
    if (!str(input.product_id) || !isUuidLike(input.product_id))
      errors.push("product_id_invalid");
  }
  if (input.voice_profile !== undefined && input.voice_profile !== null) {
    if (!str(input.voice_profile)) {
      errors.push("voice_profile_must_be_string");
    } else if (input.voice_profile.length > VOICE_PROFILE_MAX_CHARS) {
      errors.push("voice_profile_too_long");
    }
  }
  if (
    input.source_note !== undefined &&
    input.source_note !== null &&
    !str(input.source_note)
  )
    errors.push("source_note_must_be_string");

  if (errors.length > 0) return { ok: false, errors };

  const value: IdentitiesUpdateArgs = {
    identity_id: input.identity_id as string,
  };
  if (input.display_name !== undefined)
    value.display_name = (input.display_name as string).trim();
  if (input.handle !== undefined)
    value.handle = input.handle === null ? null : (input.handle as string).trim();
  if (input.product_id !== undefined)
    value.product_id =
      input.product_id === null ? null : (input.product_id as string);
  if (input.voice_profile !== undefined) {
    if (input.voice_profile === null) {
      value.voice_profile = null;
    } else {
      const trimmed = (input.voice_profile as string).trim();
      value.voice_profile = trimmed.length > 0 ? trimmed : null;
    }
  }
  if (input.source_note !== undefined)
    value.source_note =
      input.source_note === null ? null : (input.source_note as string).trim();
  return { ok: true, value };
}
