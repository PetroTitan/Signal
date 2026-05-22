# Platform capability matrix

The capability matrix says, plainly, what each platform's connection will be able to do when official OAuth ships. Today, none of these are wired.

Source: [src/core/platform-connections/platform-capabilities.ts](../../src/core/platform-connections/platform-capabilities.ts).

## Reading the matrix

- **available** — works today (only `draft_only` is "available" — drafts are pure local computation, no API needed).
- **planned** — will ship in an early phase.
- **future** — explicit scope of future work.
- **limited** — platform policy or API access restricts what's possible.
- **unavailable** — not on Signal's roadmap.

## Reddit

| Capability | State | Note |
|---|---|---|
| Read profile | planned | |
| Draft assistance | available | Local computation; no API required. |
| Publish a post | future | |
| Publish a comment | future | |
| Schedule a post | future | |
| Read metrics | limited | Reddit's API is restrictive. |
| Read mentions | future | |

## X

| Capability | State | Note |
|---|---|---|
| Read profile | planned | |
| Draft assistance | available | |
| Publish a post | future | |
| Publish a comment | future | |
| Schedule a post | future | |
| Read metrics | future | Depends on API access tier. |
| Read mentions | future | |

## LinkedIn

| Capability | State | Note |
|---|---|---|
| Read profile | planned | |
| Draft assistance | available | |
| Publish a post | limited | |
| Publish a comment | limited | |
| Schedule a post | future | |
| Read metrics | future | |
| Read mentions | future | |

## Google visibility

| Capability | State | Note |
|---|---|---|
| Read metrics | future | Requires official Search Console API access. |

Google is a search & discoverability surface, not a publishing surface. The capability set is intentionally narrow.

## Voice rules

- Always describe state in plain language. "Future." "Planned." "Limited." Not "will be available in Q4."
- Never imply support that doesn't exist.
- When a capability is `limited`, name the reason briefly.

## What this matrix never says

- That Signal can do something it can't.
- That Signal will compete with native platform tooling.
- That metrics will be exhaustive — they will reflect what the platform's API allows, no more.
