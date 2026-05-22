export const WORKSPACE_REGION_SCHEMA_VERSION = 1;

export const SUPPORTED_REGIONS = [
  "us_east",
  "us_central",
  "us_west",
  "eu_west",
  "eu_central",
  "uk",
  "jp",
  "apac",
  "global",
] as const;

export type SupportedRegion = (typeof SUPPORTED_REGIONS)[number];

export const REGION_LABELS: Record<SupportedRegion, string> = {
  us_east: "United States — East",
  us_central: "United States — Central",
  us_west: "United States — West",
  eu_west: "Europe — West",
  eu_central: "Europe — Central",
  uk: "United Kingdom",
  jp: "Japan",
  apac: "APAC",
  global: "Global",
};

export const GEO_MODES = [
  "local_only",
  "regional_operations",
  "international_operations",
] as const;

export type GeoMode = (typeof GEO_MODES)[number];

export const GEO_MODE_LABELS: Record<GeoMode, string> = {
  local_only: "Local only",
  regional_operations: "Regional operations",
  international_operations: "International operations",
};

export const GEO_MODE_DESCRIPTIONS: Record<GeoMode, string> = {
  local_only:
    "Operate in a single region. Publishing windows and tone stay local.",
  regional_operations:
    "Operate within a single broad region (e.g. US, EU, APAC). Routing stays stable.",
  international_operations:
    "Operate across multiple regions. Each platform connection sets its own stable region.",
};

export interface PublishingWindow {
  label: string;
  startHourLocal: number;
  endHourLocal: number;
  daysOfWeek: number[];
}

export interface WorkspaceRegion {
  schemaVersion: number;
  workspaceId: string;
  workspaceRegion: SupportedRegion;
  timezone: string;
  primaryLanguage: string;
  publishingRegion: SupportedRegion;
  regionalRoutingEnabled: boolean;
  networkProfileId: string | null;
  preferredPublishingWindows: PublishingWindow[];
  geoMode: GeoMode;
  regionConsistencyScore: number;
  lastUpdatedAt: string;
  active: boolean;
}

export const WORKSPACE_REGION_LIMITS = {
  publishingWindowsMax: 6,
  publishingWindowLabelMax: 60,
} as const;
