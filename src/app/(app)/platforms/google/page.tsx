import { Topbar } from "@/components/topbar";
import { NotConnectedState } from "@/components/empty-state";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { PlatformDbAccountsCard } from "../_db-accounts-card";

export const dynamic = "force-dynamic";

export default async function GoogleVisibilityCommandCenter() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Google visibility — search & discoverability operations"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl">
          <NotConnectedState variant="noDiscoverability">
            Supabase is not configured. Configure env vars to enable
            discoverability tracking.
          </NotConnectedState>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar
          title="Google visibility — search & discoverability operations"
          description="No workspace found."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl">
          <NotConnectedState variant="noDiscoverability" />
        </div>
      </>
    );
  }

  const accounts = await listAccountsByPlatform(
    membership.workspace.id,
    "google",
  );

  if (accounts.length === 0) {
    return (
      <>
        <Topbar
          title="Google visibility — search & discoverability operations"
          description="Not a publishing platform. Signal does not auto-index, auto-update, or auto-publish."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl">
          <NotConnectedState
            variant="noDiscoverability"
            secondary={{ href: "/accounts", label: "Add Google account" }}
          >
            Search Console is not connected. No fake rankings, traffic,
            indexed pages, or impressions are shown.
          </NotConnectedState>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Google visibility — search & discoverability operations"
        description="Not a publishing platform. Signal does not auto-index, auto-update, or auto-publish."
      />
      <div className="px-6 lg:px-8 py-6 max-w-3xl space-y-6">
        <PlatformDbAccountsCard platform="google" accounts={accounts} />
        <p className="text-[11px] text-ink-500 leading-relaxed">
          Discoverability metrics (visibility score, content freshness,
          topical coverage, YouTube planning) will return here once Search
          Console integration ships. No fake metrics are rendered.
        </p>
      </div>
    </>
  );
}
