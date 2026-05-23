import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getExecutionItemById } from "@/repositories/execution-item-repository";
import { getPublishHistoryForItem } from "@/repositories/publish-history-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  evaluateSafeTestPolicy,
  type SafeTestPolicyVerdict,
} from "@/core/publishing/safe-test-policy";
import {
  PUBLISH_CONFIRMATION_PHRASE,
  readAllowedTestSubreddits,
  safeTestModeEnabled,
} from "@/core/publishing/safe-test-env";
import { PublishForm } from "./_publish-form";
import { ManualPublishForm } from "./_manual-publish-form";
import { PrepareForManualPublishForm } from "./_prepare-for-manual-form";
import { isRedditOauthBlocked } from "@/lib/oauth/env";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { RedditPostPreview } from "@/components/platform-previews/reddit-post";
import { listCreativesForItems } from "@/repositories/weekly-plan-creative-repository";
import { getAccountById } from "@/repositories/account-repository";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { id: string };
}

export default async function ExecutionItemPage({ params }: PageProps) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Post" description="Persistence not configured." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Configure Supabase first.
        </div>
      </>
    );
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Post" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace first.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  let item;
  try {
    item = await getExecutionItemById(workspaceId, params.id);
  } catch (err) {
    if (err instanceof RepositoryError && err.code === "not_found") {
      notFound();
    }
    throw err;
  }

  const history = await getPublishHistoryForItem(workspaceId, item.id);

  // Pull the linked plan_item's creative + account handle so the
  // Reddit preview can render the real asset/handle.
  const planItemId =
    typeof (item.metadata as { plan_item_id?: string })?.plan_item_id ===
    "string"
      ? ((item.metadata as { plan_item_id: string }).plan_item_id)
      : null;
  const previewCreatives = planItemId
    ? await listCreativesForItems(workspaceId, [planItemId])
    : [];
  const previewCreative = previewCreatives[0] ?? null;
  const accountForPreview = item.accountId
    ? await getAccountById(workspaceId, item.accountId).catch(() => null)
    : null;

  // Resolve subreddit: form > metadata.target > whitelisted[0].
  const metaSub =
    typeof (item.metadata as { target?: string }).target === "string"
      ? (item.metadata as { target: string }).target
      : null;
  const allowed = readAllowedTestSubreddits();
  const subreddit = metaSub ?? allowed[0] ?? "";

  // Run a *dry* policy evaluation with an empty confirmation phrase
  // so we can render the gates inline. The publish action re-runs
  // the same policy with the real phrase before sending.
  //
  // F2.6: the page evaluates the policy matched to the item's status:
  //   - 'ready'                    → safe-test policy (API path)
  //   - 'ready_for_manual_publish' → manual policy (no OAuth gates)
  // The env-flag (REDDIT_OAUTH_STATUS) just informs which option the
  // operator should see surfaced first; it no longer auto-routes the
  // publish form. The operator must explicitly opt in via
  // "Prepare for manual publish".
  const oauthBlocked = isRedditOauthBlocked();
  const isReady = item.status === "ready";
  const isReadyForManual = item.status === "ready_for_manual_publish";
  let verdict: SafeTestPolicyVerdict | null = null;
  if ((isReady || isReadyForManual) && safeTestModeEnabled()) {
    const supabase = createSupabaseServerClient();
    const { evaluateManualPublishPolicy } = await import(
      "@/core/publishing/manual-publish-policy"
    );
    const policyFn = isReadyForManual
      ? evaluateManualPublishPolicy
      : evaluateSafeTestPolicy;
    verdict = await policyFn({
      supabase,
      workspaceId,
      executionItem: {
        id: item.id,
        accountId: item.accountId,
        productId: item.productId,
        platform: item.platform,
        title: item.title,
        body: item.body,
        linkUrl: item.linkUrl,
        scheduledAt: item.scheduledAt,
        actionType: item.actionType,
        metadata: item.metadata as Record<string, unknown>,
      },
      confirmationPhrase: PUBLISH_CONFIRMATION_PHRASE,
      subreddit,
      nowIso: new Date().toISOString(),
    });
  }

  const failedChecks = verdict
    ? verdict.checks.filter((c) => c.status === "fail")
    : [];
  const warningChecks = verdict
    ? verdict.checks.filter((c) => c.status === "warn")
    : [];

  return (
    <>
      <Topbar
        title={item.title ?? "Untitled post"}
        description={
          item.scheduledAt
            ? `Scheduled for ${new Date(item.scheduledAt).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}`
            : "Not scheduled"
        }
        actions={
          <div className="flex items-center gap-2">
            <ExecutionStateBadge status={item.status} size="md" />
            <Link href="/execution" className="btn-ghost text-xs">
              ← All publishing
            </Link>
          </div>
        }
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        {item.platform === "reddit" && subreddit ? (
          <section>
            <div className="text-[11px] uppercase tracking-wide text-ink-500 mb-2">
              Post preview
            </div>
            <RedditPostPreview
              subreddit={subreddit}
              authorHandle={accountForPreview?.handle ?? null}
              title={item.title ?? ""}
              body={item.body}
              linkUrl={item.linkUrl}
              scheduledAt={item.scheduledAt}
              creative={
                previewCreative
                  ? {
                      assetUrl: previewCreative.assetUrl,
                      altText: previewCreative.altText,
                      creativeType: previewCreative.creativeType,
                      mimeType: previewCreative.mimeType,
                    }
                  : null
              }
            />
          </section>
        ) : null}

        {item.status === "completed" && history ? (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5 space-y-2">
            <h2 className="text-sm font-semibold text-emerald-800">
              Published
            </h2>
            {history.providerPermalink ? (
              <a
                href={history.providerPermalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-emerald-800 underline break-all"
              >
                {history.providerPermalink}
                <span aria-hidden>↗</span>
              </a>
            ) : (
              <p className="text-xs text-emerald-800">
                Permalink not recorded.
              </p>
            )}
            <p className="text-[11px] text-ink-500">
              {new Date(history.finishedAt).toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          </section>
        ) : null}

        {!safeTestModeEnabled() ? (
          <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
            <h2 className="text-sm font-semibold text-amber-800">
              Manual publishing mode is off
            </h2>
            <p className="text-xs text-amber-800 mt-1 leading-relaxed">
              Publishing through Signal is currently paused. Re-enable it
              from your environment before this post can go out.
            </p>
          </section>
        ) : !isReady && !isReadyForManual ? (
          <section className="rounded-2xl border border-ink-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-900">
              Not ready to publish yet
            </h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              This post is still waiting for its scheduled time. Once that
              moment arrives, the publish controls unlock here.
            </p>
          </section>
        ) : verdict ? (
          <>
            {/* Publishing readiness — silent when all clear, loud only on real issues */}
            {verdict.ok ? (
              <section className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 flex items-start gap-3">
                <span
                  className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-emerald-500 text-white grid place-items-center text-xs"
                  aria-hidden
                >
                  ✓
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-emerald-800">
                    Ready to publish
                  </div>
                  {warningChecks.length > 0 ? (
                    <ul className="mt-1 text-[11px] text-amber-800 leading-relaxed space-y-0.5">
                      {warningChecks.map((c) => (
                        <li key={c.name}>· {c.detail ?? c.name}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-emerald-800/80">
                      All publishing checks passed.
                    </p>
                  )}
                </div>
              </section>
            ) : (
              <section className="rounded-2xl border border-red-200 bg-red-50/40 p-5">
                <h2 className="text-sm font-semibold text-red-800">
                  Not ready to publish
                </h2>
                <p className="text-xs text-red-800 mt-1 leading-relaxed">
                  {verdict.reasonDetail}
                </p>
                {failedChecks.length > 0 ? (
                  <ul className="mt-2 text-xs text-red-800 leading-relaxed space-y-1">
                    {failedChecks.map((c) => (
                      <li key={c.name}>· {c.detail ?? c.name}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            )}

            {verdict.ok && verdict.preview ? (
              <>
                {/* Publishing details — calm summary, no raw labels */}
                <section className="rounded-2xl border border-ink-200 bg-white p-5">
                  <h2 className="text-sm font-semibold text-ink-900">
                    Publishing details
                  </h2>
                  <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <div>
                      <dt className="text-ink-500">Going to</dt>
                      <dd className="text-ink-800">
                        r/{verdict.preview.subreddit}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-500">Posting as</dt>
                      <dd className="text-ink-800">
                        u/{verdict.preview.account.handle ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-500">For product</dt>
                      <dd className="text-ink-800">
                        {verdict.preview.product?.name ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-500">Scheduled</dt>
                      <dd className="text-ink-800">
                        {verdict.preview.scheduledAt
                          ? new Date(
                              verdict.preview.scheduledAt,
                            ).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : "—"}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-ink-500">Creative</dt>
                      <dd className="text-ink-800">
                        {verdict.preview.creative ? (
                          <>
                            {verdict.preview.creative.type} —{" "}
                            {verdict.preview.creative.altText ?? "(no alt text)"}
                          </>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                  </dl>
                </section>

                {isReadyForManual ? (
                  <ManualPublishForm
                    executionItemId={item.id}
                    defaultSubreddit={verdict.preview.subreddit}
                    payloadPreview={{
                      title: verdict.preview.title,
                      body: verdict.preview.body,
                      kind: verdict.preview.kind,
                      linkUrl: verdict.preview.linkUrl,
                      subreddit: verdict.preview.subreddit,
                      creativeAssetUrl:
                        verdict.preview.creative?.assetUrl ?? null,
                      altText: verdict.preview.creative?.altText ?? null,
                    }}
                  />
                ) : (
                  <>
                    {oauthBlocked ? (
                      <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
                        <h2 className="text-sm font-semibold text-amber-900">
                          Reddit publishing is manual right now
                        </h2>
                        <p className="text-xs text-amber-900 mt-1 leading-relaxed">
                          Reddit&apos;s API approval is still pending for
                          Signal. Use the manual publish flow below — Signal
                          prepares the post for you, you publish it on
                          Reddit, then paste the permalink back here.
                        </p>
                      </section>
                    ) : null}
                    <PrepareForManualPublishForm
                      executionItemId={item.id}
                      apiBlocked={oauthBlocked}
                    />
                    {!oauthBlocked ? (
                      <PublishForm
                        executionItemId={item.id}
                        defaultSubreddit={verdict.preview.subreddit}
                        payloadPreview={{
                          title: verdict.preview.title,
                          body: verdict.preview.body,
                          kind: verdict.preview.kind,
                          linkUrl: verdict.preview.linkUrl,
                          subreddit: verdict.preview.subreddit,
                          apiPayload: verdict.preview.apiPayload,
                        }}
                      />
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
