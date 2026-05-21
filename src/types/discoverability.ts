export type FreshnessStatus =
  | "fresh"
  | "evergreen"
  | "needs_refresh"
  | "stale"
  | "under_promoted";

export type ContentAssetKind =
  | "blog_post"
  | "landing_page"
  | "case_study"
  | "guide"
  | "documentation"
  | "release_notes"
  | "comparison"
  | "tutorial";

export interface ContentAsset {
  id: string;
  productId: string;
  cluster: string;
  kind: ContentAssetKind;
  url: string;
  title: string;
  summary: string;
  publishedAt: string;
  updatedAt: string;
  freshness: FreshnessStatus;
  indexed: boolean;
  mockSearchPosition: number | null;
  internalLinks: { incoming: number; outgoing: number };
  amplification: {
    reddit: number;
    x: number;
    linkedin: number;
  };
  notes: string[];
}

export type DiscoverabilityOpportunityKind =
  | "low_amplification"
  | "search_to_social"
  | "social_to_search"
  | "topic_cluster_gap"
  | "freshness_refresh"
  | "internal_linking"
  | "evergreen_distribution";

export type DiscoverabilityImpact = "high" | "medium" | "low";

export interface DiscoverabilityOpportunity {
  id: string;
  kind: DiscoverabilityOpportunityKind;
  productId: string;
  cluster?: string;
  assetId?: string;
  title: string;
  detail: string;
  suggestedAction: string;
  impact: DiscoverabilityImpact;
}

export type YouTubeFormatKind =
  | "shorts"
  | "founder_video"
  | "community_update"
  | "long_form";

export interface YouTubeIdea {
  id: string;
  productId: string;
  kind: YouTubeFormatKind;
  title: string;
  description: string;
}

export interface YouTubeCadencePlan {
  productId: string;
  weeklyTarget: number;
  formats: YouTubeFormatKind[];
  notes: string;
}

export interface TopicalCluster {
  id: string;
  productId: string;
  label: string;
  assetCount: number;
  averageFreshnessScore: number;
  coverageGap: "covered" | "thin" | "missing";
  note: string;
}

export interface SearchVisibilitySnapshot {
  productId: string;
  totalAssets: number;
  indexedAssets: number;
  freshAssets: number;
  staleAssets: number;
  needsRefreshAssets: number;
  evergreenAssets: number;
  underPromotedAssets: number;
  averagePosition: number | null;
  discoverabilityScore: number;
}
