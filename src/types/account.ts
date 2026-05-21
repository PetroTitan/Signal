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

export interface AccountSetupProfile {
  usernameIdeas: string[];
  bioSuggestions: string[];
  avatarBrief: string;
  coverBrief: string;
  checklist: { label: string; done: boolean }[];
  warmUpPlan: string[];
}

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
  setup: AccountSetupProfile;
  createdAt: string;
  lastActivityAt: string | null;
}
