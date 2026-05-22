import type { GrowthAccountRecord } from "@/repositories/account-repository";

const PLATFORM_LABELS: Record<string, string> = {
  reddit: "Reddit",
  x: "X",
  linkedin: "LinkedIn",
  google: "Google",
};

/**
 * Compact server-rendered card listing the workspace's accounts for one
 * platform. Used by the platform command centers when at least one
 * account exists. Renders nothing fake — only the rows that actually
 * exist in the database. Connection status is shown verbatim
 * (`not_connected` for everything until OAuth ships).
 */
export function PlatformDbAccountsCard({
  platform,
  accounts,
}: {
  platform: string;
  accounts: GrowthAccountRecord[];
}) {
  const label = PLATFORM_LABELS[platform] ?? platform;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink-900">
            {label} accounts
          </div>
          <div className="text-xs text-ink-500 mt-0.5">
            {accounts.length} saved · OAuth not yet enabled
          </div>
        </div>
      </header>
      <ul className="row-divider">
        {accounts.map((a) => (
          <li
            key={a.id}
            className="px-5 py-3 flex items-start justify-between gap-4"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink-900 truncate">
                {a.displayName ?? a.handle ?? "Untitled account"}
              </div>
              <div className="text-xs text-ink-500 mt-0.5">
                {a.handle ? `${a.handle} · ` : ""}
                {a.role ?? "role unset"}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0 text-[11px]">
              <span className="badge-neutral capitalize">{a.status}</span>
              <span className="text-ink-500">
                {a.connectionStatus.replace(/_/g, " ")}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="px-5 py-3 border-t border-ink-100 text-[11px] text-ink-500 leading-relaxed">
        Account saved. OAuth not connected yet — Signal will never ask for
        passwords, cookies, session tokens, 2FA codes, or recovery codes.
      </div>
    </section>
  );
}
