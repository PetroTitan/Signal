import Link from "next/link";
import { ChevronRightIcon } from "./icons";

export interface SectionHeaderProps {
  title: string;
  hint?: string;
  link?: { href: string; label: string };
  badge?: React.ReactNode;
}

export function SectionHeader({ title, hint, link, badge }: SectionHeaderProps) {
  return (
    <div className="px-5 py-3.5 border-b border-ink-100 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-ink-900">{title}</div>
          {badge}
        </div>
        {hint ? <div className="text-xs text-ink-500 mt-0.5">{hint}</div> : null}
      </div>
      {link ? (
        <Link
          href={link.href}
          className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1 shrink-0"
        >
          {link.label}
          <ChevronRightIcon width={12} height={12} />
        </Link>
      ) : null}
    </div>
  );
}
