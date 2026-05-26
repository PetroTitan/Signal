/**
 * Phase F6.3 — Instagram platform-native adapter.
 *
 * Manual-distribution surface (Signal does not call the IG API).
 * Adapter still models the provider payload accurately so the
 * compose-modal summary shows the operator exactly what they'll
 * post.
 *
 * Isolation
 * ---------
 * Imports only the shared platform-native domain + text utilities.
 *
 * Provider semantics
 * ------------------
 *   - media_post: one image/video + caption ≤ 2200 chars
 *   - carousel: 2–10 media slides + single caption; expectedPartCount
 *     drives the slide count
 *   - story (reserved) / short_video (reserved): adapter accepts the
 *     intent but emits format=unknown until those PRs land
 *   - media is REQUIRED for every Instagram intent (no text-only)
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

const IG_CAPTION_HARD_LIMIT = 2200;
const IG_CAPTION_SOFT_LIMIT = 1200;
const IG_CAROUSEL_MIN = 2;
const IG_CAROUSEL_MAX = 10;

const INSTAGRAM_CAPABILITIES: PlatformCapabilities = {
  platform: "instagram",
  supportedIntents: new Set([
    "media_post",
    "carousel",
    "story",
    "short_video",
    "unknown",
  ]),
  supportedThreadModes: new Set(["single_only", "none", "platform_default"]),
  supportedMediaModes: new Set([
    "first_part_only",
    "every_part",
    "media_required",
    "platform_default",
  ]),
  requiresMedia: true,
  requiresTarget: false,
  requiresTitle: false,
  budgets: { perPartUnit: "chars", perPartBudget: IG_CAPTION_HARD_LIMIT },
  reply: { supported: false, targetKind: null },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(INSTAGRAM_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  // Media required for every Instagram intent except `unknown`
  // (legacy). The shared validator already catches the
  // mediaMode=none case; here we additionally check creative.
  const hasCreative =
    input.creative !== null &&
    Boolean(input.creative.assetUrl || input.creative.sourceUrl);
  if (shape.intent !== "unknown" && !hasCreative) {
    blockers.push({
      code: "media_required",
      message:
        "Instagram: every post requires attached media. Attach a creative or change intent.",
    });
  }

  const caption = stripMarkdownToPlain(input.body ?? "").trim();
  if (caption.length > IG_CAPTION_HARD_LIMIT) {
    blockers.push({
      code: "caption_exceeds_budget",
      message: `Instagram: caption is ${caption.length} chars; the limit is ${IG_CAPTION_HARD_LIMIT}.`,
    });
  } else if (caption.length > IG_CAPTION_SOFT_LIMIT) {
    warnings.push(
      `Instagram: caption is ${caption.length} chars; readers see only the first ~${IG_CAPTION_SOFT_LIMIT} before "more".`,
    );
  }

  let format: ProviderPayloadFormat;
  const parts: ProviderPayloadPart[] = [];
  const routing: Record<string, string | null> = {};

  if (shape.intent === "carousel") {
    format = "media_post"; // carousel = multi-slide media post
    const slides = shape.expectedPartCount ?? 0;
    if (slides < IG_CAROUSEL_MIN) {
      blockers.push({
        code: "carousel_too_few_items",
        message: `Instagram: carousel requires at least ${IG_CAROUSEL_MIN} slides (expected_part_count=${slides}).`,
      });
    }
    if (slides > IG_CAROUSEL_MAX) {
      blockers.push({
        code: "carousel_too_many_items",
        message: `Instagram: carousel supports at most ${IG_CAROUSEL_MAX} slides (expected_part_count=${slides}).`,
      });
    }
    const renderedSlides = Math.max(
      IG_CAROUSEL_MIN,
      Math.min(IG_CAROUSEL_MAX, slides || IG_CAROUSEL_MIN),
    );
    for (let i = 0; i < renderedSlides; i++) {
      parts.push({
        index: i + 1,
        text: i === 0 ? caption : "",
        media: {
          attached: hasCreative,
          // Carousel: every slide carries its own media; current
          // preview attaches the cover creative to slide 1 only —
          // future PR extends to per-slide creatives.
          target: i === 0 && hasCreative ? "this_part" : "none",
          altText: i === 0 ? input.creative?.altText ?? null : null,
        },
      });
    }
    routing.carousel_count = String(renderedSlides);
  } else if (shape.intent === "story" || shape.intent === "short_video") {
    format = "unknown"; // reserved
    warnings.push(
      `Instagram: ${shape.intent} intent is reserved for a future adapter PR.`,
    );
  } else {
    // media_post (single image/video) or unknown (legacy)
    format = "media_post";
    parts.push({
      index: 1,
      text: caption,
      media: {
        attached: hasCreative,
        target: hasCreative ? "this_part" : "none",
        altText: input.creative?.altText ?? null,
      },
    });
  }

  if (caption.length === 0 && shape.intent !== "unknown") {
    warnings.push(
      "Instagram: caption is empty — many feeds get better reach with a short caption.",
    );
  }

  return {
    platform: "instagram",
    intent: shape.intent,
    format,
    parts,
    warnings,
    blockers,
    routing: Object.keys(routing).length > 0 ? routing : undefined,
  };
}

export const instagramAdapter: PlatformNativeAdapter = {
  platform: "instagram",
  capabilities: INSTAGRAM_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(INSTAGRAM_CAPABILITIES, shape),
};
