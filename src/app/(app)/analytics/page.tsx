import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { products } from "@/lib/mock";

export const metadata: Metadata = { title: "Analytics" };

const utmParams = [
  { key: "utm_source", description: "Always 'signal' for items distributed via this workspace." },
  { key: "utm_medium", description: "Platform-specific, e.g. 'reddit_organic', 'x_organic', 'linkedin_organic'." },
  { key: "utm_campaign", description: "Product campaign prefix plus weekly identifier." },
  { key: "signal_campaign_id", description: "Internal Signal campaign reference." },
  { key: "signal_item_id", description: "Specific plan item that produced the link." },
  { key: "product_id", description: "Product the link belongs to." },
  { key: "platform", description: "Source platform for the click." },
  { key: "account_id", description: "Originating account, for per-account attribution." },
];

const futureMetrics = [
  { label: "Visits" },
  { label: "Sessions" },
  { label: "Signups" },
  { label: "Engagement quality" },
  { label: "Conversions" },
  { label: "Platform attribution" },
];

export default function AnalyticsPage() {
  return (
    <>
      <Topbar
        title="Analytics"
        description="WebmasterID integration is not yet connected. Signal stores nothing, fakes nothing."
      />

      <div className="px-6 lg:px-8 py-6 max-w-5xl space-y-6">
        <section className="card">
          <div className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              WebmasterID readiness
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Tracking schema is in place. The data stream is not yet connected.
            </p>
          </div>
          <ul className="row-divider">
            <ReadinessLine label="Tracking link schema" status="ready" />
            <ReadinessLine label="UTM parameters" status="ready" />
            <ReadinessLine label="Per-product campaign prefixes" status="ready" />
            <ReadinessLine label="WebmasterID client SDK" status="pending" />
            <ReadinessLine label="Live conversion stream" status="not_connected" />
          </ul>
        </section>

        <section className="card">
          <div className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Outbound link parameters
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Reserved on every Signal-generated tracking link.
            </p>
          </div>
          <ul className="row-divider">
            {utmParams.map((p) => (
              <li key={p.key} className="px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-mono text-sm text-ink-900">{p.key}</div>
                  <span className="badge-neutral">reserved</span>
                </div>
                <p className="text-xs text-ink-500 mt-0.5">{p.description}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <div className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Performance overview
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                Metrics will appear here once WebmasterID is connected.
              </p>
            </div>
            <span className="badge bg-ink-100 text-ink-500">
              Data not yet connected
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-5">
            {futureMetrics.map((m) => (
              <div
                key={m.label}
                className="rounded-md border border-dashed border-ink-200 p-4"
              >
                <div className="stat-label">{m.label}</div>
                <div className="text-xl font-semibold text-ink-300 mt-1">
                  —
                </div>
                <div className="text-[11px] text-ink-400 mt-1">
                  Data not yet connected
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Per-product campaign prefixes
            </div>
          </div>
          <ul className="row-divider">
            {products.map((p) => (
              <li key={p.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <div className="text-sm text-ink-900">{p.name}</div>
                  <div className="text-xs text-ink-500">{p.domain}</div>
                </div>
                <div className="font-mono text-xs text-ink-700">
                  {p.trackingMetadata.utmSource} ·{" "}
                  {p.trackingMetadata.campaignPrefix}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function ReadinessLine({
  label,
  status,
}: {
  label: string;
  status: "ready" | "pending" | "not_connected";
}) {
  const tone =
    status === "ready"
      ? "bg-emerald-500"
      : status === "pending"
        ? "bg-amber-500"
        : "bg-ink-300";
  const statusLabel =
    status === "ready"
      ? "Ready"
      : status === "pending"
        ? "Pending"
        : "Not connected";
  return (
    <li className="px-5 py-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${tone}`} />
        <span className="text-sm text-ink-800">{label}</span>
      </div>
      <span className="text-xs text-ink-500">{statusLabel}</span>
    </li>
  );
}
