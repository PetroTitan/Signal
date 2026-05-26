/**
 * Phase F6.3 — Reddit platform-native adapter.
 *
 * Provider-native preview + validation. Reddit has a live publisher
 * (publish-reddit.ts) but that file is untouched by this PR — a
 * later per-platform PR wires the publisher to consult this adapter.
 *
 * Isolation
 * ---------
 * Imports only shared platform-native domain + text utilities.
 * Never imports another adapter, the publisher, the scheduler, or
 * any cross-platform middleware.
 *
 * Provider semantics
 * ------------------
 *   - submission types: text (selftext), link (URL post), media
 *   - subreddit is REQUIRED for every new submission
 *   - title is REQUIRED, max 300 chars
 *   - selftext (text post body) up to ~40,000 chars; soft warn at 10k
 *   - link_post requires an outbound URL
 *   - comment/reply requires a parent target (t1_xxx or t3_xxx)
 *   - no thread, no quote — those are not Reddit-native shapes
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

const REDDIT_TITLE_LIMIT = 300;
const REDDIT_SELFTEXT_HARD_LIMIT = 40_000;
const REDDIT_SELFTEXT_SOFT_LIMIT = 10_000;

const REDDIT_CAPABILITIES: PlatformCapabilities = {
  platform: "reddit",
  // Reddit's "text post" maps to new_post; link/media/comment/reply
  // are first-class. Quote / thread are NOT native to Reddit.
  supportedIntents: new Set([
    "new_post",
    "link_post",
    "media_post",
    "comment",
    "reply",
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
  requiresTarget: true,
  requiresTitle: true,
  // Reddit selftext is measured in chars; we expose the per-PART
  // budget that matters for the operator (selftext hard limit).
  budgets: { perPartUnit: "chars", perPartBudget: REDDIT_SELFTEXT_HARD_LIMIT },
  reply: { supported: true, targetKind: "post_id" },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(REDDIT_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  // Subreddit target required for every submission intent (NOT
  // for comment/reply — those are parent-based).
  const isSubmission =
    shape.intent === "new_post" ||
    shape.intent === "link_post" ||
    shape.intent === "media_post";
  const target = (input.target ?? "").trim();
  if (isSubmission && shape.intent !== "unknown" && target.length === 0) {
    blockers.push({
      code: "subreddit_required",
      message:
        "Reddit: every submission requires a subreddit. Set the target (without the r/ prefix).",
    });
  }

  // Title required for submissions.
  const title = (input.title ?? "").trim();
  if (isSubmission && shape.intent !== "unknown" && title.length === 0) {
    blockers.push({
      code: "title_required",
      message: "Reddit: submission title is required.",
    });
  } else if (title.length > REDDIT_TITLE_LIMIT) {
    blockers.push({
      code: "reddit_title_exceeds_budget",
      message: `Reddit: title is ${title.length} chars; the limit is ${REDDIT_TITLE_LIMIT}.`,
    });
  }

  // Body: markdown preserved for text posts; for previews we render
  // a plain-text view alongside the markdown (Reddit accepts both
  // selftext-markdown and rich-text; the publisher sends markdown).
  const plainBody = stripMarkdownToPlain(input.body ?? "");

  let format: ProviderPayloadFormat;
  const parts: ProviderPayloadPart[] = [];

  if (shape.intent === "link_post") {
    format = "link_post";
    if (!input.linkUrl || input.linkUrl.trim().length === 0) {
      blockers.push({
        code: "link_required_for_link_post",
        message:
          "Reddit: link_post intent requires an outbound URL. Provide link_url.",
      });
    }
    parts.push({
      index: 1,
      text: title || "(no title)",
      media: { attached: false, target: "none", altText: null },
    });
  } else if (shape.intent === "media_post") {
    format = "media_post";
    if (!input.creative || (!input.creative.assetUrl && !input.creative.sourceUrl)) {
      blockers.push({
        code: "media_required_for_media_post",
        message:
          "Reddit: media_post intent requires an attached creative.",
      });
    }
    parts.push({
      index: 1,
      text: title || "(no title)",
      media: {
        attached: input.creative !== null,
        target: input.creative !== null ? "this_part" : "none",
        altText: input.creative?.altText ?? null,
      },
    });
  } else if (shape.intent === "comment" || shape.intent === "reply") {
    format = "reply";
    if (!shape.replyTarget || (!shape.replyTarget.externalId && !shape.replyTarget.url)) {
      blockers.push({
        code: "parent_target_required",
        message:
          "Reddit: comment/reply intent requires reply_target with a parent post / comment id (t3_… or t1_…).",
      });
    }
    if (plainBody.length === 0) {
      blockers.push({
        code: "empty_body",
        message: "Reddit: comment/reply needs body text.",
      });
    }
    parts.push({
      index: 1,
      text: plainBody,
      media: { attached: false, target: "none", altText: null },
    });
  } else {
    // new_post (text submission) — selftext.
    format = "single_post";
    if (plainBody.length === 0 && shape.intent !== "unknown") {
      // text post with empty body is allowed for "title-only" posts;
      // surface as warning, not blocker.
      warnings.push(
        "Reddit: selftext is empty — this will publish as a title-only submission.",
      );
    } else if (plainBody.length > REDDIT_SELFTEXT_HARD_LIMIT) {
      blockers.push({
        code: "reddit_selftext_exceeds_budget",
        message: `Reddit: selftext is ${plainBody.length} chars; the limit is ${REDDIT_SELFTEXT_HARD_LIMIT}.`,
      });
    } else if (plainBody.length > REDDIT_SELFTEXT_SOFT_LIMIT) {
      warnings.push(
        `Reddit: selftext is ${plainBody.length} chars; long posts (>${REDDIT_SELFTEXT_SOFT_LIMIT}) often get TLDR'd.`,
      );
    }
    parts.push({
      index: 1,
      text: plainBody,
      media: { attached: false, target: "none", altText: null },
    });
  }

  const routing: Record<string, string | null> = {};
  if (target.length > 0) routing.subreddit = target;
  if (title.length > 0) routing.title = title;
  if (shape.intent === "link_post") routing.link_url = input.linkUrl ?? null;
  if (shape.replyTarget?.externalId)
    routing.parent_id = shape.replyTarget.externalId;
  if (shape.replyTarget?.url) routing.parent_url = shape.replyTarget.url;

  return {
    platform: "reddit",
    intent: shape.intent,
    format,
    parts,
    warnings,
    blockers,
    routing: Object.keys(routing).length > 0 ? routing : undefined,
  };
}

export const redditAdapter: PlatformNativeAdapter = {
  platform: "reddit",
  capabilities: REDDIT_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(REDDIT_CAPABILITIES, shape),
};
