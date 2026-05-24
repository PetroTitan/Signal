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
