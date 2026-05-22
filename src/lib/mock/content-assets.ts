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
    notes: ["Strong evergreen candidate. No social amplification yet."],
  },
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
    notes: ["Strong evergreen — propose calm cross-platform mention."],
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
