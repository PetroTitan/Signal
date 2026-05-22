import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

const marketingLinks = [
  { href: "/about", label: "About" },
  { href: "/philosophy", label: "Philosophy" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
];

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-ink-50">
      <header className="border-b border-ink-100 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-ink-900"
            aria-label="Signal home"
          >
            <BrandMark size={20} />
            <span className="text-sm font-semibold tracking-tight">Signal</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {marketingLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="px-2.5 py-1.5 rounded-md text-ink-700 hover:bg-ink-50 hover:text-ink-900 transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <Link href="/dashboard" className="btn-primary ml-2">
              Open app
            </Link>
          </nav>
        </div>
      </header>
      <main id="main-content" className="flex-1" tabIndex={-1}>
        {children}
      </main>
      <footer className="border-t border-ink-100 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-6 text-xs text-ink-500 flex flex-wrap items-center justify-between gap-3">
          <div>Signal — sustainable growth operations.</div>
          <div className="flex items-center gap-3">
            <Link href="/about" className="hover:text-ink-700">
              About
            </Link>
            <Link href="/philosophy" className="hover:text-ink-700">
              Philosophy
            </Link>
            <Link href="/how-it-works" className="hover:text-ink-700">
              How it works
            </Link>
            <Link href="/security" className="hover:text-ink-700">
              Security
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
