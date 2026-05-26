/**
 * Phase F6.3 — X (formerly Twitter) platform-native adapter.
 *
 * Provider-native preview + validation only. Manual-distribution
 * surface in Signal today (the operator pastes into the X
 * composer); the adapter still models the provider payload
 * accurately so:
 *
 *   - the compose-modal summary shows the exact thread structure
 *     the operator will paste;
 *   - approval can bind to a deterministic payload hash;
 *   - a future per-platform live-publish PR can swap the publisher
 *     in WITHOUT touching this adapter's preview contract.
 *
 * Isolation
 * ---------
 * This file imports only:
 *   - the shared platform-native domain types
 *   - the platform-agnostic text utilities
 * NEVER imports another adapter, a publisher, a scheduler, or any
 * cross-platform middleware.
 *
 * Provider semantics
 * ------------------
 *   - per-post hard limit: 280 characters (we target 275 to leave a
 *     2-char " (N/M)" suffix headroom for threads)
 *   - thread = explicit `intent: "thread"` OR `intent: "new_post"
 *     with thread_mode: "auto_thread_allowed"`. Never silent split.
 *   - media: first post only (X-thread convention); we accept
 *     `media_mode: "every_part"` as a forward-looking opt-in but
 *     fold to first-part-only for the v1 publisher.
 *   - reply: requires `reply_target` with a post_id or URL
 *   - quote: requires `quote_target` with a post_id or URL
 */

import {
  validateShapeAgainstCapabilities,
  type PlatformCapabilities,
} from "../../platform-capabilities";
import type {
  ProviderPayloadBlocker,
  ProviderPayloadFormat,
  ProviderPayloadPart,
  ProviderPayloadPreview,
} from "../../publishing-intent";
import { splitIntoTextChunks, stripMarkdownToPlain } from "../../text-utils";
import type { AdapterRenderInput, PlatformNativeAdapter } from "../types";

const X_HARD_LIMIT = 280;
const X_THREAD_SUFFIX_RESERVE = 5; // " (99/99)" is 8; reserve 5 for typical cases

const X_CAPABILITIES: PlatformCapabilities = {
  platform: "x",
  supportedIntents: new Set([
    "new_post",
    "thread",
    "reply",
    "quote",
    "media_post",
    "repost",
    "unknown",
  ]),
  supportedThreadModes: new Set([
    "single_only",
    "auto_thread_allowed",
    "manual_thread",
    "platform_default",
    "none",
  ]),
  supportedMediaModes: new Set([
    "none",
    "first_part_only",
    "every_part",
    "platform_default",
  ]),
  requiresMedia: false, // media required ONLY for intent=media_post — enforced in preview
  requiresTarget: false,
  requiresTitle: false,
  budgets: { perPartUnit: "chars", perPartBudget: X_HARD_LIMIT },
  reply: { supported: true, targetKind: "post_id" },
  quote: { supported: true, targetKind: "post_id" },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(X_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  const plain = stripMarkdownToPlain(input.body ?? "").trim();
  if (plain.length === 0 && shape.intent !== "repost") {
    blockers.push({
      code: "empty_body",
      message: "X: post needs body text.",
    });
  }

  // intent-specific media enforcement (NOT in the shared matrix —
  // X only requires media for media_post intent).
  if (
    shape.intent === "media_post" &&
    (!input.creative || (!input.creative.assetUrl && !input.creative.sourceUrl))
  ) {
    blockers.push({
      code: "media_required",
      message:
        "X: media_post intent requires an attached creative (image or video).",
    });
  }

  // Determine how the operator wants overflow handled. X NEVER
  // auto-threads silently — the operator must opt in explicitly.
  const allowsThread =
    shape.intent === "thread" ||
    shape.threadMode === "auto_thread_allowed" ||
    shape.threadMode === "manual_thread";

  let parts: string[];
  let format: ProviderPayloadFormat;
  if (shape.intent === "thread") {
    format = "thread";
    parts = splitIntoTextChunks(plain, X_HARD_LIMIT - X_THREAD_SUFFIX_RESERVE);
    if (parts.length < 2) {
      blockers.push({
        code: "thread_requires_multiple_parts",
        message: `X: thread intent requires more than one part (body produced ${parts.length}).`,
      });
    }
  } else if (shape.intent === "reply") {
    format = "reply";
    parts = [plain.slice(0, X_HARD_LIMIT)];
    if (!shape.replyTarget || (!shape.replyTarget.externalId && !shape.replyTarget.url)) {
      blockers.push({
        code: "reply_target_required",
        message: "X: reply intent requires reply_target with a post_id or URL.",
      });
    }
  } else if (shape.intent === "quote") {
    format = "quote";
    parts = [plain.slice(0, X_HARD_LIMIT)];
    if (!shape.quoteTarget || (!shape.quoteTarget.externalId && !shape.quoteTarget.url)) {
      blockers.push({
        code: "quote_target_required",
        message: "X: quote intent requires quote_target with a post_id or URL.",
      });
    }
  } else if (shape.intent === "repost") {
    format = "unknown"; // explicitly reserved per spec
    parts = [];
    warnings.push(
      "X: repost intent is reserved for a future adapter PR.",
    );
  } else if (shape.intent === "media_post") {
    format = "media_post";
    parts = [plain.slice(0, X_HARD_LIMIT)];
  } else if (plain.length > X_HARD_LIMIT) {
    if (allowsThread) {
      format = "thread";
      parts = splitIntoTextChunks(
        plain,
        X_HARD_LIMIT - X_THREAD_SUFFIX_RESERVE,
      );
    } else {
      // intent=new_post + thread_mode=single_only OR platform_default.
      // X policy: REFUSE to auto-thread. Operator must opt in.
      format = "single_post";
      parts = [plain.slice(0, X_HARD_LIMIT)];
      blockers.push({
        code: "x_post_exceeds_budget",
        message: `X: body is ${plain.length} chars; per-post limit is ${X_HARD_LIMIT}. Either shorten the body or set thread_mode=auto_thread_allowed (or intent=thread).`,
      });
    }
  } else {
    format = "single_post";
    parts = plain.length > 0 ? [plain] : [];
  }

  // Apply " (N/M)" suffix when threading.
  const totalParts = parts.length;
  const renderedParts: ProviderPayloadPart[] = parts.map((text, idx) => {
    const suffix = totalParts > 1 ? ` (${idx + 1}/${totalParts})` : "";
    return {
      index: idx + 1,
      text: `${text}${suffix}`,
      media: {
        attached: idx === 0 && input.creative !== null,
        target: idx === 0 && input.creative !== null ? "this_part" : "none",
        altText: input.creative?.altText ?? null,
      },
    };
  });

  // Provider-native warnings
  if (renderedParts.length > 25) {
    warnings.push(
      "X: very long thread (>25 parts) tends to lose readers; consider trimming.",
    );
  }

  const routing: Record<string, string | null> = {};
  if (shape.replyTarget?.url) routing.reply_to_url = shape.replyTarget.url;
  if (shape.replyTarget?.externalId)
    routing.reply_to_post_id = shape.replyTarget.externalId;
  if (shape.quoteTarget?.url) routing.quote_url = shape.quoteTarget.url;
  if (shape.quoteTarget?.externalId)
    routing.quote_post_id = shape.quoteTarget.externalId;
  if (totalParts > 1) routing.thread_part_count = String(totalParts);

  return {
    platform: "x",
    intent: shape.intent,
    format,
    parts: renderedParts,
    warnings,
    blockers,
    routing: Object.keys(routing).length > 0 ? routing : undefined,
  };
}

export const xAdapter: PlatformNativeAdapter = {
  platform: "x",
  capabilities: X_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(X_CAPABILITIES, shape),
};
