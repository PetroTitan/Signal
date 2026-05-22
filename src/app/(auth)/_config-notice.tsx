import { diagnoseSupabaseConfig } from "@/lib/supabase";

/**
 * Renders a config notice when the Supabase env is not in a state where
 * auth can succeed. Returns null when everything is fine.
 *
 * The diagnostic reason and any URL components are rendered verbatim.
 * The anon-key value is never rendered.
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

      {d.urlParses ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-ink-600 font-mono text-[11px]">
          <dt>protocol</dt>
          <dd className="break-all">{d.urlProtocol || "—"}</dd>
          <dt>hostname</dt>
          <dd className="break-all">{d.urlHostname || "—"}</dd>
          <dt>pathname</dt>
          <dd className="break-all">{d.urlPathname || "(empty)"}</dd>
          {d.urlHasSearch ? (
            <>
              <dt>query</dt>
              <dd>present</dd>
            </>
          ) : null}
          {d.urlHasHash ? (
            <>
              <dt>fragment</dt>
              <dd>present</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-ink-500 font-mono text-[11px]">
        <dt>url length</dt>
        <dd>{d.urlLength}</dd>
        <dt>anon key</dt>
        <dd>
          {d.anonKeyPresent
            ? `${d.anonKeyShape} (${d.anonKeyLength} chars)`
            : "missing"}
        </dd>
        {d.urlNormalizationApplied ? (
          <>
            <dt>normalized</dt>
            <dd>stripped quotes / whitespace / trailing slash</dd>
          </>
        ) : null}
      </dl>

      <p className="mt-3 text-ink-600">
        Ask the operator to set{" "}
        <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> on
        this deployment, then redeploy.
      </p>
    </div>
  );
}
