import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The compose sheet's rendered destination surface.
 *
 * The pure model is covered by publish-destinations.test.ts. This file
 * asserts the thing that actually broke: that the MODAL renders what
 * the model says, rather than a list of its own. A unit test of the
 * resolver would have passed happily throughout the entire period the
 * editor was showing four platforms.
 *
 * Technique follows the existing precedents in this repo
 * (_copy-button.test.ts, _platform-native-preview.test.ts): import the
 * .tsx and render it with `renderToStaticMarkup`. The environment is
 * node with no DOM, so `useEffect` never runs and handlers never fire —
 * which is what makes the output deterministic. `next/navigation` must
 * be mocked because the sheet calls `useRouter()` at the top level.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/weekly-plan",
  useSearchParams: () => new URLSearchParams(),
}));

// Imported after the mock, deliberately — the sheet resolves
// `useRouter` at module scope of the render.
import {
  FounderComposeSheet,
  type FounderComposeSheetDefaults,
  type FounderComposeSheetExistingItem,
} from "./founder-compose-sheet";
import {
  FOUNDER_PLATFORMS,
  resolveIdentityPlatformGuidance,
} from "@/core/publishing/platform-guidance";

function defaults(
  over: Partial<FounderComposeSheetDefaults> = {},
): FounderComposeSheetDefaults {
  return {
    timezoneLabel: "Europe/Kyiv",
    defaultAccountId: null,
    defaultProductId: null,
    defaultSubreddit: "test",
    accounts: [],
    products: [],
    allowedSubreddits: ["test"],
    aiProviderAvailable: false,
    connections: [],
    ...over,
  };
}

function render(
  over: Partial<FounderComposeSheetDefaults> = {},
  existingItem?: FounderComposeSheetExistingItem,
): string {
  return renderToStaticMarkup(
    createElement(FounderComposeSheet, {
      open: true,
      onClose: () => {},
      defaults: defaults(over),
      existingItem,
    }),
  );
}

function existing(
  over: Partial<FounderComposeSheetExistingItem> = {},
): FounderComposeSheetExistingItem {
  return {
    itemId: "item-1",
    status: "draft",
    title: null,
    body: "A body.",
    platform: "bluesky",
    contentType: "post",
    platformPublishIntent: null,
    subreddit: null,
    accountId: null,
    productId: null,
    scheduledAtIso: null,
    riskScore: 20,
    notes: null,
    creative: null,
    ...over,
  };
}

describe("Where — the rendered destination selector", () => {
  const html = render();

  it("renders a destination radio group", () => {
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Publishing destination"');
  });

  it("offers every founder platform, not a four-platform subset", () => {
    // The regression: reddit / dev.to / Hashnode / Bluesky were the
    // only options, hardcoded in the component.
    //
    // Asserted against each platform's registry LABEL rather than a
    // list written here, so this cannot become a second copy of the
    // list that drifted. `<span>Label</span>` is the chip's exact
    // label element, which keeps single-character labels like "X" from
    // matching incidental markup.
    const group = html.slice(html.indexOf('role="radiogroup"'));
    for (const platform of FOUNDER_PLATFORMS) {
      const label = resolveIdentityPlatformGuidance(platform)!.label;
      expect(
        group.includes(`<span>${label}</span>`),
        `${platform} ("${label}") missing from the destination selector`,
      ).toBe(true);
    }
  });

  it("offers X and Telegram by name", () => {
    const group = html.slice(html.indexOf('role="radiogroup"'));
    expect(group).toContain("Telegram");
    expect(group).toContain("Indie Hackers");
    expect(group).toContain("LinkedIn");
  });

  it("labels manual destinations as manual, not as API", () => {
    // "Do not imply API publishing when only manual distribution
    // exists." Five manual platforms → five Manual badges.
    const group = html.slice(html.indexOf('role="radiogroup"'));
    expect(group.match(/>Manual</g)?.length).toBe(5);
  });

  it("shows every API destination as needing a connection when none exists", () => {
    const group = html.slice(html.indexOf('role="radiogroup"'));
    // reddit, devto, hashnode, bluesky, telegram, x
    expect(group.match(/>Connect</g)?.length).toBe(6);
    expect(group).not.toContain(">API<");
  });

  it("shows a connected API destination as API", () => {
    const connectedHtml = render({
      accounts: [{ id: "a1", displayName: "@me", platform: "bluesky" }],
      connections: [
        {
          platform: "bluesky",
          connectionStatus: "connected",
          healthStatus: "healthy",
        },
      ],
    });
    const group = connectedHtml.slice(
      connectedHtml.indexOf('role="radiogroup"'),
    );
    expect(group.match(/>API</g)?.length).toBe(1);
  });
});

describe("Where — routing target ownership", () => {
  it("renders the subreddit input for Reddit", () => {
    const html = render({}, existing({ platform: "reddit", subreddit: "test" }));
    expect(html).toContain('aria-label="Subreddit"');
  });

  it("does NOT render a routing-target input for Telegram", () => {
    // The Telegram hijack control at the UI layer: there must be no way
    // to type a target that would land in metadata.target and override
    // the connected chat id.
    const html = render({}, existing({ platform: "telegram" }));
    expect(html).not.toContain('aria-label="Subreddit"');
    expect(html).toMatch(/one identity is one Telegram target/i);
  });

  it("does NOT render a routing-target input for X or Bluesky", () => {
    for (const platform of ["x", "bluesky"]) {
      const html = render({}, existing({ platform }));
      expect(html, platform).not.toContain('aria-label="Subreddit"');
    }
  });
});

describe("Title requirement is destination-scoped in the rendered editor", () => {
  it.each(["x", "bluesky", "telegram", "threads", "instagram"])(
    "%s renders the title as optional",
    (platform) => {
      const html = render({}, existing({ platform }));
      expect(html).toContain("· optional");
      expect(html).not.toMatch(/· required for/);
    },
  );

  it.each(["reddit", "devto", "hashnode"])(
    "%s renders the title as required",
    (platform) => {
      const html = render({}, existing({ platform }));
      expect(html).toMatch(/· required for/);
      expect(html).not.toContain("· optional");
    },
  );

  it("does not block a titleless Bluesky draft from being sent for approval", () => {
    const html = render({}, existing({ platform: "bluesky", title: null }));
    expect(html).toContain("Send for approval");
    expect(html).not.toContain("Add a title before sending for approval.");
  });

  it("still blocks a titleless Reddit draft", () => {
    const html = render({}, existing({ platform: "reddit", title: null }));
    expect(html).toContain("Add a title before sending for approval.");
  });
});

describe("the capability chip row no longer masquerades as a destination picker", () => {
  const html = render();

  it("is labelled as an adaptation affordance", () => {
    expect(html).toContain("Adapt draft for");
    expect(html).not.toContain("Publish destinations");
  });

  it("says explicitly that it does not change the destination", () => {
    expect(html).toMatch(/does not change\s*where this post publishes/i);
  });
});

describe("identity is attached when the destination has exactly one", () => {
  // The production incident: the Bluesky draft had no identity, was
  // approved and scheduled anyway, and died at the scheduler with
  // `account_not_confirmed`. defaultAccountId is Reddit-scoped, so any
  // other destination started empty and nothing ever asked.
  const accounts = [
    { id: "bsky-1", displayName: "@petrohrys.bsky.social", platform: "bluesky" },
    { id: "x-1", displayName: "@PetroHrys", platform: "x" },
    { id: "x-2", displayName: "@second", platform: "x" },
  ];

  it("offers the destination's identity in the picker", () => {
    const html = render(
      { accounts },
      existing({ platform: "bluesky", accountId: "bsky-1" }),
    );
    expect(html).toContain("@petrohrys.bsky.social");
  });

  it("scopes the picker to the destination", () => {
    const html = render(
      { accounts },
      existing({ platform: "bluesky", accountId: "bsky-1" }),
    );
    // The X identities belong to another destination and must not be
    // selectable here — a mismatched pair can only ever produce
    // oauth_not_connected.
    expect(html).not.toContain("@second");
  });

  it("warns when the destination has no identity at all", () => {
    const html = render({ accounts: [] }, existing({ platform: "bluesky" }));
    expect(html).toMatch(/No Bluesky identity yet/i);
  });
});

describe("the sheet renders nothing when closed", () => {
  it("returns empty markup", () => {
    expect(
      renderToStaticMarkup(
        createElement(FounderComposeSheet, {
          open: false,
          onClose: () => {},
          defaults: defaults(),
        }),
      ),
    ).toBe("");
  });
});
