import {
  NETWORK_PROFILE_SCHEMA_VERSION,
  WORKSPACE_REGION_SCHEMA_VERSION,
  type NetworkProfile,
  type NetworkProfileSummary,
  type WorkspaceRegion,
} from "@/types/geo";
import { defaultWindowsForRegion } from "./timezone-routing";

const NOW = "2026-01-01T00:00:00.000Z";

export const MOCK_WORKSPACE_REGION: WorkspaceRegion = {
  schemaVersion: WORKSPACE_REGION_SCHEMA_VERSION,
  workspaceId: "ws_helperg",
  workspaceRegion: "us_east",
  timezone: "America/New_York",
  primaryLanguage: "en-US",
  publishingRegion: "us_east",
  regionalRoutingEnabled: false,
  networkProfileId: null,
  preferredPublishingWindows: defaultWindowsForRegion("us_east"),
  geoMode: "local_only",
  regionConsistencyScore: 1,
  lastUpdatedAt: NOW,
  active: true,
};

export const MOCK_NETWORK_PROFILES: NetworkProfile[] = [];

/**
 * Masks a NetworkProfile down to fields safe to render in any client surface.
 * Strips username and any password-shaped field.
 */
export function summarizeNetworkProfile(
  profile: NetworkProfile,
): NetworkProfileSummary {
  return {
    id: profile.id,
    label: profile.label,
    region: profile.region,
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    hasCredentials: Boolean(profile.username),
    active: profile.active,
  };
}

export const NETWORK_PROFILE_VERSION_NOTE = `schemaVersion=${NETWORK_PROFILE_SCHEMA_VERSION}`;
