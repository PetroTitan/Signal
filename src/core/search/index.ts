import type {
  BacklogItem,
  ContentAsset,
  GrowthAccount,
  PlatformId,
  ProductProfile,
  RiskEvent,
  SourceInsight,
  WeeklyPlanItem,
} from "@/types";

export type SearchEntityType =
  | "product"
  | "account"
  | "weekly_item"
  | "backlog_item"
  | "insight"
  | "content_asset"
  | "risk"
  | "docs";

export interface SearchResult {
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle?: string;
  productId?: string;
  platform?: PlatformId | "google";
  status?: string;
  href: string;
  score: number;
  matchedFields: string[];
}

export interface SearchInput {
  query: string;
  products: ProductProfile[];
  accounts: GrowthAccount[];
  items: WeeklyPlanItem[];
  backlog: BacklogItem[];
  insights: SourceInsight[];
  contentAssets: ContentAsset[];
  riskEvents: RiskEvent[];
}

const docPages: { id: string; title: string; href: string; tags: string }[] = [
  {
    id: "docs_arch",
    title: "Operational stabilization architecture",
    href: "/dashboard",
    tags: "architecture workflow operational core",
  },
  {
    id: "docs_oauth",
    title: "OAuth-first principle",
    href: "/settings",
    tags: "oauth password security accounts",
  },
  {
    id: "docs_workflow",
    title: "Workflow map",
    href: "/dashboard",
    tags: "workflow flow architecture documentation",
  },
];

export function searchAll(input: SearchInput): SearchResult[] {
  const q = input.query.trim().toLowerCase();
  if (q.length < 2) return [];
  const tokens = q.split(/\s+/);

  const results: SearchResult[] = [];

  for (const p of input.products) {
    const match = scoreMatch(tokens, [
      p.name,
      p.domain,
      p.positioning,
      p.category,
      p.contentStyle,
      ...p.targetAudience,
    ]);
    if (match.score > 0) {
      results.push({
        id: p.id,
        type: "product",
        title: p.name,
        subtitle: `${p.category} · ${p.domain}`,
        productId: p.id,
        href: `/products/${p.slug}`,
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  for (const a of input.accounts) {
    const match = scoreMatch(tokens, [
      a.displayName,
      a.handle ?? "",
      a.role,
      a.status,
      a.platform,
    ]);
    if (match.score > 0) {
      results.push({
        id: a.id,
        type: "account",
        title: a.displayName,
        subtitle: `${a.platform} · ${a.role} · ${a.status.replace(/_/g, " ")}`,
        productId: a.productId,
        platform: a.platform,
        status: a.status,
        href: `/accounts/${a.id}`,
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  for (const it of input.items) {
    const match = scoreMatch(tokens, [
      it.draft.hook,
      it.draft.body,
      it.draft.cta ?? "",
      it.contentType,
      it.platform,
      it.status,
    ]);
    if (match.score > 0) {
      results.push({
        id: it.id,
        type: "weekly_item",
        title: it.draft.hook,
        subtitle: `${it.platform} · ${it.contentType.replace(/_/g, " ")} · ${it.status.replace(/_/g, " ")}`,
        productId: it.productId,
        platform: it.platform,
        status: it.status,
        href: "/weekly-plan",
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  for (const bk of input.backlog) {
    const match = scoreMatch(tokens, [
      bk.draft.hook,
      bk.draft.body,
      bk.reason,
      bk.platform,
    ]);
    if (match.score > 0) {
      results.push({
        id: bk.id,
        type: "backlog_item",
        title: bk.draft.hook,
        subtitle: `${bk.platform} · backlog`,
        productId: bk.productId,
        platform: bk.platform,
        status: "backlog",
        href: "/backlog",
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  for (const ins of input.insights) {
    const match = scoreMatch(tokens, [
      ins.title,
      ins.coreInsight,
      ins.summary,
      ins.category,
      ...ins.audience,
    ]);
    if (match.score > 0) {
      results.push({
        id: ins.id,
        type: "insight",
        title: ins.title,
        subtitle: `${ins.category.replace(/_/g, " ")}`,
        productId: ins.productId,
        href: "/weekly-plan",
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  for (const asset of input.contentAssets) {
    const match = scoreMatch(tokens, [
      asset.title,
      asset.summary,
      asset.cluster,
      asset.url,
      asset.kind,
    ]);
    if (match.score > 0) {
      results.push({
        id: asset.id,
        type: "content_asset",
        title: asset.title,
        subtitle: `${asset.cluster} · ${asset.freshness}`,
        productId: asset.productId,
        platform: "google",
        href: "/platforms/google",
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  for (const r of input.riskEvents) {
    const match = scoreMatch(tokens, [
      r.summary,
      r.recommendation,
      r.category,
      r.level,
    ]);
    if (match.score > 0) {
      results.push({
        id: r.id,
        type: "risk",
        title: r.summary,
        subtitle: `${r.category.replace(/_/g, " ")} · ${r.level}`,
        productId: r.productId,
        platform: r.platform,
        href: "/weekly-plan",
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  for (const d of docPages) {
    const match = scoreMatch(tokens, [d.title, d.tags]);
    if (match.score > 0) {
      results.push({
        id: d.id,
        type: "docs",
        title: d.title,
        subtitle: "Internal documentation",
        href: d.href,
        score: match.score,
        matchedFields: match.matchedFields,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 60);
}

function scoreMatch(
  tokens: string[],
  fields: string[],
): { score: number; matchedFields: string[] } {
  let score = 0;
  const matched = new Set<string>();
  for (const raw of fields) {
    if (!raw) continue;
    const field = raw.toLowerCase();
    for (const token of tokens) {
      if (!token) continue;
      if (field === token) {
        score += 6;
        matched.add(raw);
      } else if (field.startsWith(token)) {
        score += 4;
        matched.add(raw);
      } else if (field.includes(` ${token}`) || field.includes(`${token} `)) {
        score += 3;
        matched.add(raw);
      } else if (field.includes(token)) {
        score += 2;
        matched.add(raw);
      }
    }
  }
  return { score, matchedFields: Array.from(matched).slice(0, 3) };
}
