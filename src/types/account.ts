import type { PlatformId } from "./platform";

export type AccountRole =
  | "founder"
  | "product"
  | "support"
  | "research"
  | "community";

export type AccountStatus =
  | "planned"
  | "setup_needed"
  | "awaiting_manual_creation"
  | "ready_to_connect"
  | "connected"
  | "warming"
  | "active"
  | "paused";

export type ChecklistCategory =
  | "kit"
  | "manual"
  | "security"
  | "profile"
  | "oauth"
  | "planning";

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  category: ChecklistCategory;
}

export type WarmUpFocus =
  | "observation"
  | "comments"
  | "replies"
  | "first_post"
  | "thread"
  | "long_form";

export interface WarmUpDay {
  day: number;
  focus: WarmUpFocus;
  description: string;
}

export interface SetupKit {
  usernameIdeas: string[];
  displayNameSuggestions: string[];
  bioSuggestions: string[];
  aboutText: string;
  avatarBrief: string;
  coverBrief: string;
  contentIdeas: string[];
  commentIdeas: string[];
  warmUpDays: WarmUpDay[];
  toneReminders: string[];
  cadenceNote: string;
  pinnedPostIdea: string | null;
  featuredLinkSuggestion: string | null;
  subredditDiscovery: string[];
  checklist: ChecklistItem[];
  generatedAt: string;
}

export type AccountSetupProfile = SetupKit;

export interface GrowthAccount {
  id: string;
  platform: PlatformId;
  productId: string;
  role: AccountRole;
  handle: string | null;
  displayName: string;
  status: AccountStatus;
  readinessScore: number;
  oauthConnected: boolean;
  setup: SetupKit;
  createdAt: string;
  lastActivityAt: string | null;
}

export const ELIGIBLE_FOR_PLANNING: AccountStatus[] = [
  "warming",
  "active",
  "connected",
  "ready_to_connect",
];

export const NOT_ELIGIBLE_FOR_PLANNING: AccountStatus[] = [
  "planned",
  "setup_needed",
  "awaiting_manual_creation",
  "paused",
];

export function isEligibleForPlanning(status: AccountStatus): boolean {
  return ELIGIBLE_FOR_PLANNING.includes(status);
}
