/**
 * Platform-native content engine — public surface.
 */

export type {
  CreativeDirection,
  MediaType,
  PlatformNativeDraft,
  PlatformNativeFormat,
  PlatformRiskLevel,
  PlatformStyleProfile,
  AdaptIdeaInput,
  AdaptIdeaIdentity,
  AdaptIdeaProduct,
  AdaptIdeaResult,
} from "./types";

export {
  PLATFORM_STYLE_PROFILES,
  getPlatformStyleProfile,
} from "./style-profiles";

export {
  PLATFORM_CREATIVE_DIRECTION,
  getCreativeDirection,
} from "./creative-direction";

export {
  PLATFORM_FORBIDDEN_PATTERNS,
  getForbiddenPatterns,
  scanForPlatformViolations,
} from "./forbidden-patterns";
export type { PlatformViolation } from "./forbidden-patterns";

export {
  buildPlatformShape,
  buildCtaInstruction,
  buildNewAccountAddendum,
} from "./prompt-shape";

export { detectCrossPlatformCopypaste } from "./cross-platform-differentiation";

export {
  adaptIdeaForPlatform,
  finalizeAdaptation,
} from "./adapt-idea-for-platform";

// =====================================================================
// Phase F6.0 — platform-native publishing intent (shared core).
//
// The provider-agnostic surface for "what should publish, how, and
// where media goes." Per-platform behavior lives behind the adapter
// boundary in ./adapters/<platform>/. Nothing here imports from a
// specific adapter except the registry.
// =====================================================================

export {
  PUBLISHING_INTENTS,
  THREAD_MODES,
  MEDIA_MODES,
  PROVIDER_PAYLOAD_FORMATS,
  isPublishingIntent,
  isThreadMode,
  isMediaMode,
  legacyPlatformNativeShape,
  parsePlatformNativeShape,
  serializePlatformNativeShape,
} from "./publishing-intent";
export type {
  PublishingIntent,
  ThreadMode,
  MediaMode,
  PlatformNativeShape,
  ProviderPayloadFormat,
  ProviderPayloadPart,
  ProviderPayloadBlocker,
  ProviderPayloadPreview,
  ReplyTarget,
  QuoteTarget,
} from "./publishing-intent";

export {
  computeProviderPayloadHash,
  isApprovedPayloadStillCurrent,
} from "./payload-hash";

export { validateShapeAgainstCapabilities } from "./platform-capabilities";
export type {
  PlatformCapabilities,
  ReplyTargetKind,
  QuoteTargetKind,
} from "./platform-capabilities";

export {
  getPlatformAdapter,
  listPlatformAdapters,
} from "./adapters/registry";
export type {
  PlatformNativeAdapter,
  AdapterRenderInput,
  AdapterIdentity,
  AdapterCreative,
} from "./adapters/types";
