import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { RepositoryError } from "@/repositories/errors";
import { getBridgeRequestById } from "@/repositories/operator-bridge/bridge-request-repository";
import { listResultsForRequest } from "@/repositories/operator-bridge/bridge-result-repository";
import { getActiveNonceForRequest } from "@/repositories/operator-bridge/bridge-nonce-repository";
import {
  BRIDGE_ASSISTANT_LABELS,
  BRIDGE_REQUEST_STATUS_LABELS,
  BRIDGE_REQUEST_TYPE_LABELS,
  buildBridgeReport,
  buildTaskPrompt,
} from "@/core/operator-bridge";
import { CopyableTaskPrompt } from "../_copyable-prompt";
import { SubmitResultForm } from "../_submit-result-form";
import { CancelRequestForm } from "../_cancel-form";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { id: string };
}

export default async function OperatorBridgeDetailPage({ params }: PageProps) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Operator bridge" description="Persistence not configured." />
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
        <Topbar title="Operator bridge" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace first.
        </div>
      </>
    );
  }

  let request;
  try {
    request = await getBridgeRequestById({
      workspaceId: membership.workspace.id,
      requestId: params.id,
    });
  } catch (err) {
    if (err instanceof RepositoryError && err.code === "not_found") notFound();
    throw err;
  }

  const [results, activeNonce] = await Promise.all([
    listResultsForRequest({
      workspaceId: membership.workspace.id,
      requestId: request.id,
    }),
    getActiveNonceForRequest({
      workspaceId: membership.workspace.id,
      requestId: request.id,
    }),
  ]);

  const report = buildBridgeReport(request, results);
  const prompt = activeNonce
    ? buildTaskPrompt({ request, nonce: activeNonce.nonce })
    : null;

  return (
    <>
      <Topbar
        title={request.title}
        description={`${BRIDGE_ASSISTANT_LABELS[request.assistantType]} · ${BRIDGE_REQUEST_TYPE_LABELS[request.requestType]} · risk ${request.riskLevel}`}
        actions={
          <Link href="/operator-bridge" className="btn-secondary text-xs">
            ← All bridge requests
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card p-5">
          <div className="flex items-center justify-between text-xs text-ink-600">
            <div>
              Status:{" "}
              <span className="badge-neutral text-[10px]">
                {BRIDGE_REQUEST_STATUS_LABELS[request.status]}
              </span>
            </div>
            <div>
              Expires{" "}
              <span className="font-mono">
                {request.expiresAt.slice(0, 19).replace("T", " ")}
              </span>
              {report.isExpired ? (
                <span className="ml-2 text-red-700">(expired)</span>
              ) : null}
            </div>
          </div>
        </section>

        {prompt ? (
          <CopyableTaskPrompt
            requestId={request.id}
            prompt={prompt}
            nonce={activeNonce!.nonce}
          />
        ) : (
          <section className="card p-5 text-xs text-ink-600">
            No active nonce. The request may have been cancelled or its nonce
            consumed. Cancel and recreate the request to mint a fresh nonce.
          </section>
        )}

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Submit result</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Paste the JSON envelope the assistant returned. Signal verifies
            the schema, the request_id / nonce, and runs a forbidden-fields
            scan over the payload.
          </p>
          {report.isTerminal ? (
            <p className="text-xs text-amber-700 mt-2">
              Request is in a terminal state and no longer accepts results.
            </p>
          ) : (
            <SubmitResultForm requestId={request.id} />
          )}
        </section>

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">Results</div>
            <p className="text-xs text-ink-500 mt-0.5">
              Newest first. Each submission is preserved; nonces are
              consumed on the first submission.
            </p>
          </header>
          {results.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">No results yet.</div>
          ) : (
            <ul className="row-divider">
              {results.map((r) => (
                <li key={r.id} className="px-5 py-3 text-xs space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px]">
                      {r.id.slice(0, 8)}
                    </span>
                    <span
                      className={
                        r.verificationStatus === "verified"
                          ? "text-green-700"
                          : r.verificationStatus === "rejected"
                          ? "text-red-700"
                          : r.verificationStatus === "failed"
                          ? "text-red-700"
                          : "text-ink-500"
                      }
                    >
                      {r.verificationStatus}
                    </span>
                  </div>
                  <div className="text-ink-700">{r.resultSummary}</div>
                  {r.verificationErrors.length > 0 ? (
                    <ul className="text-[11px] text-red-700 list-disc list-inside">
                      {r.verificationErrors.slice(0, 6).map((e, idx) => (
                        <li key={idx}>{e}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="text-ink-400">{r.createdAt}</div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {!report.isTerminal ? (
          <CancelRequestForm requestId={request.id} />
        ) : null}
      </div>
    </>
  );
}
