import Link from "next/link";
import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { ChevronRightIcon } from "@/components/icons";
import { products } from "@/lib/mock";

export const metadata: Metadata = { title: "Products" };

export default function ProductsPage() {
  return (
    <>
      <Topbar
        title="Products"
        description="Each product carries its own positioning, tone, CTA policy, and risk profile. Signal applies these to every weekly plan."
      />
      <div className="px-6 lg:px-8 py-6 max-w-7xl">
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {products.map((p) => (
            <li key={p.id}>
              <Link
                href={`/products/${p.slug}`}
                className="block card hover:border-signal-300 hover:shadow transition-all"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-base font-semibold text-ink-900">
                          {p.name}
                        </span>
                        <span className="text-xs text-ink-500">{p.domain}</span>
                      </div>
                      <p className="text-sm text-ink-700 line-clamp-2">
                        {p.positioning}
                      </p>
                    </div>
                    <ChevronRightIcon className="text-ink-400 mt-1" />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="badge-neutral capitalize">{p.category}</span>
                    <span className="badge-neutral capitalize">
                      {p.riskTolerance} risk
                    </span>
                    {p.preferredPlatforms.map((id) => (
                      <PlatformBadge key={id} platform={id} />
                    ))}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
