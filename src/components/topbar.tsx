type TopbarProps = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
};

export function Topbar({ title, description, actions }: TopbarProps) {
  return (
    <header className="border-b border-ink-100 bg-white">
      <div className="px-4 sm:px-6 lg:px-10 py-5 sm:py-6 flex flex-wrap items-start justify-between gap-4">
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
        {actions ? (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
