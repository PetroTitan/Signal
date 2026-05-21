# OAuth-first principle

Signal's account model is OAuth-first. There is no other path.

## What Signal will do

- Generate setup kits and warm-up plans.
- Track readiness and a manual checklist.
- Show the founder which steps are done and which are next.
- When platform OAuth integrations ship, connect through the official authorization flow.

## What Signal will never do

- Ask for or store a platform password.
- Accept cookies, session tokens, or any browser-exported credential.
- Ask for a 2FA code, a recovery code, or a backup phrase.
- Sign in on the founder's behalf using an anti-detect browser.
- Route requests through proxies or apply fingerprint randomization.
- Manage farms of synthetic accounts.

These are not pragmatic positions to be revisited. They define what Signal is.

## Why

Anti-detect tooling and credential-storing automation are the fastest way to get a founder's account permanently locked. They also produce growth that doesn't compound: every burst lives one platform-policy-change away from being deleted. Signal's promise is sustainable presence. The OAuth-first principle is the floor that makes that promise possible.

## How this looks in the UI

- The accounts list shows a calm OAuth notice.
- The wizard's first screen states the principle.
- Each account detail page repeats the principle near its OAuth card.
- The settings page surfaces the principle under "OAuth and credentials".

The "Connect via OAuth" button is always present but always disabled with a clear hint until the platform integration is actually wired. There is no fallback path.

## Future integrations

When official OAuth integrations are added (Reddit, X, LinkedIn), the wiring will happen behind a `PlatformAdapter` interface. See [docs/platforms/platform-adapters.md](./platform-adapters.md). The UI changes will be limited to enabling the existing button and rendering the OAuth scope confirmations.
