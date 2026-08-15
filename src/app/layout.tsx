import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { SITE_URL } from "@/content/academy/seo";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    default: "Signal — Sustainable growth operations",
    template: "%s · Signal",
  },
  description:
    "Signal is an AI-assisted growth operations platform for founders and SaaS teams. Weekly planning, single approval gate, calm cadence.",
  metadataBase: new URL(SITE_URL),
  openGraph: {
    title: "Signal — Sustainable growth operations",
    description:
      "Plan once per week. Approve once per week. Distribute organically.",
    type: "website",
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * `viewportFit: "cover"` is what makes `env(safe-area-inset-*)` resolve
 * to a real value. Three components already used it — the compose
 * footer, the generate-draft sheet footer, and the new-post FAB — and
 * all three were dead code, because without this declaration the built
 * HTML emitted only `width=device-width, initial-scale=1` and the CSS
 * Env spec resolves every inset to 0px.
 *
 * `maximumScale` is deliberately not set: capping zoom is an
 * accessibility regression. The iOS focus-zoom problem is solved by
 * giving form controls a 16px base size (see `.input` in globals.css),
 * not by disabling pinch-zoom.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-ink-50 text-ink-900 antialiased font-sans">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
