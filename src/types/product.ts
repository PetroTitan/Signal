import type { PlatformId } from "./platform";

export type ProductCategory =
  | "analytics"
  | "finance"
  | "communication"
  | "productivity"
  | "utility"
  | "consulting";

export type CtaStyle =
  | "no_cta"
  | "soft_mention"
  | "contextual_link"
  | "direct_signup";

export type RiskTolerance = "conservative" | "balanced" | "assertive";

export interface ProductProfile {
  id: string;
  slug: string;
  name: string;
  domain: string;
  category: ProductCategory;
  positioning: string;
  targetAudience: string[];
  preferredPlatforms: PlatformId[];
  ctaStyle: CtaStyle;
  allowedCtaCopy: string[];
  forbiddenClaims: string[];
  riskTolerance: RiskTolerance;
  contentStyle: string;
  trackingMetadata: {
    utmSource: string;
    utmMediumByPlatform: Record<PlatformId, string>;
    campaignPrefix: string;
  };
}
