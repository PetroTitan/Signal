import type {
  ContentAsset,
  DiscoverabilityOpportunity,
  ProductProfile,
} from "@/types";
import { calculateFreshnessStatus } from "./freshness";
import { buildTopicalClusters } from "./visibility";

export function calculateDiscoverabilityOpportunities(
  assets: ContentAsset[],
  products: ProductProfile[],
): DiscoverabilityOpportunity[] {
  const out: DiscoverabilityOpportunity[] = [];

  for (const asset of assets) {
    const verdict = calculateFreshnessStatus(asset);
    const product = products.find((p) => p.id === asset.productId);
    const productName = product?.name ?? asset.productId;
    const totalAmp =
      asset.amplification.reddit +
      asset.amplification.x +
      asset.amplification.linkedin;

    if (
      verdict.status === "fresh" &&
      asset.mockSearchPosition !== null &&
      asset.mockSearchPosition <= 20 &&
      totalAmp === 0
    ) {
      out.push({
        id: `op_search_to_social_${asset.id}`,
        kind: "search_to_social",
        productId: asset.productId,
        cluster: asset.cluster,
        assetId: asset.id,
        title: `Search-ready, socially silent: "${asset.title}"`,
        detail: `${productName} content ranks in the top 20 but has no social amplification yet.`,
        suggestedAction:
          "Plan a calm cross-platform mention. Lead with the problem the article solves.",
        impact: "high",
      });
    }

    if (
      verdict.status === "evergreen" &&
      asset.amplification.reddit === 0
    ) {
      out.push({
        id: `op_evergreen_${asset.id}`,
        kind: "evergreen_distribution",
        productId: asset.productId,
        cluster: asset.cluster,
        assetId: asset.id,
        title: `Evergreen asset under-distributed: "${asset.title}"`,
        detail: `${productName} has an evergreen asset that has never surfaced in a Reddit discussion.`,
        suggestedAction:
          "Draft a soft Reddit question that maps to the asset's topic. Do not lead with the link.",
        impact: "medium",
      });
    }

    if (verdict.status === "needs_refresh" || verdict.status === "stale") {
      out.push({
        id: `op_refresh_${asset.id}`,
        kind: "freshness_refresh",
        productId: asset.productId,
        cluster: asset.cluster,
        assetId: asset.id,
        title: `Refresh window: "${asset.title}"`,
        detail: `Last updated ${verdict.ageDays} days ago. ${verdict.reason}`,
        suggestedAction:
          verdict.suggestedRefreshWindowDays
            ? `Plan a refresh in the next ${verdict.suggestedRefreshWindowDays} days.`
            : "Plan a refresh in the next cycle.",
        impact: verdict.status === "stale" ? "high" : "medium",
      });
    }

    if (verdict.status === "under_promoted") {
      out.push({
        id: `op_under_promoted_${asset.id}`,
        kind: "low_amplification",
        productId: asset.productId,
        cluster: asset.cluster,
        assetId: asset.id,
        title: `Under-promoted: "${asset.title}"`,
        detail: `Published ${verdict.ageDays} days ago with no social amplification.`,
        suggestedAction:
          "Add one calm reference next week. Choose the platform that matches the content.",
        impact: "medium",
      });
    }

    if (
      asset.internalLinks.incoming === 0 &&
      verdict.status !== "stale"
    ) {
      out.push({
        id: `op_linking_${asset.id}`,
        kind: "internal_linking",
        productId: asset.productId,
        cluster: asset.cluster,
        assetId: asset.id,
        title: `No incoming internal links: "${asset.title}"`,
        detail: `${productName} asset is isolated in its own cluster.`,
        suggestedAction:
          "Add two contextual links from other pages in the same cluster.",
        impact: "low",
      });
    }
  }

  for (const product of products) {
    const clusters = buildTopicalClusters(product.id, assets);
    for (const cluster of clusters) {
      if (cluster.coverageGap === "thin") {
        out.push({
          id: `op_cluster_${cluster.id}`,
          kind: "topic_cluster_gap",
          productId: product.id,
          cluster: cluster.label,
          title: `Thin coverage on ${cluster.label} for ${product.name}`,
          detail: cluster.note,
          suggestedAction:
            "Add a companion guide or case study to strengthen the cluster.",
          impact: "medium",
        });
      }
    }
  }

  return dedupeByKey(out, (o) => o.id).sort(
    (a, b) => impactWeight(b.impact) - impactWeight(a.impact),
  );
}

function impactWeight(impact: DiscoverabilityOpportunity["impact"]): number {
  return impact === "high" ? 3 : impact === "medium" ? 2 : 1;
}

function dedupeByKey<T>(items: T[], keyFn: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
