/**
 * API vs provider-external reconciliation (PURE).
 *
 * `publish_history.mode` is 100% 'api' across all 92 production rows, so
 * from Signal's own database the comparison the operator wants has an
 * EMPTY control arm. But the control posts exist — they were simply made
 * outside the product. Diffing a provider's own feed against the
 * provider post ids Signal recorded recovers them at zero cost:
 * @webmasterid.bsky.social has 22 posts on Bluesky and Signal published
 * 13 of them.
 *
 * WHAT THIS MODULE REFUSES TO DO
 * ------------------------------
 *   - It does not write discovered posts into publish_history. That
 *     table's execution_item_id is NOT NULL, so recording an external
 *     post would mean fabricating an execution_item that never existed —
 *     inventing Signal history to describe something Signal did not do.
 *     Discovered posts live in the report only.
 *   - It does not claim to know how an external post was composed.
 *     "Found on the provider" is the whole claim.
 *   - It does not produce a causal comparison. The two arms differ in
 *     time period, topic and format simultaneously in the real data, and
 *     the statistical gates refuse a verdict at these sample sizes
 *     regardless.
 *
 * Pure module — no I/O.
 */

import { publicationGroupLabel } from "@/core/publishing/publication-method";
import { compareGroups, type GroupComparison } from "./statistics";

export interface KnownPublication {
  publishHistoryId: string;
  platform: string;
  providerPostId: string | null;
  publishedAt: string;
  /** publish_history.mode */
  mode: string;
  /** Engagement, when the post has been measured. */
  engagement: number | null;
}

export interface ProviderPost {
  /** Provider-native id — at-uri for Bluesky, snowflake for X. */
  providerPostId: string;
  platform: string;
  publishedAt: string;
  engagement: number | null;
  /** Short excerpt, for operator recognition only. */
  excerpt?: string | null;
  /** True when the provider reports this as a repost/retweet of someone
   *  else's content rather than an original post. */
  isRepost?: boolean;
  /** True when the provider reports this as a reply. */
  isReply?: boolean;
}

export type ReconciledOrigin = "signal_api" | "signal_manual" | "provider_external";

export interface ReconciledPost {
  providerPostId: string;
  platform: string;
  publishedAt: string;
  engagement: number | null;
  origin: ReconciledOrigin;
  /** Present only for posts Signal published. */
  publishHistoryId: string | null;
  excerpt: string | null;
}

export interface ReconciliationReport {
  platform: string;
  /** Posts the provider returned, after excluding reposts and replies. */
  providerPostsConsidered: number;
  /** Signal rows whose provider id was NOT seen in the provider feed. */
  missingFromProvider: KnownPublication[];
  posts: ReconciledPost[];
  counts: Record<ReconciledOrigin, number>;
  /** Descriptive only — see the statistical gates. */
  comparison: GroupComparison | null;
  summary: string;
  caveats: string[];
}

/**
 * Reconcile a provider feed against Signal's own record.
 *
 * Reposts and replies are excluded: a repost is someone else's content
 * and a reply belongs to a conversation, so neither is comparable to an
 * original published post.
 */
export function reconcile(input: {
  platform: string;
  providerPosts: readonly ProviderPost[];
  knownPublications: readonly KnownPublication[];
}): ReconciliationReport {
  const { platform } = input;

  const known = new Map<string, KnownPublication>();
  for (const k of input.knownPublications) {
    if (k.platform !== platform) continue;
    if (k.providerPostId) known.set(k.providerPostId, k);
  }

  const original = input.providerPosts.filter(
    (p) => p.platform === platform && !p.isRepost && !p.isReply,
  );

  const posts: ReconciledPost[] = original
    .map((p) => {
      const match = known.get(p.providerPostId);
      return {
        providerPostId: p.providerPostId,
        platform,
        publishedAt: p.publishedAt,
        engagement: p.engagement,
        origin: match ? originFromMode(match.mode) : ("provider_external" as const),
        publishHistoryId: match?.publishHistoryId ?? null,
        excerpt: p.excerpt ?? null,
      };
    })
    .sort(
      (a, b) =>
        a.publishedAt.localeCompare(b.publishedAt) ||
        a.providerPostId.localeCompare(b.providerPostId),
    );

  const seen = new Set(original.map((p) => p.providerPostId));
  const missingFromProvider = input.knownPublications.filter(
    (k) =>
      k.platform === platform &&
      k.providerPostId != null &&
      !seen.has(k.providerPostId),
  );

  const counts: Record<ReconciledOrigin, number> = {
    signal_api: 0,
    signal_manual: 0,
    provider_external: 0,
  };
  for (const p of posts) counts[p.origin] += 1;

  const signalValues = posts
    .filter((p) => p.origin !== "provider_external" && p.engagement != null)
    .map((p) => p.engagement!);
  const externalValues = posts
    .filter((p) => p.origin === "provider_external" && p.engagement != null)
    .map((p) => p.engagement!);

  const comparison =
    signalValues.length > 0 || externalValues.length > 0
      ? compareGroups([
          { label: publicationGroupLabel("signal_api"), values: signalValues },
          { label: publicationGroupLabel("human_published"), values: externalValues },
        ])
      : null;

  return {
    platform,
    providerPostsConsidered: original.length,
    missingFromProvider,
    posts,
    counts,
    comparison,
    summary: summarise(platform, counts, comparison),
    caveats: buildCaveats(platform, posts, missingFromProvider.length),
  };
}

function originFromMode(mode: string): ReconciledOrigin {
  return mode === "api" ? "signal_api" : "signal_manual";
}

function summarise(
  platform: string,
  counts: Record<ReconciledOrigin, number>,
  comparison: GroupComparison | null,
): string {
  const signalTotal = counts.signal_api + counts.signal_manual;
  const head =
    `${platform}: ${signalTotal} post${signalTotal === 1 ? "" : "s"} published through Signal, ` +
    `${counts.provider_external} found on the provider that Signal did not publish.`;
  return comparison ? `${head} ${comparison.summary}` : head;
}

/**
 * The caveats are not boilerplate. Each is checked against the actual
 * reconciled set, so an operator sees the specific reasons THIS
 * comparison is weak rather than a generic disclaimer.
 */
function buildCaveats(
  platform: string,
  posts: ReconciledPost[],
  missingCount: number,
): string[] {
  const caveats: string[] = [
    "Signal does not know how the externally-published posts were composed — only that they exist on the provider.",
  ];

  const external = posts.filter((p) => p.origin === "provider_external");
  const viaSignal = posts.filter((p) => p.origin !== "provider_external");

  if (external.length > 0 && viaSignal.length > 0) {
    const externalRange = dateRange(external.map((p) => p.publishedAt));
    const signalRange = dateRange(viaSignal.map((p) => p.publishedAt));
    if (!rangesOverlap(externalRange, signalRange)) {
      caveats.push(
        `The two groups do not overlap in time: Signal posts run ${signalRange[0]}..${signalRange[1]}, ` +
          `external posts ${externalRange[0]}..${externalRange[1]}. Anything that changed about the ` +
          "account or the platform between those periods is confounded with the comparison.",
      );
    }
  }

  const firstEver = posts[0];
  if (firstEver && firstEver.origin === "provider_external") {
    caveats.push(
      "The earliest post in this comparison is external and is the account's first post, " +
        "which typically attracts follow-driven engagement no later post can.",
    );
  }

  if (missingCount > 0) {
    caveats.push(
      `${missingCount} post${missingCount === 1 ? "" : "s"} Signal recorded as published could not be found ` +
        "in the provider feed. They may have been deleted, or lie beyond the feed's pagination.",
    );
  }

  caveats.push(
    `Follower count changed over the period covered, so exposure was not constant.`,
  );

  return caveats;
}

function dateRange(isoDates: string[]): [string, string] {
  const sorted = [...isoDates].sort();
  return [sorted[0]?.slice(0, 10) ?? "", sorted[sorted.length - 1]?.slice(0, 10) ?? ""];
}

function rangesOverlap(a: [string, string], b: [string, string]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}
