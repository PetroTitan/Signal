interface Step {
  key: string;
  label: string;
}

export function Stepper({
  steps,
  active,
}: {
  steps: Step[];
  active: number;
}) {
  return (
    <ol className="flex items-center gap-2 flex-wrap text-xs">
      {steps.map((s, i) => {
        const state = i < active ? "done" : i === active ? "current" : "upcoming";
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                state === "done"
                  ? "bg-emerald-100 text-emerald-700"
                  : state === "current"
                    ? "bg-ink-900 text-white"
                    : "bg-ink-100 text-ink-500"
              }`}
            >
              {i + 1}
            </span>
            <span
              className={`${
                state === "current"
                  ? "text-ink-900 font-medium"
                  : state === "done"
                    ? "text-ink-700"
                    : "text-ink-400"
              }`}
            >
              {s.label}
            </span>
            {i < steps.length - 1 ? (
              <span className="text-ink-300 mx-1">›</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
