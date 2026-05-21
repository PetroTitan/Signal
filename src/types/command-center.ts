import type { AccountRole } from "./account";
import type { PlatformId } from "./platform";

export interface PlatformStrategy {
  platform: PlatformId;
  strategicRole: string;
  primaryGrowthObjective: string;
  toneVoice: string;
  shortDescription: string;
  longDescription: string;
  approvalBehavior: string;
  schedulingBehavior: string;
  analyticsExpectations: string;
}

export type CadenceMode = "calm" | "moderate" | "active";

export interface PlatformCadencePolicy {
  platform: PlatformId;
  minHoursBetweenPosts: number;
  suggestedPostsPerWeek: number;
  maxPostsPerWeek: number;
  cadenceMode: CadenceMode;
  notes: string[];
}

export type PromotionalLevel = "low" | "medium" | "high";

export interface PlatformContentFormat {
  id: string;
  label: string;
  description: string;
  promotionalLevel: PromotionalLevel;
  recommendedFor: AccountRole[] | "all";
}

export type RiskRuleSeverity = "low" | "medium" | "high";

export interface PlatformRiskRule {
  id: string;
  title: string;
  description: string;
  severity: RiskRuleSeverity;
  mitigation: string;
}

export type PlaybookModuleStatus = "active" | "passive" | "placeholder";

export interface PlatformPlaybookModule {
  id: string;
  title: string;
  description: string;
  status: PlaybookModuleStatus;
}

export interface PlatformPlaybook {
  platform: PlatformId;
  modules: PlatformPlaybookModule[];
}

export type OpportunitySource =
  | "subreddit"
  | "hook_bank"
  | "thread_seed"
  | "founder_narrative"
  | "case_study"
  | "reply_target";

export interface PlatformOpportunity {
  id: string;
  platform: PlatformId;
  title: string;
  detail: string;
  source: OpportunitySource;
}

export type ActionRecommendationLevel = "info" | "warn" | "block";

export interface PlatformActionRecommendation {
  id: string;
  platform: PlatformId;
  text: string;
  level: ActionRecommendationLevel;
}

export interface PlatformReadinessSnapshot {
  platform: PlatformId;
  accountsTotal: number;
  accountsEligible: number;
  accountsInSetup: number;
  averageAccountReadiness: number;
  overallScore: number;
  status: "ready" | "in_setup" | "blocked";
}

export interface PlatformCadenceLoadSummary {
  platform: PlatformId;
  count: number;
  suggested: number;
  max: number;
  utilization: number;
  isOver: boolean;
  isApproachingMax: boolean;
  mode: CadenceMode;
}

export interface PlatformCommandCenterView {
  platform: PlatformId;
  strategy: PlatformStrategy;
  cadence: PlatformCadencePolicy;
  cadenceLoad: PlatformCadenceLoadSummary;
  contentFormats: PlatformContentFormat[];
  riskRules: PlatformRiskRule[];
  playbook: PlatformPlaybook;
  opportunities: PlatformOpportunity[];
  recommendations: PlatformActionRecommendation[];
  readiness: PlatformReadinessSnapshot;
}
