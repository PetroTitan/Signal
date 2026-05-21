import type { ContentAsset, FreshnessStatus } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FreshnessVerdict {
  status: FreshnessStatus;
  ageDays: number;
  suggestedRefreshWindowDays: number | null;
  reason: string;
}

export function calculateFreshnessStatus(
  asset: ContentAsset,
  now = new Date(),
): FreshnessVerdict {
  const updated = new Date(asset.updatedAt).getTime();
  const ageDays = Math.max(0, Math.floor((now.getTime() - updated) / DAY_MS));
  const totalAmp =
    asset.amplification.reddit +
    asset.amplification.x +
    asset.amplification.linkedin;

  if (
    asset.internalLinks.incoming >= 5 &&
    asset.mockSearchPosition !== null &&
    asset.mockSearchPosition <= 10 &&
    ageDays > 90
  ) {
    return {
      status: "evergreen",
      ageDays,
      suggestedRefreshWindowDays: null,
      reason: "Strong search position and incoming links sustained over time.",
    };
  }
  if (ageDays > 270) {
    return {
      status: "stale",
      ageDays,
      suggestedRefreshWindowDays: 14,
      reason: "Hasn't been updated in over nine months.",
    };
  }
  if (ageDays > 180) {
    return {
      status: "needs_refresh",
      ageDays,
      suggestedRefreshWindowDays: 30,
      reason: "More than six months since the last update.",
    };
  }
  if (ageDays <= 60 && totalAmp === 0) {
    return {
      status: "under_promoted",
      ageDays,
      suggestedRefreshWindowDays: null,
      reason: "Recent content with no social amplification yet.",
    };
  }
  return {
    status: "fresh",
    ageDays,
    suggestedRefreshWindowDays: null,
    reason: "Within the freshness window.",
  };
}

export function applyFreshness(asset: ContentAsset, now?: Date): ContentAsset {
  const verdict = calculateFreshnessStatus(asset, now);
  if (verdict.status === asset.freshness) return asset;
  return { ...asset, freshness: verdict.status };
}
