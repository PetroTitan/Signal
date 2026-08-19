export * from "./account-health-policy";
export * from "./cadence-safety";
export * from "./link-suppression";
// cross-platform-drift was REMOVED in the social-trust milestone. It had
// zero callers, a third divergent Jaccard implementation, an ASCII-only
// tokenizer that silently deleted non-Latin text, and a `platform` type
// (PlatformId = reddit | x | linkedin) that could not express Bluesky —
// the platform pair it was nominally for. Cross-platform similarity now
// lives in src/core/intelligence/, built on the one canonical primitive
// in publishing-qa/near-duplicate.ts.
export * from "./silence-policy";
