/**
 * Phase F6.0 — Bluesky platform-native adapter (REAL).
 *
 * Wraps the existing shared payload module
 * (src/core/publishing/bluesky-payload.ts) and converts its result
 * into the canonical ProviderPayloadPreview shape that the
 * platform-native layer consumes.
 *
 * Why this is "real" while the other nine adapters are stubs
 * ----------------------------------------------------------
 * Bluesky is the only platform where preview and publish already
 * share a payload module (PR #105). Wrapping that module in the
 * adapter contract is a thin translation, not a rewrite. Other
 * platforms will get real adapters in their own follow-up PRs so
 * each provider's behavior stays isolated.
 *
 * Isolation
 * ---------
 * This file imports ONLY Bluesky-specific code and the shared
 * platform-native types. It MUST NOT import from another adapter
 * folder.
 */

import {
  BLUESKY_POST_BUDGET,
  prepareBlueskyThreadPayload,
} from "@/core/publishing/bluesky-payload";
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
import type { AdapterRenderInput, PlatformNativeAdapter } from "../types";

const BLUESKY_CAPABILITIES: PlatformCapabilities = {
  platform: "bluesky",
  supportedIntents: new Set(["new_post", "thread", "unknown"]),
  supportedThreadModes: new Set([
    "single_only",
    "auto_thread_allowed",
    "platform_default",
  ]),
  supportedMediaModes: new Set([
    "none",
    "first_part_only",
    "platform_default",
  ]),
  requiresMedia: false,
  requiresTarget: false,
  requiresTitle: false,
  budgets: { perPartUnit: "graphemes", perPartBudget: BLUESKY_POST_BUDGET },
  // Reply and quote are deferred to follow-up Bluesky PRs. The
  // capability matrix advertises false so callers can't pretend
  // they're supported yet.
  reply: { supported: false, targetKind: "uri+cid" },
  quote: { supported: false, targetKind: "uri+cid" },
  stub: false,
};

function buildBluesky(input: AdapterRenderInput): ProviderPayloadPreview {
  const shape = input.shape;
  const shapeBlockers = validateShapeAgainstCapabilities(
    BLUESKY_CAPABILITIES,
    shape,
  );

  const warnings: string[] = [];
  const blockers: ProviderPayloadBlocker[] = [...shapeBlockers];

  // Shared payload module — same call the publisher makes. The
  // adapter is a pure translation; no provider mutation lives here.
  const payload = prepareBlueskyThreadPayload({
    title: input.title,
    body: input.body,
    creative: input.creative
      ? {
          id: null,
          assetUrl: input.creative.assetUrl,
          sourceUrl: input.creative.sourceUrl,
          altText: input.creative.altText,
          creativeType: input.creative.creativeType,
        }
      : null,
  });

  if (payload.kind === "empty_body") {
    blockers.push({
      code: "empty_body",
      message: payload.reasonDetail,
    });
    return {
      platform: "bluesky",
      intent: shape.intent,
      format: "unknown",
      parts: [],
      warnings,
      blockers,
    };
  }

  for (const note of payload.transformationNotes) warnings.push(note);

  if (payload.creativeBlocked) {
    blockers.push({
      code: payload.creativeBlocked.reasonCode,
      message: payload.creativeBlocked.reasonDetail,
    });
  }

  // single_only enforcement at the preview layer: surface a blocker
  // when the operator picked single but the body forces threading.
  // Foundation PR does NOT gate publishing on this — that's the
  // Bluesky shape-binding follow-up PR's job. The blocker shows up
  // in the preview so the operator can act.
  if (
    shape.threadMode === "single_only" &&
    payload.parts.length > 1
  ) {
    blockers.push({
      code: "single_only_exceeds_budget",
      message: `Body would split into ${payload.parts.length} parts but operator chose single_only. Shorten the body or change threadMode to auto_thread_allowed.`,
    });
  }

  // expectedPartCount mismatch is a soft signal — surface but don't
  // block here (publish-time enforcement is the follow-up PR).
  if (
    shape.intent === "thread" &&
    shape.expectedPartCount !== null &&
    shape.expectedPartCount !== payload.parts.length
  ) {
    warnings.push(
      `Expected ${shape.expectedPartCount} thread parts, renderer produced ${payload.parts.length}.`,
    );
  }

  const parts: ProviderPayloadPart[] = payload.parts.map((p) => ({
    index: p.index,
    text: p.text,
    media: {
      attached: p.attachMedia,
      target: p.attachMedia ? "this_part" : "none",
      altText: payload.media?.altText ?? null,
    },
  }));

  const format: ProviderPayloadFormat =
    parts.length === 0
      ? "unknown"
      : parts.length === 1
        ? "single_post"
        : "thread";

  return {
    platform: "bluesky",
    intent: shape.intent,
    format,
    parts,
    warnings,
    blockers,
  };
}

export const blueskyAdapter: PlatformNativeAdapter = {
  platform: "bluesky",
  capabilities: BLUESKY_CAPABILITIES,
  buildPreview: buildBluesky,
  // Bluesky's preview and publish share a payload module by design.
  // Returning the same shape guarantees the payload hash matches
  // across both surfaces — the canonical preview/publish parity.
  buildPublishPayload: buildBluesky,
  validateShape: (shape) =>
    validateShapeAgainstCapabilities(BLUESKY_CAPABILITIES, shape),
};
