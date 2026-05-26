/**
 * Phase F6.0 — stub adapter factory.
 *
 * Why this file exists
 * --------------------
 * Every platform must have its OWN adapter folder so that future
 * per-platform PRs land in isolation. But until a real adapter ships,
 * we need a zero-behavior stand-in that satisfies the boundary
 * without faking any capability.
 *
 * This factory produces exactly that: an adapter that advertises
 * `stub: true`, accepts only the legacy/unknown shape, and refuses
 * every other shape with a typed `adapter_not_implemented` blocker.
 *
 * Hard rules (the reason this factory is SHARED but isolated)
 * -----------------------------------------------------------
 *   - The factory NEVER calls into any per-platform transformer,
 *     preview module, or publisher. It is pure boundary scaffolding.
 *   - When a real adapter PR for platform X lands, it replaces the
 *     contents of adapters/x/index.ts WITHOUT touching this file or
 *     any other platform's stub. That's what isolation means here.
 *   - This factory MUST NOT be used by real adapters. Real adapters
 *     own their `buildPreview` / `buildPublishPayload` directly.
 */

import type { PublishPlatform } from "@/core/publishing/publishing-types";
import {
  validateShapeAgainstCapabilities,
  type PlatformCapabilities,
} from "../platform-capabilities";
import type {
  PlatformNativeShape,
  ProviderPayloadBlocker,
  ProviderPayloadPreview,
} from "../publishing-intent";
import type { AdapterRenderInput, PlatformNativeAdapter } from "./types";

function stubCapabilities(platform: PublishPlatform): PlatformCapabilities {
  return {
    platform,
    // Only "unknown" — stubs do NOT fake support for any intent.
    supportedIntents: new Set(["unknown"]),
    supportedThreadModes: new Set(["platform_default"]),
    supportedMediaModes: new Set(["platform_default"]),
    requiresMedia: false,
    requiresTarget: false,
    requiresTitle: false,
    // Null budget — stubs advertise no per-part limit because they
    // don't know the platform's real budget yet.
    budgets: { perPartUnit: "graphemes", perPartBudget: null },
    reply: { supported: false, targetKind: null },
    quote: { supported: false, targetKind: null },
    stub: true,
  };
}

function notImplementedBlocker(
  platform: PublishPlatform,
): ProviderPayloadBlocker {
  return {
    code: "adapter_not_implemented",
    message: `${platform}: platform-native adapter is a stub. Operator approval cannot bind to a provider shape until the per-platform adapter PR ships.`,
  };
}

export function makeStubAdapter(
  platform: PublishPlatform,
): PlatformNativeAdapter {
  const capabilities = stubCapabilities(platform);

  function build(input: AdapterRenderInput): ProviderPayloadPreview {
    const shapeBlockers = validateShapeAgainstCapabilities(
      capabilities,
      input.shape,
    );
    const blockers: ProviderPayloadBlocker[] = [...shapeBlockers];
    // Even for the legacy/unknown shape, include the
    // not-implemented blocker so any caller that tries to publish a
    // stub preview is refused at the contract layer.
    blockers.push(notImplementedBlocker(platform));
    return {
      platform,
      intent: input.shape.intent,
      format: "unknown",
      parts: [],
      warnings: [],
      blockers,
    };
  }

  function validate(shape: PlatformNativeShape): ProviderPayloadBlocker[] {
    return validateShapeAgainstCapabilities(capabilities, shape);
  }

  return {
    platform,
    capabilities,
    buildPreview: build,
    buildPublishPayload: build,
    validateShape: validate,
  };
}
