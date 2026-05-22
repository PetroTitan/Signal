import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { ChevronRightIcon } from "@/components/icons";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccounts } from "@/repositories/account-repository";
import { getPlatformStrategy } from "@/core/platforms";
import type { PlatformId } from "@/types";

export const dynamic = "force-dynamic";

const platformIds: PlatformId[] = ["reddit", "x", "linkedin"];

export default async function PlatformsOverview() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Platforms"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured for this deployment.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Platforms" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace to start connecting platforms.
        </div>
      </>
    );
  }

  const accounts = await listAccounts(membership.workspace.id);
  const accountsByPlatform = new Map<string, number>();
  for (const a of accounts) {
    accountsByPlatform.set(
      a.platform,
      (accountsByPlatform.get(a.platform) ?? 0) + 1,
    );
  }

  return (
    <>
      <Topbar
        title="Platforms"
        description="Reddit, X, LinkedIn, and Google — each on its own terms."
      />

      <div className="px-6 lg:px-10 py-8 max-w-6xl space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {platformIds.map((id) => {
            const strategy = getPlatformStrategy(id);
            const count = accountsByPlatform.get(id) ?? 0;
            return (
              <PlatformOverviewCard
                key={id}
                id={id}
                title={strategy.strategicRole}
                description={strategy.shortDescription}
                accountCount={count}
              />
            );
          })}
          <GoogleOverviewCard
            accountCount={accountsByPlatform.get("google") ?? 0}
          />
        </div>

        <ComparisonTable />
      </div>
    </>
  );
}

function PlatformOverviewCard({
  id,
  title,
  description,
  accountCount,
}: {
  id: PlatformId;
  title: string;
  description: string;
  accountCount: number;
}) {
  return (
    <Link
      href={`/platforms/${id}`}
      className="card hover:border-signal-300 hover:shadow transition-all p-5 group"
    >
      <div className="flex items-center justify-between mb-2">
        <PlatformBadge platform={id} />
        <span className="text-xs text-ink-500">
          {accountCount === 0
            ? "not connected"
            : `${accountCount} account${accountCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="text-base font-semibold text-ink-900 mb-1">{title}</div>
      <p className="text-xs text-ink-600 leading-snug line-clamp-3 mb-4">
        {description}
      </p>
      {accountCount === 0 ? (
        <div className="text-xs text-ink-500 rounded-md border border-dashed border-ink-200 px-3 py-2 leading-relaxed">
          No connected accounts yet. Add one in{" "}
          <span className="text-signal-700">/accounts</span>.
        </div>
      ) : (
        <div className="text-xs text-ink-500 rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2 leading-relaxed">
          {accountCount} account{accountCount === 1 ? "" : "s"} saved. OAuth
          not yet enabled.
        </div>
      )}
      <div className="text-xs text-signal-700 font-medium mt-3 inline-flex items-center gap-1 group-hover:text-signal-800">
        Open command center
        <ChevronRightIcon width={12} height={12} />
      </div>
    </Link>
  );
}

function GoogleOverviewCard({ accountCount }: { accountCount: number }) {
  return (
    <Link
      href="/platforms/google"
      className="card hover:border-signal-300 hover:shadow transition-all p-5 group"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="badge bg-ink-900 text-white">Google</span>
        <span className="text-xs text-ink-500">
          {accountCount === 0 ? "not connected" : `${accountCount} saved`}
        </span>
      </div>
      <div className="text-base font-semibold text-ink-900 mb-1">
        Search &amp; discoverability operations
      </div>
      <p className="text-xs text-ink-600 leading-snug line-clamp-3 mb-4">
        Not a publishing platform. Visibility, content freshness, topical
        coverage, and YouTube planning sit here.
      </p>
      <div className="text-xs text-ink-500 rounded-md border border-dashed border-ink-200 px-3 py-2 leading-relaxed">
        Data not connected yet. Search Console integration ships when
        available.
      </div>
      <div className="text-xs text-signal-700 font-medium mt-3 inline-flex items-center gap-1 group-hover:text-signal-800">
        Open command center
        <ChevronRightIcon width={12} height={12} />
      </div>
    </Link>
  );
}

function ComparisonTable() {
  return (
    <section className="card overflow-x-auto">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          How the platforms differ
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Strategic role, voice, cadence, and Google&apos;s separate
          discoverability nature at a glance.
        </p>
      </header>
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left px-4 py-2.5">Dimension</th>
            <th className="text-left px-4 py-2.5">Reddit</th>
            <th className="text-left px-4 py-2.5">X</th>
            <th className="text-left px-4 py-2.5">LinkedIn</th>
            <th className="text-left px-4 py-2.5">Google</th>
          </tr>
        </thead>
        <tbody className="row-divider">
          <Row
            label="Surface type"
            values={["Social", "Social", "Social", "Search / discoverability"]}
          />
          <Row
            label="Strategic role"
            values={[
              "Community depth",
              "Founder voice",
              "B2B trust",
              "Visibility & freshness",
            ]}
          />
          <Row
            label="Voice"
            values={[
              "Calm, community-native",
              "Sharp, founder-native",
              "Professional, restrained",
              "n/a — content layer",
            ]}
          />
          <Row
            label="Cadence shape"
            values={[
              "2/week suggested",
              "7/week suggested",
              "3/week suggested",
              "Refresh windows, not cadence",
            ]}
          />
          <Row
            label="Link tolerance"
            values={["Very low", "Low", "Medium", "Internal links matter"]}
          />
        </tbody>
      </table>
    </section>
  );
}

function Row({
  label,
  values,
}: {
  label: string;
  values: [string, string, string, string];
}) {
  return (
    <tr>
      <td className="px-4 py-2.5 text-ink-700 font-medium">{label}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[0]}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[1]}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[2]}</td>
      <td className="px-4 py-2.5 text-ink-800">{values[3]}</td>
    </tr>
  );
}
