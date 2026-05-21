import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Signal — Sustainable growth operations",
    template: "%s · Signal",
  },
  description:
    "Signal is an AI-assisted growth operations platform for founders and SaaS teams. Weekly planning, single approval gate, calm cadence.",
  metadataBase: new URL("https://signal.helperg.com"),
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-50 text-ink-900 antialiased">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
