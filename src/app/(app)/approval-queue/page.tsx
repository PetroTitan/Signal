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
        description="Posts, products, and accounts waiting for your sign-off — all in one place."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        {totalPending === 0 ? (
          <section className="rounded-2xl border border-dashed border-ink-300 bg-ink-50/40 p-8 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              Nothing pending
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              You&apos;re all caught up. Posts, products, and account
              profiles will show up here when they&apos;re ready for review.
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
                  switch (reason) {
                    case null:
                      break;
                    case "creative_missing":
                      warnings.push("Media file required.");
                      break;
                    case "creative_only_planned":
                      warnings.push(
                        "Creative is only planned — attach a real asset.",
                      );
                      break;
                    case "creative_missing_asset":
                      warnings.push(
                        "Media file required (asset_url / source_url missing).",
                      );
                      break;
                    case "creative_missing_alt_text":
                      warnings.push("Alt text missing.");
                      break;
                    case "creative_missing_license_or_attribution":
                      warnings.push("License/attribution missing.");
                      break;
                    case "creative_missing_prompt":
                      warnings.push("Generated creative is missing its prompt.");
                      break;
                    case "creative_not_approved":
                      warnings.push("Creative not approved.");
                      break;
                    case "creative_rejected":
                      warnings.push("Creative was rejected.");
                      break;
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
                            id: creative.id,
                            creativeType: creative.creativeType,
                            sourceType: creative.sourceType,
                            status: creative.status,
                            assetUrl: creative.assetUrl,
                            sourceUrl: creative.sourceUrl,
                            altText: creative.altText,
                            license: creative.license,
                            attribution: creative.attribution,
                            prompt: creative.prompt,
                            mimeType: creative.mimeType,
                            sizeBytes: creative.sizeBytes,
                            uploadedAt: creative.uploadedAt,
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
                Submitted manually or via import. Approval just confirms
                the profile is yours.
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
                Submitted manually. Approving only confirms the identity —
                you still connect the account separately.
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
