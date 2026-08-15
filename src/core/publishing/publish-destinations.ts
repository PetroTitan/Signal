/**
 * Publish destinations — the derived model behind the editor's
 * "Where" selector.
 *
 * The problem this replaces
 * ------------------------
 * The compose sheet used to carry a hardcoded four-entry
 * `PLATFORM_CHOICES` array (reddit / dev.to / Hashnode / Bluesky).
 * It was written when those were the only automated platforms and
 * never moved again. X and Telegram then gained real publishers and
 * joined the scheduler's autonomous set — but the editor could not
 * see it, because capability truth lived inside `server-only`
 * modules that a client component cannot import. So the operator's
 * actual destination choice silently lagged behind what Signal could
 * do, while a SECOND surface in the same modal ("Publish
 * destinations", the adapt-for chips) listed all eleven platforms.
 * Two surfaces, two registries, two different answers.
 *
 * The two concepts, kept apart
 * ----------------------------
 *   Platform capability  — what Signal knows how to adapt, validate,
 *                          publish through an API, or prepare for
 *                          manual publication. Static; the same for
 *                          every workspace. That is the "Publish
 *                          destinations" chip row, which is
 *                          informational context, not a choice.
 *
 *   Item destination     — where THIS item is intended to go. That is
 *                          "Where". One value, persisted on
 *                          `weekly_plan_items.platform`.
 *
 *   Connection state     — whether this workspace has a usable
 *                          identity/credential for that platform
 *                          right now.
 *
 *   Publishing mode      — API/autonomous vs operator-driven manual
 *                          distribution.
 *
 * This module derives all four from existing truth. It introduces no
 * new platform list: membership comes from `FOUNDER_PLATFORMS`
 * (the editorial registry), automation from
 * `publish-capability-registry` (the execution-integrity registry),
 * and connection state from rows the caller already loaded.
 *
 * INVARIANT — UI visibility is not authorization.
 * `autonomousSchedulable` is computed ONLY from
 * `isAutonomouslySchedulable()`. A destination may be visible,
 * selectable, and even carry a connected identity while still being
 * non-autonomous; in that case Signal prepares the post and the
 * operator publishes it. Nothing in this module can widen what the
 * scheduler will drive — it only describes it.
 *
 * Pure. No I/O, no `server-only`. Safe in a client bundle.
 */

import {
  FOUNDER_PLATFORMS,
  resolveIdentityPlatformGuidance,
  type FounderPlatform,
} from "./platform-guidance";
import { isAutonomouslySchedulable } from "./publish-capability-registry";

/**
 * How a destination reaches the platform.
 *
 *   - "api"    — Signal calls the platform's official API. Requires a
 *                connected identity; the scheduler can drive it.
 *   - "manual" — Signal prepares and formats the post; the operator
 *                publishes on the platform and records the permalink.
 *                Never autonomous, by design, not by omission.
 */
export type DestinationMode = "api" | "manual";

/**
 * What the operator can do with this destination right now.
 *
 *   - "connected"           API destination with at least one usable
 *                           identity. Ready to schedule.
 *   - "connection_required" API destination with no usable identity
 *                           yet. Selectable (the operator may be
 *                           drafting ahead of connecting), but the
 *                           UI must say so and must not imply the
 *                           scheduler will publish it.
 *   - "manual"              Operator-driven distribution. A steady
 *                           state, not an error.
 *   - "unavailable"         Signal has no publishing path at all.
 */
export type DestinationAvailability =
  | "connected"
  | "connection_required"
  | "manual"
  | "unavailable";

export interface PublishDestination {
  platform: FounderPlatform;
  label: string;
  /** Compact chip prefix, e.g. "r/", "Bs", "Tg". */
  short: string;
  mode: DestinationMode;
  availability: DestinationAvailability;
  /**
   * True ONLY when the scheduler may publish this platform without a
   * human. Derived from capability truth — never from this module's
   * own membership list, never from connection state.
   */
  autonomousSchedulable: boolean;
  /**
   * True when the operator supplies the routing target by hand
   * (Reddit's subreddit). Drives whether the editor renders a target
   * input and — critically — whether it is allowed to write
   * `metadata.target`.
   */
  requiresOperatorTarget: boolean;
  /**
   * True when the destination's target belongs to the identity rather
   * than the item (Telegram: one identity is one channel / group /
   * supergroup, and the chat id lives on the connection row).
   *
   * The editor MUST NOT write `metadata.target` for these. The
   * scheduler resolves the chat id from
   * `platform_connections.provider_account_id`, but `metadata.target`
   * takes precedence over it (see `resolveSchedulerTarget`), so an
   * editor-written target would silently redirect the message to
   * another chat.
   */
  identityBoundTarget: boolean;
  /** Number of identities the workspace has for this platform. */
  identityCount: number;
  /** Number of those identities with a usable connection. */
  connectedIdentityCount: number;
  /** Calm operator-facing one-liner explaining the current state. */
  hint: string;
}

/**
 * Minimal projections of rows the caller already loads. Kept
 * structural (not tied to repository types) so this module stays
 * pure and testable.
 */
export interface DestinationIdentityInput {
  /** growth_accounts.platform */
  platform: string | null;
}

export interface DestinationConnectionInput {
  /** platform_connections.platform */
  platform: string | null;
  /** platform_connections.connection_status */
  connectionStatus: string | null;
  /** platform_connections.health_status */
  healthStatus?: string | null;
}

export interface ResolveDestinationsInput {
  identities: ReadonlyArray<DestinationIdentityInput>;
  connections: ReadonlyArray<DestinationConnectionInput>;
}

/**
 * A connection counts as usable when the platform reports it
 * connected AND health has not since flipped to expired/revoked.
 *
 * Mirrors the "needs attention" rule /weekly-plan already applies to
 * the same rows, so the editor and the attention strip cannot
 * disagree about whether an identity is usable.
 */
function isUsableConnection(c: DestinationConnectionInput): boolean {
  if (c.connectionStatus !== "connected") return false;
  if (c.healthStatus === "expired" || c.healthStatus === "revoked") {
    return false;
  }
  return true;
}

function hintFor(
  availability: DestinationAvailability,
  label: string,
  identityBoundTarget: boolean,
): string {
  switch (availability) {
    case "connected":
      return identityBoundTarget
        ? `Signal publishes to the connected ${label} target for the selected identity.`
        : `Signal publishes to ${label} through the official API.`;
    case "connection_required":
      return `Connect a ${label} identity on Accounts before Signal can publish here.`;
    case "manual":
      return `Signal prepares the post; you publish it on ${label} and paste the permalink back.`;
    case "unavailable":
      return `Signal has no publishing path for ${label} yet.`;
  }
}

/**
 * Build the destination model for every founder platform.
 *
 * Every legitimate destination is returned — the caller decides
 * ordering and presentation, not membership. Callers must NOT filter
 * out non-autonomous destinations: preparing content for a manual
 * platform is a first-class workflow, and hiding it is what produced
 * the original four-entry list.
 */
export function resolvePublishDestinations(
  input: ResolveDestinationsInput,
): PublishDestination[] {
  const identityCounts = new Map<string, number>();
  for (const identity of input.identities) {
    if (!identity.platform) continue;
    identityCounts.set(
      identity.platform,
      (identityCounts.get(identity.platform) ?? 0) + 1,
    );
  }

  const connectedCounts = new Map<string, number>();
  for (const connection of input.connections) {
    if (!connection.platform) continue;
    if (!isUsableConnection(connection)) continue;
    connectedCounts.set(
      connection.platform,
      (connectedCounts.get(connection.platform) ?? 0) + 1,
    );
  }

  return FOUNDER_PLATFORMS.map((platform) => {
    const guidance = resolveIdentityPlatformGuidance(platform);
    const label = guidance?.label ?? platform;
    const short = guidance?.short ?? platform.slice(0, 2);

    // Capability truth is the ONLY input to the autonomy claim.
    const autonomousSchedulable = isAutonomouslySchedulable(platform);
    const identityCount = identityCounts.get(platform) ?? 0;
    const connectedIdentityCount = connectedCounts.get(platform) ?? 0;

    // `publishingMode === "api"` is the editorial claim; capability
    // truth is the executable one. When they disagree, capability
    // truth wins — an editorial "api" label with no real publisher
    // would be exactly the false claim P0.3 removed.
    const mode: DestinationMode =
      autonomousSchedulable && guidance?.publishingMode === "api"
        ? "api"
        : "manual";

    // `unavailable` is reserved for a platform the editorial registry
    // itself declares to have no publishing path
    // (`publishingMode: "not_implemented"`). No platform is in that
    // state today, so this branch is currently unoccupied rather than
    // dead: it is keyed on real data and is the correct answer the
    // moment a platform is marked that way. Do not collapse it into
    // "manual" — telling an operator to publish by hand on a platform
    // Signal cannot even shape content for would be a worse lie than
    // saying nothing.
    const availability: DestinationAvailability =
      guidance?.publishingMode === "not_implemented"
        ? "unavailable"
        : mode === "api"
          ? connectedIdentityCount > 0
            ? "connected"
            : "connection_required"
          : "manual";

    const requiresOperatorTarget = platform === "reddit";
    const identityBoundTarget = platform === "telegram";

    return {
      platform,
      label,
      short,
      mode,
      availability,
      autonomousSchedulable,
      requiresOperatorTarget,
      identityBoundTarget,
      identityCount,
      connectedIdentityCount,
      hint: hintFor(availability, label, identityBoundTarget),
    };
  });
}

/**
 * Look up a single destination by platform slug. Returns null for
 * values that are not founder platforms (legacy rows, typos, or a
 * platform removed from the registry) so callers can fall back to
 * neutral copy instead of inventing capability.
 */
export function resolvePublishDestination(
  platform: string | null | undefined,
  input: ResolveDestinationsInput,
): PublishDestination | null {
  if (!platform) return null;
  return (
    resolvePublishDestinations(input).find((d) => d.platform === platform) ??
    null
  );
}

/**
 * True when the editor may persist an operator-typed routing target
 * (`metadata.target`) for this platform.
 *
 * This exists because `metadata.target` is read by
 * `resolveSchedulerTarget` with the HIGHEST precedence, above the
 * identity's own `provider_account_id`. Writing it for a
 * identity-bound platform does not "add a hint" — it overrides the
 * identity's real target. For Telegram that means publishing into a
 * different chat than the one the operator connected.
 *
 * Only Reddit takes an operator-typed target today.
 */
export function allowsOperatorTarget(
  platform: string | null | undefined,
): boolean {
  return platform === "reddit";
}

/**
 * True when Signal may create a scheduled execution item for this
 * destination — i.e. when the scheduler can actually publish it.
 *
 * Server actions gate on this so a manual destination cannot be walked
 * into the autonomous path. Without the gate the sequence is: approve
 * succeeds, `createExecutionItem` succeeds, the row walks to
 * `scheduled`, the tick refuses at the autonomy allowlist with
 * `platform_not_supported`, the plan item mirrors to `paused`, and the
 * paused footer offers "Schedule retry" — which mints a FRESH execution
 * item (the retry firewall rightly permits it: nothing was published)
 * and returns to the same refusal. An unbounded loop of blocked rows
 * with no operator exit.
 *
 * Thin wrapper over `isAutonomouslySchedulable` so call sites read as
 * the product rule they are enforcing rather than as a set lookup.
 */
export function isAutonomousDestination(
  platform: string | null | undefined,
): boolean {
  if (!platform) return false;
  return isAutonomouslySchedulable(platform);
}

/**
 * Operator-facing refusal for scheduling a destination the scheduler
 * cannot drive. Returns null when scheduling is allowed, so callers can
 * use it directly as a blocker value.
 */
export function autonomousSchedulingBlocker(
  platform: string | null | undefined,
): string | null {
  if (isAutonomousDestination(platform)) return null;
  if (!platform) {
    return "Pick a destination before scheduling this post.";
  }
  const guidance = resolveIdentityPlatformGuidance(platform);
  const label = guidance?.label ?? platform;
  return (
    `Signal does not publish to ${label} automatically. ` +
    `Approve and hold this post, then publish it on ${label} yourself. ` +
    `Scheduling it would create a queued item the publisher will refuse.`
  );
}
