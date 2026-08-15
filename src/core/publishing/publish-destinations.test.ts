import { describe, expect, it } from "vitest";

import {
  allowsOperatorTarget,
  autonomousSchedulingBlocker,
  isAutonomousDestination,
  resolvePublishDestinations,
  type DestinationConnectionInput,
  type DestinationIdentityInput,
} from "./publish-destinations";
import { FOUNDER_PLATFORMS } from "./platform-guidance";
import {
  PLATFORMS_WITH_REAL_PUBLISHER,
  SCHEDULER_AUTONOMOUS_PLATFORMS,
} from "./publish-capability-registry";

/**
 * The editor's destination model.
 *
 * The defect these tests exist to prevent is not "X is missing from a
 * list" — it is a UI surface answering a capability question from its
 * own memory. So the assertions are written against capability truth
 * rather than against a hardcoded expected list wherever possible: a
 * test that says `expect(labels).toEqual(["Reddit", ...])` would be a
 * second copy of the very list that drifted.
 */

function connected(platform: string): DestinationConnectionInput {
  return { platform, connectionStatus: "connected", healthStatus: "healthy" };
}

function identity(platform: string): DestinationIdentityInput {
  return { platform };
}

const EMPTY = { identities: [], connections: [] };

describe("resolvePublishDestinations — membership", () => {
  it("returns every founder platform, not a curated subset", () => {
    const slugs = resolvePublishDestinations(EMPTY).map((d) => d.platform);
    expect(slugs.sort()).toEqual([...FOUNDER_PLATFORMS].sort());
  });

  it("includes X — the destination the four-platform list was missing", () => {
    // X has had a real publisher and scheduler autonomy for some time;
    // the editor could not offer it because capability truth lived
    // behind server-only imports. This is the regression that motivated
    // the milestone.
    const x = resolvePublishDestinations(EMPTY).find((d) => d.platform === "x");
    expect(x).toBeDefined();
    expect(x!.autonomousSchedulable).toBe(true);
  });

  it("includes Telegram", () => {
    const telegram = resolvePublishDestinations(EMPTY).find(
      (d) => d.platform === "telegram",
    );
    expect(telegram).toBeDefined();
    expect(telegram!.autonomousSchedulable).toBe(true);
  });

  it("keeps the four originally-selectable destinations working", () => {
    const byPlatform = new Map(
      resolvePublishDestinations({
        identities: ["reddit", "devto", "hashnode", "bluesky"].map(identity),
        connections: ["reddit", "devto", "hashnode", "bluesky"].map(connected),
      }).map((d) => [d.platform, d]),
    );
    for (const p of ["reddit", "devto", "hashnode", "bluesky"] as const) {
      expect(byPlatform.get(p)?.mode, p).toBe("api");
      expect(byPlatform.get(p)?.availability, p).toBe("connected");
      expect(byPlatform.get(p)?.autonomousSchedulable, p).toBe(true);
    }
  });
});

describe("resolvePublishDestinations — capability invariant", () => {
  it("autonomousSchedulable matches capability truth exactly, for every platform", () => {
    // The load-bearing assertion. If a future edit derives autonomy
    // from connection state, `publishingMode`, or a UI list, this
    // fails for the platform where those disagree.
    for (const d of resolvePublishDestinations({
      // Give every platform an identity AND a connection, so anything
      // that (incorrectly) derived autonomy from connection state would
      // now claim autonomy everywhere.
      identities: FOUNDER_PLATFORMS.map(identity),
      connections: FOUNDER_PLATFORMS.map(connected),
    })) {
      const expected =
        (SCHEDULER_AUTONOMOUS_PLATFORMS as ReadonlySet<string>).has(
          d.platform,
        ) &&
        (PLATFORMS_WITH_REAL_PUBLISHER as ReadonlySet<string>).has(d.platform);
      expect(d.autonomousSchedulable, d.platform).toBe(expected);
    }
  });

  it("a connected identity never makes a manual destination schedulable", () => {
    // linkedin is in the platform_connections CHECK, so a row CAN
    // exist for it. It still has no publisher.
    const linkedin = resolvePublishDestinations({
      identities: [identity("linkedin")],
      connections: [connected("linkedin")],
    }).find((d) => d.platform === "linkedin")!;
    expect(linkedin.autonomousSchedulable).toBe(false);
    expect(linkedin.mode).toBe("manual");
    expect(linkedin.availability).toBe("manual");
  });

  it("manual destinations are visible — visibility is not authorization", () => {
    const manual = resolvePublishDestinations(EMPTY).filter(
      (d) => d.mode === "manual",
    );
    expect(manual.map((d) => d.platform).sort()).toEqual([
      "indie_hackers",
      "instagram",
      "linkedin",
      "threads",
      "youtube",
    ]);
    for (const d of manual) {
      expect(d.autonomousSchedulable, d.platform).toBe(false);
    }
  });
});

describe("resolvePublishDestinations — connection state", () => {
  it("an API destination with no usable connection reads connection_required", () => {
    const bluesky = resolvePublishDestinations({
      identities: [identity("bluesky")],
      connections: [],
    }).find((d) => d.platform === "bluesky")!;
    expect(bluesky.availability).toBe("connection_required");
    expect(bluesky.connectedIdentityCount).toBe(0);
    expect(bluesky.identityCount).toBe(1);
    // Still schedulable in principle — capability is not connection.
    expect(bluesky.autonomousSchedulable).toBe(true);
  });

  it("an expired or revoked connection does not count as connected", () => {
    for (const healthStatus of ["expired", "revoked"]) {
      const d = resolvePublishDestinations({
        identities: [identity("x")],
        connections: [{ platform: "x", connectionStatus: "connected", healthStatus }],
      }).find((d) => d.platform === "x")!;
      expect(d.availability, healthStatus).toBe("connection_required");
    }
  });

  it("a non-connected connection_status does not count as connected", () => {
    for (const status of ["not_connected", "revoked", "expired", null]) {
      const d = resolvePublishDestinations({
        identities: [identity("reddit")],
        connections: [{ platform: "reddit", connectionStatus: status }],
      }).find((d) => d.platform === "reddit")!;
      expect(d.availability, String(status)).toBe("connection_required");
    }
  });

  it("counts identities and usable connections per platform", () => {
    const d = resolvePublishDestinations({
      identities: [identity("telegram"), identity("telegram"), identity("x")],
      connections: [
        connected("telegram"),
        { platform: "telegram", connectionStatus: "expired" },
      ],
    }).find((d) => d.platform === "telegram")!;
    expect(d.identityCount).toBe(2);
    expect(d.connectedIdentityCount).toBe(1);
    expect(d.availability).toBe("connected");
  });
});

describe("routing target ownership", () => {
  it("only Reddit takes an operator-typed target", () => {
    // The Telegram hijack control. `resolveSchedulerTarget` reads
    // execution_items.metadata.target with HIGHER precedence than the
    // connection's provider_account_id, so writing it for Telegram does
    // not add a hint — it redirects the message to another chat.
    expect(allowsOperatorTarget("reddit")).toBe(true);
    for (const p of FOUNDER_PLATFORMS.filter((p) => p !== "reddit")) {
      expect(allowsOperatorTarget(p), p).toBe(false);
    }
    expect(allowsOperatorTarget(null)).toBe(false);
    expect(allowsOperatorTarget(undefined)).toBe(false);
  });

  it("marks Telegram's target as identity-bound", () => {
    const d = resolvePublishDestinations(EMPTY);
    expect(d.find((x) => x.platform === "telegram")!.identityBoundTarget).toBe(
      true,
    );
    expect(d.find((x) => x.platform === "reddit")!.identityBoundTarget).toBe(
      false,
    );
    expect(d.find((x) => x.platform === "reddit")!.requiresOperatorTarget).toBe(
      true,
    );
  });
});

describe("autonomous scheduling gate", () => {
  it("permits exactly the scheduler-autonomous destinations", () => {
    for (const p of FOUNDER_PLATFORMS) {
      const expected =
        (SCHEDULER_AUTONOMOUS_PLATFORMS as ReadonlySet<string>).has(p) &&
        (PLATFORMS_WITH_REAL_PUBLISHER as ReadonlySet<string>).has(p);
      expect(isAutonomousDestination(p), p).toBe(expected);
      expect(autonomousSchedulingBlocker(p) === null, p).toBe(expected);
    }
  });

  it("refuses a missing destination rather than defaulting to allowed", () => {
    expect(isAutonomousDestination(null)).toBe(false);
    expect(isAutonomousDestination("")).toBe(false);
    expect(autonomousSchedulingBlocker(null)).toMatch(/pick a destination/i);
  });

  it("names the platform and the manual path in the refusal", () => {
    const blocker = autonomousSchedulingBlocker("linkedin")!;
    expect(blocker).toContain("LinkedIn");
    expect(blocker).toMatch(/approve and hold/i);
  });

  it("refuses an unknown platform string", () => {
    expect(isAutonomousDestination("myspace")).toBe(false);
  });
});
