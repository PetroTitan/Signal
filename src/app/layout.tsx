import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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
