import { Topbar } from "@/components/topbar";
import { PlatformNotConnectedPanel } from "@/components/command-center";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { PlatformDbAccountsCard } from "../_db-accounts-card";
import { PlatformOAuthPanel } from "../_oauth-panel";

export const dynamic = "force-dynamic";

export default async function RedditCommandCenter() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Reddit command center"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl space-y-6">
          <PlatformOAuthPanel platform="reddit" />
          <PlatformNotConnectedPanel platform="reddit" />
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar
          title="Reddit command center"
          description="No workspace found."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl space-y-6">
          <PlatformOAuthPanel platform="reddit" />
          <PlatformNotConnectedPanel platform="reddit" />
        </div>
      </>
    );
  }

  const accounts = await listAccountsByPlatform(
    membership.workspace.id,
    "reddit",
  );

  if (accounts.length === 0) {
    return (
      <>
        <Topbar
          title="Reddit command center"
          description="Community-first. Comments before posts. Links last."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl space-y-6">
          <PlatformOAuthPanel platform="reddit" />
          <PlatformNotConnectedPanel platform="reddit" />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Reddit command center"
        description="Community-first. Comments before posts. Links last."
      />
      <div className="px-6 lg:px-8 py-6 max-w-3xl space-y-6">
        <PlatformOAuthPanel platform="reddit" />
        <PlatformDbAccountsCard platform="reddit" accounts={accounts} />
        <p className="text-[11px] text-ink-500 leading-relaxed">
          Engine-driven surfaces (cadence ratio, content queue, risk rules)
          will return here once weekly items are persisted to the database.
          Today this page only shows accounts that exist in your workspace.
        </p>
      </div>
    </>
  );
}
