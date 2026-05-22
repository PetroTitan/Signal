import { Topbar } from "@/components/topbar";
import { PlatformNotConnectedPanel } from "@/components/command-center";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { PlatformDbAccountsCard } from "../_db-accounts-card";
import { PlatformOAuthPanel } from "../_oauth-panel";

export const dynamic = "force-dynamic";

export default async function XCommandCenter() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="X command center"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl space-y-6">
          <PlatformOAuthPanel platform="x" />
          <PlatformNotConnectedPanel platform="x" />
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="X command center" description="No workspace found." />
        <div className="px-6 lg:px-8 py-8 max-w-3xl space-y-6">
          <PlatformOAuthPanel platform="x" />
          <PlatformNotConnectedPanel platform="x" />
        </div>
      </>
    );
  }

  const accounts = await listAccountsByPlatform(membership.workspace.id, "x");

  if (accounts.length === 0) {
    return (
      <>
        <Topbar
          title="X command center"
          description="Founder voice. Replies first. Threads when they matter."
        />
        <div className="px-6 lg:px-8 py-8 max-w-3xl space-y-6">
          <PlatformOAuthPanel platform="x" />
          <PlatformNotConnectedPanel platform="x" />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="X command center"
        description="Founder voice. Replies first. Threads when they matter."
      />
      <div className="px-6 lg:px-8 py-6 max-w-3xl space-y-6">
        <PlatformOAuthPanel platform="x" />
        <PlatformDbAccountsCard platform="x" accounts={accounts} />
        <p className="text-[11px] text-ink-500 leading-relaxed">
          Engine-driven surfaces (format mix, velocity, content queue) will
          return here once weekly items are persisted to the database.
        </p>
      </div>
    </>
  );
}
