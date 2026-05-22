import type { NetworkProfile } from "./network-profile";
import type { PublishingWindow, WorkspaceRegion } from "./workspace-region";

/**
 * Compact, render-safe view of a workspace's geo configuration. Strips
 * credentials and any field that does not belong in the UI.
 */
export interface GeoOperationContext {
  workspaceRegion: WorkspaceRegion;
  networkProfile: NetworkProfile | null;
  derivedPublishingWindow: PublishingWindow | null;
  notes: string[];
}

export interface RegionConsistencyReason {
  signal:
    | "timezone_alignment"
    | "publishing_window_consistency"
    | "region_stability"
    | "routing_stability"
    | "cadence_consistency"
    | "language_alignment";
  weight: number;
  ok: boolean;
  detail: string;
}

export interface RegionConsistencySummary {
  score: number;
  level: "stable" | "drifting" | "inconsistent";
  reasons: RegionConsistencyReason[];
  summary: string;
}
