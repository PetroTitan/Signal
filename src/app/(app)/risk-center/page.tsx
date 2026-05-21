import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import {
  accountsById,
  productsById,
  riskEvents,
} from "@/lib/mock";
import { formatDateTime } from "@/lib/format";
import type { RiskCategory } from "@/types";

export const metadata: Metadata = { title: "Risk center" };

const categoryLabels: Record<RiskCategory, string> = {
  duplicate_content: "Duplicate content",
  link_repetition: "Link repetition",
  overposting: "Overposting",
  synchronized_posting: "Synchronized posting",
  promotional_tone: "Promotional tone",
  account_fatigue: "Account fatigue",
  platform_cadence: "Platform cadence",
};

const categoryDescriptions: Record<RiskCategory, string> = {
  duplicate_content:
    "Same or near-identical content across accounts within a short window.",
  link_repetition:
    "Same outbound link posted by the same account within a short window.",
  overposting:
    "Account exceeds platform-specific cadence guidance for this period.",
  synchronized_posting:
    "Multiple accounts post within minutes of each other from this workspace.",
  promotional_tone:
    "Tone reads more salesy than the product's allowed CTA style.",
  account_fatigue:
    "Account is still in warm-up or has not earned the trust required to publish.",
  platform_cadence:
    "Cadence drift against platform-native rhythm for this content type.",
};

export default function RiskCenterPage() {
  const grouped = (Object.keys(categoryLabels) as RiskCategory[]).map(
    (cat) => ({
      category: cat,
      events: riskEvents.filter((r) => r.category === cat),
    }),
  );

  const highCount = riskEvents.filter((r) => r.level === "high").length;
  const mediumCount = riskEvents.filter((r) => r.level === "medium").length;
  const lowCount = riskEvents.filter((r) => r.level === "low").length;

  return (
    <>
      <Topbar
        title="Risk center"
        description="Cadence, tone, and account fatigue checks. Recommendations are calm. Action is yours."
      />

      <div className="px-6 lg:px-8 py-6 max-w-6xl space-y-6">
        <div className="grid grid-cols-3 gap-3">
          <Tile label="High" count={highCount} tone="high" />
          <Tile label="Medium" count={mediumCount} tone="medium" />
          <Tile label="Low / OK" count={lowCount} tone="low" />
        </div>

        <div className="space-y-4">
          {grouped.map(({ category, events }) => (
            <section key={category} className="card">
              <div className="px-5 py-3.5 border-b border-ink-100">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-ink-900">
                    {categoryLabels[category]}
                  </div>
                  <div className="text-xs text-ink-500">
                    {events.length} signal{events.length === 1 ? "" : "s"}
                  </div>
                </div>
                <p className="text-xs text-ink-500 mt-0.5">
                  {categoryDescriptions[category]}
                </p>
              </div>
              <ul className="row-divider">
                {events.length === 0 ? (
                  <li className="px-5 py-4 text-sm text-ink-500">
                    Nothing flagged for this category.
                  </li>
                ) : (
                  events.map((r) => {
                    const account = r.accountId
                      ? accountsById[r.accountId]
                      : undefined;
                    const product = r.productId
                      ? productsById[r.productId]
                      : undefined;
                    return (
                      <li key={r.id} className="px-5 py-3.5">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <RiskBadge level={r.level} />
                          {r.platform ? (
                            <PlatformBadge platform={r.platform} />
                          ) : null}
                          {product ? (
                            <span className="text-xs text-ink-500">
                              {product.name}
                            </span>
                          ) : null}
                          {account ? (
                            <span className="text-xs text-ink-500">
                              · {account.displayName}
                            </span>
                          ) : null}
                          <span className="ml-auto text-xs text-ink-400">
                            {formatDateTime(r.detectedAt)}
                          </span>
                        </div>
                        <div className="text-sm text-ink-800">{r.summary}</div>
                        <div className="text-xs text-ink-600 mt-1 italic">
                          {r.recommendation}
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

function Tile({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "low" | "medium" | "high";
}) {
  const accent =
    tone === "high"
      ? "text-red-700 bg-red-50"
      : tone === "medium"
        ? "text-amber-700 bg-amber-50"
        : "text-emerald-700 bg-emerald-50";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className="flex items-center justify-between mt-1">
        <div className="stat-value">{count}</div>
        <span className={`badge ${accent}`}>{label} signals</span>
      </div>
    </div>
  );
}
