import type {
  PlatformId,
  PlatformOpportunity,
  ProductProfile,
} from "@/types";

const subredditByCategory: Record<string, string[]> = {
  analytics: ["r/analytics", "r/webdev", "r/dataisbeautiful", "r/SaaS"],
  finance: ["r/freelance", "r/Accounting", "r/personalfinance", "r/Entrepreneur"],
  communication: ["r/iphone", "r/Android", "r/sysadmin", "r/Entrepreneur"],
  productivity: ["r/productivity", "r/notion", "r/Workflow"],
  utility: ["r/excel", "r/software", "r/sysadmin"],
  consulting: ["r/consulting", "r/freelance", "r/Entrepreneur"],
};

export function getPlatformOpportunities(
  platform: PlatformId,
  products: ProductProfile[],
): PlatformOpportunity[] {
  if (platform === "reddit") {
    const out: PlatformOpportunity[] = [];
    for (const product of products) {
      const subs = subredditByCategory[product.category] ?? [];
      for (const sub of subs.slice(0, 3)) {
        out.push({
          id: `reddit_${product.id}_${sub.replace(/[/]/g, "_")}`,
          platform: "reddit",
          title: `${sub} — fit for ${product.name}`,
          detail: `Comment-first opportunity. ${product.name} fits this audience; lead with help, never with a link.`,
          source: "subreddit",
        });
      }
    }
    return out.slice(0, 8);
  }

  if (platform === "x") {
    const out: PlatformOpportunity[] = [];
    for (const product of products.slice(0, 5)) {
      out.push({
        id: `x_hook_${product.id}_a`,
        platform: "x",
        title: `Hook idea for ${product.name}`,
        detail: `Lead with the problem ${product.targetAudience[0] ?? "operators"} run into before they discover ${product.name}.`,
        source: "hook_bank",
      });
      out.push({
        id: `x_thread_${product.id}`,
        platform: "x",
        title: `Thread seed for ${product.name}`,
        detail: `Anatomy of a real workflow that ${product.name} replaces. Five posts, ends on a question.`,
        source: "thread_seed",
      });
    }
    out.push({
      id: "x_reply_target_general",
      platform: "x",
      title: "Reply target: founder threads",
      detail:
        "Pick 3 founder threads in your network each day. One sentence on substance per reply.",
      source: "reply_target",
    });
    return out.slice(0, 10);
  }

  // linkedin
  const out: PlatformOpportunity[] = [];
  for (const product of products.slice(0, 4)) {
    out.push({
      id: `linkedin_essay_${product.id}`,
      platform: "linkedin",
      title: `Founder essay seed for ${product.name}`,
      detail: `A first-person lesson from operating ${product.name}. Lead with one specific moment.`,
      source: "founder_narrative",
    });
    out.push({
      id: `linkedin_case_${product.id}`,
      platform: "linkedin",
      title: `Case study skeleton for ${product.name}`,
      detail: `One customer, one before/after metric, one decision worth documenting.`,
      source: "case_study",
    });
  }
  return out.slice(0, 8);
}
