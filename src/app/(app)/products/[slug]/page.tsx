"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { useSignal } from "@/core/store";
import type { ProductProfile } from "@/types";

export default function ProductPage() {
  const params = useParams<{ slug: string }>();
  const { state } = useSignal();
  const product = useMemo(
    () => Object.values(state.productsById).find((p) => p.slug === params.slug),
    [state.productsById, params.slug],
  );

  if (!product) {
    return (
      <>
        <Topbar title="Product not found" />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-center">
          <p className="text-sm text-ink-700">
            This product does not exist in the current workspace.
          </p>
          <Link href="/products" className="btn mt-4 inline-flex">
            Back to products
          </Link>
        </div>
      </>
    );
  }

  return <ProductView product={product} />;
}

function ProductView({ product }: { product: ProductProfile }) {
  const { state } = useSignal();
  const productAccounts = useMemo(
    () =>
      Object.values(state.accountsById).filter(
        (a) => a.productId === product.id,
      ),
    [state.accountsById, product.id],
  );
  const productItems = state.items.filter((i) => i.productId === product.id);

  return (
    <>
      <Topbar
        title={product.name}
        description={`${product.domain} · ${product.category}`}
      />
      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <Section title="Positioning">
          <p className="text-sm text-ink-800 leading-relaxed">{product.positioning}</p>
        </Section>

        <Section title="Audience">
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

        <Section title="CTA policy">
          <p className="text-sm text-ink-800 mb-2">
            Style:{" "}
            <span className="text-ink-900 font-medium">
              {product.ctaStyle.replace(/_/g, " ")}
            </span>
          </p>
          {product.allowedCtaCopy.length > 0 ? (
            <ul className="text-sm text-ink-800 space-y-1">
              {product.allowedCtaCopy.map((c) => (
                <li key={c}>· {c}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-500">No outbound CTA permitted.</p>
          )}
        </Section>

        <Section title="Accounts">
          {productAccounts.length === 0 ? (
            <p className="text-sm text-ink-500">No connected accounts yet.</p>
          ) : (
            <ul className="text-sm text-ink-800 space-y-1">
              {productAccounts.map((a) => (
                <li key={a.id}>· {a.displayName}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Items this week">
          {productItems.length === 0 ? (
            <p className="text-sm text-ink-500">Nothing planned for this product.</p>
          ) : (
            <ul className="text-sm text-ink-800 space-y-1">
              {productItems.map((i) => (
                <li key={i.id}>· {i.draft.hook}</li>
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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500 mb-3">
        {title}
      </div>
      {children}
    </section>
  );
}
