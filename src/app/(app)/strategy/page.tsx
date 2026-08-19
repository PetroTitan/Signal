import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { loadStrategy } from "@/core/strategy/load-strategy.server";
import { interpretStrategy } from "@/core/strategy/interpret-strategy.server";
import { interpretationUnavailableNote } from "@/core/strategy/ai-interpretation";
import { EVIDENCE_THRESHOLDS } from "@/core/strategy/performance";
import {
  ExperimentCard,
  InterpretationBlock,
  MixRow,
  OptionCard,
  PairRow,
  PerformanceRow,
} from "./_strategy-cards";

export const dynamic = "force-dynamic";

/**
 * Content strategy — "what should I post next?"
 *
 * The page renders the pipeline in the order it runs: what was
 * published, what that means descriptively, the options that follow, and
 * only then an optional AI reading of the same evidence. Nothing on this
 * page approves, schedules, publishes, or blocks anything, and no
 * control here writes a row.
 */

export default async function StrategyPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Strategy"
          description="What to post next, and the evidence behind each option."
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
  const view = membership ? await loadStrategy(membership.workspace.id) : null;

  if (!view || view.empty) {
    return (
      <>
        <Topbar
          title="Strategy"
          description="What to post next, and the evidence behind each option."
        />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-6">
          <div className="card card-padded">
            <h2 className="section-title">Nothing published yet</h2>
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              This page describes what you have published and what that supports.
              With no history there is nothing to describe — the options below are
              starting points, not findings.
            </p>
            <Link href="/weekly-plan" className="btn-secondary mt-4 inline-flex">
              Go to the weekly plan
            </Link>
          </div>
          {view ? (
            <section className="card card-padded">
              <h2 className="section-title">Starting points</h2>
              <ul className="list-none p-0 m-0 mt-2">
                {view.recommendations.map((option) => (
                  <OptionCard key={option.id} option={option} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </>
    );
  }

  // The AI section is optional in the strictest sense: this page is
  // complete before the call, and unchanged if it returns nothing.
  const interpretation = membership
    ? await interpretStrategy(
        {
          statements: [
            `${view.postCount} post(s) published over ${view.window.label} across ${view.platforms.join(", ")}.`,
            view.mix.summary,
            view.topicSummary,
            view.performance.summary,
            view.differentiation.summary,
            ...view.dominant,
            ...view.untested.map((u) => u.fact),
          ],
          options: view.recommendations.map((o) => ({
            title: o.title,
            rationale: o.rationale,
          })),
          gaps:
            view.performance.measuredCount === 0
              ? ["No post has been measured, so no option is supported by performance data."]
              : [],
        },
        { workspaceId: membership.workspace.id },
      )
    : null;

  return (
    <>
      <Topbar
        title="Strategy"
        description="Options for what to post next, each with the evidence behind it. Nothing here blocks publishing, approval or scheduling."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-6">
        <section className="card card-padded">
          <h2 className="section-title">What you have published</h2>
          <p className="text-sm text-ink-600 mt-2 leading-relaxed break-words">
            {view.mix.summary}
          </p>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed break-words">
            {view.topicSummary}
          </p>
          <p className="text-[11px] text-ink-400 mt-2 leading-relaxed break-words">
            {view.window.reason}
            {view.cadence.postsPerWeek != null
              ? ` About ${view.cadence.postsPerWeek} post(s) a week.`
              : " Your publishing rate is not established yet."}
          </p>
        </section>

        <section className="card card-padded space-y-5">
          <h2 className="section-title">Content mix</h2>
          <MixRow dimension={view.mix.archetypes} />
          <MixRow dimension={view.mix.hooks} />
          <MixRow dimension={view.mix.ctas} />
          {view.untested.length > 0 ? (
            <div className="border-t border-ink-100 pt-4">
              <h3 className="stat-label">Never tried</h3>
              <ul className="list-none p-0 m-0 mt-2 space-y-1">
                {view.untested.map((item) => (
                  <li key={`${item.dimension}-${item.value}`} className="text-sm text-ink-600 leading-relaxed break-words">
                    {item.fact}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-ink-400 mt-2 leading-relaxed">
                An untested option is not a gap to close. It is simply something
                with no evidence either way.
              </p>
            </div>
          ) : null}
        </section>

        <section className="card card-padded">
          <h2 className="section-title">What to post next</h2>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            Options, in no required order. You decide; none of these is a
            prerequisite for anything.
          </p>
          <ul className="list-none p-0 m-0 mt-3">
            {view.recommendations.map((option) => (
              <OptionCard key={option.id} option={option} />
            ))}
          </ul>
        </section>

        <section className="card card-padded">
          <h2 className="section-title">Performance evidence</h2>
          <p className="text-sm text-ink-600 mt-2 leading-relaxed break-words">
            {view.performance.summary}
          </p>
          {view.performance.strongest.length > 0 ? (
            <ul className="list-none p-0 m-0 mt-3">
              {view.performance.strongest.slice(0, 6).map((entry) => (
                <PerformanceRow key={`${entry.dimension}-${entry.value}`} entry={entry} />
              ))}
            </ul>
          ) : null}
          <p className="text-[11px] text-ink-400 mt-3 leading-relaxed">
            A median needs {EVIDENCE_THRESHOLDS.medianRequires} measured posts; a
            comparative verdict needs {EVIDENCE_THRESHOLDS.verdictRequires}. Below
            those, the answer is a description, not a finding — and posts that were
            never measured are excluded rather than counted as zero.
          </p>
        </section>

        {view.differentiation.similarPairs.length > 0 ? (
          <section className="card card-padded">
            <h2 className="section-title">Across platforms</h2>
            <p className="text-sm text-ink-600 mt-2 leading-relaxed break-words">
              {view.differentiation.summary}
            </p>
            <ul className="list-none p-0 m-0 mt-3">
              {view.differentiation.similarPairs.slice(0, 5).map((pair) => (
                <PairRow key={`${pair.aId}-${pair.bId}`} pair={pair} />
              ))}
            </ul>
            <p className="text-[11px] text-ink-400 mt-3 leading-relaxed">
              Reposting the same message on every platform is a valid choice. This
              is a text measurement, not a verdict, and it never stops a post.
            </p>
          </section>
        ) : null}

        {view.experiments.length > 0 ? (
          <section className="card card-padded">
            <h2 className="section-title">Questions worth asking</h2>
            <p className="text-sm text-ink-600 mt-2 leading-relaxed break-words">
              {view.experimentSummary}
            </p>
            <ul className="list-none p-0 m-0 mt-3">
              {view.experiments.map((experiment) => (
                <ExperimentCard key={experiment.id} experiment={experiment} />
              ))}
            </ul>
          </section>
        ) : null}

        {interpretation ? (
          <InterpretationBlock
            text={interpretation.ok ? interpretation.text : null}
            note={interpretation.ok ? null : interpretationUnavailableNote(interpretation.reason)}
          />
        ) : null}

        <div className="card card-padded">
          <h2 className="section-title">How to read this page</h2>
          <ul className="text-sm text-ink-600 mt-2 space-y-1.5 leading-relaxed">
            <li>
              Every statement is labelled as a fact, an observation, or a
              suggestion. A suggestion is not a finding, and neither is a finding
              an instruction.
            </li>
            <li>
              Nothing here shows how a platform treated your account. Signal
              cannot see that, so it does not claim to.
            </li>
            <li>
              These options never block publishing, approval or scheduling. You can
              ignore all of them and nothing changes.
            </li>
          </ul>
          <Link href="/account-health" className="btn-ghost mt-3 inline-flex text-ink-500">
            See account health
          </Link>
        </div>
      </div>
    </>
  );
}
