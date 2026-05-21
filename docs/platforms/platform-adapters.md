# Platform adapters

Signal treats each target platform as an adapter that exposes:

- A name and short label.
- OAuth availability.
- Cadence guidance: minimum hours between posts, suggested posts per week, maximum posts per week.
- A promotional tone allowance: `very_low`, `low`, `medium`.
- Operating notes used when surfacing recommendations.

## Reddit

- OAuth available: yes
- Minimum hours between posts: 36
- Suggested posts per week: 2
- Promotional tone allowance: very low
- Notes: comment-first cadence. Top-of-funnel posts only after sustained karma. Avoid repeated outbound links from the same account.

## X

- OAuth available: yes
- Minimum hours between posts: 6
- Suggested posts per week: 7
- Promotional tone allowance: low
- Notes: replies count as native presence. Pinned thread per product. Stagger promotional content across the week.

## LinkedIn

- OAuth available: yes
- Minimum hours between posts: 24
- Suggested posts per week: 3
- Promotional tone allowance: medium
- Notes: comments on industry posts are first-class presence. Personal posts outperform company-page posts.

## Adapter contract

Adapters in the future will implement a small interface:

```ts
interface PlatformAdapter {
  id: PlatformId;
  authorize(): Promise<OauthResult>;
  publish(post: ScheduledPost): Promise<PublishResult>;
  fetchEngagement(postExternalId: string): Promise<EngagementSnapshot>;
}
```

Each adapter is responsible for native cadence guidance, native tone constraints, and the OAuth handshake. Signal core remains platform-agnostic.

## What adapters never do

- Sign in with username and password.
- Use anti-detect browsers or fingerprint randomization.
- Route through proxies to obscure origin.
- Multi-account by impersonation.

Every adapter uses the platform's official authorization flow. No exceptions.
