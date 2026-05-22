import { Topbar } from "@/components/topbar";
import { SectionHeader } from "@/components/section-header";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listRecentActivity } from "@/repositories/activity-repository";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Activity"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured. Activity events will appear here once
            persistence is enabled.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Activity" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard.
        </div>
      </>
    );
  }

  const events = await listRecentActivity(membership.workspace.id, 80);

  return (
    <>
      <Topbar
        title="Activity"
        description="Real workspace events. Append-only, workspace-scoped."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {events.length === 0 ? (
          <div className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No activity yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Activity surfaces here as you add products, accounts, and adjust
              workspace settings.
            </p>
          </div>
        ) : (
          <section className="card">
            <SectionHeader
              title={`${events.length} event${events.length === 1 ? "" : "s"}`}
              hint="Most recent first."
            />
            <ul className="row-divider">
              {events.map((e) => (
                <li key={e.id} className="px-5 py-3 flex items-start gap-3">
                  <span className="text-[10px] uppercase tracking-wide text-ink-500 font-mono shrink-0 w-32 truncate">
                    {e.eventType}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink-900 leading-snug">
                      {e.title}
                    </div>
                    {e.description ? (
                      <div className="text-xs text-ink-600 mt-0.5 leading-relaxed">
                        {e.description}
                      </div>
                    ) : null}
                  </div>
                  <span className="text-[11px] text-ink-500 font-mono shrink-0">
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Activity is append-only and scoped to your workspace. No external
          analytics are ingested.
        </p>
      </div>
    </>
  );
}
