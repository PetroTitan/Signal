import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRightIcon } from "./icons";
import { realEmpty, type RealEmptyKey } from "@/core/data-mode";

export interface EmptyStateAction {
  href: string;
  label: string;
}

export interface EmptyStateProps {
  title: string;
  description: string;
  actions?: EmptyStateAction[];
  tone?: "neutral" | "ok";
}

export function EmptyState({
  title,
  description,
  actions,
  tone = "neutral",
}: EmptyStateProps) {
  const cls =
    tone === "ok"
      ? "border-emerald-200 bg-emerald-50/40"
      : "border-ink-100 bg-ink-50/40";
  return (
    <div className={`card ${cls} p-6 text-sm`}>
      <div className="font-semibold text-ink-900">{title}</div>
      <p className="text-ink-700 mt-1 leading-relaxed">{description}</p>
      {actions && actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="btn inline-flex items-center gap-1"
            >
              {a.label}
              <ChevronRightIcon width={12} height={12} />
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface NotConnectedStateProps {
  variant: RealEmptyKey;
  /** Optional secondary text rendered above the CTAs. */
  detail?: string;
  /** Optional extra CTA rendered alongside the canonical one. */
  secondary?: { href: string; label: string };
  /** Extra content rendered after the CTAs (notes, OAuth reminders). */
  children?: ReactNode;
}

/**
 * Honest empty state for normal mode. Renders the canonical title, hint,
 * and CTA for a given real-empty key.
 */
export function NotConnectedState({
  variant,
  detail,
  secondary,
  children,
}: NotConnectedStateProps) {
  const state = realEmpty(variant);
  return (
    <div className="text-center py-16 max-w-md mx-auto">
      <h2 className="text-base font-semibold text-ink-900">{state.title}</h2>
      <p className="text-sm text-ink-500 mt-2 leading-relaxed">
        {detail ?? state.hint}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link href={state.cta.href} className="btn-primary">
          {state.cta.label}
        </Link>
        {secondary ? (
          <Link href={secondary.href} className="btn">
            {secondary.label}
          </Link>
        ) : null}
      </div>
      {children ? (
        <div className="mt-6 text-xs text-ink-500 leading-relaxed">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Visible label every page must render when showing demo content. Place it
 * at the top of the page body, before any cards.
 */
export function DemoLabel({ detail }: { detail?: string }) {
  return (
    <div className="text-[11px] uppercase tracking-wide text-ink-500 border border-ink-100 bg-ink-50/60 rounded-md px-3 py-2 flex items-center justify-between gap-3">
      <span>
        <span className="font-semibold text-ink-700">Demo preview</span>
        <span className="ml-2 normal-case tracking-normal text-ink-500">
          This data is not connected to real accounts.
          {detail ? ` ${detail}` : ""}
        </span>
      </span>
      <Link
        href="/settings"
        className="text-signal-700 hover:text-signal-800 font-medium normal-case tracking-normal"
      >
        Settings
      </Link>
    </div>
  );
}
