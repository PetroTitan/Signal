/**
 * Phase F6.3 — YouTube platform-native adapter.
 *
 * Manual-distribution surface in Signal today. Adapter models two
 * distinct YouTube payload shapes:
 *
 *   - video_post: a real video upload. Title required (≤ 100 chars);
 *                  description, thumbnail, tags optional.
 *   - new_post:   a community-tab post (text or text+image). Up to
 *                  ~5000 chars; treated as a single post.
 *
 * `short_video` reserved (Shorts) — adapter accepts the intent but
 * emits format=unknown until the Shorts PR lands.
 *
 * Isolation
 * ---------
 * Imports only the shared platform-native domain.
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

const YT_VIDEO_TITLE_LIMIT = 100;
const YT_VIDEO_DESCRIPTION_LIMIT = 5000;
const YT_COMMUNITY_POST_LIMIT = 5000;
const YT_MAX_TAGS = 12;

const YOUTUBE_CAPABILITIES: PlatformCapabilities = {
  platform: "youtube",
  supportedIntents: new Set([
    "video_post",
    "new_post", // = community post
    "short_video",
    "unknown",
  ]),
  supportedThreadModes: new Set(["single_only", "none", "platform_default"]),
  supportedMediaModes: new Set([
    "none",
    "first_part_only",
    "media_required",
    "platform_default",
  ]),
  requiresMedia: false,
  requiresTarget: false,
  requiresTitle: false,
  budgets: { perPartUnit: "chars", perPartBudget: YT_VIDEO_DESCRIPTION_LIMIT },
  reply: { supported: false, targetKind: null },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(YOUTUBE_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  const title = (input.title ?? "").trim();
  const plain = stripMarkdownToPlain(input.body ?? "").trim();
  const tags = (input.tags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  let format: ProviderPayloadFormat;
  const parts: ProviderPayloadPart[] = [];
  const routing: Record<string, string | null> = {};

  if (shape.intent === "video_post") {
    format = "video_post";
    if (title.length === 0) {
      blockers.push({
        code: "video_title_required",
        message: "YouTube: video upload requires a title.",
      });
    } else if (title.length > YT_VIDEO_TITLE_LIMIT) {
      blockers.push({
        code: "youtube_title_exceeds_budget",
        message: `YouTube: video title is ${title.length} chars; limit is ${YT_VIDEO_TITLE_LIMIT}.`,
      });
    }
    if (
      !input.creative ||
      (!input.creative.assetUrl && !input.creative.sourceUrl)
    ) {
      blockers.push({
        code: "video_required",
        message:
          "YouTube: video_post intent requires an attached video creative (or a thumbnail asset URL).",
      });
    }
    if (plain.length > YT_VIDEO_DESCRIPTION_LIMIT) {
      blockers.push({
        code: "youtube_description_exceeds_budget",
        message: `YouTube: description is ${plain.length} chars; limit is ${YT_VIDEO_DESCRIPTION_LIMIT}.`,
      });
    }
    routing.video_title = title || null;
    if (tags.length > 0) routing.tags_csv = tags.slice(0, YT_MAX_TAGS).join(",");
    if (input.creative?.assetUrl) routing.thumbnail_url = input.creative.assetUrl;
    parts.push({
      index: 1,
      text: plain,
      media: {
        attached: input.creative !== null,
        target: input.creative !== null ? "this_part" : "none",
        altText: input.creative?.altText ?? null,
      },
    });
  } else if (shape.intent === "new_post") {
    format = "single_post";
    if (plain.length === 0) {
      blockers.push({
        code: "empty_body",
        message: "YouTube: community post needs body text.",
      });
    } else if (plain.length > YT_COMMUNITY_POST_LIMIT) {
      blockers.push({
        code: "community_post_exceeds_budget",
        message: `YouTube: community post is ${plain.length} chars; limit is ${YT_COMMUNITY_POST_LIMIT}.`,
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
  } else if (shape.intent === "short_video") {
    format = "unknown"; // reserved
    warnings.push("YouTube: short_video intent is reserved for a future PR.");
  } else {
    // unknown / legacy
    format = "unknown";
    parts.push({
      index: 1,
      text: plain,
      media: { attached: false, target: "none", altText: null },
    });
  }

  return {
    platform: "youtube",
    intent: shape.intent,
    format,
    parts,
    warnings,
    blockers,
    routing: Object.keys(routing).length > 0 ? routing : undefined,
  };
}

export const youtubeAdapter: PlatformNativeAdapter = {
  platform: "youtube",
  capabilities: YOUTUBE_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(YOUTUBE_CAPABILITIES, shape),
};
