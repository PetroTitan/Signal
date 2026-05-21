"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, AccountStatusBadge } from "@/components/badges";
import { CheckIcon, DotIcon, LockIcon } from "@/components/icons";
import {
  useAccount,
  useAccountActions,
  useSignal,
} from "@/core/store";
import {
  computeReadiness,
  missingSteps,
  nextBestAction,
  planningEligibility,
  safetyRecommendation,
} from "@/core/onboarding";
import type {
  AccountStatus,
  ChecklistCategory,
  GrowthAccount,
  WarmUpDay,
} from "@/types";
import { formatDateTime } from "@/lib/format";

const statusOptions: { value: AccountStatus; label: string }[] = [
  { value: "planned", label: "Planned" },
  { value: "setup_needed", label: "Setup needed" },
  { value: "awaiting_manual_creation", label: "Awaiting manual creation" },
  { value: "ready_to_connect", label: "Ready to connect" },
  { value: "connected", label: "Connected" },
  { value: "warming", label: "Warming" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

const categoryLabels: Record<ChecklistCategory, string> = {
  kit: "Profile kit",
  manual: "Manual setup",
  security: "Security",
  profile: "Profile",
  oauth: "OAuth (placeholder)",
  planning: "Planning",
};

export default function AccountSetupPage() {
  const params = useParams<{ id: string }>();
  const account = useAccount(params.id);
  const actions = useAccountActions();
  const { state } = useSignal();

  if (!account) {
    return <NotFound />;
  }

  const product = state.productsById[account.productId];
  const readiness = computeReadiness(account);
  const eligibility = planningEligibility(account);
  const safety = safetyRecommendation(account);
  const missing = missingSteps(account);
  const next = nextBestAction(account);

  const itemsOnThisAccount = state.items.filter(
    (i) => i.accountId === account.id,
  );

  return (
    <>
      <Topbar
        title={account.displayName}
        description={`${product?.name ?? "Product"} · ${capitalize(account.role)} · ${platformName(account.platform)}`}
        actions={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => actions.regenerateKit(account.id)}
            >
              Refresh setup kit
            </button>
            <button
              type="button"
              disabled
              className="btn-primary opacity-60 cursor-not-allowed inline-flex items-center gap-2"
              title="OAuth providers not yet integrated"
            >
              <LockIcon />
              Connect via official OAuth
            </button>
          </>
        }
      />

      <div className="px-6 lg:px-8 py-6 max-w-5xl space-y-6">
        <SafetyBanner />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card-padded">
            <div className="stat-label">Platform</div>
            <div className="mt-2"><PlatformBadge platform={account.platform} /></div>
          </div>
          <div className="card-padded">
            <div className="stat-label">Status</div>
            <div className="mt-2">
              <AccountStatusBadge status={account.status} />
            </div>
          </div>
          <div className="card-padded">
            <div className="stat-label">Readiness</div>
            <div className="stat-value mt-1">{readiness}%</div>
            <div className="text-[11px] text-ink-500 mt-0.5">
              {missing.length === 0
                ? "Checklist complete"
                : `${missing.length} step${missing.length === 1 ? "" : "s"} left`}
            </div>
          </div>
          <div className="card-padded">
            <div className="stat-label">Weekly plan eligibility</div>
            <div className="mt-2">
              {eligibility.eligible ? (
                <span className="badge-low">Eligible</span>
              ) : (
                <span className="badge-medium">Not eligible</span>
              )}
            </div>
            <div className="text-[11px] text-ink-500 mt-1 leading-snug">
              {eligibility.reason}
            </div>
          </div>
        </div>

        {next ? (
          <NextAction text={next} />
        ) : null}

        {safety ? (
          <div className="card border-amber-200 bg-amber-50/40 p-4 text-sm text-ink-800">
            {safety}
          </div>
        ) : null}

        <ActionsRow account={account} />

        <ChecklistSection account={account} />

        <Section title="Username ideas" hint="Pick one when creating the account on the platform.">
          <ul className="font-mono text-sm text-ink-800 space-y-1">
            {account.setup.usernameIdeas.map((u) => (
              <li key={u}>· {u}</li>
            ))}
          </ul>
        </Section>

        <Section title="Display name suggestions">
          <ul className="text-sm text-ink-800 space-y-1">
            {account.setup.displayNameSuggestions.map((d) => (
              <li key={d}>· {d}</li>
            ))}
          </ul>
        </Section>

        <Section title="Bio / headline" hint={`Three options written for ${platformName(account.platform)}.`}>
          <ul className="text-sm text-ink-800 space-y-2">
            {account.setup.bioSuggestions.map((b) => (
              <li
                key={b}
                className="border-l-2 border-ink-100 pl-3 leading-relaxed"
              >
                {b}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="About / profile text">
          <p className="text-sm text-ink-800 whitespace-pre-line leading-relaxed">
            {account.setup.aboutText}
          </p>
        </Section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Section title="Avatar brief">
            <p className="text-sm text-ink-800">{account.setup.avatarBrief}</p>
          </Section>
          <Section title="Cover / banner brief">
            <p className="text-sm text-ink-800">{account.setup.coverBrief}</p>
          </Section>
        </div>

        {account.platform === "x" && account.setup.pinnedPostIdea ? (
          <Section title="Pinned post idea">
            <p className="text-sm text-ink-800">{account.setup.pinnedPostIdea}</p>
          </Section>
        ) : null}

        {account.platform === "linkedin" && account.setup.featuredLinkSuggestion ? (
          <Section title="Featured link suggestion">
            <p className="text-sm text-ink-800">
              {account.setup.featuredLinkSuggestion}
            </p>
          </Section>
        ) : null}

        {account.platform === "reddit" && account.setup.subredditDiscovery.length > 0 ? (
          <Section title="Subreddit discovery prompts">
            <ul className="text-sm text-ink-800 space-y-1 font-mono">
              {account.setup.subredditDiscovery.map((s) => (
                <li key={s}>· {s}</li>
              ))}
            </ul>
          </Section>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Section
            title="First 10 content ideas"
            hint="Non-promotional. Lead with substance, no link in the first month."
          >
            <ol className="text-sm text-ink-800 space-y-1 list-decimal list-inside">
              {account.setup.contentIdeas.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
          </Section>
          <Section title="First 10 comment ideas">
            <ol className="text-sm text-ink-800 space-y-1 list-decimal list-inside">
              {account.setup.commentIdeas.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
          </Section>
        </div>

        <WarmUpSection days={account.setup.warmUpDays} />

        <Section title="Tone reminders">
          <ul className="text-sm text-ink-800 space-y-1">
            {account.setup.toneReminders.map((t) => (
              <li key={t}>· {t}</li>
            ))}
          </ul>
          <p className="text-xs text-ink-500 mt-3">{account.setup.cadenceNote}</p>
        </Section>

        <Section
          title="Items on this account this week"
          hint={`${itemsOnThisAccount.length} ${itemsOnThisAccount.length === 1 ? "item" : "items"}`}
        >
          {itemsOnThisAccount.length === 0 ? (
            <p className="text-sm text-ink-500">
              No items planned for this account this week.
            </p>
          ) : (
            <ul className="row-divider -mx-5">
              {itemsOnThisAccount.map((it) => (
                <li key={it.id} className="px-5 py-2.5">
                  <div className="text-sm text-ink-900">{it.draft.hook}</div>
                  <div className="text-xs text-ink-500 mt-0.5">
                    {formatDateTime(it.scheduledFor)} ·{" "}
                    {it.contentType.replace(/_/g, " ")}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <OauthCard platform={account.platform} />
      </div>
    </>
  );
}

function NotFound() {
  return (
    <>
      <Topbar title="Account not found" />
      <div className="px-6 lg:px-8 py-10 max-w-2xl">
        <div className="card-padded text-sm">
          <p className="text-ink-800">This account does not exist.</p>
          <Link
            href="/accounts"
            className="btn mt-3 inline-flex"
          >
            Back to accounts
          </Link>
        </div>
      </div>
    </>
  );
}

function SafetyBanner() {
  return (
    <div className="card border-signal-200 bg-signal-50/40">
      <div className="p-4 flex items-start gap-3 text-sm">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
          <LockIcon />
        </span>
        <div>
          <div className="font-semibold text-ink-900">
            Signal helps prepare accounts; it does not create or mask them.
          </div>
          <p className="text-ink-700 mt-0.5 leading-relaxed">
            We never ask for your password, cookies, session tokens, 2FA codes,
            or recovery codes. Create the account manually on the platform.
            Connect only through official OAuth when integration is enabled.
          </p>
        </div>
      </div>
    </div>
  );
}

function NextAction({ text }: { text: string }) {
  return (
    <div className="card border-emerald-200 bg-emerald-50/40 p-4">
      <div className="stat-label text-emerald-700">Next best action</div>
      <p className="text-sm text-ink-900 mt-1">{text}</p>
    </div>
  );
}

function ActionsRow({ account }: { account: GrowthAccount }) {
  const actions = useAccountActions();
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-ink-900">Account state</div>
          <p className="text-xs text-ink-500 mt-0.5">
            Move this account through the lifecycle as you complete steps.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Set status"
            value={account.status}
            onChange={(e) =>
              actions.setStatus(account.id, e.target.value as AccountStatus)
            }
            className="border border-ink-200 rounded-md text-sm px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-signal-300"
          >
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="px-5 py-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn"
          onClick={() => actions.setStatus(account.id, "warming")}
        >
          Move to warming
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => actions.setStatus(account.id, "active")}
        >
          Move to active
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => actions.markReadyForPlanning(account.id)}
        >
          Mark ready for weekly planning
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            actions.setStatus(
              account.id,
              account.status === "paused" ? "warming" : "paused",
            )
          }
        >
          {account.status === "paused" ? "Resume account" : "Pause account"}
        </button>
      </div>
    </section>
  );
}

function ChecklistSection({ account }: { account: GrowthAccount }) {
  const actions = useAccountActions();
  const groups = useMemo(() => {
    const cats: ChecklistCategory[] = [
      "kit",
      "manual",
      "security",
      "profile",
      "planning",
      "oauth",
    ];
    return cats.map((cat) => ({
      category: cat,
      items: account.setup.checklist.filter((c) => c.category === cat),
    }));
  }, [account.setup.checklist]);

  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Setup checklist
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Tick steps as you complete them on the platform. Signal does not
          perform these steps for you.
        </p>
      </header>
      <div className="px-5 py-3 space-y-3">
        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.category}>
              <div className="stat-label mb-1.5">{categoryLabels[g.category]}</div>
              <ul className="space-y-1">
                {g.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={g.category === "oauth"}
                      onClick={() =>
                        actions.toggleChecklistItem(account.id, item.id)
                      }
                      className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-md text-sm text-left transition-colors ${
                        g.category === "oauth"
                          ? "cursor-not-allowed opacity-80"
                          : "hover:bg-ink-50"
                      }`}
                    >
                      <span
                        className={`inline-flex h-5 w-5 items-center justify-center rounded-full ${
                          item.done
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-ink-100 text-ink-400"
                        }`}
                      >
                        {item.done ? (
                          <CheckIcon width={12} height={12} />
                        ) : (
                          <DotIcon width={10} height={10} />
                        )}
                      </span>
                      <span
                        className={`${
                          item.done ? "text-ink-500 line-through" : "text-ink-800"
                        }`}
                      >
                        {item.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function WarmUpSection({ days }: { days: WarmUpDay[] }) {
  return (
    <Section
      title="14-day warm-up plan"
      hint="Calm cadence. No promotional posts until warm-up is complete."
    >
      <ol className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {days.map((d) => (
          <li
            key={d.day}
            className="rounded-md border border-ink-100 p-3 bg-white"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-mono text-ink-500">
                Day {d.day}
              </span>
              <span className="text-[11px] uppercase tracking-wide text-ink-500">
                {d.focus.replace(/_/g, " ")}
              </span>
            </div>
            <p className="text-sm text-ink-800 leading-snug">
              {d.description}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function OauthCard({ platform }: { platform: GrowthAccount["platform"] }) {
  return (
    <section className="card border-signal-200 bg-signal-50/40">
      <div className="p-4 flex items-start gap-3">
        <LockIcon className="text-signal-700 mt-0.5" />
        <div className="text-sm">
          <div className="font-semibold text-ink-900">OAuth connection</div>
          <p className="text-ink-700 mt-0.5 leading-relaxed">
            When {platformName(platform)} OAuth ships, this account will connect
            through the platform&apos;s authorization flow. Signal will not
            request or store your password, cookies, or session tokens.
          </p>
          <button
            type="button"
            disabled
            className="btn-primary opacity-60 cursor-not-allowed mt-3 inline-flex items-center gap-2"
          >
            <LockIcon />
            Connect via {platformName(platform)} OAuth (not yet available)
          </button>
        </div>
      </div>
    </section>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">{title}</div>
        {hint ? <div className="text-xs text-ink-500 mt-0.5">{hint}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function platformName(p: GrowthAccount["platform"]): string {
  return p === "x" ? "X" : p === "reddit" ? "Reddit" : "LinkedIn";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

