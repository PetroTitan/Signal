import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccounts } from "@/repositories/account-repository";
import { listProducts } from "@/repositories/product-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import {
  hasTokenEncryptionKey,
  isOAuthProviderConfigured,
  isRedditOauthBlocked,
} from "@/lib/oauth/env";
import { type OAuthPlatform } from "@/core/platform-oauth";
import { AccountCreateForm } from "./_create-form";
import { ArchiveAccountButton } from "./_archive-button";
import { ConnectionControls } from "./_connection-controls";
import { AccountIdentityCard } from "@/components/publishing/account-identity-card";

export const dynamic = "force-dynamic";

function isOAuthPlatform(p: string): p is OAuthPlatform {
  return p === "reddit" || p === "x" || p === "linkedin";
}

export default async function AccountsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Publishing accounts"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured. Set the Supabase env variables to
            enable account persistence.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Publishing accounts" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard to start adding accounts.
        </div>
      </>
    );
  }

  const [accounts, products, connections, recentPublishes] =
    await Promise.all([
      listAccounts(membership.workspace.id),
      listProducts(membership.workspace.id),
      listPlatformConnections(membership.workspace.id),
      listRecentPublishes(membership.workspace.id, 100),
    ]);

  const providerConfigured: Record<OAuthPlatform, boolean> = {
    reddit: isOAuthProviderConfigured("reddit"),
    x: isOAuthProviderConfigured("x"),
    linkedin: isOAuthProviderConfigured("linkedin"),
  };
  const encryptionOn = hasTokenEncryptionKey();
  const redditOauthBlocked = isRedditOauthBlocked();

  const connectionByAccountPlatform = new Map<
    string,
    (typeof connections)[number]
  >();
  for (const c of connections) {
    if (c.accountId) {
      connectionByAccountPlatform.set(`${c.accountId}|${c.platform}`, c);
    }
  }

  // Last successful publish per account.
  const lastPublishByAccount = new Map<string, string>();
  for (const p of recentPublishes) {
    if (p.outcome !== "published" || !p.accountId) continue;
    const prev = lastPublishByAccount.get(p.accountId);
    if (!prev || new Date(p.finishedAt) > new Date(prev)) {
      lastPublishByAccount.set(p.accountId, p.finishedAt);
    }
  }

  return (
    <>
      <Topbar
        title="Publishing accounts"
        description="Connected creator identities Signal can publish from. Each account uses the platform's official OAuth flow — no passwords, no cookies."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        {redditOauthBlocked ? (
          <section className="rounded-2xl border border-amber-100 bg-amber-50/40 p-4">
            <h2 className="text-sm font-semibold text-amber-900">
              Reddit publishing is currently manual
            </h2>
            <p className="text-xs text-amber-900 mt-1 leading-relaxed">
              Reddit hasn&apos;t approved Signal&apos;s OAuth app yet, so
              direct publishing is paused. Drafts still flow through the
              normal approval queue; the operator copies the prepared
              payload, publishes manually on Reddit, and pastes the
              permalink back into Signal. Every safety gate still applies.
            </p>
          </section>
        ) : null}

        <section className="rounded-2xl border border-ink-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-ink-900">
            Connection setup
          </h2>
          <ul className="mt-2 text-xs text-ink-700 space-y-1">
            <ProviderStatusRow
              label="Reddit"
              ok={providerConfigured.reddit}
              note={redditOauthBlocked ? "Reddit API approval pending" : null}
            />
            <ProviderStatusRow label="X" ok={providerConfigured.x} />
            <ProviderStatusRow
              label="LinkedIn"
              ok={providerConfigured.linkedin}
            />
            <li className="flex items-center justify-between pt-2 border-t border-ink-100">
              <span className="text-ink-700">Encrypted token storage</span>
              <span
                className={encryptionOn ? "text-emerald-700" : "text-amber-700"}
              >
                {encryptionOn ? "Ready" : "Not configured"}
              </span>
            </li>
          </ul>
        </section>

        {accounts.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-ink-300 bg-ink-50/40 p-8 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No connected accounts yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Add the Reddit handle you&apos;ll publish as. Signal stores it
              quietly until you complete the OAuth handshake from this page.
            </p>
          </section>
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => {
              const c = isOAuthPlatform(a.platform)
                ? connectionByAccountPlatform.get(`${a.id}|${a.platform}`)
                : undefined;
              const helperNote =
                a.platform === "reddit" && redditOauthBlocked
                  ? "Reddit is in manual publish mode while their API approval is pending. Drafts still flow through the weekly plan."
                  : null;
              const archive = <ArchiveAccountButton accountId={a.id} />;
              const controls = isOAuthPlatform(a.platform) ? (
                <ConnectionControls
                  platform={a.platform}
                  accountId={a.id}
                  providerConfigured={providerConfigured[a.platform]}
                  encryptionConfigured={encryptionOn}
                  redditOauthBlocked={redditOauthBlocked}
                  connectionStatus={c?.connectionStatus ?? "not_connected"}
                  healthStatus={c?.healthStatus ?? "unknown"}
                  hasAccessToken={c?.hasAccessToken ?? false}
                  lastCheckedAt={c?.lastCheckedAt ?? null}
                />
              ) : (
                <p className="text-[11px] text-ink-400 italic">
                  This platform isn&apos;t publishable from Signal yet.
                </p>
              );
              return (
                <AccountIdentityCard
                  key={a.id}
                  platform={a.platform}
                  displayName={a.displayName}
                  handle={c?.handle ?? a.handle}
                  connectionState={c?.connectionStatus ?? "not_connected"}
                  lastPublishedAt={lastPublishByAccount.get(a.id) ?? null}
                  lastCheckedAt={c?.lastCheckedAt ?? null}
                  notes={null}
                  helperNote={helperNote}
                  controls={controls}
                  archiveControl={archive}
                />
              );
            })}
          </div>
        )}

        <AccountCreateForm
          products={products.map((p) => ({ id: p.id, name: p.name }))}
        />

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Signal never asks for passwords, cookies, session tokens, 2FA codes,
          or recovery codes. Connections happen through each platform&apos;s
          official OAuth flow.
        </p>
      </div>
    </>
  );
}

function ProviderStatusRow({
  label,
  ok,
  note,
}: {
  label: string;
  ok: boolean;
  note?: string | null;
}) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-ink-700">{label}</span>
      <span
        className={
          note ? "text-amber-700" : ok ? "text-emerald-700" : "text-ink-500"
        }
      >
        {note ?? (ok ? "Ready" : "Not set up")}
      </span>
    </li>
  );
}
