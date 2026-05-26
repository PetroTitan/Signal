/**
 * Phase F6.3 — LinkedIn platform-native adapter.
 *
 * Manual-distribution surface in Signal today; the operator pastes
 * into LinkedIn's composer. The adapter models the provider payload
 * accurately so a future live-publish PR can swap publishers in
 * without touching this contract.
 *
 * Isolation
 * ---------
 * Imports only the shared platform-native domain + text utilities.
 *
 * Provider semantics
 * ------------------
 *   - feed post (new_post): plain text up to ~3000 chars with soft
 *     truncation at the "see more" boundary (~1300 chars)
 *   - article (article): long-form, title required, markdown body
 *   - media_post: image / video upload; caption optional
 *   - link_post: shared URL with preview card
 *   - threading: not native; refuse split intents
 *   - reply / quote: not supported in this PR
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

const LINKEDIN_FEED_HARD_LIMIT = 3000;
const LINKEDIN_FEED_SOFT_LIMIT = 1300;
const LINKEDIN_ARTICLE_TITLE_LIMIT = 150;

const LINKEDIN_CAPABILITIES: PlatformCapabilities = {
  platform: "linkedin",
  supportedIntents: new Set([
    "new_post",
    "article",
    "media_post",
    "link_post",
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
  requiresTitle: false, // true for article-only — enforced in preview
  budgets: { perPartUnit: "chars", perPartBudget: LINKEDIN_FEED_HARD_LIMIT },
  reply: { supported: false, targetKind: null },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(LINKEDIN_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  const title = (input.title ?? "").trim();
  const plain = stripMarkdownToPlain(input.body ?? "").trim();

  let format: ProviderPayloadFormat;
  const parts: ProviderPayloadPart[] = [];
  const routing: Record<string, string | null> = {};

  if (shape.intent === "article") {
    format = "article";
    if (title.length === 0) {
      blockers.push({
        code: "article_title_required",
        message: "LinkedIn: article intent requires a title.",
      });
    } else if (title.length > LINKEDIN_ARTICLE_TITLE_LIMIT) {
      blockers.push({
        code: "linkedin_article_title_exceeds_budget",
        message: `LinkedIn: article title is ${title.length} chars; recommended max is ${LINKEDIN_ARTICLE_TITLE_LIMIT}.`,
      });
    }
    if (plain.length === 0) {
      blockers.push({
        code: "article_body_required",
        message: "LinkedIn: article body cannot be empty.",
      });
    }
    routing.article_title = title || null;
    parts.push({
      index: 1,
      text: plain,
      media: {
        attached: input.creative !== null,
        target: input.creative !== null ? "this_part" : "none",
        altText: input.creative?.altText ?? null,
      },
    });
  } else if (shape.intent === "link_post") {
    format = "link_post";
    if (!input.linkUrl || input.linkUrl.trim().length === 0) {
      blockers.push({
        code: "link_required_for_link_post",
        message:
          "LinkedIn: link_post intent requires an outbound URL. Provide link_url.",
      });
    }
    routing.link_url = input.linkUrl ?? null;
    parts.push({
      index: 1,
      text: plain,
      media: { attached: false, target: "none", altText: null },
    });
  } else if (shape.intent === "media_post") {
    format = "media_post";
    if (!input.creative || (!input.creative.assetUrl && !input.creative.sourceUrl)) {
      blockers.push({
        code: "media_required_for_media_post",
        message:
          "LinkedIn: media_post intent requires an attached creative.",
      });
    }
    if (plain.length > LINKEDIN_FEED_HARD_LIMIT) {
      blockers.push({
        code: "linkedin_post_exceeds_budget",
        message: `LinkedIn: caption is ${plain.length} chars; limit is ${LINKEDIN_FEED_HARD_LIMIT}.`,
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
  } else if (shape.intent === "new_post" || shape.intent === "unknown") {
    format = "single_post";
    if (plain.length === 0 && shape.intent !== "unknown") {
      blockers.push({
        code: "empty_body",
        message: "LinkedIn: feed post needs body text.",
      });
    }
    if (plain.length > LINKEDIN_FEED_HARD_LIMIT) {
      blockers.push({
        code: "linkedin_post_exceeds_budget",
        message: `LinkedIn: post is ${plain.length} chars; limit is ${LINKEDIN_FEED_HARD_LIMIT}. LinkedIn does not auto-truncate — operator must shorten.`,
      });
    } else if (plain.length > LINKEDIN_FEED_SOFT_LIMIT) {
      warnings.push(
        `LinkedIn: post is ${plain.length} chars; readers see only the first ~${LINKEDIN_FEED_SOFT_LIMIT} chars before "see more".`,
      );
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
    format = "unknown";
    warnings.push(
      `LinkedIn: intent "${shape.intent}" is not modeled by this adapter.`,
    );
  }

  return {
    platform: "linkedin",
    intent: shape.intent,
    format,
    parts,
    warnings,
    blockers,
    routing: Object.keys(routing).length > 0 ? routing : undefined,
  };
}

export const linkedinAdapter: PlatformNativeAdapter = {
  platform: "linkedin",
  capabilities: LINKEDIN_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(LINKEDIN_CAPABILITIES, shape),
};
