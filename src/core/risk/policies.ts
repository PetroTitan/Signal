export const PROMOTIONAL_PHRASES = [
  "best",
  "guaranteed",
  "100%",
  "secret",
  "hack",
  "trick",
  "explode",
  "viral",
  "skyrocket",
  "magic",
];

export const COMPARATIVE_PHRASES = [
  "better than",
  "made me cry",
  "killed",
  "destroyed",
  "obliterate",
  "alternative to",
];

export const PLATFORM_TONE_ALLOWANCE = {
  reddit: 0.15,
  x: 0.4,
  linkedin: 0.7,
} as const;

export const RISK_THRESHOLDS = {
  low: 25,
  medium: 55,
  high: 80,
};

export interface RiskInput {
  hasOutboundLink: boolean;
  ctaPresent: boolean;
  promotionalPhraseCount: number;
  comparativePhraseCount: number;
  duplicateHookCount: number;
  domainRepetitionCount: number;
  platformOverloaded: boolean;
  platformApproachingMax: boolean;
  accountSameDayCount: number;
  accountCooldownConflict: boolean;
  accountStatusReady: boolean;
  accountWarming: boolean;
  productRiskTolerance: "conservative" | "balanced" | "assertive";
  ctaStyle:
    | "no_cta"
    | "soft_mention"
    | "contextual_link"
    | "direct_signup";
  synchronizedWithinMinutes: number | null;
}
