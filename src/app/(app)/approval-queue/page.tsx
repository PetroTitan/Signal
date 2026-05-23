import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listPlanItemsByStatus } from "@/repositories/weekly-plan-repository";
import {
  listProducts,
  listProductsPendingReview,
} from "@/repositories/product-repository";
import {
  listAccounts,
  listAccountsPendingReview,
  type GrowthAccountRecord,
} from "@/repositories/account-repository";
import {
  creativeReadinessReason,
  listCreativesForItems,
} from "@/repositories/weekly-plan-creative-repository";
import { ApprovalRow } from "./_row";
import { PendingProductRow } from "./_product-row";
import { PendingAccountRow } from "./_account-row";

export const dynamic = "force-dynamic";

export default async function ApprovalQueuePage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Review this week"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured. Configure env vars to use the
            persisted approval queue.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Review this week" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace to start reviewing.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  const [
    pendingItems,
    pendingProducts,
    pendingAccounts,
    allProducts,
    allAccounts,
  ] = await Promise.all([
    listPlanItemsByStatus(workspaceId, ["pending_approval"]),
    listProductsPendingReview(workspaceId),
    listAccountsPendingReview(workspaceId),
    listProducts(workspaceId, { includeArchived: true }),
    listAccounts(workspaceId),
  ]);

  const productNameById = new Map(
    allProducts.map((p) => [p.id, p.name] as const),
  );
  const productNameFor = (a: GrowthAccountRecord): string | null =>
    a.productId ? productNameById.get(a.productId) ?? null : null;
  const accountById = new Map(allAccounts.map((a) => [a.id, a] as const));

  const creatives = pendingItems.length
    ? await listCreativesForItems(
        workspaceId,
        pendingItems.map((i) => i.id),
      )
    : [];
  const creativeByItem = new Map<string, (typeof creatives)[number]>();
  for (const c of creatives) {
    if (!creativeByItem.has(c.weeklyPlanItemId)) {
      creativeByItem.set(c.weeklyPlanItemId, c);
    }
  }

  const totalPending =
    pendingItems.length + pendingProducts.length + pendingAccounts.length;

  return (
    <>
      <Topbar
        title="Review this week"
        description="Approve, reject, or move to the backlog. One central surface for content items, product profiles, and account profiles."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {totalPending === 0 ? (
          <section className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              Nothing pending
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              No weekly plan items in <span className="font-mono">pending_approval</span>,
              no products in <span className="font-mono">pending_review</span>,
              no accounts in <span className="font-mono">pending_review</span>.
            </p>
          </section>
        ) : null}

        {pendingItems.length > 0 ? (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  Weekly plan items awaiting approval ({pendingItems.length})
                </div>
                <p className="text-[11px] text-ink-500 mt-0.5">
                  Approving a <span className="font-mono">post</span> queues it
                  for scheduled publishing — it does not publish now. Comments
                  remain draft-only.
                </p>
              </div>
              <div className="text-xs text-ink-500">
                Workspace: {membership.workspace.name}
              </div>
            </header>
            <ul className="row-divider">
              {pendingItems.map((it) => {
                const isPost = it.contentType === "post";
                const creative = creativeByItem.get(it.id) ?? null;
                const warnings: string[] = [];
                if (isPost && !it.scheduledAt) {
                  warnings.push("Missing schedule (date/time).");
                }
                if (isPost) {
                  const reason = creativeReadinessReason(creative);
                  if (reason) {
                    warnings.push(
                      `Creative not ready: ${reason.replace(/_/g, " ")}.`,
                    );
                  }
                }
                const account = it.accountId
                  ? accountById.get(it.accountId)
                  : null;
                const accountLabel = account
                  ? `${account.displayName ?? account.id} · ${account.platform}`
                  : null;
                const productName = it.productId
                  ? (productNameById.get(it.productId) ?? null)
                  : null;
                const canApprove = !isPost || warnings.length === 0;
                return (
                  <ApprovalRow
                    key={it.id}
                    itemId={it.id}
                    title={it.title}
                    platform={it.platform}
                    contentType={it.contentType}
                    body={it.body}
                    riskLevel={it.riskLevel}
                    scheduledAt={it.scheduledAt}
                    accountLabel={accountLabel}
                    productName={productName}
                    creative={
                      creative
                        ? {
                            type: creative.creativeType,
                            sourceType: creative.sourceType,
                            status: creative.status,
                          }
                        : null
                    }
                    warnings={warnings}
                    isPost={isPost}
                    canApprove={canApprove}
                  />
                );
              })}
            </ul>
          </section>
        ) : null}

        {pendingProducts.length > 0 ? (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100">
              <div className="text-sm font-semibold text-ink-900">
                Product profiles awaiting review ({pendingProducts.length})
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                Created by manual entry, the MCP server, or import flows.
                Approval only confirms the profile.
              </p>
            </header>
            <ul className="row-divider">
              {pendingProducts.map((p) => (
                <PendingProductRow
                  key={p.id}
                  productId={p.id}
                  name={p.name}
                  domain={p.domain}
                  summary={p.summary}
                  category={p.category}
                  source={p.source}
                  reviewStatus={p.reviewStatus}
                  status={p.status}
                  createdAt={p.createdAt}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {pendingAccounts.length > 0 ? (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100">
              <div className="text-sm font-semibold text-ink-900">
                Account profiles awaiting review ({pendingAccounts.length})
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                Created by manual entry or the MCP server. Approval does not
                connect OAuth.
              </p>
            </header>
            <ul className="row-divider">
              {pendingAccounts.map((a) => (
                <PendingAccountRow
                  key={a.id}
                  accountId={a.id}
                  displayName={a.displayName}
                  handle={a.handle}
                  platform={a.platform}
                  role={a.role}
                  productName={productNameFor(a)}
                  source={a.source}
                  reviewStatus={a.reviewStatus}
                  connectionStatus={a.connectionStatus}
                  status={a.status}
                  createdAt={a.createdAt}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
