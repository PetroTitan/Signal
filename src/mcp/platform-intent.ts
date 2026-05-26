import "server-only";

/**
 * MCP-side platform-native intent helpers.
 *
 * Role
 * ----
 * Bridges optional MCP tool fields into a validated PlatformNativeShape
 * the repository can persist into weekly_plan_items.platform_publish_intent.
 *
 * Hard isolation rules
 * --------------------
 * This module imports ONLY:
 *   - `@/core/platform-native` (shared deterministic surface)
 *   - `@/core/publishing/publishing-types` (the PublishPlatform union)
 *
 * It MUST NOT import:
 *   - any per-platform adapter implementation
 *   - any publisher (publish-*.ts)
 *   - any transformer (transformers/*.ts)
 *   - the publishing-runner, publishing-scheduler, or orchestrators
 *
 * Enforced by `mcp-isolation.test.ts`.
 *
 * Generic terminology
 * -------------------
 * This file describes a single PUBLISH ENTITY — there is no "weekly"
 * lifecycle assumption. The legacy tool names (signal.weekly_plan.*)
 * are preserved for backwards compatibility; the LOGIC here is
 * lifecycle-agnostic. Comments use "publish item" / "publish entity"
 * / "platform-native shape".
 */

import {
  getPlatformAdapter,
  legacyPlatformNativeShape,
  parsePlatformNativeShape,
  serializePlatformNativeShape,
  validateShapeAgainstCapabilities,
  type MediaMode,
  type PlatformNativeShape,
  type ProviderPayloadBlocker,
  type PublishingIntent,
  type QuoteTarget,
  type ReplyTarget,
  type ThreadMode,
} from "@/core/platform-native";
import {
  isMediaMode,
  isPublishingIntent,
  isThreadMode,
} from "@/core/platform-native";
import type { PublishPlatform } from "@/core/publishing/publishing-types";

// =====================================================================
// Public input / output shapes
// =====================================================================

/**
 * Raw native fields as MCP receives them — snake_case, all optional.
 * Each tool's parser strips unknown fields and produces this.
 */
export interface McpPlatformIntentInput {
  intent?: PublishingIntent | null;
  thread_mode?: ThreadMode | null;
  media_mode?: MediaMode | null;
  reply_to_url?: string | null;
  reply_to_external_id?: string | null;
  quote_url?: string | null;
  quote_external_id?: string | null;
  single_post_only?: boolean | null;
  expected_part_count?: number | null;
}

/**
 * Structured MCP validation error. Distinct from the raw Zod-style
 * `errors: string[]` returned by the parsers — these are returned in
 * the tool response so the caller (Claude or another agent) can fix
 * the request without parsing English.
 */
export interface McpValidationIssue {
  code: string;
  message: string;
  field: string | null;
  allowed_values?: ReadonlyArray<string>;
  suggested_fix?: string;
}

export type McpPlatformIntentMode = "explicit" | "legacy";

export interface McpPlatformIntentResult {
  /**
   * "explicit" when any native field was supplied AND validation
   * passed. "legacy" when no native fields were supplied (existing
   * behavior preserved).
   */
  mode: McpPlatformIntentMode;
  /**
   * The shape to persist into weekly_plan_items.platform_publish_intent.
   * Null in legacy mode (do NOT write the column).
   */
  shape: PlatformNativeShape | null;
  /** Pre-serialized JSON envelope ready for the DB column write. */
  serialized: Record<string, unknown> | null;
  warnings: ReadonlyArray<string>;
  blockers: ReadonlyArray<McpValidationIssue>;
}

// =====================================================================
// Detection — did the caller actually supply any native field?
// =====================================================================

/**
 * True when the caller supplied at least one native field. `undefined`
 * means "field not present"; explicit `null` counts as supplied
 * (operator intends to clear a reply/quote target on update).
 */
export function hasAnyPlatformIntentField(
  input: McpPlatformIntentInput,
): boolean {
  return (
    input.intent !== undefined ||
    input.thread_mode !== undefined ||
    input.media_mode !== undefined ||
    input.reply_to_url !== undefined ||
    input.reply_to_external_id !== undefined ||
    input.quote_url !== undefined ||
    input.quote_external_id !== undefined ||
    input.single_post_only !== undefined ||
    input.expected_part_count !== undefined
  );
}

// =====================================================================
// Build — first-time creation (prepare_item)
// =====================================================================

/**
 * Construct a PlatformNativeShape from MCP fields for a CREATE flow.
 * No existing shape to merge into.
 *
 * Validation runs against the platform adapter's capability matrix.
 * Stub adapters reject non-unknown intents with `adapter_not_implemented`.
 *
 * Returns:
 *   - mode="legacy" if NO native fields supplied (do not write column)
 *   - mode="explicit" with shape + serialized payload otherwise
 *   - blockers populated on validation failure (caller refuses the write)
 */
export function buildShapeForCreate(args: {
  platform: PublishPlatform | null;
  input: McpPlatformIntentInput;
}): McpPlatformIntentResult {
  if (!hasAnyPlatformIntentField(args.input)) {
    return {
      mode: "legacy",
      shape: null,
      serialized: null,
      warnings: [],
      blockers: [],
    };
  }

  if (!args.platform) {
    return {
      mode: "explicit",
      shape: null,
      serialized: null,
      warnings: [],
      blockers: [
        {
          code: "platform_required_for_intent",
          message:
            "Platform must be set explicitly when any platform-native intent field is supplied. Do not infer from account.",
          field: "platform",
          suggested_fix:
            "Set the `platform` field on this tool call (e.g. \"bluesky\"). The adapter resolves all capability validation.",
        },
      ],
    };
  }

  const shape = applyInputToShape({
    base: legacyPlatformNativeShape(args.platform),
    input: args.input,
    isUpdate: false,
  });

  return finalize({
    platform: args.platform,
    shape,
    input: args.input,
    isUpdate: false,
  });
}

// =====================================================================
// Merge — existing-row update (update_item)
// =====================================================================

/**
 * Merge MCP fields into an existing platform_publish_intent envelope.
 *
 * Rules
 * -----
 *   - `undefined` for a field → preserve existing value
 *   - explicit `null` for reply_to_* / quote_* → clear that target
 *   - explicit value → set
 *
 * When the caller supplies NO native field AND the existing envelope
 * is null, returns mode="legacy" (do not write). When existing is
 * non-null and caller supplies no native field, returns the parsed
 * existing shape unchanged (no write needed — caller can detect via
 * `serialized === null` is FALSE).
 *
 * When ANY payload-relevant field changes — body / title / platform /
 * account / intent / thread_mode / media_mode / reply target / quote
 * target / creative — the caller is responsible for setting
 * `clearApprovedHash: true` via `shouldClearApprovedHash`. This
 * function clears the hash field on the OUTPUT shape only when the
 * merge itself touches a payload-relevant intent field.
 */
export function buildShapeForUpdate(args: {
  platform: PublishPlatform | null;
  existingRaw: Record<string, unknown> | null;
  input: McpPlatformIntentInput;
  /** Other tool-level payload changes (body/title/platform/etc.) the
   *  caller already detected. When true, the output shape clears
   *  `operatorApprovedShapeHash`. */
  externalPayloadChanged: boolean;
}): McpPlatformIntentResult {
  const hasAny = hasAnyPlatformIntentField(args.input);
  const existingShape = args.platform
    ? parsePlatformNativeShape(args.existingRaw, args.platform)
    : null;

  if (!hasAny && !existingShape) {
    return {
      mode: "legacy",
      shape: null,
      serialized: null,
      warnings: [],
      blockers: [],
    };
  }

  if (!hasAny && existingShape) {
    // Caller supplied no native field; envelope unchanged. We still
    // return the parsed shape so the caller can clear the approved
    // hash on a body/title change.
    const cleared = args.externalPayloadChanged
      ? { ...existingShape, operatorApprovedShapeHash: null }
      : existingShape;
    return {
      mode: "explicit",
      shape: cleared,
      serialized: serializePlatformNativeShape(cleared),
      warnings: [],
      blockers: [],
    };
  }

  if (!args.platform) {
    return {
      mode: "explicit",
      shape: null,
      serialized: null,
      warnings: [],
      blockers: [
        {
          code: "platform_required_for_intent",
          message:
            "Platform must be known to merge platform-native intent fields. The plan item has no platform set.",
          field: "platform",
          suggested_fix:
            "Set the plan_item's platform first (via prepare_item or in the UI) before sending intent fields.",
        },
      ],
    };
  }

  const base: PlatformNativeShape =
    existingShape ?? legacyPlatformNativeShape(args.platform);
  const merged = applyInputToShape({
    base,
    input: args.input,
    isUpdate: true,
  });

  // Any merged intent field is payload-relevant — clear approved
  // hash. External payload changes (body/title) are folded in too.
  const shape: PlatformNativeShape = {
    ...merged,
    operatorApprovedShapeHash: null,
  };
  // Silence unused-variable lint when caller doesn't pass externalPayloadChanged.
  void args.externalPayloadChanged;

  return finalize({
    platform: args.platform,
    shape,
    input: args.input,
    isUpdate: true,
  });
}

// =====================================================================
// Payload-relevant change detection
// =====================================================================

export interface PayloadRelevantUpdateProbe {
  bodyChanged: boolean;
  titleChanged: boolean;
  platformChanged: boolean;
  accountChanged: boolean;
  creativeChanged: boolean;
  intentFieldsPresent: boolean;
}

/**
 * Pure predicate: true when the operator approval hash must be
 * cleared. Mirrors the spec: any change to body / title / platform /
 * identity / intent / thread_mode / media_mode / reply target /
 * quote target / media or creative invalidates approval.
 *
 * Separated from the merge function so callers can compose checks
 * across schema/repository/MCP layers without coupling.
 */
export function shouldClearApprovedHash(
  probe: PayloadRelevantUpdateProbe,
): boolean {
  return (
    probe.bodyChanged ||
    probe.titleChanged ||
    probe.platformChanged ||
    probe.accountChanged ||
    probe.creativeChanged ||
    probe.intentFieldsPresent
  );
}

// =====================================================================
// Response shaping
// =====================================================================

/**
 * Translate the result into the response fields a tool puts on
 * `McpToolResponse.data`. Keeps the response keys snake_case to match
 * the rest of the MCP surface.
 */
export function serializeMcpResponse(
  result: McpPlatformIntentResult,
): Record<string, unknown> {
  if (result.mode === "legacy") {
    return {
      platform_native_mode: "legacy",
      warning:
        "Legacy payload mode: provider shape will be inferred until platform_publish_intent is set.",
    };
  }
  return {
    platform_native_mode: "explicit",
    platform_publish_intent: result.serialized,
    validation_warnings: result.warnings,
    validation_blockers: result.blockers,
  };
}

// =====================================================================
// Internals
// =====================================================================

function applyInputToShape(args: {
  base: PlatformNativeShape;
  input: McpPlatformIntentInput;
  isUpdate: boolean;
}): PlatformNativeShape {
  const { base, input, isUpdate } = args;

  // Defaults only apply when caller supplied SOMETHING and is missing
  // the corresponding field. On UPDATE we never override existing
  // values just because the caller left a field undefined.
  const fillDefault = (existing: unknown, defaultValue: unknown): unknown =>
    isUpdate ? existing : defaultValue;

  // Intent: explicit value > existing (update) > default new_post (create)
  const intent: PublishingIntent =
    input.intent !== undefined
      ? (input.intent ?? base.intent)
      : (fillDefault(base.intent, "new_post") as PublishingIntent);

  // Thread mode with single_post_only override (forces single_only).
  let threadMode: ThreadMode =
    input.thread_mode !== undefined
      ? (input.thread_mode ?? base.threadMode)
      : (fillDefault(base.threadMode, "platform_default") as ThreadMode);
  if (input.single_post_only === true) {
    threadMode = "single_only";
  }

  const mediaMode: MediaMode =
    input.media_mode !== undefined
      ? (input.media_mode ?? base.mediaMode)
      : (fillDefault(base.mediaMode, "platform_default") as MediaMode);

  const expectedPartCount: number | null =
    input.expected_part_count !== undefined
      ? input.expected_part_count
      : base.expectedPartCount;

  const replyTarget: ReplyTarget | null = mergeTarget({
    existing: base.replyTarget,
    incomingUrl: input.reply_to_url,
    incomingExternalId: input.reply_to_external_id,
  });

  const quoteTarget: QuoteTarget | null = mergeTarget({
    existing: base.quoteTarget,
    incomingUrl: input.quote_url,
    incomingExternalId: input.quote_external_id,
  });

  return {
    version: 1,
    platform: base.platform,
    intent,
    threadMode,
    mediaMode,
    expectedPartCount,
    replyTarget,
    quoteTarget,
    operatorApprovedShapeHash: base.operatorApprovedShapeHash,
  };
}

function mergeTarget(args: {
  existing: ReplyTarget | null;
  incomingUrl: string | null | undefined;
  incomingExternalId: string | null | undefined;
}): ReplyTarget | null {
  // Both undefined → preserve existing.
  if (args.incomingUrl === undefined && args.incomingExternalId === undefined) {
    return args.existing;
  }
  // Explicit null on EITHER field → caller intends to clear.
  if (args.incomingUrl === null || args.incomingExternalId === null) {
    // Only clear if both incoming are null-or-undefined.
    const url = args.incomingUrl === undefined ? args.existing?.url ?? null : args.incomingUrl;
    const externalId =
      args.incomingExternalId === undefined
        ? args.existing?.externalId ?? null
        : args.incomingExternalId;
    if (url === null && externalId === null) return null;
    return { url, externalId };
  }
  const url = args.incomingUrl ?? args.existing?.url ?? null;
  const externalId =
    args.incomingExternalId ?? args.existing?.externalId ?? null;
  if (url === null && externalId === null) return null;
  return { url, externalId };
}

function finalize(args: {
  platform: PublishPlatform;
  shape: PlatformNativeShape;
  input: McpPlatformIntentInput;
  isUpdate: boolean;
}): McpPlatformIntentResult {
  const adapter = getPlatformAdapter(args.platform);
  if (!adapter) {
    return {
      mode: "explicit",
      shape: null,
      serialized: null,
      warnings: [],
      blockers: [
        {
          code: "platform_unknown",
          message: `${args.platform}: no platform-native adapter registered.`,
          field: "platform",
        },
      ],
    };
  }

  const blockers: McpValidationIssue[] = [];

  // Cross-field MCP-specific checks (capability matrix runs after).
  pushCrossFieldBlockers(args.input, args.shape, blockers);

  // Adapter / capability validation.
  for (const rawBlocker of validateShapeAgainstCapabilities(
    adapter.capabilities,
    args.shape,
  )) {
    blockers.push(toMcpIssue(rawBlocker));
  }

  if (blockers.length > 0) {
    return {
      mode: "explicit",
      shape: null,
      serialized: null,
      warnings: [],
      blockers,
    };
  }

  // Stub-adapter awareness: a valid unknown-intent shape is "explicit
  // mode" for accounting purposes but carries a warning so the
  // caller knows publish-time enforcement isn't yet available.
  const warnings: string[] = [];
  if (adapter.capabilities.stub) {
    warnings.push(
      `${args.platform}: adapter is a stub. The shape will persist, but provider validation will only run when the per-platform adapter PR ships.`,
    );
  }

  return {
    mode: "explicit",
    shape: args.shape,
    serialized: serializePlatformNativeShape(args.shape),
    warnings,
    blockers,
  };
}

function toMcpIssue(b: ProviderPayloadBlocker): McpValidationIssue {
  // Mirror foundation-PR blocker codes 1:1 so callers can switch on
  // them without translation. `field` and `suggested_fix` are
  // best-effort hints based on the code.
  switch (b.code) {
    case "intent_not_supported":
      return {
        code: b.code,
        message: b.message,
        field: "intent",
        allowed_values: ALLOWED_INTENTS,
        suggested_fix:
          "Pick an intent the adapter supports, or wait for the per-platform adapter PR that introduces this intent.",
      };
    case "thread_mode_not_supported":
      return {
        code: b.code,
        message: b.message,
        field: "thread_mode",
        allowed_values: ALLOWED_THREAD_MODES,
      };
    case "media_mode_not_supported":
      return {
        code: b.code,
        message: b.message,
        field: "media_mode",
        allowed_values: ALLOWED_MEDIA_MODES,
      };
    case "media_required":
      return {
        code: b.code,
        message: b.message,
        field: "media_mode",
        suggested_fix:
          "Attach a creative or set media_mode to first_part_only / every_part.",
      };
    case "reply_target_missing":
      return {
        code: "reply_target_required",
        message: b.message,
        field: "reply_to_url",
        suggested_fix:
          "Provide reply_to_url or reply_to_external_id when intent=reply.",
      };
    case "quote_target_missing":
      return {
        code: "quote_target_required",
        message: b.message,
        field: "quote_to_url",
        suggested_fix:
          "Provide quote_url or quote_external_id when intent=quote.",
      };
    case "reply_not_supported":
    case "quote_not_supported":
      return {
        code: b.code,
        message: b.message,
        field: b.code === "reply_not_supported" ? "reply_to_url" : "quote_url",
      };
    case "adapter_not_implemented":
      return {
        code: b.code,
        message: b.message,
        field: "platform",
        suggested_fix:
          "Use the legacy payload mode (omit all platform-native fields) until this platform's adapter PR ships.",
      };
    case "platform_mismatch":
      return {
        code: b.code,
        message: b.message,
        field: "platform",
      };
    case "thread_part_count_invalid":
      return {
        code: b.code,
        message: b.message,
        field: "expected_part_count",
        suggested_fix: "Thread intent requires expected_part_count >= 2.",
      };
    default:
      return { code: b.code, message: b.message, field: null };
  }
}

function pushCrossFieldBlockers(
  input: McpPlatformIntentInput,
  shape: PlatformNativeShape,
  out: McpValidationIssue[],
): void {
  if (input.single_post_only === true && input.intent === "thread") {
    out.push({
      code: "thread_mode_conflicts_with_intent",
      message:
        "single_post_only=true conflicts with intent=thread. Pick one.",
      field: "thread_mode",
      suggested_fix:
        "Set intent=new_post for a single post, or remove single_post_only to allow a thread.",
    });
  }
  if (
    (input.quote_url !== undefined && input.quote_url !== null) ||
    (input.quote_external_id !== undefined && input.quote_external_id !== null)
  ) {
    if (shape.intent !== "quote") {
      out.push({
        code: "quote_requires_quote_intent",
        message:
          "quote_url / quote_external_id supplied but intent is not 'quote'.",
        field: "intent",
        suggested_fix:
          "Set intent=quote, or remove quote_url / quote_external_id.",
      });
    }
  }
  if (
    (input.reply_to_url !== undefined && input.reply_to_url !== null) ||
    (input.reply_to_external_id !== undefined &&
      input.reply_to_external_id !== null)
  ) {
    if (shape.intent !== "reply") {
      out.push({
        code: "reply_requires_reply_intent",
        message:
          "reply_to_url / reply_to_external_id supplied but intent is not 'reply'.",
        field: "intent",
        suggested_fix:
          "Set intent=reply, or remove reply_to_url / reply_to_external_id.",
      });
    }
  }
}

const ALLOWED_INTENTS: ReadonlyArray<string> = [
  "new_post",
  "thread",
  "reply",
  "comment",
  "quote",
  "repost",
  "article",
  "media_post",
  "link_post",
  "video_post",
  "carousel",
  "story",
  "short_video",
  "unknown",
];
const ALLOWED_THREAD_MODES: ReadonlyArray<string> = [
  "none",
  "single_only",
  "auto_thread_allowed",
  "manual_thread",
  "platform_default",
];
const ALLOWED_MEDIA_MODES: ReadonlyArray<string> = [
  "none",
  "first_part_only",
  "every_part",
  "platform_default",
  "media_required",
];

// =====================================================================
// Parser — used by both prepare_item and update_item schemas
// =====================================================================

/**
 * Pure parser for the snake_case MCP fields. Returns the validated
 * input or a list of error codes. The host parser (parseWeeklyPlanX)
 * folds the result into its own ParseFail.
 *
 * Forbids `operator_approved_shape_hash` outright — MCP must never
 * set it.
 */
export function parsePlatformIntentFields(
  rawInput: Record<string, unknown>,
): { ok: true; value: McpPlatformIntentInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: McpPlatformIntentInput = {};

  if ("operator_approved_shape_hash" in rawInput) {
    errors.push("operator_approved_shape_hash_forbidden");
  }

  if ("intent" in rawInput) {
    const v = rawInput.intent;
    if (v === null) {
      out.intent = null;
    } else if (!isPublishingIntent(v)) {
      errors.push("intent_invalid");
    } else {
      out.intent = v;
    }
  }
  if ("thread_mode" in rawInput) {
    const v = rawInput.thread_mode;
    if (v === null) {
      out.thread_mode = null;
    } else if (!isThreadMode(v)) {
      errors.push("thread_mode_invalid");
    } else {
      out.thread_mode = v;
    }
  }
  if ("media_mode" in rawInput) {
    const v = rawInput.media_mode;
    if (v === null) {
      out.media_mode = null;
    } else if (!isMediaMode(v)) {
      errors.push("media_mode_invalid");
    } else {
      out.media_mode = v;
    }
  }
  if ("reply_to_url" in rawInput) {
    const v = rawInput.reply_to_url;
    if (v !== null && typeof v !== "string") errors.push("reply_to_url_must_be_string_or_null");
    else out.reply_to_url = v;
  }
  if ("reply_to_external_id" in rawInput) {
    const v = rawInput.reply_to_external_id;
    if (v !== null && typeof v !== "string")
      errors.push("reply_to_external_id_must_be_string_or_null");
    else out.reply_to_external_id = v;
  }
  if ("quote_url" in rawInput) {
    const v = rawInput.quote_url;
    if (v !== null && typeof v !== "string") errors.push("quote_url_must_be_string_or_null");
    else out.quote_url = v;
  }
  if ("quote_external_id" in rawInput) {
    const v = rawInput.quote_external_id;
    if (v !== null && typeof v !== "string")
      errors.push("quote_external_id_must_be_string_or_null");
    else out.quote_external_id = v;
  }
  if ("single_post_only" in rawInput) {
    const v = rawInput.single_post_only;
    if (v !== null && typeof v !== "boolean")
      errors.push("single_post_only_must_be_boolean");
    else out.single_post_only = v;
  }
  if ("expected_part_count" in rawInput) {
    const v = rawInput.expected_part_count;
    if (v === null) {
      out.expected_part_count = null;
    } else if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v <= 0 ||
      v > 100
    ) {
      errors.push("expected_part_count_invalid");
    } else {
      out.expected_part_count = v;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}
