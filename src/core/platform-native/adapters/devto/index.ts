/**
 * Phase F6.3 — dev.to platform-native adapter.
 *
 * Provider-native preview + validation. dev.to has a live publisher
 * (publish-devto.ts) but that file is untouched by this PR.
 *
 * Isolation
 * ---------
 * Imports only the shared platform-native domain.
 *
 * Provider semantics
 * ------------------
 *   - article-only (no social-post shape on dev.to)
 *   - title required, max 128 chars
 *   - body is markdown verbatim (NOT stripped — adapters that publish
 *     to markdown surfaces preserve the body)
 *   - tags optional, max 4, alphanumeric + dashes only
 *   - canonical URL optional
 *   - cover image optional (modelled via `creative`)
 *   - threads / replies / quotes are not native to dev.to
 */

import {
  validateShapeAgainstCapabilities,
  type PlatformCapabilities,
} from "../../platform-capabilities";
import type {
  ProviderPayloadBlocker,
  ProviderPayloadPart,
  ProviderPayloadPreview,
} from "../../publishing-intent";
import type { AdapterRenderInput, PlatformNativeAdapter } from "../types";

const DEVTO_TITLE_LIMIT = 128;
const DEVTO_MAX_TAGS = 4;
const DEVTO_TAG_PATTERN = /^[a-z0-9-]+$/;

const DEVTO_CAPABILITIES: PlatformCapabilities = {
  platform: "devto",
  supportedIntents: new Set(["article", "unknown"]),
  supportedThreadModes: new Set(["none", "platform_default"]),
  supportedMediaModes: new Set(["none", "first_part_only", "platform_default"]),
  requiresMedia: false,
  requiresTarget: false,
  requiresTitle: true,
  // dev.to article body has no documented hard char limit. Adapter
  // exposes `null` to communicate "no per-part budget".
  budgets: { perPartUnit: "chars", perPartBudget: null },
  reply: { supported: false, targetKind: null },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(DEVTO_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  const title = (input.title ?? "").trim();
  // Article body is markdown — preserved verbatim, NOT stripped.
  const body = (input.body ?? "").trim();

  if (shape.intent === "article" || shape.intent === "unknown") {
    if (title.length === 0 && shape.intent !== "unknown") {
      blockers.push({
        code: "article_title_required",
        message: "dev.to: article title is required.",
      });
    } else if (title.length > DEVTO_TITLE_LIMIT) {
      blockers.push({
        code: "devto_title_exceeds_budget",
        message: `dev.to: title is ${title.length} chars; the limit is ${DEVTO_TITLE_LIMIT}.`,
      });
    }
    if (body.length === 0 && shape.intent !== "unknown") {
      blockers.push({
        code: "article_body_required",
        message: "dev.to: article body cannot be empty.",
      });
    }
  }

  // Tag validation (provider-native — dev.to enforces these rules
  // server-side; surfacing them as blockers prevents a server-side
  // rejection at publish time).
  const tags = (input.tags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const invalidTags = tags.filter((t) => !DEVTO_TAG_PATTERN.test(t));
  if (invalidTags.length > 0) {
    blockers.push({
      code: "devto_tag_format_invalid",
      message: `dev.to: tags must be alphanumeric + dashes only. Invalid: ${invalidTags.join(", ")}.`,
    });
  }
  if (tags.length > DEVTO_MAX_TAGS) {
    warnings.push(
      `dev.to: ${tags.length} tags supplied; only the first ${DEVTO_MAX_TAGS} will be sent.`,
    );
  }

  const parts: ProviderPayloadPart[] = [
    {
      index: 1,
      text: body,
      media: {
        attached: input.creative !== null,
        target: input.creative !== null ? "this_part" : "none",
        altText: input.creative?.altText ?? null,
      },
    },
  ];

  const routing: Record<string, string | null> = {};
  routing.article_title = title || null;
  if (tags.length > 0) routing.tags_csv = tags.slice(0, DEVTO_MAX_TAGS).join(",");
  if (input.creative?.assetUrl) routing.cover_image_url = input.creative.assetUrl;

  return {
    platform: "devto",
    intent: shape.intent,
    format: shape.intent === "article" ? "article" : "unknown",
    parts,
    warnings,
    blockers,
    routing,
  };
}

export const devtoAdapter: PlatformNativeAdapter = {
  platform: "devto",
  capabilities: DEVTO_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(DEVTO_CAPABILITIES, shape),
};
