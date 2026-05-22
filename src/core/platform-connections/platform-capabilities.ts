import type { PlatformId } from "@/types";

export const PLATFORM_CAPABILITIES = [
  "read_profile",
  "read_metrics",
  "draft_only",
  "publish_post",
  "publish_comment",
  "schedule_post",
  "media_upload",
  "read_mentions",
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export type CapabilityState =
  | "future"
  | "planned"
  | "limited"
  | "unavailable"
  | "available";

export type SupportedChannel = PlatformId | "google";

export interface CapabilityMatrixEntry {
  capability: PlatformCapability;
  state: CapabilityState;
  note?: string;
}

export interface PlatformCapabilityProfile {
  channel: SupportedChannel;
  label: string;
  shortDescription: string;
  publishingModel: "social_publishing" | "search_discoverability";
  capabilities: CapabilityMatrixEntry[];
}

export const PLATFORM_CAPABILITY_PROFILES: Record<
  SupportedChannel,
  PlatformCapabilityProfile
> = {
  reddit: {
    channel: "reddit",
    label: "Reddit",
    shortDescription:
      "Community-first. Comments and discussion, not promotion.",
    publishingModel: "social_publishing",
    capabilities: [
      { capability: "read_profile", state: "planned" },
      { capability: "draft_only", state: "available" },
      { capability: "publish_post", state: "future" },
      { capability: "publish_comment", state: "future" },
      { capability: "schedule_post", state: "future" },
      { capability: "read_metrics", state: "limited", note: "Reddit's API is restrictive." },
      { capability: "read_mentions", state: "future" },
    ],
  },
  x: {
    channel: "x",
    label: "X",
    shortDescription: "Founder voice. Replies, short posts, threads.",
    publishingModel: "social_publishing",
    capabilities: [
      { capability: "read_profile", state: "planned" },
      { capability: "draft_only", state: "available" },
      { capability: "publish_post", state: "future" },
      { capability: "publish_comment", state: "future" },
      { capability: "schedule_post", state: "future" },
      { capability: "read_metrics", state: "future", note: "Depends on API access tier." },
      { capability: "read_mentions", state: "future" },
    ],
  },
  linkedin: {
    channel: "linkedin",
    label: "LinkedIn",
    shortDescription: "B2B trust. Long-form, professional voice.",
    publishingModel: "social_publishing",
    capabilities: [
      { capability: "read_profile", state: "planned" },
      { capability: "draft_only", state: "available" },
      { capability: "publish_post", state: "limited" },
      { capability: "publish_comment", state: "limited" },
      { capability: "schedule_post", state: "future" },
      { capability: "read_metrics", state: "future" },
      { capability: "read_mentions", state: "future" },
    ],
  },
  google: {
    channel: "google",
    label: "Google visibility",
    shortDescription:
      "Discoverability and content freshness — not a publishing surface.",
    publishingModel: "search_discoverability",
    capabilities: [
      { capability: "read_metrics", state: "future", note: "Requires official API access." },
    ],
  },
};

export const CAPABILITY_LABELS: Record<PlatformCapability, string> = {
  read_profile: "Read profile",
  read_metrics: "Read metrics",
  draft_only: "Draft assistance",
  publish_post: "Publish a post",
  publish_comment: "Publish a comment",
  schedule_post: "Schedule a post",
  media_upload: "Upload media",
  read_mentions: "Read mentions",
};

export const STATE_LABELS: Record<CapabilityState, string> = {
  available: "Available",
  planned: "Planned",
  limited: "Limited",
  future: "Future",
  unavailable: "Not available",
};
