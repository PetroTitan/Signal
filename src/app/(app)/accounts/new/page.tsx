"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { Stepper } from "@/components/stepper";
import { LockIcon } from "@/components/icons";
import { useAccountActions, useSignal } from "@/core/store";
import { buildSetupKit } from "@/core/onboarding";
import { platforms } from "@/lib/mock";
import type { AccountRole, PlatformId } from "@/types";

const roles: { id: AccountRole; label: string; description: string }[] = [
  {
    id: "founder",
    label: "Founder",
    description: "Your personal voice. Operator notes, lessons, story.",
  },
  {
    id: "product",
    label: "Product",
    description: "Speaks for the product itself. Calm, technical, link-aware.",
  },
  {
    id: "support",
    label: "Support",
    description: "Answers questions, surfaces fixes, no marketing voice.",
  },
  {
    id: "research",
    label: "Research",
    description: "Observation and curiosity. Avoids promotional links.",
  },
  {
    id: "community",
    label: "Community",
    description: "Engages where the audience already lives. Listens first.",
  },
];

const steps = [
  { key: "platform", label: "Platform" },
  { key: "product", label: "Product" },
  { key: "role", label: "Role" },
  { key: "kit", label: "Generate kit" },
];

export default function NewAccountWizard() {
  const router = useRouter();
  const { state } = useSignal();
  const actions = useAccountActions();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );

  const [stepIndex, setStepIndex] = useState(0);
  const [platform, setPlatform] = useState<PlatformId | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [role, setRole] = useState<AccountRole | null>(null);
  const [displayName, setDisplayName] = useState<string>("");
  const [creating, setCreating] = useState(false);

  const product = productId ? state.productsById[productId] : undefined;

  const previewKit = useMemo(() => {
    if (!platform || !product || !role) return null;
    return buildSetupKit({
      platform,
      product,
      role,
      generatedAt: "preview",
    });
  }, [platform, product, role]);

  if (products.length === 0) {
    return (
      <>
        <Topbar title="New account" />
        <div className="px-6 lg:px-10 py-16 max-w-md mx-auto text-center">
          <h2 className="text-base font-semibold text-ink-900">
            Add a product first
          </h2>
          <p className="text-sm text-ink-500 mt-2 leading-relaxed">
            Accounts belong to products. Create a product profile before adding
            an account.
          </p>
          <Link href="/products" className="btn-primary mt-5 inline-flex">
            Open products
          </Link>
        </div>
      </>
    );
  }

  const canNext =
    (stepIndex === 0 && platform !== null) ||
    (stepIndex === 1 && productId !== null) ||
    (stepIndex === 2 && role !== null) ||
    stepIndex === 3;

  const next = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const back = () => setStepIndex((i) => Math.max(i - 1, 0));

  const create = () => {
    if (!platform || !productId || !role) return;
    setCreating(true);
    const id = actions.createAccount({
      platform,
      productId,
      role,
      displayName: displayName.trim() || undefined,
    });
    router.push(`/accounts/${id}`);
  };

  return (
    <>
      <Topbar
        title="New account"
        description="Signal will prepare a setup kit. You create the account on the platform yourself."
        actions={
          <Link href="/accounts" className="btn-ghost">
            Cancel
          </Link>
        }
      />

      <div className="px-6 lg:px-8 py-6 max-w-4xl space-y-6">
        <SafetyBanner />

        <div className="card-padded">
          <Stepper steps={steps} active={stepIndex} />
        </div>

        {stepIndex === 0 ? (
          <PlatformStep platform={platform} onChange={setPlatform} />
        ) : null}

        {stepIndex === 1 ? (
          <ProductStep
            products={products}
            productId={productId}
            onChange={setProductId}
          />
        ) : null}

        {stepIndex === 2 ? (
          <RoleStep role={role} onChange={setRole} />
        ) : null}

        {stepIndex === 3 && previewKit && platform && product && role ? (
          <KitPreview
            platform={platform}
            productName={product.name}
            role={role}
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            previewKit={previewKit}
          />
        ) : null}

        <Footer
          onBack={back}
          onNext={next}
          onCreate={create}
          canNext={canNext}
          stepIndex={stepIndex}
          creating={creating}
        />
      </div>
    </>
  );
}

function SafetyBanner() {
  return (
    <div className="card border-signal-200 bg-signal-50/40">
      <div className="p-4 flex items-start gap-3 text-sm">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
          <LockIcon />
        </span>
        <div>
          <div className="font-semibold text-ink-900">
            Signal never asks for your platform password.
          </div>
          <p className="text-ink-700 mt-0.5 leading-relaxed">
            Create accounts manually on each platform. Signal prepares a setup
            kit, a 14-day warm-up plan, and a readiness checklist — it does not
            create or mask accounts. Connection happens later, only through
            official OAuth when integrations are enabled.
          </p>
        </div>
      </div>
    </div>
  );
}

function PlatformStep({
  platform,
  onChange,
}: {
  platform: PlatformId | null;
  onChange: (p: PlatformId) => void;
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Choose a platform</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Each platform shapes tone, cadence, and the warm-up plan.
        </p>
      </header>
      <ul className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3">
        {platforms.map((p) => {
          const active = platform === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onChange(p.id)}
                className={`w-full text-left p-4 rounded-md border transition-colors ${
                  active
                    ? "border-signal-500 bg-signal-50/50"
                    : "border-ink-100 hover:border-signal-200"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <PlatformBadge platform={p.id} />
                  <span className="text-[11px] text-ink-500">
                    {p.cadenceGuidance.suggestedPostsPerWeek}/wk suggested
                  </span>
                </div>
                <p className="text-sm text-ink-800 leading-snug">
                  {p.description}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProductStep({
  products,
  productId,
  onChange,
}: {
  products: { id: string; name: string; domain: string; positioning: string; category: string }[];
  productId: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Choose a product</div>
        <p className="text-xs text-ink-500 mt-0.5">
          The product&apos;s positioning and CTA policy will shape the kit.
        </p>
      </header>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
        {products.map((p) => {
          const active = productId === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onChange(p.id)}
                className={`w-full text-left p-4 rounded-md border transition-colors ${
                  active
                    ? "border-signal-500 bg-signal-50/50"
                    : "border-ink-100 hover:border-signal-200"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-ink-900">
                    {p.name}
                  </span>
                  <span className="text-[11px] text-ink-500">{p.domain}</span>
                </div>
                <p className="text-xs text-ink-700 line-clamp-2">{p.positioning}</p>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RoleStep({
  role,
  onChange,
}: {
  role: AccountRole | null;
  onChange: (r: AccountRole) => void;
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Choose an account role</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Different roles produce different bios, warm-up plans, and content ideas.
        </p>
      </header>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
        {roles.map((r) => {
          const active = role === r.id;
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onChange(r.id)}
                className={`w-full text-left p-4 rounded-md border transition-colors ${
                  active
                    ? "border-signal-500 bg-signal-50/50"
                    : "border-ink-100 hover:border-signal-200"
                }`}
              >
                <div className="text-sm font-semibold text-ink-900 mb-1">
                  {r.label}
                </div>
                <p className="text-xs text-ink-600">{r.description}</p>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function KitPreview({
  platform,
  productName,
  role,
  displayName,
  onDisplayNameChange,
  previewKit,
}: {
  platform: PlatformId;
  productName: string;
  role: AccountRole;
  displayName: string;
  onDisplayNameChange: (v: string) => void;
  previewKit: ReturnType<typeof buildSetupKit>;
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center gap-2 flex-wrap">
        <PlatformBadge platform={platform} />
        <span className="text-sm text-ink-700">{productName}</span>
        <span className="text-xs text-ink-500">· {role}</span>
      </header>
      <div className="px-5 py-4 space-y-5">
        <div>
          <label
            htmlFor="display-name"
            className="block stat-label mb-1"
          >
            Display name
          </label>
          <input
            id="display-name"
            type="text"
            placeholder={previewKit.displayNameSuggestions[0] ?? ""}
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            className="w-full border border-ink-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal-300 focus:border-signal-500"
          />
          <p className="text-[11px] text-ink-500 mt-1">
            Leave blank to use the first suggestion.
          </p>
        </div>

        <PreviewBlock title="Username ideas">
          <ul className="font-mono text-sm text-ink-800 space-y-1">
            {previewKit.usernameIdeas.map((u) => (
              <li key={u}>· {u}</li>
            ))}
          </ul>
        </PreviewBlock>

        <PreviewBlock title="Display name suggestions">
          <ul className="text-sm text-ink-800 space-y-1">
            {previewKit.displayNameSuggestions.map((d) => (
              <li key={d}>· {d}</li>
            ))}
          </ul>
        </PreviewBlock>

        <PreviewBlock title="Bio / headline">
          <ul className="text-sm text-ink-800 space-y-2">
            {previewKit.bioSuggestions.map((b) => (
              <li
                key={b}
                className="border-l-2 border-ink-100 pl-3 leading-relaxed"
              >
                {b}
              </li>
            ))}
          </ul>
        </PreviewBlock>

        <PreviewBlock title="14-day warm-up plan">
          <ol className="text-sm text-ink-800 space-y-1 list-decimal list-inside">
            {previewKit.warmUpDays.slice(0, 4).map((d) => (
              <li key={d.day}>
                <span className="text-ink-500 font-mono mr-1">Day {d.day}:</span>
                {d.description}
              </li>
            ))}
          </ol>
          <p className="text-[11px] text-ink-500 mt-2">
            Preview: 4 of 14 days. The full plan will appear on the account page.
          </p>
        </PreviewBlock>

        <PreviewBlock title="Manual setup checklist">
          <ul className="text-sm text-ink-800 space-y-1">
            {previewKit.checklist.map((c) => (
              <li key={c.id}>· {c.label}</li>
            ))}
          </ul>
        </PreviewBlock>
      </div>
    </section>
  );
}

function PreviewBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="stat-label mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function Footer({
  onBack,
  onNext,
  onCreate,
  canNext,
  stepIndex,
  creating,
}: {
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
  canNext: boolean;
  stepIndex: number;
  creating: boolean;
}) {
  const isLast = stepIndex === steps.length - 1;
  return (
    <div className="card-padded flex items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        className="btn"
        disabled={stepIndex === 0}
      >
        Back
      </button>
      <div className="text-xs text-ink-500">
        Step {stepIndex + 1} of {steps.length}
      </div>
      {isLast ? (
        <button
          type="button"
          onClick={onCreate}
          className="btn-primary"
          disabled={!canNext || creating}
        >
          {creating ? "Creating…" : "Create account"}
        </button>
      ) : (
        <button
          type="button"
          onClick={onNext}
          className="btn-primary"
          disabled={!canNext}
        >
          Continue
        </button>
      )}
    </div>
  );
}
