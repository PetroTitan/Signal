import {
  OAUTH_PROVIDERS,
  OAUTH_PLATFORM_LABELS,
  PLATFORM_OAUTH_CAPABILITIES,
  OAUTH_CAPABILITY_LABELS,
  isPublishingCapability,
  type OAuthPlatform,
} from "@/core/platform-oauth";
import {
  hasTokenEncryptionKey,
  isOAuthProviderConfigured,
} from "@/lib/oauth/env";

interface Props {
  platform: OAuthPlatform;
}

/**
 * Read-only panel describing the OAuth contract for a platform.
 * Connect / disconnect / health buttons live on /accounts where the
 * action is bound to a specific growth_accounts row.
 */
export function PlatformOAuthPanel({ platform }: Props) {
  const provider = OAUTH_PROVIDERS[platform];
  const configured = isOAuthProviderConfigured(platform);
  const encryptionOn = hasTokenEncryptionKey();
  const capabilities = PLATFORM_OAUTH_CAPABILITIES[platform];

  return (
    <section className="card p-5 space-y-3">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-900">
          {OAUTH_PLATFORM_LABELS[platform]} OAuth
        </h2>
        <span
          className={
            configured ? "text-xs text-green-700" : "text-xs text-amber-700"
          }
        >
          {configured ? "Provider configured" : "OAuth app not configured yet."}
        </span>
      </header>

      <p className="text-xs text-ink-600 leading-relaxed">
        Signal connects to {OAUTH_PLATFORM_LABELS[platform]} only through the
        official OAuth flow. We never ask for passwords, cookies, session
        tokens, 2FA codes, or recovery codes.
      </p>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Requested scopes (read-only in this phase)
        </div>
        <ul className="text-xs text-ink-700 space-y-1">
          {provider.scopes.map((s) => (
            <li key={s.scope} className="flex justify-between gap-3">
              <span>
                <span className="font-mono text-[11px]">{s.scope}</span>{" "}
                — {s.rationale}
              </span>
              <span className="text-[10px] text-ink-500">
                {s.required ? "required" : "optional"}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
          Capabilities
        </div>
        <ul className="text-xs text-ink-700 space-y-0.5">
          {capabilities.map((c) => (
            <li key={c}>
              <span className="font-mono text-[11px]">{c}</span>{" "}
              <span className="text-ink-500">
                — {OAUTH_CAPABILITY_LABELS[c]}
                {isPublishingCapability(c) ? " · not enabled in this phase" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {!configured ? (
        <div className="text-[11px] text-amber-700 leading-relaxed border-t border-ink-100 pt-3">
          Set{" "}
          <code className="font-mono">
            {platform.toUpperCase()}_CLIENT_ID
          </code>
          ,{" "}
          <code className="font-mono">
            {platform.toUpperCase()}_CLIENT_SECRET
          </code>
          , and{" "}
          <code className="font-mono">
            {platform.toUpperCase()}_REDIRECT_URI
          </code>{" "}
          in the server env, then add an account on{" "}
          <a href="/accounts" className="text-signal-700 underline">
            /accounts
          </a>{" "}
          to start the OAuth flow.
        </div>
      ) : !encryptionOn ? (
        <div className="text-[11px] text-amber-700 leading-relaxed border-t border-ink-100 pt-3">
          Token encryption (
          <code className="font-mono">TOKEN_ENCRYPTION_KEY</code>) is not
          configured. Signal will refuse to store real OAuth tokens until it
          is — connections complete the round-trip but land in{" "}
          <code className="font-mono">connection_status=error</code>.
        </div>
      ) : (
        <div className="text-[11px] text-ink-500 border-t border-ink-100 pt-3">
          Manage individual account connections on{" "}
          <a href="/accounts" className="text-signal-700 underline">
            /accounts
          </a>
          .
        </div>
      )}
    </section>
  );
}
