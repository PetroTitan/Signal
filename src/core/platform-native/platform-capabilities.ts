/**
 * Phase F6.0 — platform capability matrix.
 *
 * Each platform-native adapter advertises what it supports. Callers
 * (preview UI, MCP write paths, publish gates) use this matrix to
 * validate an operator's PlatformNativeShape before any provider
 * call.
 *
 * Boundary rule — capabilities are a DECLARATIVE contract. They
 * describe what an adapter can validate; they do NOT carry behavior.
 * No splitting rules here, no markdown stripping, no media policy
 * specifics. Those live inside each adapter.
 */

import type { PublishPlatform } from "@/core/publishing/publishing-types";
import type {
  MediaMode,
  PlatformNativeShape,
  ProviderPayloadBlocker,
  PublishingIntent,
  ThreadMode,
} from "./publishing-intent";

export type ReplyTargetKind = "uri+cid" | "post_id" | "comment_id" | null;
export type QuoteTargetKind = "uri+cid" | "post_id" | null;

export interface PlatformCapabilities {
  platform: PublishPlatform;
  /** Empty set means "no intents supported yet" — typical for stub
   *  adapters. Callers must NOT infer intents from absence. */
  supportedIntents: ReadonlySet<PublishingIntent>;
  supportedThreadModes: ReadonlySet<ThreadMode>;
  supportedMediaModes: ReadonlySet<MediaMode>;
  requiresMedia: boolean;
  requiresTarget: boolean;
  requiresTitle: boolean;
  budgets: {
    perPartUnit: "graphemes" | "chars";
    /** Null when the adapter doesn't enforce a per-part budget yet. */
    perPartBudget: number | null;
  };
  reply: { supported: boolean; targetKind: ReplyTargetKind };
  quote: { supported: boolean; targetKind: QuoteTargetKind };
  /**
   * True when the adapter is a stub — capability=unknown. UI surfaces
   * use this to render "Legacy payload mode" / "Stub adapter — provider
   * shape not yet modeled" badges. Stub adapters MUST set this true.
   */
  stub: boolean;
}

/**
 * Validate a PlatformNativeShape against a capability matrix.
 * Returns the list of blockers; an empty list means valid.
 *
 * Pure. No I/O. The shape's `operatorApprovedShapeHash` is NOT
 * validated here — that's the publisher's job at publish time via
 * isApprovedPayloadStillCurrent.
 *
 * Stub adapters return a single blocker for any non-legacy shape;
 * legacy shape (intent="unknown") is the one shape stubs accept.
 */
export function validateShapeAgainstCapabilities(
  capabilities: PlatformCapabilities,
  shape: PlatformNativeShape,
): ProviderPayloadBlocker[] {
  const blockers: ProviderPayloadBlocker[] = [];

  if (capabilities.platform !== shape.platform) {
    blockers.push({
      code: "platform_mismatch",
      message: `Shape targets platform "${shape.platform}" but adapter is for "${capabilities.platform}".`,
    });
    // Hard mismatch — no point checking the rest.
    return blockers;
  }

  // Stub adapters: the only valid shape is the legacy/unknown sentinel.
  // Stubs deliberately do NOT pretend to support any intent.
  if (capabilities.stub) {
    if (shape.intent !== "unknown") {
      blockers.push({
        code: "adapter_not_implemented",
        message: `${shape.platform}: platform-native adapter is a stub. Intent "${shape.intent}" cannot be validated until the adapter ships. Operator approval cannot bind to a provider shape yet.`,
      });
    }
    return blockers;
  }

  if (!capabilities.supportedIntents.has(shape.intent)) {
    blockers.push({
      code: "intent_not_supported",
      message: `${shape.platform}: intent "${shape.intent}" is not supported by this adapter.`,
    });
  }
  if (!capabilities.supportedThreadModes.has(shape.threadMode)) {
    blockers.push({
      code: "thread_mode_not_supported",
      message: `${shape.platform}: threadMode "${shape.threadMode}" is not supported.`,
    });
  }
  if (!capabilities.supportedMediaModes.has(shape.mediaMode)) {
    blockers.push({
      code: "media_mode_not_supported",
      message: `${shape.platform}: mediaMode "${shape.mediaMode}" is not supported.`,
    });
  }
  // Legacy/unknown rows never trigger requiresMedia — they predate
  // platform-native intent and would otherwise become permanently
  // blocked. Adapters that need to enforce media for SPECIFIC intents
  // (e.g. Instagram media_post) do so in their own validate/preview
  // path; this shared rule fires only when the operator has chosen a
  // real intent.
  if (
    capabilities.requiresMedia &&
    shape.intent !== "unknown" &&
    (shape.mediaMode === "none" || shape.mediaMode === "platform_default")
  ) {
    blockers.push({
      code: "media_required",
      message: `${shape.platform}: this platform requires attached media. Set mediaMode to first_part_only or every_part.`,
    });
  }
  if (shape.replyTarget !== null && !capabilities.reply.supported) {
    blockers.push({
      code: "reply_not_supported",
      message: `${shape.platform}: replies are not supported by this adapter yet.`,
    });
  }
  if (shape.quoteTarget !== null && !capabilities.quote.supported) {
    blockers.push({
      code: "quote_not_supported",
      message: `${shape.platform}: quotes are not supported by this adapter yet.`,
    });
  }
  if (
    shape.intent === "reply" &&
    capabilities.reply.supported &&
    shape.replyTarget === null
  ) {
    blockers.push({
      code: "reply_target_missing",
      message: `${shape.platform}: reply intent requires a replyTarget with externalId or url.`,
    });
  }
  if (
    shape.intent === "quote" &&
    capabilities.quote.supported &&
    shape.quoteTarget === null
  ) {
    blockers.push({
      code: "quote_target_missing",
      message: `${shape.platform}: quote intent requires a quoteTarget with externalId or url.`,
    });
  }
  if (
    shape.intent === "thread" &&
    shape.expectedPartCount !== null &&
    shape.expectedPartCount < 2
  ) {
    blockers.push({
      code: "thread_part_count_invalid",
      message: `${shape.platform}: thread intent requires expectedPartCount >= 2 (got ${shape.expectedPartCount}).`,
    });
  }
  return blockers;
}
