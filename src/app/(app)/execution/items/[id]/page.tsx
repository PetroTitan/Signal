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

export const dynamic = "force-dynamic";

interface PageProps {
  params: { id: string };
}

export default async function ExecutionItemPage({ params }: PageProps) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Execution item" description="Persistence not configured." />
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
        <Topbar title="Execution item" description="No workspace found." />
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
  let verdict: SafeTestPolicyVerdict | null = null;
  if (item.status === "ready" && safeTestModeEnabled()) {
    const supabase = createSupabaseServerClient();
    verdict = await evaluateSafeTestPolicy({
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

  return (
    <>
      <Topbar
        title={`Execution item — ${item.status}`}
        description={`Queue: ${item.queueId}`}
        actions={
          <Link
            href={`/execution/${item.queueId}`}
            className="btn-ghost text-xs"
          >
            ← Back to queue
          </Link>
        }
      />
      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-5">
        <section className="card p-5 space-y-2">
          <h2 className="text-sm font-semibold text-ink-900">
            {item.title ?? "Untitled"}
          </h2>
          <div className="text-[11px] text-ink-500">
            platform: {item.platform ?? "—"} · action: {item.actionType} ·
            scheduled_at: {item.scheduledAt ?? "—"}
          </div>
          {item.body ? (
            <p className="text-xs text-ink-700 whitespace-pre-wrap">
              {item.body}
            </p>
          ) : null}
          {item.linkUrl ? (
            <div className="text-xs text-ink-700 font-mono break-all">
              link: {item.linkUrl}
            </div>
          ) : null}
        </section>

        {item.status === "completed" && history ? (
          <section className="card p-5 space-y-2 border-emerald-200 bg-emerald-50/40">
            <h2 className="text-sm font-semibold text-emerald-800">
              Published
            </h2>
            <div className="text-xs text-ink-700">
              Permalink:{" "}
              {history.providerPermalink ? (
                <a
                  href={history.providerPermalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-signal-700 underline font-mono"
                >
                  {history.providerPermalink}
                </a>
              ) : (
                "(none returned)"
              )}
            </div>
            <div className="text-[11px] text-ink-500">
              provider_post_id: {history.providerPostId ?? "—"} ·{" "}
              finished_at: {history.finishedAt}
            </div>
          </section>
        ) : null}

        {!safeTestModeEnabled() ? (
          <section className="card p-5 border-amber-200 bg-amber-50/40">
            <h2 className="text-sm font-semibold text-amber-800">
              SAFE_TEST_MODE is not enabled
            </h2>
            <p className="text-xs text-amber-800 mt-1 leading-relaxed">
              The controlled-publish path is gated by{" "}
              <span className="font-mono">SAFE_TEST_MODE=true</span>. Until
              the env var is set, no Reddit publish can be triggered.
            </p>
          </section>
        ) : item.status !== "ready" ? (
          <section className="card p-5 border-ink-200">
            <h2 className="text-sm font-semibold text-ink-900">
              Not ready for publish
            </h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              The scheduler hasn&apos;t marked this item{" "}
              <span className="font-mono">ready</span> yet. Once{" "}
              <span className="font-mono">scheduled_at</span> elapses and
              the next scheduler tick runs, this surface unlocks.
            </p>
          </section>
        ) : verdict ? (
          <>
            <section className="card p-5 space-y-3">
              <h2 className="text-sm font-semibold text-ink-900">
                Pre-publish checks
              </h2>
              <ul className="text-xs space-y-1.5">
                {verdict.checks.map((c) => (
                  <li
                    key={c.name}
                    className="flex items-start justify-between gap-3"
                  >
                    <div>
                      <span
                        className={
                          c.status === "pass"
                            ? "text-emerald-700"
                            : c.status === "fail"
                              ? "text-red-700"
                              : "text-amber-700"
                        }
                      >
                        {c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "·"}
                      </span>{" "}
                      <span className="text-ink-800">{c.name}</span>
                    </div>
                    <div className="text-ink-500 text-[11px]">{c.detail ?? "—"}</div>
                  </li>
                ))}
              </ul>
              {!verdict.ok ? (
                <div className="text-xs text-red-700 leading-relaxed">
                  Blocked: {verdict.reasonCode} — {verdict.reasonDetail}
                </div>
              ) : null}
            </section>

            {verdict.ok && verdict.preview ? (
              <>
                <section className="card p-5 space-y-2">
                  <h2 className="text-sm font-semibold text-ink-900">
                    Payload preview
                  </h2>
                  <div className="text-xs text-ink-700">
                    <div>
                      <span className="text-ink-500">subreddit:</span>{" "}
                      <span className="font-mono">
                        r/{verdict.preview.subreddit}
                      </span>
                    </div>
                    <div>
                      <span className="text-ink-500">account:</span>{" "}
                      u/{verdict.preview.account.handle ?? "—"}
                    </div>
                    <div>
                      <span className="text-ink-500">product:</span>{" "}
                      {verdict.preview.product?.name ?? "—"}
                    </div>
                    <div>
                      <span className="text-ink-500">creative:</span>{" "}
                      {verdict.preview.creative
                        ? `${verdict.preview.creative.type} · ${verdict.preview.creative.sourceType}`
                        : "—"}
                    </div>
                    <div>
                      <span className="text-ink-500">alt text:</span>{" "}
                      <span className="text-ink-700">
                        {verdict.preview.creative?.altText ?? "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-ink-500">scheduled_at:</span>{" "}
                      <span className="font-mono">
                        {verdict.preview.scheduledAt ?? "—"}
                      </span>
                    </div>
                  </div>
                  <pre className="text-[11px] bg-ink-50 p-3 rounded-md overflow-x-auto font-mono">
                    {JSON.stringify(verdict.preview.apiPayload, null, 2)}
                  </pre>
                </section>

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
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
