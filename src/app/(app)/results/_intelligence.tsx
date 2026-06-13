import Link from "next/link";
import { PlatformChip } from "@/components/publishing/platform-chip";
import type {
  BestTimeResult,
  ConsistencyResult,
  ResultsIntelligence,
  TopPlatformsResult,
  TopPostsResult,
} from "@/core/results/results-intelligence";
import type { PostMetricsStatus } from "@/lib/supabase/types";

/**
 * Phase D.1F — Results Intelligence panel (server component).
 *
 * Renders ONLY verified-data insight. Each section shows an honest
 * "not enough measured posts yet" state instead of a fabricated number
 * when the sample is below threshold. The metrics-status grid never
 * hides a platform — Connected / Pending / Unavailable / Unsupported are
 * all shown.
 */

export interface PlatformStatusSummary {
  platform: string;
  total: number;
  connected: number;
  pending: number;
  unavailable: number;
  unsupported: number;
}

function Insufficient({ have, needed }: { have: number; needed: number }) {
  return (
    <p className="text-xs text-ink-500">
      Not enough measured posts yet — {have} of {needed} needed. Signal waits
      for real data rather than showing an estimate.
    </p>
  );
}

function fmtAvg(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString();
}

function TopPostsCard({ result }: { result: TopPostsResult }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Top posts</h2>
      <p className="text-[11px] text-ink-500 mt-0.5 mb-3">
        Ranked by verified engagement (sum of real provider counts).
      </p>
      {result.kind === "insufficient_data" ? (
        <Insufficient have={result.have} needed={result.needed} />
      ) : (
        <ol className="space-y-2">
          {result.posts.map((p, i) => (
            <li key={p.publishHistoryId} className="flex items-center gap-2 text-sm">
              <span className="text-ink-400 tabular-nums w-4">{i + 1}.</span>
              <PlatformChip platform={p.platform} />
              <span className="truncate flex-1 text-ink-800">{p.title?.trim() || "Untitled"}</span>
              <span className="text-ink-900 font-medium tabular-nums">{p.engagement.toLocaleString()}</span>
              {p.permalink ? (
                <a
                  href={p.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-emerald-700 hover:text-emerald-800 shrink-0"
                >
                  ↗
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TopPlatformsCard({ result }: { result: TopPlatformsResult }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Top platforms</h2>
      <p className="text-[11px] text-ink-500 mt-0.5 mb-3">
        Average verified engagement per measured post.
      </p>
      {result.kind === "insufficient_data" ? (
        <Insufficient have={result.have} needed={result.needed} />
      ) : (
        <ul className="space-y-2">
          {result.platforms.map((p) => (
            <li key={p.platform} className="flex items-center gap-2 text-sm">
              <PlatformChip platform={p.platform} />
              <span className="flex-1 text-ink-500 text-[11px]">
                {p.posts} measured · {p.totalEngagement.toLocaleString()} total
              </span>
              <span className="text-ink-900 font-medium tabular-nums">
                {fmtAvg(p.avgEngagement)} avg
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConsistencyCard({ result }: { result: ConsistencyResult }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Publishing consistency</h2>
      <p className="text-[11px] text-ink-500 mt-0.5 mb-3">
        From real publish timestamps.
      </p>
      {result.kind === "insufficient_data" ? (
        <Insufficient have={result.have} needed={result.needed} />
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Stat label="Posts" value={result.stats.totalPosts.toLocaleString()} />
          <Stat label="Posts / week" value={fmtAvg(result.stats.postsPerWeek)} />
          <Stat label="Active days" value={result.stats.activeDays.toLocaleString()} />
          <Stat label="Span" value={`${result.stats.spanDays} d`} />
          <Stat label="Longest gap" value={`${result.stats.longestGapDays} d`} />
        </dl>
      )}
    </section>
  );
}

function BestTimeCard({ result }: { result: BestTimeResult }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Best publishing time</h2>
      <p className="text-[11px] text-ink-500 mt-0.5 mb-3">
        Highest average verified engagement (UTC).
      </p>
      {result.kind === "insufficient_data" ? (
        <Insufficient have={result.have} needed={result.needed} />
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Stat
            label="Best weekday"
            value={
              result.stats.bestWeekday
                ? `${result.stats.bestWeekday.label} (${fmtAvg(result.stats.bestWeekday.avgEngagement)} avg)`
                : "—"
            }
          />
          <Stat
            label="Best hour"
            value={
              result.stats.bestHour
                ? `${result.stats.bestHour.label} (${fmtAvg(result.stats.bestHour.avgEngagement)} avg)`
                : "—"
            }
          />
          <Stat label="Sample" value={`${result.stats.sampleSize} measured`} />
        </dl>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-500">{label}</dt>
      <dd className="text-ink-900 font-medium">{value}</dd>
    </div>
  );
}

const STATUS_TONE: Record<PostMetricsStatus, string> = {
  connected: "text-emerald-700",
  pending: "text-amber-600",
  unavailable: "text-ink-500",
  unsupported: "text-ink-400",
};

function MetricsStatusCard({ summary }: { summary: PlatformStatusSummary[] }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-ink-900">Metrics status by platform</h2>
      <p className="text-[11px] text-ink-500 mt-0.5 mb-3">
        Every platform is shown — missing data is labelled, never hidden or faked.
      </p>
      {summary.length === 0 ? (
        <p className="text-xs text-ink-500">No published posts yet.</p>
      ) : (
        <ul className="space-y-2">
          {summary.map((s) => (
            <li key={s.platform} className="flex items-center gap-2 text-[12px]">
              <PlatformChip platform={s.platform} />
              <span className="text-ink-500">{s.total} post{s.total === 1 ? "" : "s"}</span>
              <span className="flex-1" />
              {s.connected > 0 ? (
                <span className={STATUS_TONE.connected}>{s.connected} connected</span>
              ) : null}
              {s.pending > 0 ? (
                <span className={STATUS_TONE.pending}>{s.pending} pending</span>
              ) : null}
              {s.unavailable > 0 ? (
                <span className={STATUS_TONE.unavailable}>{s.unavailable} unavailable</span>
              ) : null}
              {s.unsupported > 0 ? (
                <span className={STATUS_TONE.unsupported}>{s.unsupported} unsupported</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ResultsIntelligencePanel({
  intel,
  statusSummary,
}: {
  intel: ResultsIntelligence;
  statusSummary: PlatformStatusSummary[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink-900">Results intelligence</h2>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-ink-500">
            {intel.totalPosts} published · {intel.connectedPosts} measured
          </span>
          <span className="text-ink-300">·</span>
          <Link
            href="/api/results/export?type=top_posts"
            className="text-signal-700 hover:text-signal-800"
            prefetch={false}
          >
            Export top posts
          </Link>
          <Link
            href="/api/results/export?type=platform_performance"
            className="text-signal-700 hover:text-signal-800"
            prefetch={false}
          >
            Platforms
          </Link>
          <Link
            href="/api/results/export?type=metrics_history"
            className="text-signal-700 hover:text-signal-800"
            prefetch={false}
          >
            History
          </Link>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <TopPostsCard result={intel.topPosts} />
        <TopPlatformsCard result={intel.topPlatforms} />
        <ConsistencyCard result={intel.consistency} />
        <BestTimeCard result={intel.bestTime} />
      </div>
      <MetricsStatusCard summary={statusSummary} />
    </div>
  );
}
