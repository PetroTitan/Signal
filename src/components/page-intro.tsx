export interface PageIntroProps {
  title: string;
  body: string;
  tone?: "neutral" | "signal";
}

export function PageIntro({ title, body, tone = "signal" }: PageIntroProps) {
  const cls =
    tone === "signal"
      ? "border-signal-200 bg-signal-50/30"
      : "border-ink-100 bg-ink-50/40";
  return (
    <div className={`card ${cls} p-4 text-sm leading-relaxed`}>
      <div className="font-semibold text-ink-900 mb-1">{title}</div>
      <p className="text-ink-700">{body}</p>
    </div>
  );
}
