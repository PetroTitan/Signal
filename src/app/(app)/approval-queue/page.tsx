import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listPlanItemsByStatus } from "@/repositories/weekly-plan-repository";
import { ApprovalRow } from "./_row";

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

  const pending = await listPlanItemsByStatus(membership.workspace.id, [
    "pending_approval",
  ]);

  return (
    <>
      <Topbar
        title="Review this week"
        description="Approve, reject, or move to the backlog. One pass."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {pending.length === 0 ? (
          <section className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No items awaiting approval
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Items added to the current weekly plan land here as{" "}
              <span className="font-mono">pending_approval</span>.
            </p>
          </section>
        ) : (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-900">
                {pending.length} item{pending.length === 1 ? "" : "s"} pending
              </div>
              <div className="text-xs text-ink-500">Workspace: {membership.workspace.name}</div>
            </header>
            <ul className="row-divider">
              {pending.map((it) => (
                <ApprovalRow
                  key={it.id}
                  itemId={it.id}
                  title={it.title}
                  platform={it.platform}
                  contentType={it.contentType}
                  body={it.body}
                  riskLevel={it.riskLevel}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
