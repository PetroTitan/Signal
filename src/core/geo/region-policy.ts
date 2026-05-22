import type { SupportedRegion } from "@/types/geo";

export interface RegionMetadata {
  region: SupportedRegion;
  label: string;
  defaultTimezone: string;
  defaultLanguage: string;
  businessHoursStartLocal: number;
  businessHoursEndLocal: number;
  cadenceProfile: "us_business" | "eu_business" | "jp_calm" | "apac_mixed" | "global";
}

export const REGION_METADATA: Record<SupportedRegion, RegionMetadata> = {
  us_east: {
    region: "us_east",
    label: "United States — East",
    defaultTimezone: "America/New_York",
    defaultLanguage: "en-US",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 17,
    cadenceProfile: "us_business",
  },
  us_central: {
    region: "us_central",
    label: "United States — Central",
    defaultTimezone: "America/Chicago",
    defaultLanguage: "en-US",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 17,
    cadenceProfile: "us_business",
  },
  us_west: {
    region: "us_west",
    label: "United States — West",
    defaultTimezone: "America/Los_Angeles",
    defaultLanguage: "en-US",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 17,
    cadenceProfile: "us_business",
  },
  eu_west: {
    region: "eu_west",
    label: "Europe — West",
    defaultTimezone: "Europe/Paris",
    defaultLanguage: "en-GB",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 18,
    cadenceProfile: "eu_business",
  },
  eu_central: {
    region: "eu_central",
    label: "Europe — Central",
    defaultTimezone: "Europe/Berlin",
    defaultLanguage: "en-GB",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 18,
    cadenceProfile: "eu_business",
  },
  uk: {
    region: "uk",
    label: "United Kingdom",
    defaultTimezone: "Europe/London",
    defaultLanguage: "en-GB",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 18,
    cadenceProfile: "eu_business",
  },
  jp: {
    region: "jp",
    label: "Japan",
    defaultTimezone: "Asia/Tokyo",
    defaultLanguage: "ja-JP",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 18,
    cadenceProfile: "jp_calm",
  },
  apac: {
    region: "apac",
    label: "APAC",
    defaultTimezone: "Asia/Singapore",
    defaultLanguage: "en-SG",
    businessHoursStartLocal: 9,
    businessHoursEndLocal: 18,
    cadenceProfile: "apac_mixed",
  },
  global: {
    region: "global",
    label: "Global",
    defaultTimezone: "UTC",
    defaultLanguage: "en",
    businessHoursStartLocal: 8,
    businessHoursEndLocal: 20,
    cadenceProfile: "global",
  },
};

/**
 * The principles every geo decision in Signal obeys. These are operational
 * constraints, not stealth or anti-detect rules. Signal does not rotate
 * regions, spoof anything, or mask intent.
 */
export const REGION_POLICY_PRINCIPLES = [
  "A workspace has one stable region. No random country switching.",
  "Routing is workspace-level, not per-request. No rotation pools.",
  "Outbound network profiles are optional. Most workspaces never need one.",
  "Regional routing never bypasses approval, cadence, or risk checks.",
  "Region changes are logged. The consistency engine flags unstable switching.",
  "Credentials are never present in the client; the UI sees masked placeholders.",
] as const;
