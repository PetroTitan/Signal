import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccounts } from "@/repositories/account-repository";
import { listProducts } from "@/repositories/product-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import {
  hasTokenEncryptionKey,
  isOAuthProviderConfigured,
  isRedditOauthBlocked,
} from "@/lib/oauth/env";
import { OAUTH_PLATFORMS, type OAuthPlatform } from "@/core/platform-oauth";
import { AccountCreateForm } from "./_create-form";
import { ArchiveAccountButton } from "./_archive-button";
import { ConnectionControls } from "./_connection-controls";

export const dynamic = "force-dynamic";

const PLATFORM_LABELS: Record<string, string> = {
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
  google: "Google",
};

function isOAuthPlatform(p: string): p is OAuthPlatform {
  return p === "reddit" || p === "x" || p === "linkedin";
}

export default async function AccountsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Accounts"
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
        <Topbar title="Accounts" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard to start adding accounts.
        </div>
      </>
    );
  }

  const [accounts, products, connections] = await Promise.all([
    listAccounts(membership.workspace.id),
    listProducts(membership.workspace.id),
    listPlatformConnections(membership.workspace.id),
  ]);

  const providerConfigured: Record<OAuthPlatform, boolean> = {
    reddit: isOAuthProviderConfigured("reddit"),
    x: isOAuthProviderConfigured("x"),
    linkedin: isOAuthProviderConfigured("linkedin"),
  };
  const encryptionOn = hasTokenEncryptionKey();
  const redditOauthBlocked = isRedditOauthBlocked();

  const connectionByAccountPlatform = new Map<string, (typeof connections)[number]>();
  for (const c of connections) {
    if (c.accountId) {
      connectionByAccountPlatform.set(`${c.accountId}|${c.platform}`, c);
    }
  }

  return (
    <>
      <Topbar
        title="Accounts"
        description="Connected only through official OAuth. Signal never asks for passwords, cookies, or 2FA codes."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {redditOauthBlocked ? (
          <section className="card p-5 border-amber-200 bg-amber-50/40">
            <h2 className="text-sm font-semibold text-amber-900">
              Reddit API approval pending
            </h2>
            <p className="text-xs text-amber-900 mt-1 leading-relaxed">
              Reddit&apos;s Responsible Builder Policy is blocking our OAuth
              app provisioning. Reddit Connect is disabled until approval
              lands; use the{" "}
              <span className="font-semibold">manual publish fallback</span>{" "}
              on <a href="/execution" className="underline">/execution</a> to
              record posts in the meantime. Every safety gate (whitelist,
              creative readiness, alt text, rate limit, duplicate, confirmation
              phrase) still applies on the manual path.
            </p>
          </section>
        ) : null}

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">OAuth providers</h2>
          <ul className="mt-3 text-xs text-ink-700 space-y-1">
            {OAUTH_PLATFORMS.map((p) => (
              <li key={p} className="flex items-center justify-between">
                <span>{PLATFORM_LABELS[p]}</span>
                <span
                  className={
                    p === "reddit" && redditOauthBlocked
                      ? "text-amber-700"
                      : providerConfigured[p]
                        ? "text-green-700"
                        : "text-amber-700"
                  }
                >
                  {p === "reddit" && redditOauthBlocked
                    ? "Blocked — pending Reddit API approval"
                    : providerConfigured[p]
                      ? "Configured"
                      : "Not configured"}
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between pt-2 border-t border-ink-100">
              <span>Token encryption</span>
              <span
                className={encryptionOn ? "text-green-700" : "text-amber-700"}
              >
                {encryptionOn
                  ? "Configured"
                  : "Not configured — real tokens will not be stored"}
              </span>
            </li>
          </ul>
        </section>

        {accounts.length === 0 ? (
          <section className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No connected accounts yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Add an account below. Signal stores it as{" "}
              <span className="font-mono">not_connected</span> until OAuth
              integrations are enabled.
            </p>
          </section>
        ) : (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-900">
                {accounts.length} account{accounts.length === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-ink-500">
                Workspace: {membership.workspace.name}
              </div>
            </header>
            <ul className="row-divider">
              {accounts.map((a) => {
                const c = isOAuthPlatform(a.platform)
                  ? connectionByAccountPlatform.get(`${a.id}|${a.platform}`)
                  : undefined;
                return (
                  <li
                    key={a.id}
                    className="px-5 py-3.5 flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink-900 truncate">
                        {a.displayName ?? a.handle ?? "Untitled account"}
                      </div>
                      <div className="text-xs text-ink-500 mt-0.5">
                        {PLATFORM_LABELS[a.platform] ?? a.platform}
                        {a.role ? ` · ${a.role}` : ""}
                        {a.handle ? ` · ${a.handle}` : ""}
                      </div>
                      {isOAuthPlatform(a.platform) ? (
                        <div className="mt-2">
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
                        </div>
                      ) : (
                        <div className="text-[11px] text-ink-400 mt-2">
                          OAuth not modeled for this platform.
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="badge-neutral capitalize">{a.status}</span>
                      <ArchiveAccountButton accountId={a.id} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <AccountCreateForm
          products={products.map((p) => ({ id: p.id, name: p.name }))}
        />

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Signal never asks for passwords, cookies, session tokens, 2FA codes,
          or recovery codes. Accounts connect only through the platform&apos;s
          official OAuth flow.
        </p>
      </div>
    </>
  );
}
