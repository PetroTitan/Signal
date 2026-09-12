import type { MetadataRoute } from "next";

/**
 * Web app manifest.
 *
 * A framework-native metadata file rather than a hand-maintained
 * `manifest.json` in `public/`: the route is generated, so the name and
 * theme colour cannot drift from the values used everywhere else, and
 * there is no stale filename to cache-bust.
 *
 * The icons are the brand mark with a transparent background. `any`
 * rather than `maskable`, deliberately: a maskable icon is cropped to
 * the platform's shape, and the S's caps reach the edges of its box —
 * they would be clipped. The Apple touch icon is the one that gets a
 * tile, and it carries its own navy background.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Signal — Sustainable growth operations",
    short_name: "Signal",
    description:
      "Signal is an AI-assisted growth operations platform for founders and SaaS teams. Weekly planning, single approval gate, calm cadence.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#FFFFFF",
    // Deep navy: the browser chrome tint on Android, and the colour the
    // Apple touch icon is built on.
    theme_color: "#0A2360",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
