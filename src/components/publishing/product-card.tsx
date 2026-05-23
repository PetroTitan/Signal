/**
 * Phase F2.9.7 — visual product card for /products.
 *
 * Replaces the list-row look with a creator-shaped tile: name,
 * domain + category, summary, linked connected accounts, recent
 * post count, last-published timestamp.
 */

import Link from "next/link";

export interface ProductCardProps {
  id: string;
  name: string;
  domain: string | null;
  summary: string | null;
  category: string | null;
  status: string;
  /** Accounts linked to this product (handle + platform). */
  linkedAccounts: { id: string; handle: string | null; platform: string }[];
  /** Recent posts authored against this product (any status). */
  recentPostCount: number;
  /** Last `outcome='published'` time across all accounts. */
  lastPublishedAt: string | null;
  /** Bottom-right archive action. */
  archiveControl?: React.ReactNode;
}

export function ProductCard(props: ProductCardProps) {
  const initial = (props.name?.[0] ?? "?").toUpperCase();
  return (
    <article className="rounded-2xl border border-ink-200 bg-white overflow-hidden">
      <div className="p-4 md:p-5">
        <div className="flex items-start gap-3">
          {/* Product avatar tile — initial letter */}
          <div
            className="w-12 h-12 rounded-xl grid place-items-center shrink-0 bg-signal-50 text-signal-700 font-semibold text-lg"
            aria-hidden
          >
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink-900 truncate">
                {props.name}
              </h3>
              {props.status && props.status !== "active" ? (
                <span className="inline-flex items-center rounded-full border border-ink-200 px-2 py-0.5 text-[10px] text-ink-600 capitalize">
                  {props.status}
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-ink-500 mt-0.5 truncate">
              {props.domain ? (
                <>
                  <span className="font-mono">{props.domain}</span>
                  {props.category ? " · " : null}
                </>
              ) : null}
              {props.category ?? null}
            </div>
            {props.summary ? (
              <p className="text-xs text-ink-700 leading-relaxed mt-2 line-clamp-2">
                {props.summary}
              </p>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-3">
          <Stat
            label="Recent posts"
            value={
              props.recentPostCount === 0
                ? "None yet"
                : `${props.recentPostCount}`
            }
          />
          <Stat
            label="Last published"
            value={formatRelative(props.lastPublishedAt) ?? "Not yet"}
          />
        </div>

        {props.linkedAccounts.length > 0 ? (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-ink-500 mb-1">
              Publishing accounts
            </div>
            <div className="flex flex-wrap gap-1.5">
              {props.linkedAccounts.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center rounded-full border border-ink-200 px-2 py-0.5 text-[11px] text-ink-700"
                >
                  {a.platform === "reddit"
                    ? `u/${(a.handle ?? "").replace(/^u\//i, "") || a.id.slice(0, 6)}`
                    : (a.handle ?? a.id.slice(0, 6))}
                  <span className="ml-1 text-ink-400 text-[10px]">
                    · {a.platform}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link href="/weekly-plan" className="btn-primary text-xs">
            Create post
          </Link>
          <Link href="/execution" className="btn-ghost text-xs">
            Publishing activity
          </Link>
        </div>
      </div>

      {props.archiveControl ? (
        <div className="px-4 md:px-5 py-2 border-t border-ink-100 bg-ink-50/40 flex justify-end">
          {props.archiveControl}
        </div>
      ) : null}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ink-100 bg-ink-50/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-500">
        {label}
      </div>
      <div className="text-xs text-ink-800 mt-0.5">{value}</div>
    </div>
  );
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  const minutes = ms / (60 * 1000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
