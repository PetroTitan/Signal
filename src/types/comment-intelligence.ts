import type { PlatformId } from "./platform";
import type { GuardrailFlag } from "./content-intelligence";

export type DiscussionContext = "subreddit_thread" | "x_thread" | "linkedin_post";

export type ParticipationRecommendation = "participate" | "watch" | "skip";

export type CommunityFitLevel = "strong" | "medium" | "weak" | "off_topic";

export interface CommunityFitSignal {
  level: CommunityFitLevel;
  reason: string;
}

export interface ThreadParticipationSignal {
  freshness: "active" | "settling" | "cold";
  audienceMatch: "aligned" | "adjacent" | "off";
  noise: "low" | "medium" | "high";
}

export interface DiscussionOpportunity {
  id: string;
  platform: PlatformId;
  context: DiscussionContext;
  contextLabel: string;
  threadTitle: string;
  threadSummary: string;
  question: string;
  url: string | null;
  topicTags: string[];
  matchedInsightIds: string[];
  communityFit: CommunityFitSignal;
  participation: ThreadParticipationSignal;
  participationScore: number;
  recommendation: ParticipationRecommendation;
  skipReason?: string;
  ageHours: number;
}

export type ConversationRiskLevel = "low" | "medium" | "high" | "blocked";

export interface ConversationRisk {
  level: ConversationRiskLevel;
  reasons: string[];
  recommendation: string;
}

export interface CommentDraft {
  id: string;
  opportunityId: string;
  platform: PlatformId;
  body: string;
  toneStrength: "calm" | "moderate";
  hasLink: boolean;
  guardrailFlags: GuardrailFlag[];
  risk: ConversationRisk;
}

export interface ReplyDraft {
  id: string;
  opportunityId: string;
  platform: PlatformId;
  body: string;
  toneStrength: "calm" | "moderate";
  guardrailFlags: GuardrailFlag[];
  risk: ConversationRisk;
}

export interface ParticipationRecommendationCard {
  id: string;
  opportunityId: string;
  platform: PlatformId;
  text: string;
  level: "info" | "warn" | "block";
}
