import Link from "next/link";
import { ChevronRightIcon } from "./icons";

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
