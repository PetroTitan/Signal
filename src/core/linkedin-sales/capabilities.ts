/**
 * The official LinkedIn capability registry — the single place that
 * says what Signal may do with LinkedIn, and how.
 *
 * STATUSES
 * --------
 *   unavailable            no lawful path exists in this product today
 *   manual_only            a person does it on LinkedIn; Signal prepares
 *                          and records
 *   official_api_approved  a documented LinkedIn API product, an
 *                          adapter in this repository, and the exact
 *                          scopes granted to the installed application
 *
 * Every outreach and member action is `manual_only`, and stays so by
 * design: no documented LinkedIn API sends messages or connection
 * requests, views or searches member profiles, or performs engagement
 * on behalf of a member (Marketing API program, read 2026-09-15). The
 * status is not a setting; it is a claim with evidence, and the guard
 * below fails closed unless every part of that claim holds.
 *
 * Authentication scopes (openid, profile, email) identify a person.
 * They are listed here for `identity_display` and nothing else, and the
 * guard treats them as sufficient for nothing else.
 *
 * Pure. No I/O. Imported by server and client code alike.
 */

export type CapabilityStatus = "unavailable" | "manual_only" | "official_api_approved";

export interface LinkedInCapability {
  /** Stable identifier. */
  name: LinkedInCapabilityName;
  status: CapabilityStatus;
  /** What a person sees on the compliance page. */
  title: string;
  explanation: string;
  /** OAuth product and scopes an official path would need. Empty when none exists. */
  requiredProduct: string | null;
  requiredScopes: readonly string[];
  /** Where the status comes from. Never a competitor's behaviour. */
  evidence: string;
  lastVerified: string;
  /**
   * The module that would implement an official path. `null` for every
   * manual or unavailable capability; the guard refuses without one.
   */
  adapter: string | null;
}

export type LinkedInCapabilityName =
  | "identity_display"
  | "profile_lookup"
  | "profile_search"
  | "connection_request"
  | "direct_message"
  | "inmail"
  | "profile_view"
  | "post_engagement"
  | "follow_unfollow"
  | "endorsement"
  | "connections_export"
  | "email_outreach";

const VERIFIED = "2026-09-15";
const SOURCES =
  "LinkedIn Prohibited Software & Extensions (a1341387); User Agreement §8.2.2/8.2.13; API Terms of Use §3.1(23)(24)(26); Marketing API program index — all read " +
  VERIFIED +
  ". See docs/linkedin-sales/00-audit-and-boundary.md §1.";

export const LINKEDIN_CAPABILITIES: readonly LinkedInCapability[] = Object.freeze([
  {
    name: "identity_display",
    status: "official_api_approved",
    title: "Show which LinkedIn account is connected",
    explanation:
      "Signal shows the name of the LinkedIn account you connected so you know which account to act as in your own browser. This uses the identity scopes only; it grants no permission to message, connect, read a network or post.",
    requiredProduct: "Sign In with LinkedIn using OpenID Connect",
    requiredScopes: ["openid", "profile"],
    evidence: "docs/oauth/linkedin-oauth.md — scopes requested: openid, profile. " + SOURCES,
    lastVerified: VERIFIED,
    adapter: "src/app/api/oauth/[platform] (existing, identity only)",
  },
  {
    name: "profile_lookup",
    status: "unavailable",
    title: "Fetch or verify a profile",
    explanation:
      "Signal never requests a profile URL, not even to check it exists. Reading member profiles outside an approved API is scraping. A URL you provide is accepted as your statement and nothing more.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: "User Agreement §8.2.2; API Terms §3.1(24); Crawling Terms. " + SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "profile_search",
    status: "unavailable",
    title: "Search LinkedIn for people",
    explanation: "No documented API offers member search to this application. Signal does not search LinkedIn.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: "Marketing API program index lists no member-search product. " + SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "connection_request",
    status: "manual_only",
    title: "Send a connection request",
    explanation:
      "You send it yourself on LinkedIn. Signal prepares the note, opens the public profile in a new tab, and records what you confirm. Automated connection requests are prohibited (§8.2.13) and no API exists for them.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "direct_message",
    status: "manual_only",
    title: "Send a LinkedIn message",
    explanation:
      "You send it yourself on LinkedIn. Signal prepares a draft you copy. Automated messaging is prohibited (§8.2.13) and no API exists for it.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "inmail",
    status: "manual_only",
    title: "Send an InMail",
    explanation: "Same as a message: prepared here, sent by you, confirmed by you.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "profile_view",
    status: "manual_only",
    title: "View a profile",
    explanation:
      "\"Open in LinkedIn\" opens the public profile in a new browser tab — your browser, your session. Signal records that you opened it. It never views a profile for you.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "post_engagement",
    status: "manual_only",
    title: "Like, comment or share",
    explanation: "Not part of this product. Automated engagement is prohibited (§8.2.13).",
    requiredProduct: null,
    requiredScopes: [],
    evidence: SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "follow_unfollow",
    status: "manual_only",
    title: "Follow or unfollow a member",
    explanation: "Not part of this product. Automated following is prohibited (§8.2.13).",
    requiredProduct: null,
    requiredScopes: [],
    evidence: SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "endorsement",
    status: "manual_only",
    title: "Endorse a skill",
    explanation: "Not part of this product.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "connections_export",
    status: "unavailable",
    title: "Import your LinkedIn connections",
    explanation:
      "Signal does not read your connections. Reading a member's network requires their express permission and an approved API (§3.1(23)); none is granted to this application. Provide the profile URLs yourself.",
    requiredProduct: null,
    requiredScopes: [],
    evidence: "API Terms §3.1(23). " + SOURCES,
    lastVerified: VERIFIED,
    adapter: null,
  },
  {
    name: "email_outreach",
    status: "unavailable",
    title: "Send email through an authorized integration",
    explanation:
      "No email integration is authorized in this release, so sequences containing an email step cannot be activated. When one is added it must enforce unsubscribe and the suppression list before any send.",
    requiredProduct: "A separately authorized email integration (not LinkedIn)",
    requiredScopes: [],
    evidence: "src/core/notifications/notification-sender.ts: the email sender is a documented no-op.",
    lastVerified: VERIFIED,
    adapter: null,
  },
]);

export function getCapability(name: LinkedInCapabilityName): LinkedInCapability {
  const found = LINKEDIN_CAPABILITIES.find((c) => c.name === name);
  if (!found) throw new Error(`Unknown LinkedIn capability: ${name}`);
  return found;
}

/** Every outreach / member-action capability. All are manual_only. */
export const MEMBER_ACTION_CAPABILITIES: readonly LinkedInCapabilityName[] = Object.freeze([
  "connection_request",
  "direct_message",
  "inmail",
  "profile_view",
  "post_engagement",
  "follow_unfollow",
  "endorsement",
]);

export class LinkedInCapabilityRefused extends Error {
  constructor(
    public readonly capability: LinkedInCapabilityName,
    public readonly reason:
      | "not_official"
      | "no_adapter"
      | "scope_missing"
      | "no_scopes_required_is_not_permission",
    message: string,
  ) {
    super(message);
    this.name = "LinkedInCapabilityRefused";
  }
}

/**
 * FAIL CLOSED. Throws unless the capability is `official_api_approved`,
 * names an adapter, requires at least one scope, and every required
 * scope is present in the scopes actually granted to the installed
 * application. Nothing in this repository calls it for an outreach
 * capability, and a structural test asserts no LinkedIn HTTP client
 * exists to call.
 */
export function assertLinkedInApiUse(
  name: LinkedInCapabilityName,
  grantedScopes: readonly string[],
): LinkedInCapability {
  const cap = getCapability(name);
  if (cap.status !== "official_api_approved") {
    throw new LinkedInCapabilityRefused(name, "not_official",
      `${cap.title}: ${cap.status === "manual_only" ? "a person does this on LinkedIn; Signal does not" : "no lawful path exists"}.`);
  }
  if (!cap.adapter) {
    throw new LinkedInCapabilityRefused(name, "no_adapter", `${cap.title}: no adapter is implemented.`);
  }
  if (cap.requiredScopes.length === 0) {
    throw new LinkedInCapabilityRefused(name, "no_scopes_required_is_not_permission",
      `${cap.title}: an official capability must name the scopes it needs.`);
  }
  const granted = new Set(grantedScopes.map((s) => s.trim()));
  for (const scope of cap.requiredScopes) {
    if (!granted.has(scope)) {
      throw new LinkedInCapabilityRefused(name, "scope_missing",
        `${cap.title}: the installed application was not granted "${scope}".`);
    }
  }
  return cap;
}

/** The one-line status for the dashboard. */
export function linkedInAccessSummary(): "manual_only" {
  // Outreach is manual in every configuration this release supports.
  return "manual_only";
}
