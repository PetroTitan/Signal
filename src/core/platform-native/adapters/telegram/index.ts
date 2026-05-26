/**
 * Phase F6.3 — Telegram platform-native adapter.
 *
 * Provider-native preview + validation. Telegram has a live
 * publisher (publish-telegram.ts) but that file is untouched.
 *
 * Isolation
 * ---------
 * Imports only the shared platform-native domain + text utilities.
 *
 * Provider semantics
 * ------------------
 *   - channel_message / group_message (modelled as new_post): plain
 *     text up to 4096 chars per message; NO silent truncation
 *   - media_message (modelled as media_post): image/document with
 *     optional caption up to 1024 chars
 *   - target REQUIRED: chat / channel id, sourced from the
 *     identity's handle in production (passed via input.target)
 *   - no threads, no replies, no quotes
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
import { stripMarkdownToPlain } from "../../text-utils";
import type { AdapterRenderInput, PlatformNativeAdapter } from "../types";

const TELEGRAM_TEXT_HARD_LIMIT = 4096;
const TELEGRAM_CAPTION_HARD_LIMIT = 1024;

const TELEGRAM_CAPABILITIES: PlatformCapabilities = {
  platform: "telegram",
  supportedIntents: new Set(["new_post", "media_post", "unknown"]),
  supportedThreadModes: new Set(["single_only", "none", "platform_default"]),
  supportedMediaModes: new Set([
    "none",
    "first_part_only",
    "media_required",
    "platform_default",
  ]),
  requiresMedia: false,
  requiresTarget: true,
  requiresTitle: false,
  budgets: { perPartUnit: "chars", perPartBudget: TELEGRAM_TEXT_HARD_LIMIT },
  reply: { supported: false, targetKind: null },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(TELEGRAM_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  // Telegram requires a target (channel @username or chat id).
  // Falls back to identity.handle (the production wiring sets the
  // chat id on growth_accounts.handle).
  const target = (input.target ?? input.identity.handle ?? "").trim();
  if (target.length === 0 && shape.intent !== "unknown") {
    blockers.push({
      code: "telegram_target_required",
      message:
        "Telegram: every message requires a chat / channel target (sourced from the identity's handle or input.target).",
    });
  }

  const plain = stripMarkdownToPlain(input.body ?? "").trim();
  let format: ProviderPayloadFormat;
  const parts: ProviderPayloadPart[] = [];

  if (shape.intent === "media_post") {
    format = "media_post";
    if (!input.creative || (!input.creative.assetUrl && !input.creative.sourceUrl)) {
      blockers.push({
        code: "media_required_for_media_post",
        message:
          "Telegram: media_post intent requires an attached creative.",
      });
    }
    if (plain.length > TELEGRAM_CAPTION_HARD_LIMIT) {
      blockers.push({
        code: "telegram_caption_exceeds_budget",
        message: `Telegram: caption is ${plain.length} chars; the per-media caption limit is ${TELEGRAM_CAPTION_HARD_LIMIT}.`,
      });
    }
    parts.push({
      index: 1,
      text: plain,
      media: {
        attached: input.creative !== null,
        target: input.creative !== null ? "this_part" : "none",
        altText: input.creative?.altText ?? null,
      },
    });
  } else {
    // new_post / unknown — text message.
    format = "single_post";
    if (plain.length === 0 && shape.intent !== "unknown") {
      blockers.push({
        code: "empty_body",
        message: "Telegram: message needs body text.",
      });
    }
    if (plain.length > TELEGRAM_TEXT_HARD_LIMIT) {
      blockers.push({
        code: "telegram_message_exceeds_budget",
        message: `Telegram: message is ${plain.length} chars; the per-message limit is ${TELEGRAM_TEXT_HARD_LIMIT}. Telegram will NOT auto-truncate — operator must shorten or split manually.`,
      });
    }
    parts.push({
      index: 1,
      text: plain,
      media: { attached: false, target: "none", altText: null },
    });
  }

  const routing: Record<string, string | null> = {};
  if (target.length > 0) routing.chat_target = target;

  return {
    platform: "telegram",
    intent: shape.intent,
    format,
    parts,
    warnings,
    blockers,
    routing: Object.keys(routing).length > 0 ? routing : undefined,
  };
}

export const telegramAdapter: PlatformNativeAdapter = {
  platform: "telegram",
  capabilities: TELEGRAM_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(TELEGRAM_CAPABILITIES, shape),
};
