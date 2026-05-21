import type { SourceInsight } from "@/types";

export const sourceInsights: SourceInsight[] = [
  // WebmasterID
  {
    id: "ins_wmi_001",
    productId: "prod_webmasterid",
    title: "Most analytics stacks treat agent traffic as a single bucket",
    coreInsight:
      "Generic 'bot' and 'human' buckets hide the fastest-growing slice of web traffic: AI agents acting on behalf of users.",
    summary:
      "Splitting visits three ways changes the shape of every funnel report we touch.",
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
      "When half your visitors aren't human, treating utm_medium as a string field stops working — you need a small vocabulary.",
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
    id: "ins_wmi_003",
    productId: "prod_webmasterid",
    title: "Agent traffic vs classic bots",
    coreInsight:
      "AI agents behave like neither a human nor a search-crawler bot, and grouping them with either one breaks attribution.",
    summary: "The three behaviors that separate agents from crawlers in our logs.",
    category: "discoverability_gap",
    sourceType: "discoverability_gap",
    audience: ["developers", "operators"],
    discoverabilityPotential: 70,
    evergreenScore: 60,
    conversationScore: 65,
    freshnessPotential: 60,
    riskLevel: "low",
    platformFit: {
      reddit: "strong",
      x: "medium",
      linkedin: "medium",
      google: "strong",
    },
    createdAt: "2025-09-20T09:00:00.000Z",
  },

  // Cash Workspace
  {
    id: "ins_cw_001",
    productId: "prod_cash_workspace",
    title: "Revenue is not available cash",
    coreInsight:
      "Freelancers often confuse revenue with available cash because taxes are future liabilities. The mismatch is what causes 'profitable but broke' quarters.",
    summary:
      "Three columns — this month, runway, late invoices — settle the question every solo operator actually asks.",
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
    id: "ins_cw_002",
    productId: "prod_cash_workspace",
    title: "An honest tax-season checklist",
    coreInsight:
      "A small calendar of three checkpoints (5 months out, 2 months out, 2 weeks out) prevents the annual scramble far better than any tax tool.",
    summary:
      "Most tax pain isn't math — it's missing artifacts the founder never tracked.",
    category: "operational_lesson",
    sourceType: "operational_lesson",
    audience: ["freelancers", "small_business"],
    discoverabilityPotential: 60,
    evergreenScore: 80,
    conversationScore: 50,
    freshnessPotential: 35,
    riskLevel: "low",
    platformFit: {
      reddit: "medium",
      x: "weak",
      linkedin: "medium",
      google: "strong",
    },
    createdAt: "2025-08-19T09:00:00.000Z",
  },

  // TwinPhone
  {
    id: "ins_tp_001",
    productId: "prod_twinphone",
    title: "Founder DMs and customer calls don't belong on the same number",
    coreInsight:
      "Almost every founder eventually gets the call: a customer dials, their kid's school dials at the same time, and the wrong one picks up.",
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

  // PDF tools
  {
    id: "ins_pdf_001",
    productId: "prod_pdf_tools",
    title: "Browser-only OCR is faster than people expect",
    coreInsight:
      "The assumption that OCR has to go through a server is a leftover from the slow-browser era. In-tab OCR is competitive on small files.",
    summary:
      "What runs in the tab, what doesn't, and why the math is faster than expected.",
    category: "product_lesson",
    sourceType: "product_lesson",
    audience: ["developers", "operators"],
    discoverabilityPotential: 70,
    evergreenScore: 65,
    conversationScore: 80,
    freshnessPotential: 65,
    riskLevel: "low",
    platformFit: {
      reddit: "strong",
      x: "medium",
      linkedin: "weak",
      google: "strong",
    },
    createdAt: "2026-04-02T09:00:00.000Z",
  },
  {
    id: "ins_pdf_002",
    productId: "prod_pdf_tools",
    title: "Redaction that doesn't quietly fail",
    coreInsight:
      "The most common PDF-redaction stack leaks text the moment the file is copied — the visual cover-up doesn't remove the underlying glyphs.",
    summary: "A common, quiet failure that bites compliance teams late.",
    category: "support_pattern",
    sourceType: "support_pattern",
    audience: ["operators", "support_teams"],
    discoverabilityPotential: 60,
    evergreenScore: 75,
    conversationScore: 60,
    freshnessPotential: 50,
    riskLevel: "low",
    platformFit: {
      reddit: "strong",
      x: "medium",
      linkedin: "medium",
      google: "strong",
    },
    createdAt: "2025-11-12T09:00:00.000Z",
  },

  // Printer apps
  {
    id: "ins_pra_001",
    productId: "prod_printer_apps",
    title: "AirPrint pairing skips a step that's obvious in hindsight",
    coreInsight:
      "Brother QL label printers fail AirPrint pairing more often than not on the first try because most guides skip the network-priority step.",
    summary:
      "The exact pairing flow, including the parts the official docs leave out.",
    category: "support_pattern",
    sourceType: "support_pattern",
    audience: ["small_business", "operators"],
    discoverabilityPotential: 65,
    evergreenScore: 80,
    conversationScore: 70,
    freshnessPotential: 50,
    riskLevel: "low",
    platformFit: {
      reddit: "strong",
      x: "weak",
      linkedin: "weak",
      google: "strong",
    },
    createdAt: "2026-03-10T09:00:00.000Z",
  },

  // HELPERG
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
  {
    id: "ins_hg_002",
    productId: "prod_helperg",
    title: "Mock-data architecture beats premature persistence",
    coreInsight:
      "Treating the mock module as a contract — same shape as the future database — lets you build the entire UI and feedback loop before adding a single migration.",
    summary:
      "How the HELPERG portfolio ships polished UI without committing to a backend early.",
    category: "operational_lesson",
    sourceType: "operational_lesson",
    audience: ["developers", "operators"],
    discoverabilityPotential: 80,
    evergreenScore: 75,
    conversationScore: 70,
    freshnessPotential: 60,
    riskLevel: "low",
    platformFit: {
      reddit: "strong",
      x: "strong",
      linkedin: "strong",
      google: "strong",
    },
    createdAt: "2025-12-05T09:00:00.000Z",
  },
];

export const insightsById = Object.fromEntries(
  sourceInsights.map((i) => [i.id, i]),
) as Record<string, SourceInsight>;
