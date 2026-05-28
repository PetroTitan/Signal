import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { readTierOneConfigStatus } from "@/core/publishing/platform-credentials";
import {
  hasTokenEncryptionKey,
  isOAuthProviderConfigured,
  isRedditOauthBlocked,
} from "@/lib/oauth/env";
import {
  buildPublishingPlatformRows,
  type PublishingPlatformRowStatus,
} from "./_rows";

export const dynamic = "force-dynamic";

/**
 * /settings/publishing-platforms — workspace-level platform overview.
 *
 * This page renders WORKSPACE-LEVEL truth ("is the integration
 * plumbing in place?"), not per-identity sign-in state. Per-identity
 * status lives on /accounts.
 *
 * Row logic is in `./_rows` so it can be unit-tested without
 * rendering the React tree.
 */
export default function PublishingPlatformsPage() {
  const tier1 = readTierOneConfigStatus();
  const rows = buildPublishingPlatformRows({
    tier1,
    redditProviderConfigured: isOAuthProviderConfigured("reddit"),
    redditBlocked: isRedditOauthBlocked(),
    xProviderConfigured: isOAuthProviderConfigured("x"),
    encryptionOn: hasTokenEncryptionKey(),
  });

  return (
    <>
      <Topbar
        title="Publishing platforms"
        description="Where Signal can publish for you, and which connections are set up."
        actions={
          <Link href="/settings" className="btn-ghost text-xs">
            ← Back to settings
          </Link>
        }
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        <section className="rounded-2xl border border-ink-200 bg-white">
          <ul className="row-divider">
            {rows.map((row) => (
              <li
                key={row.key}
                className="px-5 py-4 flex items-start gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink-900">
                    {row.label}
                  </div>
                  <p className="text-xs text-ink-600 mt-0.5 leading-relaxed">
                    {row.status.detail}
                  </p>
                </div>
                <StatusBadge kind={row.status.kind} />
              </li>
            ))}
          </ul>
        </section>

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Connections happen through each platform&apos;s official method —
          OAuth for Reddit, API key for dev.to and Hashnode, app-password
          for Bluesky, bot token for Telegram. Signal never asks for your
          platform password and never stores plaintext tokens.
        </p>
      </div>
    </>
  );
}

function StatusBadge({ kind }: { kind: PublishingPlatformRowStatus["kind"] }) {
  if (kind === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium shrink-0">
        <span
          className="w-1.5 h-1.5 rounded-full bg-emerald-500"
          aria-hidden
        />
        Connected
      </span>
    );
  }
  if (kind === "manual") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 text-[11px] font-medium shrink-0">
        <span
          className="w-1.5 h-1.5 rounded-full bg-amber-500"
          aria-hidden
        />
        Manual mode
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 text-ink-600 border border-ink-200 px-2 py-0.5 text-[11px] font-medium shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-ink-300" aria-hidden />
      Not connected
    </span>
  );
}
