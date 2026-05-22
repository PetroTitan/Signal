export const AI_SAFETY_BLOCKED_OUTPUTS = [
  "fake_metrics",
  "fake_testimonials",
  "fake_user_numbers",
  "fake_partnerships",
  "unsupported_claims",
  "aggressive_spam_ctas",
  "platform_bypass_suggestions",
  "engagement_manipulation_instructions",
  "comment_spam",
  "account_farming_workflows",
] as const;

export type AiBlockedOutput = (typeof AI_SAFETY_BLOCKED_OUTPUTS)[number];

export const AI_SAFETY_PREFERRED = [
  "softer_language",
  "no_link_versions",
  "discussion_first_framing",
  "human_approval",
  "skip_recommendation_when_appropriate",
] as const;

export type AiSafetyPreferred = (typeof AI_SAFETY_PREFERRED)[number];

export const AI_SAFETY_NOTES = [
  "AI output is recommendation, not action. Human approval is structural.",
  "AI must never generate engagement-manipulation instructions.",
  "AI must never invent numbers, testimonials, or partnerships.",
  "AI must prefer no-link, discussion-first framings on Reddit.",
  "AI must offer a skip recommendation when no real signal exists.",
];

export interface SafetyCheck {
  blocked: boolean;
  flags: AiBlockedOutput[];
  note?: string;
}

const aggressiveSnippets = [
  "guaranteed",
  "you will go viral",
  "10x your followers",
  "secret trick",
  "this one hack",
  "fake users",
  "buy followers",
];

const claimsRequiringEvidence = [
  /trusted by \d+/i,
  /\d+x growth/i,
  /\d+,?\d+\+? users/i,
  /\d+,?\d+\+? customers/i,
];

export function quickSafetyCheck(text: string): SafetyCheck {
  const flags = new Set<AiBlockedOutput>();
  const lower = text.toLowerCase();
  for (const snippet of aggressiveSnippets) {
    if (lower.includes(snippet)) flags.add("aggressive_spam_ctas");
  }
  for (const re of claimsRequiringEvidence) {
    if (re.test(text)) {
      flags.add("fake_metrics");
      flags.add("unsupported_claims");
    }
  }
  return {
    blocked: flags.has("aggressive_spam_ctas") || flags.has("fake_metrics"),
    flags: Array.from(flags),
  };
}
