import type { SourceInsight } from "@/types";

export const sourceInsights: SourceInsight[] = [
  {
    id: "ins_wmi_001",
    productId: "prod_webmasterid",
    title: "Most analytics stacks treat agent traffic as a single bucket",
    coreInsight:
      "Generic bot and human buckets hide the fastest-growing slice of web traffic: AI agents acting on behalf of users.",
    summary:
      "Splitting visits three ways changes the shape of every funnel report.",
    category: "industry_pattern",
    sourceType: "industry_pattern",
    audience: ["operators", "developers", "marketers"],
    discoverabilityPotential: 78,
    evergreenScore: 70,
    conversationScore: 75,
    freshnessPotential: 80,
    riskLevel: "low",
    platformFit: {
      reddit: "strong",
      x: "strong",
      linkedin: "strong",
      google: "strong",
    },
    createdAt: "2026-03-04T09:00:00.000Z",
  },
  {
    id: "ins_wmi_002",
    productId: "prod_webmasterid",
    title: "UTM conventions that survive agentic traffic",
    coreInsight:
      "When half your visitors aren't human, treating utm_medium as a free-form string stops working — you need a small vocabulary.",
    summary:
      "A small naming convention beats per-team improvisation by month four.",
    category: "operational_lesson",
    sourceType: "operational_lesson",
    audience: ["operators", "marketers"],
    discoverabilityPotential: 65,
    evergreenScore: 82,
    conversationScore: 55,
    freshnessPotential: 50,
    riskLevel: "low",
    platformFit: {
      reddit: "medium",
      x: "medium",
      linkedin: "strong",
      google: "strong",
    },
    createdAt: "2025-11-12T09:00:00.000Z",
  },
  {
    id: "ins_cw_001",
    productId: "prod_cash_workspace",
    title: "Revenue is not available cash",
    coreInsight:
      "Freelancers often confuse revenue with available cash because taxes are future liabilities. The mismatch causes profitable-but-broke quarters.",
    summary:
      "Three columns — this month, runway, late invoices — settle the question every solo operator asks.",
    category: "user_problem",
    sourceType: "user_problem",
    audience: ["freelancers", "small_business", "operators"],
    discoverabilityPotential: 72,
    evergreenScore: 85,
    conversationScore: 80,
    freshnessPotential: 55,
    riskLevel: "low",
    platformFit: {
      reddit: "strong",
      x: "strong",
      linkedin: "medium",
      google: "strong",
    },
    createdAt: "2026-01-14T09:00:00.000Z",
  },
  {
    id: "ins_tp_001",
    productId: "prod_twinphone",
    title: "Founder DMs and customer calls don't belong on one number",
    coreInsight:
      "Every founder eventually gets the call: a customer dials, their kid's school dials at the same time, and the wrong one picks up.",
    summary:
      "The reason to split lines isn't privacy — it's interruption shape.",
    category: "founder_observation",
    sourceType: "founder_observation",
    audience: ["founders", "operators"],
    discoverabilityPotential: 55,
    evergreenScore: 70,
    conversationScore: 70,
    freshnessPotential: 60,
    riskLevel: "low",
    platformFit: {
      reddit: "medium",
      x: "strong",
      linkedin: "medium",
      google: "medium",
    },
    createdAt: "2026-02-02T09:00:00.000Z",
  },
  {
    id: "ins_hg_001",
    productId: "prod_helperg",
    title: "The weekly approval gate beats daily posting",
    coreInsight:
      "Batching a week of content into a single Monday review reduces overposting, kills impulse threads, and keeps founder voice consistent.",
    summary: "Less posting, more presence — the operational shape behind it.",
    category: "operational_lesson",
    sourceType: "operational_lesson",
    audience: ["founders", "operators"],
    discoverabilityPotential: 75,
    evergreenScore: 80,
    conversationScore: 80,
    freshnessPotential: 70,
    riskLevel: "low",
    platformFit: {
      reddit: "medium",
      x: "strong",
      linkedin: "strong",
      google: "strong",
    },
    createdAt: "2026-04-10T09:00:00.000Z",
  },
];

export const insightsById = Object.fromEntries(
  sourceInsights.map((i) => [i.id, i]),
) as Record<string, SourceInsight>;
