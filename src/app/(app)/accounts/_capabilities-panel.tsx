import Link from "next/link";
import {
  FOUNDER_PLATFORMS,
  resolveIdentityPlatformGuidance,
} from "@/core/publishing/platform-guidance";
import { readTierOneConfigStatus } from "@/core/publishing/platform-credentials";
import { isRedditOauthBlocked } from "@/lib/oauth/env";

/**
 * Phase F4.4.1 — "Where Signal can publish today".
 *
 * Replaces the legacy /accounts "Connection setup" panel
 * (Reddit / X / LinkedIn / Encrypted token storage). Reads the same
 * server-side config status the dedicated /settings/publishing-
 * platforms page uses, but presents it in calmer founder language
 * with no env-var names, no "OAuth", and no "token" wording.
 *
 * Each row reads as "Platform — Mode" with a small status chip on
 * the right.
 */

type RowKind = "automated" | "manual_first" | "manual_only" | "not_connected";

interface PlatformRow {
  label: string;
  short: string;
  mode: string;
  status:
    | { kind: "ready"; detail: string }
    | { kind: "manual"; detail: string }
    | { kind: "missing"; detail: string };
  rowKind: RowKind;
}

export function PublishingCapabilitiesPanel() {
  const tier1 = readTierOneConfigStatus();
  const redditBlocked = isRedditOauthBlocked();

  const rows: PlatformRow[] = FOUNDER_PLATFORMS.map((p) => {
    const meta = resolveIdentityPlatformGuidance(p);
    const label = meta?.label ?? p;
    const short = meta?.short ?? p.slice(0, 2);

    if (p === "devto") {
      return tier1.devto.configured
        ? {
            label,
            short,
            mode: "Automated when connected",
            status: { kind: "ready", detail: "Connected" },
            rowKind: "automated",
          }
        : {
            label,
            short,
            mode: "Automated when connected",
            status: { kind: "missing", detail: "Not connected" },
            rowKind: "not_connected",
          };
    }
    if (p === "hashnode") {
      return tier1.hashnode.configured
        ? {
            label,
            short,
            mode: "Automated when connected",
            status: { kind: "ready", detail: "Connected" },
            rowKind: "automated",
          }
        : {
            label,
            short,
            mode: "Automated when connected",
            status: { kind: "missing", detail: "Not connected" },
            rowKind: "not_connected",
          };
    }
    if (p === "bluesky") {
      return tier1.bluesky.configured
        ? {
            label,
            short,
            mode: "Automated when connected",
            status: { kind: "ready", detail: "Connected" },
            rowKind: "automated",
          }
        : {
            label,
            short,
            mode: "Automated when connected",
            status: { kind: "missing", detail: "Not connected" },
            rowKind: "not_connected",
          };
    }
    if (p === "reddit") {
      return {
        label,
        short,
        mode: redditBlocked
          ? "Manual — API approval pending"
          : "Manual-first",
        status: {
          kind: "manual",
          detail: redditBlocked ? "Manual mode" : "Manual-first",
        },
        rowKind: "manual_first",
      };
    }
    if (p === "x" || p === "linkedin") {
      // F5.0 — distribution layers. Signal prepares the post and
      // opens the native composer; the founder publishes on the
      // platform itself.
      return {
        label,
        short,
        mode: "Manual distribution",
        status: { kind: "manual", detail: "Manual distribution" },
        rowKind: "manual_first",
      };
    }
    // indie_hackers
    return {
      label,
      short,
      mode: "Manual",
      status: { kind: "manual", detail: "Manual" },
      rowKind: "manual_only",
    };
  });

  return (
    <section className="rounded-2xl border border-ink-200 bg-white">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            Where Signal can publish today
          </h2>
          <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
            Connection status across the platforms Signal supports.
          </p>
        </div>
        <Link
          href="/settings/publishing-platforms"
          className="text-[11px] text-signal-700 hover:text-signal-800 whitespace-nowrap shrink-0"
        >
          Manage →
        </Link>
      </header>
      <ul className="row-divider">
        {rows.map((row) => (
          <li
            key={row.label}
            className="px-5 py-3 flex items-center gap-3"
          >
            <span
              className="w-6 h-6 rounded-md bg-ink-100 text-ink-700 grid place-items-center text-[10px] font-mono shrink-0"
              aria-hidden
            >
              {row.short}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink-900">{row.label}</div>
              <div className="text-[11px] text-ink-500">{row.mode}</div>
            </div>
            <StatusBadge kind={row.status.kind} detail={row.status.detail} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusBadge({
  kind,
  detail,
}: {
  kind: "ready" | "manual" | "missing";
  detail: string;
}) {
  const tone =
    kind === "ready"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : kind === "manual"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-ink-50 text-ink-500 border-ink-200";
  const dot =
    kind === "ready"
      ? "bg-emerald-500"
      : kind === "manual"
        ? "bg-amber-500"
        : "bg-ink-300";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium shrink-0 ${tone}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      {detail}
    </span>
  );
}
