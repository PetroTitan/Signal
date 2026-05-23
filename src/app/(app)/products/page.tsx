import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import { ProductCreateForm } from "./_create-form";
import { ArchiveProductButton } from "./_archive-button";
import { ProductCard } from "@/components/publishing/product-card";

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
            Supabase is not configured for this deployment. Set{" "}
            <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
            and{" "}
            <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>{" "}
            to enable product persistence.
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

  const workspaceId = membership.workspace.id;
  const [products, accounts, recentPublishes] = await Promise.all([
    listProducts(workspaceId),
    listAccounts(workspaceId),
    listRecentPublishes(workspaceId, 100),
  ]);

  // Per-product: recent plan_item count + last published time.
  const supabase = createSupabaseServerClient();
  const { data: recentItemsRaw } = await supabase
    .from("weekly_plan_items")
    .select("product_id, account_id, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);
  const recentItems = (recentItemsRaw ?? []) as Array<{
    product_id: string | null;
    account_id: string | null;
    created_at: string;
  }>;
  const recentPostCountByProduct = new Map<string, number>();
  for (const it of recentItems) {
    if (!it.product_id) continue;
    recentPostCountByProduct.set(
      it.product_id,
      (recentPostCountByProduct.get(it.product_id) ?? 0) + 1,
    );
  }

  const lastPublishedByProduct = new Map<string, string>();
  for (const p of recentPublishes) {
    if (p.outcome !== "published" || !p.productId) continue;
    const prev = lastPublishedByProduct.get(p.productId);
    if (!prev || new Date(p.finishedAt) > new Date(prev)) {
      lastPublishedByProduct.set(p.productId, p.finishedAt);
    }
  }

  // Linked accounts per product. We resolve via the plan items
  // (any account that has authored a post against this product
  // counts as linked) plus the account.product_id pointer.
  const linkedByProduct = new Map<
    string,
    Set<string>
  >();
  for (const a of accounts) {
    if (a.productId) {
      const set = linkedByProduct.get(a.productId) ?? new Set();
      set.add(a.id);
      linkedByProduct.set(a.productId, set);
    }
  }
  for (const it of recentItems) {
    if (!it.product_id || !it.account_id) continue;
    const set = linkedByProduct.get(it.product_id) ?? new Set();
    set.add(it.account_id);
    linkedByProduct.set(it.product_id, set);
  }

  return (
    <>
      <Topbar
        title="Products"
        description="The products Signal is publishing for. Each carries its own positioning and links to the accounts publishing it."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        {products.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-ink-300 bg-ink-50/40 p-8 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No products yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Add your first product. Signal uses its name, domain, and
              positioning to ground every post you write.
            </p>
          </section>
        ) : (
          <div className="space-y-3">
            {products.map((p) => {
              const linkedIds = linkedByProduct.get(p.id) ?? new Set();
              const linkedAccounts = accounts
                .filter((a) => linkedIds.has(a.id))
                .map((a) => ({
                  id: a.id,
                  handle: a.handle,
                  platform: a.platform,
                }));
              return (
                <ProductCard
                  key={p.id}
                  id={p.id}
                  name={p.name}
                  domain={p.domain}
                  summary={p.summary}
                  category={p.category}
                  status={p.status}
                  linkedAccounts={linkedAccounts}
                  recentPostCount={recentPostCountByProduct.get(p.id) ?? 0}
                  lastPublishedAt={lastPublishedByProduct.get(p.id) ?? null}
                  archiveControl={<ArchiveProductButton productId={p.id} />}
                />
              );
            })}
          </div>
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
