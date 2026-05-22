import type { PlatformId, RiskScore } from "@/types";
import type { AiUseCase } from "./ai-use-cases";

interface BaseContract {
  useCase: AiUseCase;
  description: string;
  maxOutputChars: number;
  allowedTone: ("calm" | "moderate" | "direct")[];
  blockedClaims: string[];
  requiredDisclaimers: string[];
}

export interface RewriteSofterContract extends BaseContract {
  useCase: "rewrite_softer";
  input: {
    text: string;
    knownHooks?: string[];
  };
}

export interface DraftVariantContract extends BaseContract {
  useCase: "draft_variant";
  input: {
    insightTitle: string;
    insightBody: string;
    platform: PlatformId;
    contentType: string;
    productPositioning?: string;
    allowedCtaCopy?: string[];
  };
}

export interface CommentPolishContract extends BaseContract {
  useCase: "comment_polish";
  input: {
    threadTitle: string;
    threadSummary: string;
    draftBody: string;
    platform: PlatformId;
  };
}

export interface InsightExtractionContract extends BaseContract {
  useCase: "insight_extraction";
  input: {
    rawObservation: string;
    productContext?: string;
  };
}

export interface PlatformAdaptationContract extends BaseContract {
  useCase: "platform_adaptation";
  input: {
    insightTitle: string;
    insightBody: string;
    targetPlatforms: PlatformId[];
  };
}

export interface SummarizeOpportunityContract extends BaseContract {
  useCase: "summarize_opportunity";
  input: {
    opportunityTitle: string;
    rationale: string;
  };
}

export interface RiskExplanationContract extends BaseContract {
  useCase: "explain_risk";
  input: {
    risk: RiskScore;
    hook: string;
    body: string;
  };
}

export interface ConvertToCommentContract extends BaseContract {
  useCase: "convert_post_to_comment";
  input: {
    postBody: string;
    cta?: string | null;
    hasLink: boolean;
  };
}

export interface RemovePromotionalToneContract extends BaseContract {
  useCase: "remove_promotional_tone";
  input: {
    text: string;
  };
}

export interface GenerateTitleOptionsContract extends BaseContract {
  useCase: "generate_title_options";
  input: {
    body: string;
    platform: PlatformId;
    count?: number;
  };
}

export type AiContract =
  | RewriteSofterContract
  | DraftVariantContract
  | CommentPolishContract
  | InsightExtractionContract
  | PlatformAdaptationContract
  | SummarizeOpportunityContract
  | RiskExplanationContract
  | ConvertToCommentContract
  | RemovePromotionalToneContract
  | GenerateTitleOptionsContract;

export type AiContractFor<U extends AiUseCase> = Extract<AiContract, { useCase: U }>;
export type AiInputFor<U extends AiUseCase> = AiContractFor<U>["input"];

const sharedBlockedClaims = [
  "guaranteed results",
  "100% safe",
  "viral",
  "10x growth",
  "best in class",
  "fake testimonials",
  "invented metrics",
  "policy bypass",
];

const sharedDisclaimers = [
  "AI output requires human approval before publication.",
];

export const AI_CONTRACTS: Record<AiUseCase, BaseContract> = {
  rewrite_softer: {
    useCase: "rewrite_softer",
    description: "Soften promotional tone while preserving meaning.",
    maxOutputChars: 600,
    allowedTone: ["calm", "moderate"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
  draft_variant: {
    useCase: "draft_variant",
    description:
      "Produce one platform-native draft variant from a source insight.",
    maxOutputChars: 1200,
    allowedTone: ["calm", "moderate"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
  comment_polish: {
    useCase: "comment_polish",
    description:
      "Polish a comment for community fit. May return should_post=false.",
    maxOutputChars: 400,
    allowedTone: ["calm"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
  insight_extraction: {
    useCase: "insight_extraction",
    description: "Convert a raw observation into a SourceInsight shape.",
    maxOutputChars: 800,
    allowedTone: ["calm"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
  platform_adaptation: {
    useCase: "platform_adaptation",
    description:
      "Produce platform-specific variants for an insight across target platforms.",
    maxOutputChars: 1800,
    allowedTone: ["calm", "moderate"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
  summarize_opportunity: {
    useCase: "summarize_opportunity",
    description: "One-line summary of an opportunity row.",
    maxOutputChars: 200,
    allowedTone: ["calm"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: [],
  },
  explain_risk: {
    useCase: "explain_risk",
    description: "Explain a risk score in operator language.",
    maxOutputChars: 500,
    allowedTone: ["calm"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: [],
  },
  convert_post_to_comment: {
    useCase: "convert_post_to_comment",
    description:
      "Convert a planned post into a comment by removing CTAs and links.",
    maxOutputChars: 400,
    allowedTone: ["calm"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
  remove_promotional_tone: {
    useCase: "remove_promotional_tone",
    description: "Strip promotional language while keeping the message intent.",
    maxOutputChars: 600,
    allowedTone: ["calm"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
  generate_title_options: {
    useCase: "generate_title_options",
    description: "Produce a small set of restrained title options.",
    maxOutputChars: 300,
    allowedTone: ["calm", "moderate"],
    blockedClaims: sharedBlockedClaims,
    requiredDisclaimers: sharedDisclaimers,
  },
};
