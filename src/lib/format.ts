export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDayHour(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDateRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const monthDay = (d: Date) =>
    d.toLocaleString("en-US", { month: "short", day: "numeric" });
  return `${monthDay(s)} – ${monthDay(e)}, ${e.getUTCFullYear()}`;
}

export function relativeFromNow(iso: string, now = new Date()): string {
  const t = new Date(iso).getTime();
  const diff = t - now.getTime();
  const absMin = Math.abs(diff) / 60000;
  if (absMin < 60) {
    const m = Math.round(absMin);
    return diff >= 0 ? `in ${m}m` : `${m}m ago`;
  }
  if (absMin < 60 * 24) {
    const h = Math.round(absMin / 60);
    return diff >= 0 ? `in ${h}h` : `${h}h ago`;
  }
  const days = Math.round(absMin / 60 / 24);
  return diff >= 0 ? `in ${days}d` : `${days}d ago`;
}
