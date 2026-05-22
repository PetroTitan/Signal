"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";

export default function ProductsPage() {
  const { state } = useSignal();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );

  return (
    <>
      <Topbar
        title="Products"
        description="Each product carries its own positioning, voice, and CTA policy."
      />
      <div className="px-6 lg:px-10 py-8 max-w-4xl">
        {products.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-3">
            {products.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/products/${p.slug}`}
                  className="block card p-4 hover:border-signal-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-ink-900">
                          {p.name}
                        </span>
                        <span className="text-xs text-ink-500">{p.domain}</span>
                      </div>
                      <p className="text-xs text-ink-600 line-clamp-2 leading-relaxed">
                        {p.positioning}
                      </p>
                    </div>
                    <ChevronRightIcon className="text-ink-400 mt-1" />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="badge-neutral text-[10px] capitalize">
                      {p.category}
                    </span>
                    {p.preferredPlatforms.map((id) => (
                      <PlatformBadge key={id} platform={id} />
                    ))}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <h2 className="text-base font-semibold text-ink-900">
        No products yet
      </h2>
      <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
        Create your first product profile. Signal will use its positioning, voice,
        and CTA policy when generating opportunities and drafts.
      </p>
      <p className="text-xs text-ink-400 mt-6">
        Product creation flow is planned for a later release. Turn on Demo data in
        Settings to explore the workflow.
      </p>
    </div>
  );
}
