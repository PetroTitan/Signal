import type {
  ConversationRisk,
  ConversationRiskLevel,
  DiscussionOpportunity,
  GuardrailFlag,
} from "@/types";
import { scanText } from "../content-intelligence/guardrails";

interface CommentRiskInput {
  body: string;
  hasLink: boolean;
  knownBodies: string[];
  opportunity?: DiscussionOpportunity;
}

const blockedFlagThreshold: GuardrailFlag[] = [
  "cta_too_aggressive",
  "launch_language",
  "fake_certainty",
];

export function scoreConversationRisk(input: CommentRiskInput): {
  risk: ConversationRisk;
  flags: GuardrailFlag[];
} {
  const report = scanText({
    hook: "",
    body: input.body,
    cta: null,
    knownHooks: [],
  });
  const flags = new Set<GuardrailFlag>(report.flags);
  const reasons: string[] = [...report.notes];
  let score = report.flags.length * 18;

  if (input.hasLink && input.opportunity?.platform === "reddit") {
    score += 30;
    reasons.push("Outbound link in a Reddit comment.");
  }

  if (
    input.opportunity &&
    input.opportunity.communityFit.level === "weak"
  ) {
    score += 25;
    reasons.push("Community fit is weak for this thread.");
  }

  if (input.knownBodies.some((b) => sharesPattern(b, input.body))) {
    flags.add("repeated_wording");
    score += 25;
    reasons.push("Body reuses phrasing from another recent comment.");
  }

  if (input.opportunity && input.opportunity.participation.noise === "high") {
    score += 10;
    reasons.push("Thread is noisy — wait for it to settle.");
  }

  if (
    input.opportunity &&
    input.opportunity.recommendation === "skip"
  ) {
    score += 40;
    reasons.push(
      input.opportunity.skipReason ??
        "Discussion engine recommends skipping this thread.",
    );
  }

  const level: ConversationRiskLevel = pickLevel(score, Array.from(flags));
  const recommendation = pickRecommendation(level, reasons);
  return {
    risk: { level, reasons, recommendation },
    flags: Array.from(flags),
  };
}

function pickLevel(
  score: number,
  flags: GuardrailFlag[],
): ConversationRiskLevel {
  if (flags.some((f) => blockedFlagThreshold.includes(f))) return "blocked";
  if (score >= 60) return "blocked";
  if (score >= 35) return "high";
  if (score >= 15) return "medium";
  return "low";
}

function pickRecommendation(
  level: ConversationRiskLevel,
  reasons: string[],
): string {
  switch (level) {
    case "blocked":
      return "Skip this discussion. Don't reply.";
    case "high":
      return reasons[0]
        ? `Rewrite softer or wait. ${reasons[0]}`
        : "Rewrite softer or wait before replying.";
    case "medium":
      return reasons[0]
        ? `Reduce certainty and remove any CTA. ${reasons[0]}`
        : "Reduce certainty and remove any CTA.";
    case "low":
    default:
      return "Safe to participate as drafted.";
  }
}

function sharesPattern(a: string, b: string): boolean {
  const an = a.trim().toLowerCase();
  const bn = b.trim().toLowerCase();
  if (an === bn) return true;
  if (an.length < 30 || bn.length < 30) return false;
  return an.slice(0, 30) === bn.slice(0, 30);
}
