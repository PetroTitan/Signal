import { diagnoseSupabaseConfig } from "@/lib/supabase";

/**
 * Renders a config notice when the Supabase env is not in a state where
 * auth can succeed. Returns null when everything is fine. The diagnostic
 * reason is rendered verbatim (it never contains the anon-key value).
 */
export function SupabaseConfigNotice() {
  const d = diagnoseSupabaseConfig();
  if (d.reason === null) return null;

  return (
    <div
      role="alert"
      className="card border-amber-200 bg-amber-50/70 p-4 text-xs leading-relaxed"
    >
      <div className="text-sm font-semibold text-ink-900">
        Authentication is not available
      </div>
      <p className="mt-1 text-ink-700">{d.reason}</p>
      <p className="mt-2 text-ink-600">
        Ask the operator to set{" "}
        <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> for
        this deployment.
      </p>
    </div>
  );
}
