"use client";

import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { ChevronRightIcon } from "@/components/icons";

interface Stage {
  id: string;
  number: number;
  title: string;
  description: string;
  inputs: string[];
  outputs: string[];
  routes: { href: string; label: string }[];
  category: "configuration" | "intelligence" | "operations" | "platform" | "future";
}

const stages: Stage[] = [
  {
    id: "product_profile",
    number: 1,
    title: "Product profile",
    description:
      "Each product carries positioning, audience, allowed CTA style, forbidden claims, risk tolerance, and tracking metadata. Everything else in Signal reads from this profile.",
    inputs: ["Founder-defined product data"],
    outputs: ["Voice / CTA constraints used by every adapter"],
    routes: [{ href: "/products", label: "Products" }],
    category: "configuration",
  },
  {
    id: "account_setup",
    number: 2,
    title: "Account setup",
    description:
      "The four-step wizard prepares accounts and the 14-day warm-up plan. Signal never creates the account on the platform; it never asks for passwords, cookies, or tokens.",
    inputs: ["Product profile", "Platform choice", "Role"],
    outputs: ["Setup kit", "Readiness score", "Eligibility status"],
    routes: [
      { href: "/accounts", label: "Accounts" },
      { href: "/accounts/new", label: "Wizard" },
    ],
    category: "configuration",
  },
  {
    id: "source_insight",
    number: 3,
    title: "Source insight",
    description:
      "Founder observations, product lessons, support patterns, and industry patterns become structured insights. Insights are the only origin of content suggestions.",
    inputs: ["Founder-observed reality"],
    outputs: ["SourceInsight rows with platform fit + scores"],
    routes: [{ href: "/content-intelligence", label: "Content intelligence" }],
    category: "intelligence",
  },
  {
    id: "platform_adaptation",
    number: 4,
    title: "Platform adaptation",
    description:
      "Per-platform adapters transform each insight into platform-native opportunities and draft variants. Calm variants ship without links or CTAs.",
    inputs: ["SourceInsight", "Product profile"],
    outputs: [
      "ContentOpportunity rows",
      "DraftVariant rows (Reddit / X / LinkedIn)",
      "DiscoverabilityOpportunity rows (Google)",
    ],
    routes: [
      { href: "/opportunities", label: "Opportunities" },
      { href: "/platforms", label: "Platforms" },
    ],
    category: "intelligence",
  },
  {
    id: "discussion_opportunity",
    number: 5,
    title: "Comment / discussion opportunity",
    description:
      "Discussion seeds are evaluated for community fit, audience match, freshness, and noise. The engine returns participate / watch / skip with a calm reason.",
    inputs: ["DiscussionSeed", "SourceInsight library"],
    outputs: [
      "DiscussionOpportunity with recommendation",
      "Comment / reply drafts (when participating)",
    ],
    routes: [
      { href: "/discussions", label: "Discussions" },
      { href: "/comments", label: "Comments" },
    ],
    category: "intelligence",
  },
  {
    id: "risk_analysis",
    number: 6,
    title: "Risk analysis",
    description:
      "Every draft and every comment is scored deterministically. Aggressive CTAs, launch language, and fake certainty force the level to blocked. Risk is surfaced, never silently applied.",
    inputs: ["Draft text", "Account status", "Cadence load", "Recent body history"],
    outputs: ["RiskScore + ConversationRisk"],
    routes: [{ href: "/risk-center", label: "Risk center" }],
    category: "operations",
  },
  {
    id: "approval_queue",
    number: 7,
    title: "Approval queue",
    description:
      "One calm weekly review. Approve, reject, soften, remove link, delay, convert to comment, save to backlog, pause, or duplicate next week. No daily notifications.",
    inputs: ["Pending draft variants"],
    outputs: ["Approved items"],
    routes: [{ href: "/approval-queue", label: "Approval queue" }],
    category: "operations",
  },
  {
    id: "scheduler",
    number: 8,
    title: "Scheduler",
    description:
      "Items distribute across the week respecting platform cadence, per-account cooldown, and promotional spacing. Items that exceed safe capacity move to the backlog.",
    inputs: ["Approved items", "Platform cadence policies"],
    outputs: ["Scheduled posts", "Cadence load summary", "Move reasons"],
    routes: [{ href: "/scheduler", label: "Scheduler" }],
    category: "operations",
  },
  {
    id: "backlog",
    number: 9,
    title: "Backlog",
    description:
      "Items held for future weeks. Saved by the founder, deferred for cadence, or blocked by setup. Restoring runs the scheduler again and rescores the week.",
    inputs: ["Held items"],
    outputs: ["Restored items (back into the weekly plan)"],
    routes: [{ href: "/backlog", label: "Backlog" }],
    category: "operations",
  },
  {
    id: "platform_command_centers",
    number: 10,
    title: "Platform command centers",
    description:
      "Three social lenses (Reddit, X, LinkedIn) and one search lens (Google). Each is a calm projection of the same shared state through a platform-native strategy.",
    inputs: ["Live state", "Per-platform policies"],
    outputs: ["Platform-specific recommendations"],
    routes: [
      { href: "/platforms/reddit", label: "Reddit" },
      { href: "/platforms/x", label: "X" },
      { href: "/platforms/linkedin", label: "LinkedIn" },
      { href: "/platforms/google", label: "Google" },
    ],
    category: "platform",
  },
  {
    id: "discoverability_loop",
    number: 11,
    title: "Discoverability loop",
    description:
      "Search-to-social and social-to-search opportunities surfaced from content assets paired with insights. Refresh windows, internal linking, evergreen distribution.",
    inputs: ["Content assets", "SourceInsights"],
    outputs: ["DiscoverabilityOpportunity rows"],
    routes: [
      { href: "/discoverability", label: "Discoverability" },
      { href: "/platforms/google", label: "Google visibility" },
    ],
    category: "platform",
  },
  {
    id: "webmasterid_analytics",
    number: 12,
    title: "WebmasterID analytics (future)",
    description:
      "Per-product, per-account, and per-platform attribution arrives when the WebmasterID integration ships. Tracking metadata is already shaped. Until then, every analytics surface says 'Data not yet connected'.",
    inputs: ["UTM-shaped outbound links"],
    outputs: ["Live engagement and conversion data (future)"],
    routes: [{ href: "/analytics", label: "Analytics readiness" }],
    category: "future",
  },
];

const categoryStyles: Record<Stage["category"], string> = {
  configuration: "bg-ink-100 text-ink-700",
  intelligence: "bg-emerald-50 text-emerald-700",
  operations: "bg-amber-50 text-amber-700",
  platform: "bg-signal-50 text-signal-700",
  future: "bg-ink-100 text-ink-500",
};

export default function WorkflowPage() {
  return (
    <>
      <Topbar
        title="Workflow"
        description="Signal's end-to-end operational flow. Useful for founder onboarding, team onboarding, and architecture review."
      />

      <div className="px-6 lg:px-8 py-6 max-w-5xl space-y-6">
        <Intro />
        <ul className="space-y-3">
          {stages.map((stage, i) => (
            <StageRow key={stage.id} stage={stage} isLast={i === stages.length - 1} />
          ))}
        </ul>
        <ClosingNote />
      </div>
    </>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        One operating loop, twelve stages.
      </div>
      <p className="text-ink-700">
        Configuration feeds intelligence; intelligence feeds operations;
        operations feeds the platform lenses; the platform lenses inform
        future analytics. Every stage is deterministic today — when external
        APIs ship, they slot in behind the existing types.
      </p>
    </div>
  );
}

function StageRow({ stage, isLast }: { stage: Stage; isLast: boolean }) {
  return (
    <li className="relative">
      <article className="card p-5">
        <div className="flex items-start gap-4">
          <div className="shrink-0">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-ink-900 text-white text-sm font-semibold">
              {stage.number}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className="text-base font-semibold text-ink-900">
                {stage.title}
              </h3>
              <span className={`badge ${categoryStyles[stage.category]}`}>
                {stage.category}
              </span>
            </div>
            <p className="text-sm text-ink-700 leading-relaxed">
              {stage.description}
            </p>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
              <Slot label="Inputs" items={stage.inputs} />
              <Slot label="Outputs" items={stage.outputs} />
            </div>

            {stage.routes.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {stage.routes.map((r) => (
                  <Link
                    key={r.href}
                    href={r.href}
                    className="btn inline-flex items-center gap-1 text-xs"
                  >
                    {r.label}
                    <ChevronRightIcon width={12} height={12} />
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </article>
      {!isLast ? (
        <div className="flex justify-center my-2">
          <div className="h-4 w-0.5 bg-ink-200 rounded-full" />
        </div>
      ) : null}
    </li>
  );
}

function Slot({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="rounded-md bg-ink-50/60 p-3">
      <div className="stat-label">{label}</div>
      <ul className="mt-1 space-y-0.5 text-xs text-ink-700">
        {items.map((it) => (
          <li key={it}>· {it}</li>
        ))}
      </ul>
    </div>
  );
}

function ClosingNote() {
  return (
    <div className="card border-ink-100 bg-ink-50/40 p-4 text-sm text-ink-700 leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        What is intentionally not in this loop yet.
      </div>
      <p>
        Supabase, OAuth, real AI APIs, real publishing, and live analytics are
        explicitly deferred. The loop is built to survive their arrival
        without rewrites: pure functions stay where they are, the store
        contract stays where it is, and the platform adapters slot in as
        thin shells over the existing types.
      </p>
    </div>
  );
}
