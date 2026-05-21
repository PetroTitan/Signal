import type {
  ContentAsset,
  SearchVisibilitySnapshot,
  TopicalCluster,
} from "@/types";
import { calculateFreshnessStatus } from "./freshness";

export function buildVisibilitySnapshot(
  productId: string,
  assets: ContentAsset[],
): SearchVisibilitySnapshot {
  const productAssets = assets.filter((a) => a.productId === productId);
  const total = productAssets.length;
  const counts = {
    fresh: 0,
    evergreen: 0,
    needs_refresh: 0,
    stale: 0,
    under_promoted: 0,
  };
  let indexed = 0;
  let positionSum = 0;
  let positionCount = 0;
  for (const asset of productAssets) {
    const verdict = calculateFreshnessStatus(asset);
    counts[verdict.status]++;
    if (asset.indexed) indexed++;
    if (asset.mockSearchPosition !== null) {
      positionSum += asset.mockSearchPosition;
      positionCount++;
    }
  }
  const averagePosition = positionCount === 0 ? null : positionSum / positionCount;
  const discoverabilityScore = computeScore({
    total,
    indexed,
    fresh: counts.fresh + counts.evergreen,
    stale: counts.stale,
    needsRefresh: counts.needs_refresh,
    underPromoted: counts.under_promoted,
    averagePosition,
  });

  return {
    productId,
    totalAssets: total,
    indexedAssets: indexed,
    freshAssets: counts.fresh,
    staleAssets: counts.stale,
    needsRefreshAssets: counts.needs_refresh,
    evergreenAssets: counts.evergreen,
    underPromotedAssets: counts.under_promoted,
    averagePosition,
    discoverabilityScore,
  };
}

function computeScore(input: {
  total: number;
  indexed: number;
  fresh: number;
  stale: number;
  needsRefresh: number;
  underPromoted: number;
  averagePosition: number | null;
}): number {
  if (input.total === 0) return 0;
  const indexedRatio = input.indexed / input.total;
  const freshRatio = input.fresh / input.total;
  const stalePenalty = input.stale / input.total;
  const refreshPenalty = (input.needsRefresh + input.underPromoted) / input.total;
  const positionScore =
    input.averagePosition === null
      ? 0
      : Math.max(0, 1 - input.averagePosition / 40);
  const raw =
    indexedRatio * 25 +
    freshRatio * 30 +
    positionScore * 30 -
    stalePenalty * 25 -
    refreshPenalty * 10;
  return Math.max(0, Math.min(100, Math.round(raw + 35)));
}

export function buildTopicalClusters(
  productId: string,
  assets: ContentAsset[],
): TopicalCluster[] {
  const productAssets = assets.filter((a) => a.productId === productId);
  const grouped = new Map<string, ContentAsset[]>();
  for (const a of productAssets) {
    const list = grouped.get(a.cluster) ?? [];
    list.push(a);
    grouped.set(a.cluster, list);
  }
  return Array.from(grouped.entries()).map(([cluster, items]) => {
    const ageDays = items.map((a) => {
      const t = new Date(a.updatedAt).getTime();
      return Math.max(0, (Date.now() - t) / (24 * 60 * 60 * 1000));
    });
    const avgAge =
      ageDays.length === 0
        ? 0
        : ageDays.reduce((s, n) => s + n, 0) / ageDays.length;
    const averageFreshnessScore = Math.max(
      0,
      Math.min(100, Math.round(100 - avgAge / 4)),
    );
    let coverageGap: TopicalCluster["coverageGap"] = "covered";
    let note = `${items.length} asset${items.length === 1 ? "" : "s"} in this cluster.`;
    if (items.length === 1) {
      coverageGap = "thin";
      note = "Only one asset covers this cluster — add a companion guide or case study.";
    } else if (items.length >= 4) {
      coverageGap = "covered";
      note = `${items.length} assets — strong topical coverage.`;
    } else if (items.length <= 2 && avgAge > 180) {
      coverageGap = "thin";
      note = "Few assets and aging fast — refresh or expand.";
    }
    return {
      id: `${productId}_${cluster}`,
      productId,
      label: cluster,
      assetCount: items.length,
      averageFreshnessScore,
      coverageGap,
      note,
    };
  });
}
