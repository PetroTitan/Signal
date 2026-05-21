import type {
  ContentOpportunity,
  DraftVariant,
  ProductProfile,
  SourceInsight,
} from "@/types";
import { adaptToReddit } from "../platform-adapters/reddit";
import { adaptToX } from "../platform-adapters/x";
import { adaptToLinkedIn } from "../platform-adapters/linkedin";

interface BuildDraftsInput {
  opportunity: ContentOpportunity;
  insight: SourceInsight;
  product: ProductProfile;
  knownHooks: string[];
}

export function buildDrafts({
  opportunity,
  insight,
  product,
  knownHooks,
}: BuildDraftsInput): DraftVariant[] {
  if (opportunity.channel === "reddit") {
    return adaptToReddit({ insight, opportunity, knownHooks });
  }
  if (opportunity.channel === "x") {
    return adaptToX({ insight, opportunity, product, knownHooks });
  }
  if (opportunity.channel === "linkedin") {
    return adaptToLinkedIn({ insight, opportunity, product, knownHooks });
  }
  return [];
}
