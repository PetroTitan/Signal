// Vitest runs in Node, not in a Next.js server context. The real
// `server-only` package throws on import to prevent client bundles from
// pulling server code. Tests legitimately need to import server modules
// directly, so we alias the package to this empty shim.
export {};
