import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listBridgeRequests } from "@/repositories/operator-bridge/bridge-request-repository";
import {
  BRIDGE_ASSISTANT_LABELS,
  BRIDGE_REQUEST_STATUS_LABELS,
  BRIDGE_REQUEST_TYPE_LABELS,
} from "@/core/operator-bridge";
import { CreateBridgeRequestForm } from "./_create-form";

export const dynamic = "force-dynamic";

export default async function OperatorBridgeIndexPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Operator bridge"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Configure Supabase to use the operator bridge.
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
          Create a workspace before requesting operator-side work.
        </div>
      </>
    );
  }

  const requests = await listBridgeRequests({
    workspaceId: membership.workspace.id,
  });

  return (
    <>
      <Topbar
        title="Operator bridge"
        description="Send a structured task to Claude Code / Codex / Opus, then paste the signed result back. Claude/Codex run outside Signal."
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-ink-900">
            How this works
          </h2>
          <ol className="mt-2 list-decimal list-inside text-xs text-ink-700 space-y-1 leading-relaxed">
            <li>Create a bridge request below.</li>
            <li>
              Open the request, copy the task prompt, paste it into Claude
              Code / Codex / Opus.
            </li>
            <li>The assistant runs the task and returns a JSON envelope.</li>
            <li>
              Paste the JSON back into Signal. Signal verifies the nonce and
              schema, then stores the result.
            </li>
            <li>
              The assistant&apos;s <em>recommended next action</em> never
              executes automatically. Apply it manually after review.
            </li>
          </ol>
        </section>

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Bridge requests
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                One row per task. Click into a row to copy the prompt and
                submit a result.
              </p>
            </div>
            <div className="text-xs text-ink-500">{requests.length} total</div>
          </header>
          {requests.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No bridge requests yet. Create one below.
            </div>
          ) : (
            <ul className="row-divider">
              {requests.map((r) => (
                <li
                  key={r.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/operator-bridge/${r.id}`}
                      className="text-sm font-medium text-ink-900 hover:text-signal-700"
                    >
                      {r.title}
                    </Link>
                    <div className="text-[11px] text-ink-500 mt-0.5">
                      {BRIDGE_ASSISTANT_LABELS[r.assistantType]} ·{" "}
                      {BRIDGE_REQUEST_TYPE_LABELS[r.requestType]} · risk{" "}
                      {r.riskLevel}
                    </div>
                    <div className="text-[11px] text-ink-400 mt-0.5">
                      expires {r.expiresAt.slice(0, 19).replace("T", " ")}
                    </div>
                  </div>
                  <span className="badge-neutral text-[10px] whitespace-nowrap">
                    {BRIDGE_REQUEST_STATUS_LABELS[r.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <CreateBridgeRequestForm />
      </div>
    </>
  );
}
