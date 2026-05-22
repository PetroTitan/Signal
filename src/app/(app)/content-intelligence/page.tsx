"use client";

import { Topbar } from "@/components/topbar";
import { useSignal } from "@/core/store";
import { sourceInsights as allSourceInsights } from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";
import type { SourceInsight } from "@/types";

const categoryLabels: Record<SourceInsight["category"], string> = {
  founder_observation: "Founder observation",
  product_lesson: "Product lesson",
  support_pattern: "Support pattern",
  workflow_problem: "Workflow problem",
  user_problem: "User problem",
  seo_opportunity: "SEO opportunity",
  discoverability_gap: "Discoverability gap",
  industry_pattern: "Industry pattern",
  operational_lesson: "Operational lesson",
  evergreen_topic: "Evergreen topic",
};

export default function ContentIntelligencePage() {
  const { state } = useSignal();
  const productsById = state.productsById;
  const insights = useDemoData(allSourceInsights);

  return (
    <>
      <Topbar
        title="Insights"
        description="Real observations Signal turns into platform-native opportunities."
      />

      <div className="px-6 lg:px-10 py-8 space-y-4 max-w-4xl">
        {insights.length === 0 ? (
          <div className="text-sm text-ink-500 py-12 text-center">
            No insights yet. Add one as a founder observation, product lesson,
            or support pattern.
          </div>
        ) : (
          <ul className="space-y-3">
            {insights.map((insight) => (
              <li key={insight.id} className="card p-4">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="badge-neutral text-[10px]">
                    {categoryLabels[insight.category]}
                  </span>
                  <span className="text-xs text-ink-500 ml-auto">
                    {productsById[insight.productId]?.name}
                  </span>
                </div>
                <div className="text-sm font-medium text-ink-900 leading-snug">
                  {insight.title}
                </div>
                <p className="text-xs text-ink-700 mt-1.5 leading-relaxed">
                  {insight.coreInsight}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
