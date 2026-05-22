import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listProducts } from "@/repositories/product-repository";
import { ProductCreateForm } from "./_create-form";
import { ArchiveProductButton } from "./_archive-button";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Products"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured for this deployment. Set
            <code className="font-mono text-xs"> NEXT_PUBLIC_SUPABASE_URL</code>{" "}
            and
            <code className="font-mono text-xs"> NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
            {" "}to enable product persistence.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Products" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard to start adding products.
        </div>
      </>
    );
  }

  const products = await listProducts(membership.workspace.id);

  return (
    <>
      <Topbar
        title="Products"
        description="Each product carries its own positioning, voice, and CTA policy."
      />
      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {products.length === 0 ? (
          <section className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No products yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Create your first product profile. Signal will use its positioning
              and category when generating opportunities and drafts later.
            </p>
          </section>
        ) : (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-900">
                {products.length} product{products.length === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-ink-500">
                Workspace: {membership.workspace.name}
              </div>
            </header>
            <ul className="row-divider">
              {products.map((p) => (
                <li
                  key={p.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-900 truncate">
                      {p.name}
                    </div>
                    <div className="text-xs text-ink-500 mt-0.5 truncate">
                      {p.domain ?? "—"} · {p.category ?? "uncategorized"}
                    </div>
                    {p.summary ? (
                      <p className="text-xs text-ink-700 mt-1 line-clamp-2">
                        {p.summary}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="badge-neutral capitalize">{p.status}</span>
                    <ArchiveProductButton productId={p.id} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <ProductCreateForm />

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Stored in Supabase under your workspace. Visible only to{" "}
          <Link href="/settings" className="underline">
            workspace members
          </Link>
          .
        </p>
      </div>
    </>
  );
}
