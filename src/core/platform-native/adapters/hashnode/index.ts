/**
 * Phase F6.3 — Hashnode platform-native adapter.
 *
 * Provider-native preview + validation. Hashnode has a live
 * publisher (publish-hashnode.ts) but that file is untouched by
 * this PR.
 *
 * Isolation
 * ---------
 * Imports only the shared platform-native domain.
 *
 * Provider semantics
 * ------------------
 *   - article-only
 *   - title required, max 250 chars
 *   - body is markdown verbatim (NOT stripped)
 *   - slug optional (derived from title at publish)
 *   - tags optional, up to 5
 *   - canonical URL optional
 *   - cover image optional
 *   - publicationId required at PUBLISH time (sourced from creds,
 *     not from the preview input — adapter does not assert this)
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

const HASHNODE_TITLE_LIMIT = 250;
const HASHNODE_MAX_TAGS = 5;

const HASHNODE_CAPABILITIES: PlatformCapabilities = {
  platform: "hashnode",
  supportedIntents: new Set(["article", "unknown"]),
  supportedThreadModes: new Set(["none", "platform_default"]),
  supportedMediaModes: new Set(["none", "first_part_only", "platform_default"]),
  requiresMedia: false,
  requiresTarget: false,
  requiresTitle: true,
  budgets: { perPartUnit: "chars", perPartBudget: null },
  reply: { supported: false, targetKind: null },
  quote: { supported: false, targetKind: null },
  stub: false,
};

function buildPreview(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const blockers: ProviderPayloadBlocker[] = [
    ...validateShapeAgainstCapabilities(HASHNODE_CAPABILITIES, shape),
  ];
  const warnings: string[] = [];

  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();

  if (shape.intent === "article" || shape.intent === "unknown") {
    if (title.length === 0 && shape.intent !== "unknown") {
      blockers.push({
        code: "article_title_required",
        message: "Hashnode: article title is required.",
      });
    } else if (title.length > HASHNODE_TITLE_LIMIT) {
      blockers.push({
        code: "hashnode_title_exceeds_budget",
        message: `Hashnode: title is ${title.length} chars; the limit is ${HASHNODE_TITLE_LIMIT}.`,
      });
    }
    if (body.length === 0 && shape.intent !== "unknown") {
      blockers.push({
        code: "article_body_required",
        message: "Hashnode: article body cannot be empty.",
      });
    }
  }

  const tags = (input.tags ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tags.length > HASHNODE_MAX_TAGS) {
    warnings.push(
      `Hashnode: ${tags.length} tags supplied; only the first ${HASHNODE_MAX_TAGS} will be sent.`,
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
  if (tags.length > 0)
    routing.tags_csv = tags.slice(0, HASHNODE_MAX_TAGS).join(",");
  if (input.creative?.assetUrl) routing.cover_image_url = input.creative.assetUrl;
  routing.slug_source = title || null; // derived at publish

  return {
    platform: "hashnode",
    intent: shape.intent,
    format: shape.intent === "article" ? "article" : "unknown",
    parts,
    warnings,
    blockers,
    routing,
  };
}

export const hashnodeAdapter: PlatformNativeAdapter = {
  platform: "hashnode",
  capabilities: HASHNODE_CAPABILITIES,
  buildPreview,
  buildPublishPayload: buildPreview,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(HASHNODE_CAPABILITIES, shape),
};
