import type { ContentAsset, ContentAssetKind, FreshnessStatus } from "@/types";

interface Seed {
  id: string;
  productId: string;
  cluster: string;
  kind: ContentAssetKind;
  slug: string;
  title: string;
  summary: string;
  publishedAt: string;
  updatedAt: string;
  freshness: FreshnessStatus;
  indexed: boolean;
  mockSearchPosition: number | null;
  internalLinksIn: number;
  internalLinksOut: number;
  amplification: { reddit: number; x: number; linkedin: number };
  notes?: string[];
}

const seeds: Seed[] = [
  // WebmasterID
  {
    id: "asset_wmi_001",
    productId: "prod_webmasterid",
    cluster: "ai-traffic",
    kind: "blog_post",
    slug: "agent-vs-human-traffic-split",
    title: "How to tell AI agents from humans in your web logs",
    summary:
      "The practical heuristics we use at WebmasterID to split a single visits column into three buckets.",
    publishedAt: "2026-02-10T09:00:00.000Z",
    updatedAt: "2026-04-22T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 6,
    internalLinksIn: 5,
    internalLinksOut: 3,
    amplification: { reddit: 1, x: 2, linkedin: 1 },
  },
  {
    id: "asset_wmi_002",
    productId: "prod_webmasterid",
    cluster: "ai-traffic",
    kind: "case_study",
    slug: "100k-agent-visits",
    title: "What 100k agent visits taught us about caching",
    summary:
      "A real customer case: three times the agent traffic, half the conversion, and the rewrite that fixed it.",
    publishedAt: "2026-03-15T09:00:00.000Z",
    updatedAt: "2026-03-15T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 14,
    internalLinksIn: 2,
    internalLinksOut: 1,
    amplification: { reddit: 0, x: 1, linkedin: 0 },
    notes: ["Strong search potential, low social amplification."],
  },
  {
    id: "asset_wmi_003",
    productId: "prod_webmasterid",
    cluster: "attribution",
    kind: "guide",
    slug: "utm-conventions-for-agentic-traffic",
    title: "UTM conventions that survive agentic traffic",
    summary:
      "What to put in utm_source and utm_medium when half of your visits aren't human.",
    publishedAt: "2025-11-08T09:00:00.000Z",
    updatedAt: "2025-11-08T09:00:00.000Z",
    freshness: "needs_refresh",
    indexed: true,
    mockSearchPosition: 22,
    internalLinksIn: 1,
    internalLinksOut: 5,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["Has not been updated since publish. Strong evergreen candidate."],
  },
  {
    id: "asset_wmi_004",
    productId: "prod_webmasterid",
    cluster: "platform",
    kind: "documentation",
    slug: "docs-index",
    title: "WebmasterID documentation",
    summary: "Top-level docs index.",
    publishedAt: "2025-10-01T09:00:00.000Z",
    updatedAt: "2026-05-01T09:00:00.000Z",
    freshness: "evergreen",
    indexed: true,
    mockSearchPosition: 4,
    internalLinksIn: 18,
    internalLinksOut: 22,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
  },
  {
    id: "asset_wmi_005",
    productId: "prod_webmasterid",
    cluster: "ai-traffic",
    kind: "comparison",
    slug: "agent-traffic-vs-classic-bots",
    title: "Agent traffic vs classic bots: the practical differences",
    summary:
      "Why AI agents behave like neither a human nor a search-crawler bot.",
    publishedAt: "2025-08-22T09:00:00.000Z",
    updatedAt: "2025-08-22T09:00:00.000Z",
    freshness: "stale",
    indexed: true,
    mockSearchPosition: 38,
    internalLinksIn: 0,
    internalLinksOut: 2,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: [
      "Older than 9 months, no incoming links, no amplification.",
    ],
  },
  {
    id: "asset_wmi_006",
    productId: "prod_webmasterid",
    cluster: "attribution",
    kind: "blog_post",
    slug: "campaign-id-conventions",
    title: "Campaign IDs that survive a year of growth",
    summary:
      "A small naming convention that prevents campaign data fragmentation.",
    publishedAt: "2026-04-30T09:00:00.000Z",
    updatedAt: "2026-04-30T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 11,
    internalLinksIn: 1,
    internalLinksOut: 4,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["High search potential, no social distribution yet."],
  },

  // Cash Workspace
  {
    id: "asset_cw_001",
    productId: "prod_cash_workspace",
    cluster: "solo-operator-finance",
    kind: "blog_post",
    slug: "monthly-cash-view",
    title: "The monthly cash view I wish I had as a solo operator",
    summary:
      "Three columns: this month, runway, late invoices. The only reports I actually use.",
    publishedAt: "2026-01-20T09:00:00.000Z",
    updatedAt: "2026-01-20T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 9,
    internalLinksIn: 3,
    internalLinksOut: 2,
    amplification: { reddit: 0, x: 1, linkedin: 1 },
  },
  {
    id: "asset_cw_002",
    productId: "prod_cash_workspace",
    cluster: "tax",
    kind: "guide",
    slug: "tax-season-checklist",
    title: "A boring, accurate tax-season checklist for solo founders",
    summary:
      "Five months out, two months out, two weeks out — the items that actually matter.",
    publishedAt: "2025-09-04T09:00:00.000Z",
    updatedAt: "2025-09-04T09:00:00.000Z",
    freshness: "needs_refresh",
    indexed: true,
    mockSearchPosition: 28,
    internalLinksIn: 1,
    internalLinksOut: 0,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["Annual refresh recommended before next tax season."],
  },
  {
    id: "asset_cw_003",
    productId: "prod_cash_workspace",
    cluster: "runway",
    kind: "tutorial",
    slug: "runway-spreadsheet-to-app",
    title: "From runway spreadsheet to a tool that just shows the answer",
    summary:
      "The decisions we made converting a single-sheet model into Cash Workspace.",
    publishedAt: "2026-05-02T09:00:00.000Z",
    updatedAt: "2026-05-02T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 17,
    internalLinksIn: 0,
    internalLinksOut: 1,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["No internal links yet. Add cluster connections."],
  },

  // TwinPhone
  {
    id: "asset_tp_001",
    productId: "prod_twinphone",
    cluster: "second-line",
    kind: "blog_post",
    slug: "why-founders-need-second-line",
    title: "Why every founder eventually needs a second line",
    summary:
      "Founder DMs, customer calls, your kid's school — the story of why we built TwinPhone.",
    publishedAt: "2026-02-08T09:00:00.000Z",
    updatedAt: "2026-02-08T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 15,
    internalLinksIn: 1,
    internalLinksOut: 1,
    amplification: { reddit: 0, x: 1, linkedin: 0 },
  },
  {
    id: "asset_tp_002",
    productId: "prod_twinphone",
    cluster: "setup",
    kind: "guide",
    slug: "setting-up-twinphone-iphone",
    title: "Setting up TwinPhone on iPhone, end to end",
    summary: "The full setup flow, with screenshots.",
    publishedAt: "2025-10-12T09:00:00.000Z",
    updatedAt: "2025-12-05T09:00:00.000Z",
    freshness: "evergreen",
    indexed: true,
    mockSearchPosition: 7,
    internalLinksIn: 5,
    internalLinksOut: 0,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["Strong evergreen — propose a Reddit reply-friendly version."],
  },

  // PDF tools
  {
    id: "asset_pdf_001",
    productId: "prod_pdf_tools",
    cluster: "ocr",
    kind: "tutorial",
    slug: "browser-ocr-without-upload",
    title: "How browser-only OCR actually works (no upload)",
    summary:
      "What runs in the tab, what doesn't, and why the math is faster than people expect.",
    publishedAt: "2026-04-09T09:00:00.000Z",
    updatedAt: "2026-04-09T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 19,
    internalLinksIn: 2,
    internalLinksOut: 2,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["Reddit r/webdev opportunity — no current discussion link."],
  },
  {
    id: "asset_pdf_002",
    productId: "prod_pdf_tools",
    cluster: "redaction",
    kind: "guide",
    slug: "redaction-without-flattening",
    title: "Redaction that doesn't quietly fail when someone copies the file",
    summary:
      "Why the most common PDF redaction stack still leaks text — and the fix.",
    publishedAt: "2025-11-30T09:00:00.000Z",
    updatedAt: "2025-11-30T09:00:00.000Z",
    freshness: "evergreen",
    indexed: true,
    mockSearchPosition: 13,
    internalLinksIn: 3,
    internalLinksOut: 1,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["Strong evergreen, ripe for a soft Reddit discussion."],
  },

  // Printer apps
  {
    id: "asset_pra_001",
    productId: "prod_printer_apps",
    cluster: "labels",
    kind: "guide",
    slug: "brother-ql-airprint",
    title: "Brother QL label printers and AirPrint, set up properly",
    summary: "The exact pairing flow, including the parts the official docs skip.",
    publishedAt: "2026-03-22T09:00:00.000Z",
    updatedAt: "2026-03-22T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 10,
    internalLinksIn: 1,
    internalLinksOut: 1,
    amplification: { reddit: 1, x: 0, linkedin: 0 },
  },
  {
    id: "asset_pra_002",
    productId: "prod_printer_apps",
    cluster: "labels",
    kind: "comparison",
    slug: "thermal-printer-companion-apps",
    title: "Thermal printer companion apps compared",
    summary:
      "What works for an Etsy seller, what works for a small clinic, what's overkill.",
    publishedAt: "2025-12-18T09:00:00.000Z",
    updatedAt: "2025-12-18T09:00:00.000Z",
    freshness: "needs_refresh",
    indexed: true,
    mockSearchPosition: 25,
    internalLinksIn: 0,
    internalLinksOut: 0,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: ["No incoming links, no amplification, getting older."],
  },

  // HELPERG
  {
    id: "asset_hg_001",
    productId: "prod_helperg",
    cluster: "operator-notes",
    kind: "blog_post",
    slug: "weekly-approval-essay",
    title: "I stopped posting daily and grew anyway",
    summary:
      "The weekly approval workflow that runs the HELPERG portfolio, and what changed when I switched to it.",
    publishedAt: "2026-04-18T09:00:00.000Z",
    updatedAt: "2026-04-18T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 12,
    internalLinksIn: 4,
    internalLinksOut: 3,
    amplification: { reddit: 0, x: 1, linkedin: 1 },
  },
  {
    id: "asset_hg_002",
    productId: "prod_helperg",
    cluster: "operator-notes",
    kind: "case_study",
    slug: "portfolio-week-of-may",
    title: "A real week running the HELPERG portfolio",
    summary:
      "Times, channels, decisions, and what didn't happen. Numbers, not narratives.",
    publishedAt: "2026-05-05T09:00:00.000Z",
    updatedAt: "2026-05-05T09:00:00.000Z",
    freshness: "fresh",
    indexed: true,
    mockSearchPosition: 21,
    internalLinksIn: 1,
    internalLinksOut: 5,
    amplification: { reddit: 0, x: 1, linkedin: 1 },
  },
  {
    id: "asset_hg_003",
    productId: "prod_helperg",
    cluster: "operator-notes",
    kind: "guide",
    slug: "build-from-mock-to-real",
    title: "Building from mock data to real persistence without rewrites",
    summary:
      "The contract pattern HELPERG uses so the same React UI works against mock data today and a real database later.",
    publishedAt: "2025-12-02T09:00:00.000Z",
    updatedAt: "2025-12-02T09:00:00.000Z",
    freshness: "evergreen",
    indexed: true,
    mockSearchPosition: 5,
    internalLinksIn: 6,
    internalLinksOut: 2,
    amplification: { reddit: 0, x: 0, linkedin: 0 },
    notes: [
      "Top performer in search, almost no social amplification yet.",
    ],
  },
];

export const contentAssets: ContentAsset[] = seeds.map(toAsset);

function toAsset(s: Seed): ContentAsset {
  return {
    id: s.id,
    productId: s.productId,
    cluster: s.cluster,
    kind: s.kind,
    url: urlFor(s),
    title: s.title,
    summary: s.summary,
    publishedAt: s.publishedAt,
    updatedAt: s.updatedAt,
    freshness: s.freshness,
    indexed: s.indexed,
    mockSearchPosition: s.mockSearchPosition,
    internalLinks: { incoming: s.internalLinksIn, outgoing: s.internalLinksOut },
    amplification: s.amplification,
    notes: s.notes ?? [],
  };
}

function urlFor(s: Seed): string {
  const domains: Record<string, string> = {
    prod_webmasterid: "webmasterid.com",
    prod_cash_workspace: "cashworkspace.com",
    prod_twinphone: "twinphone.app",
    prod_pdf_tools: "pdftools.studio",
    prod_printer_apps: "printerapps.io",
    prod_helperg: "helperg.com",
  };
  return `https://${domains[s.productId] ?? "example.com"}/${s.slug}`;
}

export const contentAssetsById = Object.fromEntries(
  contentAssets.map((a) => [a.id, a]),
) as Record<string, ContentAsset>;
