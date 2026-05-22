import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccounts } from "@/repositories/account-repository";
import { listProducts } from "@/repositories/product-repository";
import { AccountCreateForm } from "./_create-form";

export const dynamic = "force-dynamic";

const PLATFORM_LABELS: Record<string, string> = {
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
  google: "Google",
};

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

  const [accounts, products] = await Promise.all([
    listAccounts(membership.workspace.id),
    listProducts(membership.workspace.id),
  ]);

  return (
    <>
      <Topbar
        title="Accounts"
        description="Connected only through official OAuth, when integrations ship."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
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
              {accounts.map((a) => (
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
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="badge-neutral capitalize">{a.status}</span>
                    <span className="text-[11px] text-ink-500">
                      {a.connectionStatus.replace(/_/g, " ")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <AccountCreateForm
          products={products.map((p) => ({ id: p.id, name: p.name }))}
        />

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Signal never asks for passwords, cookies, session tokens, 2FA codes,
          or recovery codes. Accounts will connect through official platform
          OAuth when integrations are enabled.
        </p>
      </div>
    </>
  );
}
