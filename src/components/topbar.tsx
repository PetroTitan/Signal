import { workspace } from "@/lib/mock";

type TopbarProps = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
};

export function Topbar({ title, description, actions }: TopbarProps) {
  return (
    <header className="border-b border-ink-100 bg-white">
      <div className="px-6 lg:px-8 py-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-ink-500 mb-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span>{workspace.name}</span>
          </div>
          <h1 className="text-xl font-semibold text-ink-900 leading-tight">
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-ink-500 mt-1 max-w-2xl">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
