import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { loadAccountHealth } from "@/core/intelligence/load-account-health.server";
import { platformLabel } from "@/core/metrics/metric-availability";
import {
  RecommendationRow,
  SignalCard,
} from "./_signal-card";

export const dynamic = "force-dynamic";

/**
 * Social performance / account health.
 *
 * Every card answers an operator question. There is no vanity metric on
 * this page and no composite score — each signal stands or falls on its
 * own evidence, and a signal that cannot be assessed says so rather than
 * rendering a zero.
 */

export default async function AccountHealthPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Account health"
          description="Audience, cadence and content signals for each connected identity."
        />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl">
          <div className="card card-padded">
            <p className="text-sm text-ink-600">
              Connect Supabase to read publication history.
            </p>
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  const view = membership
    ? await loadAccountHealth(membership.workspace.id)
    : { platforms: [] as Awaited<ReturnType<typeof loadAccountHealth>>["platforms"], empty: true };

  return (
    <>
      <Topbar
        title="Account health"
        description="Audience, cadence and content signals per identity. Signals are shown with their evidence — nothing here is a score, and a signal with too little data says so."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-6">
        {view.empty ? (
          <div className="card card-padded">
            <h2 className="section-title">Nothing published yet</h2>
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              Once a post goes out through Signal, this page will show the audience
              behind it, how often you publish, and whether the copy is repeating
              across platforms.
            </p>
            <Link href="/weekly-plan" className="btn-secondary mt-4 inline-flex">
              Go to the weekly plan
            </Link>
          </div>
        ) : null}

        {view.platforms.map((platform) => (
          <section key={platform.panel.platform} className="card card-padded space-y-4">
            <header className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="section-title">
                  {platformLabel(platform.panel.platform)}
                </h2>
                {platform.panel.handle ? (
                  <span className="text-xs text-ink-500 break-all">
                    {platform.panel.handle}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-ink-600 leading-relaxed">
                {platform.panel.summary}
              </p>
              <p className="text-[11px] text-ink-400">
                {platform.publishedCount} published ·{" "}
                {platform.measuredCount} measured
                {platform.lastPublishedAt
                  ? ` · last on ${platform.lastPublishedAt.slice(0, 10)}`
                  : null}
              </p>
            </header>

            <ul className="list-none p-0 m-0">
              {platform.panel.signals.map((signal) => (
                <SignalCard key={signal.key} signal={signal} />
              ))}
            </ul>

            {platform.recommendations.length > 0 ? (
              <div className="border-t border-ink-100 pt-4 space-y-3">
                <h3 className="stat-label">What to do next</h3>
                {platform.recommendations.map((rec) => (
                  <RecommendationRow
                    key={`${platform.panel.platform}-${rec.kind}`}
                    recommendation={rec}
                  />
                ))}
                <p className="text-[11px] text-ink-400 leading-relaxed">
                  These are suggestions for you to act on. Signal does not like,
                  follow, reply or engage on your behalf.
                </p>
              </div>
            ) : null}
          </section>
        ))}

        {!view.empty ? (
          <div className="card card-padded">
            <h2 className="section-title">How to read this page</h2>
            <ul className="text-sm text-ink-600 mt-2 space-y-1.5 leading-relaxed">
              <li>
                A metric a platform does not report shows as unavailable, never as
                zero. Bluesky, for example, has no impressions of any kind.
              </li>
              <li>
                Comparisons use medians, and are withheld entirely below six
                measured posts. &ldquo;Not enough data&rdquo; is a real answer.
              </li>
              <li>
                Nothing on this page shows how a platform treated your account.
                Signal cannot see that, so it does not claim to.
              </li>
            </ul>
            <Link href="/results" className="btn-ghost mt-3 inline-flex text-ink-500">
              See individual post results
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
