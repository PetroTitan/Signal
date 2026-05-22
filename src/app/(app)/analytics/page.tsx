import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";

export const metadata: Metadata = { title: "Analytics" };

const utmParams = [
  { key: "utm_source", description: "Always 'signal' for items distributed via this workspace." },
  { key: "utm_medium", description: "Platform-specific (reddit_organic, x_organic, linkedin_organic)." },
  { key: "utm_campaign", description: "Product campaign prefix plus weekly identifier." },
  { key: "signal_campaign_id", description: "Internal Signal campaign reference." },
  { key: "signal_item_id", description: "Specific plan item that produced the link." },
  { key: "product_id", description: "Product the link belongs to." },
  { key: "platform", description: "Source platform for the click." },
  { key: "account_id", description: "Originating account, for per-account attribution." },
];

export default function AnalyticsPage() {
  return (
    <>
      <Topbar
        title="Analytics"
        description="WebmasterID data is not connected yet."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            No analytics data yet
          </h2>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            When WebmasterID is connected, this page will surface per-product
            and per-account attribution. Until then, no engagement numbers,
            impressions, or conversion counts are shown — they would be
            fabricated, and Signal does not fabricate data.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Outbound link parameters (reserved)
          </h2>
          <p className="text-xs text-ink-500 mt-1">
            Every Signal-generated outbound link will carry these.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {utmParams.map((p) => (
              <li key={p.key} className="leading-relaxed">
                <span className="font-mono text-ink-900">{p.key}</span>
                <span className="text-ink-500"> — {p.description}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
