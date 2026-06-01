/**
 * Phase F8 — JSON Schema (`inputSchema`) for every Signal MCP tool.
 *
 * The real MCP endpoint (`/api/mcp/http`) must advertise an
 * `inputSchema` per tool in its `tools/list` response. The existing
 * dispatcher validates arguments with hand-written `parse*` functions
 * (see `src/mcp/schemas.ts`); those are the source of truth for
 * runtime validation. This file is the *declarative* mirror Claude
 * Code reads to know how to shape a `tools/call`.
 *
 * Drift between this map and the live tool registry is caught by
 * `tool-input-schemas.test.ts`, which asserts every registered tool
 * name has a schema here (and vice-versa).
 *
 * Pure data — no `server-only` import, so it can be unit-tested and
 * imported from either side of the bridge.
 */

import { FOUNDER_PLATFORMS } from "@/core/publishing/platform-guidance";

/** Loose JSON-Schema shape; we only ever emit plain JSON. */
export type JsonSchema = Record<string, unknown>;

const EMPTY_OBJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const UUID: JsonSchema = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
};

const NULLABLE_STRING: JsonSchema = { type: ["string", "null"] };

const CREATIVE_TYPE_ENUM = ["image", "video", "animation"] as const;
const CREATIVE_SOURCE_TYPE_ENUM = [
  "generated",
  "uploaded",
  "wikimedia",
  "official_source",
  "manual_url",
  "planned",
] as const;

/**
 * Shared platform-native intent object (optional on prepare_item /
 * update_item). Mirrors `McpPlatformIntentInput` in
 * `src/mcp/platform-intent.ts`.
 */
const PLATFORM_INTENT_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Optional platform-native publish shape. Validated against the platform adapter capability matrix. operator_approved_shape_hash is forbidden.",
  properties: {
    intent: {
      type: ["string", "null"],
      description: "e.g. new_post, thread, reply, quote, article, repost.",
    },
    thread_mode: { type: ["string", "null"] },
    media_mode: { type: ["string", "null"] },
    reply_to_url: NULLABLE_STRING,
    reply_to_external_id: NULLABLE_STRING,
    quote_url: NULLABLE_STRING,
    quote_external_id: NULLABLE_STRING,
    single_post_only: { type: ["boolean", "null"] },
    expected_part_count: { type: ["integer", "null"], minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

const PRODUCTS_PREPARE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, description: "Product name." },
    domain: NULLABLE_STRING,
    category: NULLABLE_STRING,
    summary: NULLABLE_STRING,
    source_note: NULLABLE_STRING,
  },
  required: ["name"],
  additionalProperties: false,
};

const ACCOUNTS_PREPARE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    platform: {
      type: "string",
      enum: [...FOUNDER_PLATFORMS],
      description: "Publishing platform. Must be a founder-supported platform.",
    },
    display_name: { type: "string", minLength: 1 },
    handle: NULLABLE_STRING,
    product_id: { type: ["string", "null"], description: "UUID of a product." },
    source_note: NULLABLE_STRING,
    voice_profile: { type: ["string", "null"], maxLength: 1500 },
    review_status: {
      type: "string",
      enum: ["pending_review", "confirmed"],
      description: "Defaults to pending_review.",
    },
    source_website_url: NULLABLE_STRING,
    reference_urls: { type: ["array", "null"], items: { type: "string" } },
  },
  required: ["platform", "display_name"],
  additionalProperties: false,
};

const WEEKLY_PLAN_PREPARE_ITEM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    product_id: { type: ["string", "null"] },
    account_id: { type: ["string", "null"] },
    platform: NULLABLE_STRING,
    body: NULLABLE_STRING,
    content_type: NULLABLE_STRING,
    scheduled_at: NULLABLE_STRING,
    timezone: NULLABLE_STRING,
    risk_score: { type: ["number", "null"], minimum: 0, maximum: 100 },
    save_as_draft: {
      type: "boolean",
      description:
        "Default false → lands as pending_approval. true → keeps it as a private draft.",
    },
    creative_required: { type: "boolean" },
    creative_type: { type: ["string", "null"], enum: [...CREATIVE_TYPE_ENUM, null] },
    creative_source_type: {
      type: ["string", "null"],
      enum: [...CREATIVE_SOURCE_TYPE_ENUM, null],
    },
    creative_prompt: NULLABLE_STRING,
    creative_source_url: NULLABLE_STRING,
    creative_asset_url: NULLABLE_STRING,
    creative_alt_text: NULLABLE_STRING,
    creative_license: NULLABLE_STRING,
    creative_attribution: NULLABLE_STRING,
    creative_risk_notes: NULLABLE_STRING,
    platform_intent: PLATFORM_INTENT_SCHEMA,
  },
  required: ["title"],
  additionalProperties: false,
};

const WEEKLY_PLAN_ATTACH_CREATIVE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    weekly_plan_item_id: UUID,
    creative_type: { type: "string", enum: [...CREATIVE_TYPE_ENUM] },
    source_type: { type: "string", enum: [...CREATIVE_SOURCE_TYPE_ENUM] },
    source_url: NULLABLE_STRING,
    asset_url: NULLABLE_STRING,
    prompt: NULLABLE_STRING,
    alt_text: NULLABLE_STRING,
    license: NULLABLE_STRING,
    attribution: NULLABLE_STRING,
    risk_notes: NULLABLE_STRING,
  },
  required: ["weekly_plan_item_id", "creative_type", "source_type"],
  additionalProperties: false,
};

const UPLOAD_CREATIVE_ASSET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    weekly_plan_item_id: UUID,
    source_type: {
      type: "string",
      const: "uploaded",
      description: "Always 'uploaded' — Signal does not generate creatives.",
    },
    mime_type: {
      type: "string",
      description: "jpeg / png / webp / gif / mp4 / webm (policy whitelist).",
    },
    file_base64: {
      type: "string",
      description: "Base64-encoded file bytes (RFC 4648).",
    },
    creative_type: { type: "string", enum: [...CREATIVE_TYPE_ENUM] },
    alt_text: NULLABLE_STRING,
    prompt: NULLABLE_STRING,
    aspect_ratio: NULLABLE_STRING,
    origin: {
      type: ["string", "null"],
      enum: ["ai_external", "operator", "external_tool", null],
    },
    notes: NULLABLE_STRING,
  },
  required: ["weekly_plan_item_id", "source_type", "mime_type", "file_base64"],
  additionalProperties: false,
};

const IMPORTS_PREPARE_MAPPING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    import_type: { type: "string", enum: ["product", "account"] },
    raw_text: { type: "string", minLength: 1 },
    extracted_fields: { type: "object" },
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["import_type", "raw_text"],
  additionalProperties: false,
};

const REPORTS_SUBMIT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    report_type: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: ["pass", "warning", "fail"] },
          details: { type: "array", items: { type: "string" } },
        },
        required: ["name", "status"],
        additionalProperties: false,
      },
    },
    recommended_next_action: NULLABLE_STRING,
  },
  required: ["report_type", "summary"],
  additionalProperties: false,
};

const VERIFICATION_RUN_CHECK_SCHEMA: JsonSchema = {
  type: "object",
  properties: { check_name: { type: "string" } },
  required: ["check_name"],
  additionalProperties: false,
};

const EXECUTION_DRY_RUN_SCHEMA: JsonSchema = {
  type: "object",
  description: "Provide queue_id OR item_id (at least one is required).",
  properties: {
    queue_id: { type: ["string", "null"] },
    item_id: { type: ["string", "null"] },
  },
  additionalProperties: false,
};

const EXECUTION_ITEM_PREVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    execution_item_id: UUID,
    subreddit: NULLABLE_STRING,
  },
  required: ["execution_item_id"],
  additionalProperties: false,
};

const EXECUTION_RECORD_MANUAL_PUBLISH_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    execution_item_id: UUID,
    permalink: {
      type: "string",
      minLength: 1,
      description: "reddit.com/r/<sub>/comments/<id>/ or redd.it/<id>.",
    },
    provider_post_id: NULLABLE_STRING,
    notes: NULLABLE_STRING,
  },
  required: ["execution_item_id", "permalink"],
  additionalProperties: false,
};

const EXECUTION_AUTHORIZE_ITEM_SCHEMA: JsonSchema = {
  type: "object",
  properties: { execution_item_id: UUID },
  required: ["execution_item_id"],
  additionalProperties: false,
};

const TOPIC_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    topic: { type: "string", minLength: 1 },
    goal: NULLABLE_STRING,
    cta: NULLABLE_STRING,
    source_url: NULLABLE_STRING,
  },
  required: ["topic"],
  additionalProperties: false,
};

const GENERATE_DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    identity_id: UUID,
    topic: { type: "string", minLength: 1 },
    goal: NULLABLE_STRING,
    cta: NULLABLE_STRING,
    source_url: NULLABLE_STRING,
    tone_adjustment: NULLABLE_STRING,
    schedule_preference: NULLABLE_STRING,
    week_start: {
      type: ["string", "null"],
      description: "ISO date (YYYY-MM-DD).",
    },
  },
  required: ["identity_id", "topic"],
  additionalProperties: false,
};

const GENERATE_WEEKLY_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    product_id: UUID,
    week_start: { type: "string", description: "ISO date (YYYY-MM-DD)." },
    identity_ids: { type: "array", items: UUID, minItems: 1 },
    topics: { type: "array", items: TOPIC_SCHEMA, minItems: 1 },
    strategic_theme: NULLABLE_STRING,
    max_posts_per_platform: { type: ["number", "null"], minimum: 1 },
    include_media_briefs: { type: "boolean" },
  },
  required: ["product_id", "week_start", "identity_ids", "topics"],
  additionalProperties: false,
};

const GENERATE_MULTIWEEK_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    product_id: UUID,
    start_date: { type: "string", description: "ISO date (YYYY-MM-DD)." },
    number_of_weeks: { type: "integer", minimum: 1, maximum: 4 },
    identity_ids: { type: "array", items: UUID, minItems: 1 },
    topics_per_week: { type: "array", items: TOPIC_SCHEMA, minItems: 1 },
    strategic_theme: { type: "string", minLength: 1 },
    max_posts_per_week: { type: ["number", "null"], minimum: 1 },
    approval_mode: { type: "string", const: "operator_review_required" },
  },
  required: [
    "product_id",
    "start_date",
    "number_of_weeks",
    "identity_ids",
    "topics_per_week",
    "strategic_theme",
    "approval_mode",
  ],
  additionalProperties: false,
};

const IDENTITIES_UPDATE_SCHEMA: JsonSchema = {
  type: "object",
  description: "At least one updatable field must be provided.",
  properties: {
    identity_id: UUID,
    display_name: { type: "string", minLength: 1 },
    handle: NULLABLE_STRING,
    product_id: { type: ["string", "null"] },
    voice_profile: { type: ["string", "null"], maxLength: 1500 },
    source_note: NULLABLE_STRING,
    source_website_url: NULLABLE_STRING,
    reference_urls: { type: ["array", "null"], items: { type: "string" } },
  },
  required: ["identity_id"],
  additionalProperties: false,
};

const WEEKLY_PLAN_UPDATE_ITEM_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Edit a draft / pending_approval item. At least one content field required. Never approves, schedules, or publishes.",
  properties: {
    plan_item_id: UUID,
    title: { type: "string", minLength: 1 },
    body: { type: "string", minLength: 1 },
    cta: NULLABLE_STRING,
    creative_brief: { type: "string", minLength: 1 },
    media_prompt_or_brief: { type: "string", minLength: 1 },
    risk_notes: { type: "array", items: { type: "string" }, maxItems: 10 },
    platform_intent: PLATFORM_INTENT_SCHEMA,
    confirm_update: { type: "boolean", const: true },
  },
  required: ["plan_item_id", "confirm_update"],
  additionalProperties: false,
};

const SCHEDULE_PUBLISH_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    plan_item_id: UUID,
    scheduled_at: {
      type: "string",
      description:
        "ISO timestamp at least 2 minutes in the future. Item must be in status='approved'.",
    },
    confirm_schedule: { type: "boolean", const: true },
  },
  required: ["plan_item_id", "scheduled_at", "confirm_schedule"],
  additionalProperties: false,
};

/**
 * Tool name → JSON Schema for its arguments. Keyed by the exact
 * registered tool name so `tools/list` can attach the right schema.
 */
export const TOOL_INPUT_SCHEMAS: Record<string, JsonSchema> = {
  // Read tools (no arguments).
  "signal.workspace.get": EMPTY_OBJECT_SCHEMA,
  "signal.products.list": EMPTY_OBJECT_SCHEMA,
  "signal.accounts.list": EMPTY_OBJECT_SCHEMA,
  "signal.weekly_plan.current": EMPTY_OBJECT_SCHEMA,
  "signal.contracts.active": EMPTY_OBJECT_SCHEMA,
  "signal.execution.queue_status": EMPTY_OBJECT_SCHEMA,
  "signal.verification.latest": EMPTY_OBJECT_SCHEMA,
  "signal.oauth.connections.list": EMPTY_OBJECT_SCHEMA,
  "signal.activity.latest": EMPTY_OBJECT_SCHEMA,
  "signal.verification.run": EMPTY_OBJECT_SCHEMA,
  // Prepare / write-pending tools.
  "signal.products.prepare": PRODUCTS_PREPARE_SCHEMA,
  "signal.products.create": PRODUCTS_PREPARE_SCHEMA,
  "signal.accounts.prepare": ACCOUNTS_PREPARE_SCHEMA,
  "signal.identities.create": ACCOUNTS_PREPARE_SCHEMA,
  "signal.weekly_plan.prepare_item": WEEKLY_PLAN_PREPARE_ITEM_SCHEMA,
  "signal.weekly_plan.attach_creative": WEEKLY_PLAN_ATTACH_CREATIVE_SCHEMA,
  "signal.upload_creative_asset": UPLOAD_CREATIVE_ASSET_SCHEMA,
  "signal.imports.prepare_mapping": IMPORTS_PREPARE_MAPPING_SCHEMA,
  "signal.reports.submit": REPORTS_SUBMIT_SCHEMA,
  // Verification / dry-run tools.
  "signal.verification.run_check": VERIFICATION_RUN_CHECK_SCHEMA,
  "signal.execution.dry_run": EXECUTION_DRY_RUN_SCHEMA,
  "signal.execution.manual_publish_preview": EXECUTION_ITEM_PREVIEW_SCHEMA,
  "signal.execution.record_manual_publish":
    EXECUTION_RECORD_MANUAL_PUBLISH_SCHEMA,
  "signal.execution.publish_preview": EXECUTION_ITEM_PREVIEW_SCHEMA,
  "signal.execution.authorize_item": EXECUTION_AUTHORIZE_ITEM_SCHEMA,
  // Planning / generation tools.
  "signal.generate_draft": GENERATE_DRAFT_SCHEMA,
  "signal.generate_weekly_plan": GENERATE_WEEKLY_PLAN_SCHEMA,
  "signal.generate_multiweek_plan": GENERATE_MULTIWEEK_PLAN_SCHEMA,
  "signal.identities.update": IDENTITIES_UPDATE_SCHEMA,
  "signal.weekly_plan.update_item": WEEKLY_PLAN_UPDATE_ITEM_SCHEMA,
  // Scheduling.
  "signal.schedule_publish": SCHEDULE_PUBLISH_SCHEMA,
};

/**
 * Resolve a tool's input schema, falling back to a permissive object
 * schema if a tool somehow lacks an explicit entry. The drift test
 * guarantees the fallback is never hit in practice.
 */
export function mcpInputSchemaFor(toolName: string): JsonSchema {
  return TOOL_INPUT_SCHEMAS[toolName] ?? { type: "object" };
}
