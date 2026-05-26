import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getExecutionItemById } from "@/repositories/execution-item-repository";
import { getPublishHistoryForItem } from "@/repositories/publish-history-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  formatUtcForOperatorDebug,
  formatUtcForWorkspace,
  getRelativeDueLabel,
} from "@/core/scheduling/workspace-time";
import { buildBlueskyOutcomeSummary } from "@/core/publishing/bluesky-outcome-summary";
import { BlueskyOutcomeDiagnostics } from "@/components/publishing/bluesky-outcome-diagnostics";
import { listLogsForItem } from "@/repositories/execution-log-repository";
import { listCreativesForItem } from "@/repositories/weekly-plan-creative-repository";
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
import { PublishTierOneForm } from "./_publish-tier-one-form";
import { PublishDistributionForm } from "./_publish-distribution-form";
import {
  buildFullThreadText,
  buildXShareIntentUrl,
  transformForX,
} from "@/core/publishing/transformers/x";
import {
  buildLinkedInShareIntentUrl,
  transformForLinkedIn,
} from "@/core/publishing/transformers/linkedin";
import {
  buildFullYouTubeText,
  buildYouTubeStudioUrl,
  transformForYouTube,
} from "@/core/publishing/transformers/youtube";
import {
  buildThreadsComposerUrl,
  transformForThreads,
} from "@/core/publishing/transformers/threads";
import {
  buildFullInstagramText,
  buildInstagramComposerUrl,
  transformForInstagram,
} from "@/core/publishing/transformers/instagram";
import { canonicalPostFromRequest } from "@/core/publishing/canonical-post";
import { isRedditOauthBlocked } from "@/lib/oauth/env";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { RedditPostPreview } from "@/components/platform-previews/reddit-post";
import { listCreativesForItems } from "@/repositories/weekly-plan-creative-repository";
import { getAccountById } from "@/repositories/account-repository";
import { getPlanItemById } from "@/repositories/weekly-plan-repository";
import { RemoveButton } from "@/app/(app)/weekly-plan/_remove-button";

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
  const supabaseForTz = createSupabaseServerClient();
  const { data: wsSettingsForTz } = await supabaseForTz
    .from("workspace_settings")
    .select("timezone")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const workspaceTimezone =
    (wsSettingsForTz as { timezone?: string | null } | null)?.timezone ??
    "UTC";
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
  // The plan-item drives the "remove / cancel" affordance because it
  // owns the founder-facing status. The execution_item is the
  // engine's view; we keep it in sync but don't expose its enum.
  const linkedPlanItem = planItemId
    ? await getPlanItemById(workspaceId, planItemId).catch(() => null)
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
  const isTierOne =
    item.platform === "devto" ||
    item.platform === "hashnode" ||
    item.platform === "bluesky";
  // F5.0 + F5.1 — distribution-only (manual-first) platforms.
  const isDistribution =
    item.platform === "x" ||
    item.platform === "linkedin" ||
    item.platform === "youtube" ||
    item.platform === "threads" ||
    item.platform === "instagram";
  let verdict: SafeTestPolicyVerdict | null = null;
  // Tier-1 platforms (dev.to / Hashnode / Bluesky) AND distribution
  // platforms (X / LinkedIn) skip the Reddit-shaped safe-test policy
  // entirely — they use either API credentials read from env or the
  // founder's own browser session on the native composer.
  if (
    !isTierOne &&
    !isDistribution &&
    (isReady || isReadyForManual) &&
    safeTestModeEnabled()
  ) {
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

  // Cadence cooldown — soft warning only, never blocks.
  const { checkCadence, cadenceMessage } = await import(
    "@/core/publishing/cadence-cooldown"
  );
  const cadence =
    item.platform === "devto" ||
    item.platform === "hashnode" ||
    item.platform === "bluesky" ||
    item.platform === "x" ||
    item.platform === "linkedin" ||
    item.platform === "youtube" ||
    item.platform === "threads" ||
    item.platform === "instagram" ||
    item.platform === "telegram"
      ? await checkCadence({
          workspaceId,
          platform: item.platform,
        })
      : null;
  const cadenceWarning =
    cadence && cadence.recommendWaiting && item.platform
      ? cadenceMessage(cadence, item.platform)
      : null;

  // Bluesky-specific outcome diagnostics. Built from:
  //   - execution_items.metadata.publish_outcome (status fields)
  //   - latest terminal execution_logs row (rich AT Proto fields)
  //   - plan_item creatives (for divergence detection)
  // No-op for other platforms; the component is only rendered when
  // platform === "bluesky".
  let blueskyOutcomeSummary:
    | ReturnType<typeof buildBlueskyOutcomeSummary>
    | null = null;
  if (item.platform === "bluesky") {
    const logs = await listLogsForItem(workspaceId, item.id, 50);
    const TERMINAL_LOG_EVENTS = new Set([
      "item.completed",
      "item.failed",
      "item.blocked",
      "item.dry_run_finished",
    ]);
    const latestTerminalLog =
      logs.find((l) => TERMINAL_LOG_EVENTS.has(l.eventType)) ?? null;
    const planItemCreatives = planItemId
      ? await listCreativesForItem(workspaceId, planItemId).catch(() => [])
      : [];
    blueskyOutcomeSummary = buildBlueskyOutcomeSummary({
      executionItem: {
        status: item.status,
        metadata: item.metadata as Record<string, unknown> | null,
        body: item.body,
        title: item.title,
      },
      latestTerminalLog: latestTerminalLog
        ? {
            eventType: latestTerminalLog.eventType,
            message: latestTerminalLog.message,
            metadata: latestTerminalLog.metadata as Record<string, unknown> | null,
            createdAt: latestTerminalLog.createdAt,
          }
        : null,
      planItemCreatives,
    });
  }

  return (
    <>
      <Topbar
        title={item.title ?? "Untitled post"}
        description={
          item.scheduledAt
            ? `Scheduled for ${
                formatUtcForWorkspace(item.scheduledAt, workspaceTimezone).local
              } (${workspaceTimezone}) · ${formatUtcForOperatorDebug(item.scheduledAt)} · ${
                getRelativeDueLabel(item.scheduledAt, new Date()).relative
              }`
            : "Not scheduled"
        }
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <ExecutionStateBadge status={item.status} size="md" />
            {linkedPlanItem && linkedPlanItem.status !== "published" ? (
              <RemoveButton
                itemId={linkedPlanItem.id}
                status={linkedPlanItem.status}
                size="md"
              />
            ) : null}
            <Link href="/execution" className="btn-ghost text-xs">
              ← All publishing
            </Link>
          </div>
        }
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        {item.platform === "bluesky" && blueskyOutcomeSummary ? (
          <BlueskyOutcomeDiagnostics summary={blueskyOutcomeSummary} />
        ) : null}

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
              {formatUtcForWorkspace(history.finishedAt, workspaceTimezone).local} ·{" "}
              {workspaceTimezone} ·{" "}
              {formatUtcForOperatorDebug(history.finishedAt)}
            </p>
          </section>
        ) : null}

        {isDistribution && isReady ? (
          <DistributionPublishBranch
            itemId={item.id}
            platform={
              item.platform as
                | "x"
                | "linkedin"
                | "youtube"
                | "threads"
                | "instagram"
            }
            title={item.title}
            body={item.body}
            linkUrl={item.linkUrl}
            tags={
              Array.isArray((item.metadata as { tags?: unknown })?.tags)
                ? ((item.metadata as { tags: unknown[] }).tags as string[])
                : []
            }
            summary={
              typeof (item.metadata as { summary?: unknown })?.summary === "string"
                ? ((item.metadata as { summary: string }).summary as string)
                : null
            }
            canonicalUrl={
              typeof (item.metadata as { canonical_url?: unknown })?.canonical_url ===
              "string"
                ? ((item.metadata as { canonical_url: string }).canonical_url as string)
                : item.linkUrl
            }
            cadenceWarning={cadenceWarning}
          />
        ) : isDistribution && !isReady ? (
          <section className="rounded-2xl border border-ink-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-900">
              Not ready to publish yet
            </h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              This post is still waiting for its scheduled time. Once that
              moment arrives, the publish controls unlock here.
            </p>
          </section>
        ) : isTierOne && isReady ? (
          <>
            {cadenceWarning ? (
              <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 flex items-start gap-3">
                <span
                  className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-amber-500 text-white grid place-items-center text-xs"
                  aria-hidden
                >
                  ·
                </span>
                <p className="text-xs text-amber-900 leading-relaxed">
                  {cadenceWarning}
                </p>
              </section>
            ) : null}
            <PublishTierOneForm
              executionItemId={item.id}
              platform={
                item.platform as "devto" | "hashnode" | "bluesky"
              }
              cooldownWarning={null}
            />
          </>
        ) : isTierOne && !isReady ? (
          <section className="rounded-2xl border border-ink-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-ink-900">
              Not ready to publish yet
            </h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              This post is still waiting for its scheduled time. Once that
              moment arrives, the publish controls unlock here.
            </p>
          </section>
        ) : !safeTestModeEnabled() ? (
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
            {cadenceWarning ? (
              <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 flex items-start gap-3">
                <span
                  className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-amber-500 text-white grid place-items-center text-xs"
                  aria-hidden
                >
                  ·
                </span>
                <p className="text-xs text-amber-900 leading-relaxed">
                  {cadenceWarning}
                </p>
              </section>
            ) : null}
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
                        {verdict.preview.scheduledAt ? (
                          <>
                            {
                              formatUtcForWorkspace(
                                verdict.preview.scheduledAt,
                                workspaceTimezone,
                              ).local
                            }{" "}
                            <span className="text-ink-500">
                              · {workspaceTimezone} ·{" "}
                              {formatUtcForOperatorDebug(
                                verdict.preview.scheduledAt,
                              )}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
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

/**
 * F5.0 + F5.1 — build the manual-distribution preview server-side from
 * the execution-item content and render the publish form.
 */
function DistributionPublishBranch(props: {
  itemId: string;
  platform: "x" | "linkedin" | "youtube" | "threads" | "instagram";
  title: string | null;
  body: string | null;
  linkUrl: string | null;
  tags: string[];
  summary: string | null;
  canonicalUrl: string | null;
  cadenceWarning: string | null;
}) {
  const canonical = canonicalPostFromRequest({
    planItemId: props.itemId,
    title: props.title,
    body: props.body,
    linkUrl: props.linkUrl,
    canonicalUrl: props.canonicalUrl ?? props.linkUrl,
    summary: props.summary,
    tags: props.tags,
  });

  const empty = (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5">
      <h2 className="text-sm font-semibold text-amber-800">
        Nothing to publish yet
      </h2>
      <p className="text-xs text-amber-800 mt-1 leading-relaxed">
        Write the post body first, then come back to publish.
      </p>
    </section>
  );

  if (props.platform === "x") {
    const thread = transformForX(canonical);
    if (thread.length === 0) return empty;
    return (
      <PublishDistributionForm
        executionItemId={props.itemId}
        platform="x"
        preview={{
          kind: "x_thread",
          parts: thread,
          fullText: buildFullThreadText(thread),
          shareIntentUrl: buildXShareIntentUrl(thread[0]?.text ?? ""),
        }}
        cooldownWarning={props.cadenceWarning}
      />
    );
  }

  if (props.platform === "linkedin") {
    const result = transformForLinkedIn(canonical);
    if (result.text.length === 0) return empty;
    return (
      <PublishDistributionForm
        executionItemId={props.itemId}
        platform="linkedin"
        preview={{
          kind: "linkedin_post",
          text: result.text,
          warnings: result.warnings,
          shareIntentUrl: buildLinkedInShareIntentUrl(
            props.canonicalUrl ?? props.linkUrl,
          ),
        }}
        cooldownWarning={props.cadenceWarning}
      />
    );
  }

  if (props.platform === "youtube") {
    const assets = transformForYouTube(canonical);
    if (assets.title.length === 0 && assets.description.length === 0) {
      return empty;
    }
    return (
      <PublishDistributionForm
        executionItemId={props.itemId}
        platform="youtube"
        preview={{
          kind: "youtube_assets",
          title: assets.title,
          description: assets.description,
          tags: assets.tags,
          chapters: assets.chapters,
          thumbnailIdea: assets.thumbnailIdea,
          pinnedCommentSuggestion: assets.pinnedCommentSuggestion,
          shortsHook: assets.shortsHook,
          warnings: assets.warnings,
          fullText: buildFullYouTubeText(assets),
          shareIntentUrl: buildYouTubeStudioUrl(),
        }}
        cooldownWarning={props.cadenceWarning}
      />
    );
  }

  if (props.platform === "threads") {
    const result = transformForThreads(canonical);
    if (result.text.length === 0) return empty;
    return (
      <PublishDistributionForm
        executionItemId={props.itemId}
        platform="threads"
        preview={{
          kind: "threads_post",
          text: result.text,
          warnings: result.warnings,
          shareIntentUrl: buildThreadsComposerUrl(),
        }}
        cooldownWarning={props.cadenceWarning}
      />
    );
  }

  // instagram
  const assets = transformForInstagram(canonical);
  if (assets.caption.length === 0) return empty;
  return (
    <PublishDistributionForm
      executionItemId={props.itemId}
      platform="instagram"
      preview={{
        kind: "instagram_assets",
        caption: assets.caption,
        carouselOutline: assets.carouselOutline,
        reelHook: assets.reel.hook,
        reelCaption: assets.reel.caption,
        hashtags: assets.hashtags,
        warnings: assets.warnings,
        fullText: buildFullInstagramText(assets),
        shareIntentUrl: buildInstagramComposerUrl(),
      }}
      cooldownWarning={props.cadenceWarning}
    />
  );
}
