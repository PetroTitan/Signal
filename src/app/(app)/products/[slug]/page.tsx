import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { products, productsBySlug, accounts, weeklyPlanItems } from "@/lib/mock";

type Params = { params: { slug: string } };

export function generateStaticParams() {
  return products.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({ params }: Params): Metadata {
  const p = productsBySlug[params.slug];
  if (!p) return { title: "Product not found" };
  return {
    title: p.name,
    description: p.positioning,
  };
}

export default function ProductPage({ params }: Params) {
  const product = productsBySlug[params.slug];
  if (!product) notFound();

  const productAccounts = accounts.filter((a) => a.productId === product.id);
  const productItems = weeklyPlanItems.filter(
    (i) => i.productId === product.id,
  );

  return (
    <>
      <Topbar
        title={product.name}
        description={`${product.domain} — ${product.category}`}
      />
      <div className="px-6 lg:px-8 py-6 max-w-5xl space-y-6">
        <Section title="Positioning">
          <p className="text-sm text-ink-800 leading-relaxed">
            {product.positioning}
          </p>
        </Section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Section title="Target audience">
            <ul className="text-sm text-ink-800 space-y-1">
              {product.targetAudience.map((a) => (
                <li key={a}>· {a}</li>
              ))}
            </ul>
          </Section>
          <Section title="Preferred platforms">
            <div className="flex flex-wrap gap-2">
              {product.preferredPlatforms.map((id) => (
                <PlatformBadge key={id} platform={id} />
              ))}
            </div>
          </Section>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Section title="CTA policy">
            <Row label="Style" value={prettyCta(product.ctaStyle)} />
            <div className="mt-2">
              <div className="stat-label mb-1.5">Allowed</div>
              <ul className="text-sm text-ink-800 space-y-1">
                {product.allowedCtaCopy.length === 0 ? (
                  <li className="text-ink-500">No outbound CTA permitted.</li>
                ) : (
                  product.allowedCtaCopy.map((c) => <li key={c}>· {c}</li>)
                )}
              </ul>
            </div>
            <div className="mt-3">
              <div className="stat-label mb-1.5">Forbidden claims</div>
              <ul className="text-sm text-ink-800 space-y-1">
                {product.forbiddenClaims.map((c) => (
                  <li key={c}>· {c}</li>
                ))}
              </ul>
            </div>
          </Section>

          <Section title="Content style and risk">
            <Row label="Risk tolerance" value={capitalize(product.riskTolerance)} />
            <div className="mt-2 text-sm text-ink-800">{product.contentStyle}</div>
          </Section>
        </div>

        <Section title="Tracking metadata (future WebmasterID)">
          <Row label="utm_source" value={product.trackingMetadata.utmSource} />
          <Row label="campaign prefix" value={product.trackingMetadata.campaignPrefix} />
          <div className="mt-2">
            <div className="stat-label mb-1.5">utm_medium by platform</div>
            <ul className="text-sm text-ink-800 space-y-1 font-mono">
              {Object.entries(product.trackingMetadata.utmMediumByPlatform).map(
                ([k, v]) => (
                  <li key={k}>
                    {k} → {v}
                  </li>
                ),
              )}
            </ul>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            Data not yet connected. Links will resolve and report once WebmasterID is wired in.
          </p>
        </Section>

        <Section
          title="Accounts on this product"
          hint={`${productAccounts.length} configured`}
        >
          {productAccounts.length === 0 ? (
            <p className="text-sm text-ink-500">No accounts yet.</p>
          ) : (
            <ul className="row-divider -mx-5">
              {productAccounts.map((a) => (
                <li key={a.id} className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink-900">
                      {a.displayName}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <PlatformBadge platform={a.platform} />
                      <span className="text-xs text-ink-500 capitalize">
                        {a.role}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-ink-500">
                    Readiness {a.readinessScore}%
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="This week's items"
          hint={`${productItems.length} planned`}
        >
          {productItems.length === 0 ? (
            <p className="text-sm text-ink-500">
              No items planned for this product this week.
            </p>
          ) : (
            <ul className="row-divider -mx-5">
              {productItems.map((i) => (
                <li key={i.id} className="px-5 py-3">
                  <div className="flex items-center gap-2 mb-0.5">
                    <PlatformBadge platform={i.platform} />
                    <span className="text-xs text-ink-500 capitalize">
                      {i.contentType.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="text-sm text-ink-800 truncate">
                    {i.draft.hook}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="px-5 py-3.5 border-b border-ink-100 flex items-start justify-between gap-3">
        <div className="text-sm font-semibold text-ink-900">{title}</div>
        {hint ? <div className="text-xs text-ink-500">{hint}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <span className="text-ink-500">{label}</span>
      <span className="text-ink-900 font-medium">{value}</span>
    </div>
  );
}

function prettyCta(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
