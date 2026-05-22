import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listBacklog } from "@/repositories/backlog-repository";
import { BacklogRow } from "./_row";

export const dynamic = "force-dynamic";

export default async function BacklogPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Backlog" description="Persistence not configured." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured. Configure env vars to use the
            persisted backlog.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Backlog" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace to use the backlog.
        </div>
      </>
    );
  }

  const items = await listBacklog(membership.workspace.id);

  return (
    <>
      <Topbar
        title="Backlog"
        description="Held items, ready to come back when the cadence has room."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {items.length === 0 ? (
          <section className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No backlog items yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Items moved here during approval will appear in this list.
            </p>
          </section>
        ) : (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-900">
                Held for future weeks
              </div>
              <span className="badge-neutral">
                {items.length} held
              </span>
            </header>
            <ul className="row-divider">
              {items.map((b) => (
                <BacklogRow
                  key={b.id}
                  backlogId={b.id}
                  title={b.title}
                  body={b.body}
                  platform={b.platform}
                  reason={b.reason}
                  createdAt={b.createdAt}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
