import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { readTierOneConfigStatus } from "@/core/publishing/platform-credentials";
import { isRedditOauthBlocked } from "@/lib/oauth/env";

export const dynamic = "force-dynamic";

interface Row {
  label: string;
  status:
    | { kind: "ready"; detail: string }
    | { kind: "missing"; detail: string }
    | { kind: "manual"; detail: string };
}

export default function PublishingPlatformsPage() {
  const tier1 = readTierOneConfigStatus();
  const redditBlocked = isRedditOauthBlocked();

  const rows: Row[] = [
    {
      label: "Reddit",
      status: redditBlocked
        ? {
            kind: "manual",
            detail:
              "Manual mode. Reddit's API approval is still pending — copy and paste from the post preview.",
          }
        : {
            kind: "ready",
            detail: "Connected via OAuth.",
          },
    },
    {
      label: "dev.to",
      status: tier1.devto.configured
        ? { kind: "ready", detail: "Connected." }
        : {
            kind: "missing",
            detail:
              "Add a dev.to API key in your environment to publish here.",
          },
    },
    {
      label: "Hashnode",
      status: tier1.hashnode.configured
        ? { kind: "ready", detail: "Connected." }
        : tier1.hashnode.hasPublicationId
          ? {
              kind: "missing",
              detail:
                "Publication is set, but the API key is missing. Add a Hashnode key in your environment.",
            }
          : {
              kind: "missing",
              detail:
                "Add a Hashnode API key and select the publication to publish to.",
            },
    },
    {
      label: "Bluesky",
      status: tier1.bluesky.configured
        ? { kind: "ready", detail: "Connected." }
        : {
            kind: "missing",
            detail:
              "Add your Bluesky identifier and app-password in your environment.",
          },
    },
  ];

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
                key={row.label}
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
          for Bluesky. Signal never asks for your platform password and
          never stores plaintext tokens.
        </p>
      </div>
    </>
  );
}

function StatusBadge({ kind }: { kind: Row["status"]["kind"] }) {
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
