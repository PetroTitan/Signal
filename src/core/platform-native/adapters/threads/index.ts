/**
 * Phase F6.3 — Threads (Meta) platform-native adapter.
 *
 * Manual-distribution surface in Signal today. Adapter models the
 * provider payload accurately.
 *
 * Isolation
 * ---------
 * Imports only the shared platform-native domain + text utilities.
 *
 * Provider semantics
 * ------------------
 *   - per-post hard limit: 500 characters
 *   - thread = explicit `intent: "thread"` OR `intent: "new_post"
 *     with thread_mode: "auto_thread_allowed"`. Never silent split.
 *   - reply: requires reply_target with a post id or URL
 *   - media_post: single image/video + caption
 *   - quote: not supported (Threads has no native quote primitive)
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

const THREADS_HARD_LIMIT = 500;
const THREADS_THREAD_SUFFIX_RESERVE = 5;

const THREADS_CAPABILITIES: PlatformCapabilities = {
  platform: "threads",
  supportedIntents: new Set([
    "new_post",
    "thread",
    "reply",
    "media_post",
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
    "media_required",
    "platform_default",
  ]),
  requiresMedia: false,
  requiresTarget: false,
  requiresTitle: false,
  budgets: { perPartUnit: "chars", perPartBudget: THREADS_HARD_LIMIT },
  reply: { supported: true, targetKind: "post_id" },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(THREADS_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  const plain = stripMarkdownToPlain(input.body ?? "").trim();
  if (plain.length === 0 && shape.intent !== "unknown") {
    blockers.push({
      code: "empty_body",
      message: "Threads: post needs body text.",
    });
  }

  if (
    shape.intent === "media_post" &&
    (!input.creative || (!input.creative.assetUrl && !input.creative.sourceUrl))
  ) {
    blockers.push({
      code: "media_required_for_media_post",
      message:
        "Threads: media_post intent requires an attached creative.",
    });
  }

  const allowsThread =
    shape.intent === "thread" ||
    shape.threadMode === "auto_thread_allowed" ||
    shape.threadMode === "manual_thread";

  let parts: string[];
  let format: ProviderPayloadFormat;
  if (shape.intent === "thread") {
    format = "thread";
    parts = splitIntoTextChunks(
      plain,
      THREADS_HARD_LIMIT - THREADS_THREAD_SUFFIX_RESERVE,
    );
    if (parts.length < 2) {
      blockers.push({
        code: "thread_requires_multiple_parts",
        message: `Threads: thread intent requires more than one part (body produced ${parts.length}).`,
      });
    }
  } else if (shape.intent === "reply") {
    format = "reply";
    parts = [plain.slice(0, THREADS_HARD_LIMIT)];
    if (!shape.replyTarget || (!shape.replyTarget.externalId && !shape.replyTarget.url)) {
      blockers.push({
        code: "reply_target_required",
        message:
          "Threads: reply intent requires reply_target with a post_id or URL.",
      });
    }
  } else if (shape.intent === "media_post") {
    format = "media_post";
    parts = [plain.slice(0, THREADS_HARD_LIMIT)];
  } else if (plain.length > THREADS_HARD_LIMIT) {
    if (allowsThread) {
      format = "thread";
      parts = splitIntoTextChunks(
        plain,
        THREADS_HARD_LIMIT - THREADS_THREAD_SUFFIX_RESERVE,
      );
    } else {
      format = "single_post";
      parts = [plain.slice(0, THREADS_HARD_LIMIT)];
      blockers.push({
        code: "threads_post_exceeds_budget",
        message: `Threads: body is ${plain.length} chars; per-post limit is ${THREADS_HARD_LIMIT}. Either shorten the body or set thread_mode=auto_thread_allowed.`,
      });
    }
  } else {
    format = "single_post";
    parts = plain.length > 0 ? [plain] : [];
  }

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

  const routing: Record<string, string | null> = {};
  if (shape.replyTarget?.url) routing.reply_to_url = shape.replyTarget.url;
  if (shape.replyTarget?.externalId)
    routing.reply_to_post_id = shape.replyTarget.externalId;
  if (totalParts > 1) routing.thread_part_count = String(totalParts);

  return {
    platform: "threads",
    intent: shape.intent,
    format,
    parts: renderedParts,
    warnings,
    blockers,
    routing: Object.keys(routing).length > 0 ? routing : undefined,
  };
}

export const threadsAdapter: PlatformNativeAdapter = {
  platform: "threads",
  capabilities: THREADS_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(THREADS_CAPABILITIES, shape),
};
