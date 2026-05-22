import { Topbar } from "@/components/topbar";
import { PlatformNotConnectedPanel } from "@/components/command-center";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { PlatformDbAccountsCard } from "../_db-accounts-card";

export const dynamic = "force-dynamic";

export default async function LinkedInCommandCenter() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="LinkedIn command center"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-8 py-8 max-w-7xl">
          <PlatformNotConnectedPanel platform="linkedin" />
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar
          title="LinkedIn command center"
          description="No workspace found."
        />
        <div className="px-6 lg:px-8 py-8 max-w-7xl">
          <PlatformNotConnectedPanel platform="linkedin" />
        </div>
      </>
    );
  }

  const accounts = await listAccountsByPlatform(
    membership.workspace.id,
    "linkedin",
  );

  if (accounts.length === 0) {
    return (
      <>
        <Topbar
          title="LinkedIn command center"
          description="B2B trust layer. Quality over frequency."
        />
        <div className="px-6 lg:px-8 py-8 max-w-7xl">
          <PlatformNotConnectedPanel platform="linkedin" />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="LinkedIn command center"
        description="B2B trust layer. Quality over frequency."
      />
      <div className="px-6 lg:px-8 py-6 max-w-3xl space-y-6">
        <PlatformDbAccountsCard platform="linkedin" accounts={accounts} />
        <p className="text-[11px] text-ink-500 leading-relaxed">
          Engine-driven surfaces (polish checklist, content queue, risk
          rules) will return here once weekly items are persisted to the
          database.
        </p>
      </div>
    </>
  );
}
