import Link from "next/link";
import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, AccountStatusBadge } from "@/components/badges";
import { ChevronRightIcon, LockIcon } from "@/components/icons";
import { accounts, productsById } from "@/lib/mock";

export const metadata: Metadata = { title: "Accounts" };

export default function AccountsPage() {
  return (
    <>
      <Topbar
        title="Accounts"
        description="Each account belongs to a product and a platform. Signal connects only via official OAuth."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <OauthNotice />

        <section className="card">
          <div className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">
              {accounts.length} accounts
            </div>
            <div className="text-xs text-ink-500">
              Sorted by readiness
            </div>
          </div>
          <ul className="row-divider">
            {[...accounts]
              .sort((a, b) => b.readinessScore - a.readinessScore)
              .map((a) => {
                const product = productsById[a.productId];
                return (
                  <li key={a.id}>
                    <Link
                      href={`/accounts/${a.id}`}
                      className="flex items-center gap-4 px-5 py-3.5 hover:bg-ink-50/60 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-900 truncate">
                          {a.displayName}
                          {a.handle ? (
                            <span className="ml-2 text-xs text-ink-500 font-normal">
                              {a.handle}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <PlatformBadge platform={a.platform} />
                          <span className="text-xs text-ink-500 capitalize">
                            {a.role} · {product.name}
                          </span>
                          <AccountStatusBadge status={a.status} />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-medium text-ink-900">
                          {a.readinessScore}%
                        </div>
                        <div className="text-[11px] text-ink-500">readiness</div>
                      </div>
                      <ChevronRightIcon className="text-ink-400" />
                    </Link>
                  </li>
                );
              })}
          </ul>
        </section>
      </div>
    </>
  );
}

function OauthNotice() {
  return (
    <div className="card border-signal-200 bg-signal-50/40">
      <div className="p-4 flex items-start gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
          <LockIcon />
        </span>
        <div className="text-sm">
          <div className="font-semibold text-ink-900">
            Connect accounts only via official OAuth.
          </div>
          <p className="text-ink-700 mt-0.5 leading-relaxed">
            Signal never asks for passwords. We do not store credentials. We do
            not use anti-detect browsers, proxies, or fingerprinting. Once a
            platform OAuth integration ships, every account will connect
            through the platform&apos;s own authorization flow.
          </p>
        </div>
      </div>
    </div>
  );
}
