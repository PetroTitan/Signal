import Link from "next/link";
import { SearchIcon } from "./icons";

type TopbarProps = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
};

export function Topbar({ title, description, actions }: TopbarProps) {
  return (
    <header className="border-b border-ink-100 bg-white">
      <div className="px-6 lg:px-10 py-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900 leading-tight tracking-tight">
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-ink-500 mt-1 max-w-xl leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/search"
            aria-label="Open search"
            className="btn-ghost p-2"
          >
            <SearchIcon />
          </Link>
          {actions}
        </div>
      </div>
    </header>
  );
}
