import type {
  ContentAsset,
  DiscoverabilityOpportunity,
  ProductProfile,
  SourceInsight,
} from "@/types";

interface AdaptInput {
  insight: SourceInsight;
  product: ProductProfile;
  assets: ContentAsset[];
}

export function adaptToGoogle(input: AdaptInput): DiscoverabilityOpportunity[] {
  const { insight, product, assets } = input;
  const out: DiscoverabilityOpportunity[] = [];
  const productAssets = assets.filter((a) => a.productId === product.id);

  if (insight.evergreenScore >= 60 && productAssets.length > 0) {
    const evergreenMatch = productAssets.find(
      (a) =>
        a.cluster && insightCluster(insight) === a.cluster && a.freshness === "evergreen",
    );
    if (evergreenMatch) {
      out.push({
        id: `cg_evergreen_${insight.id}`,
        kind: "evergreen_distribution",
        productId: product.id,
        cluster: insightCluster(insight),
        assetId: evergreenMatch.id,
        title: `Evergreen opportunity tied to insight: ${insight.title}`,
        detail: `This insight maps to "${evergreenMatch.title}", which holds search position but has limited amplification.`,
        suggestedAction:
          "Plan one calm cross-platform reference next week. Avoid leading with the link.",
        impact: "medium",
      });
    }
  }

  if (insight.discoverabilityPotential >= 70) {
    const cluster = insightCluster(insight);
    const hasAsset = productAssets.some((a) => a.cluster === cluster);
    if (!hasAsset) {
      out.push({
        id: `cg_topic_gap_${insight.id}`,
        kind: "topic_cluster_gap",
        productId: product.id,
        cluster,
        title: `Topic gap: ${insight.title}`,
        detail: `Strong discoverability potential, but no published asset covers the cluster.`,
        suggestedAction:
          "Draft an evergreen guide or essay around this insight. Plan a refresh window after publish.",
        impact: "high",
      });
    }
  }

  if (insight.freshnessPotential >= 60) {
    const candidate = productAssets.find(
      (a) =>
        insightCluster(insight) === a.cluster &&
        (a.freshness === "needs_refresh" || a.freshness === "stale"),
    );
    if (candidate) {
      out.push({
        id: `cg_refresh_${insight.id}`,
        kind: "freshness_refresh",
        productId: product.id,
        cluster: insightCluster(insight),
        assetId: candidate.id,
        title: `Refresh opportunity: ${candidate.title}`,
        detail: `Insight aligns with an asset that has slipped out of the freshness window.`,
        suggestedAction:
          "Plan a calm refresh this cycle. Update one section, re-link from a current cluster page.",
        impact: candidate.freshness === "stale" ? "high" : "medium",
      });
    }
  }

  if (insight.conversationScore >= 60 && insight.discoverabilityPotential >= 50) {
    const linkedAsset = productAssets.find(
      (a) => insightCluster(insight) === a.cluster,
    );
    if (linkedAsset) {
      const totalAmp =
        linkedAsset.amplification.reddit +
        linkedAsset.amplification.x +
        linkedAsset.amplification.linkedin;
      if (totalAmp === 0) {
        out.push({
          id: `cg_search_to_social_${insight.id}`,
          kind: "search_to_social",
          productId: product.id,
          cluster: insightCluster(insight),
          assetId: linkedAsset.id,
          title: `Search-to-social bridge for "${linkedAsset.title}"`,
          detail: `${product.name} content ranks but has not yet been referenced socially.`,
          suggestedAction:
            "Plan one calm cross-platform reference. Lead with the problem, not the link.",
          impact: "high",
        });
      }
    }
  }

  if (insight.discoverabilityPotential >= 50) {
    out.push({
      id: `cg_internal_links_${insight.id}`,
      kind: "internal_linking",
      productId: product.id,
      cluster: insightCluster(insight),
      title: `Internal linking from cluster: ${insightCluster(insight)}`,
      detail: `Add two contextual links between cluster assets so this insight has structural support.`,
      suggestedAction:
        "From two cluster pages, link to the asset that most directly carries this insight.",
      impact: "low",
    });
  }

  return out;
}

function insightCluster(insight: SourceInsight): string {
  return insight.category.replace(/_/g, "-");
}
