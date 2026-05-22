import type { SupportedRegion } from "@/types/geo";
import { REGION_METADATA } from "./region-policy";

export interface RegionalCadenceProfile {
  region: SupportedRegion;
  toneHints: string[];
  pacingHints: string[];
  discoverabilityHints: string[];
}

/**
 * Subtle, deterministic guidance per region. Not localization; not
 * translation. These hints feed into the platform_adaptation prompt
 * contract and are not stored as part of any account memory.
 */
export const REGIONAL_CADENCE_PROFILES: Record<SupportedRegion, RegionalCadenceProfile> = {
  us_east: {
    region: "us_east",
    toneHints: ["founder first-person", "specific over general"],
    pacingHints: ["match US business hours", "avoid late-night posts"],
    discoverabilityHints: ["consider US-centric search intent"],
  },
  us_central: {
    region: "us_central",
    toneHints: ["founder first-person", "warm and concrete"],
    pacingHints: ["match Central business hours"],
    discoverabilityHints: ["consider US-centric search intent"],
  },
  us_west: {
    region: "us_west",
    toneHints: ["founder first-person", "calm and confident"],
    pacingHints: ["match West Coast morning ramp"],
    discoverabilityHints: ["consider US-centric search intent"],
  },
  eu_west: {
    region: "eu_west",
    toneHints: ["measured", "operational"],
    pacingHints: ["respect European workday rhythm"],
    discoverabilityHints: ["consider EU search intent and language variants"],
  },
  eu_central: {
    region: "eu_central",
    toneHints: ["measured", "specific"],
    pacingHints: ["respect Central European workday rhythm"],
    discoverabilityHints: ["consider EU search intent and language variants"],
  },
  uk: {
    region: "uk",
    toneHints: ["measured", "concrete"],
    pacingHints: ["respect UK workday rhythm"],
    discoverabilityHints: ["consider UK search intent"],
  },
  jp: {
    region: "jp",
    toneHints: ["calm", "polite", "specific"],
    pacingHints: ["follow JST workday rhythm", "lower posting frequency"],
    discoverabilityHints: ["consider local Japanese search intent"],
  },
  apac: {
    region: "apac",
    toneHints: ["clear", "concrete", "neutral"],
    pacingHints: ["follow local APAC workday rhythm"],
    discoverabilityHints: ["consider regional search intent"],
  },
  global: {
    region: "global",
    toneHints: ["neutral", "specific"],
    pacingHints: ["distribute across major working hours"],
    discoverabilityHints: ["match search intent per audience"],
  },
};

export function cadenceProfileFor(
  region: SupportedRegion,
): RegionalCadenceProfile {
  return REGIONAL_CADENCE_PROFILES[region];
}

/**
 * Suggested daily posting volume per region. Calmer regions get smaller
 * defaults. These are guidance; the cadence engine still enforces the
 * workspace-level policy.
 */
export function suggestedDailyVolumeFor(region: SupportedRegion): number {
  switch (REGION_METADATA[region].cadenceProfile) {
    case "jp_calm":
      return 1;
    case "eu_business":
      return 2;
    case "us_business":
      return 2;
    case "apac_mixed":
      return 2;
    case "global":
      return 3;
  }
}
