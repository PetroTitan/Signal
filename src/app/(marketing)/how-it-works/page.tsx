import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Signal turns founder insights into platform-native opportunities, batches them into one weekly approval, and distributes them across the week with calm cadence.",
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    title: "How Signal works",
    description:
      "The operating loop: source insights → platform-native opportunities → weekly approval → staggered schedule → discoverability loop.",
    type: "article",
  },
};

interface Stage {
  number: number;
  title: string;
  description: string;
}

const stages: Stage[] = [
  {
    number: 1,
    title: "Configure product profiles",
    description:
      "Voice, target audience, CTA policy, forbidden claims, and risk tolerance for each product in the portfolio.",
  },
  {
    number: 2,
    title: "Set up accounts manually",
    description:
      "A guided wizard prepares a setup kit, a 14-day warm-up plan, and a manual checklist. Signal never creates accounts or asks for credentials.",
  },
  {
    number: 3,
    title: "Add source insights",
    description:
      "Founder observations, product lessons, support patterns. Signal turns insights into platform-native opportunities — never AI-generated prompts.",
  },
  {
    number: 4,
    title: "Generate platform-native opportunities",
    description:
      "Reddit, X, and LinkedIn adapters transform each insight into format-appropriate drafts. Google produces discoverability opportunities instead.",
  },
  {
    number: 5,
    title: "Evaluate discussions",
    description:
      "Signal scores discussion threads for community fit, audience match, and noise — and recommends participate, watch, or skip.",
  },
  {
    number: 6,
    title: "Score risk deterministically",
    description:
      "Every draft and comment is scored against a deterministic risk model. Aggressive CTAs, launch language, and fake certainty are blocked at the door.",
  },
  {
    number: 7,
    title: "Approve once a week",
    description:
      "One calm review pass. Approve, soften, delay, remove links, convert to comment, save to backlog. Bulk approve all low-risk items in one click.",
  },
  {
    number: 8,
    title: "Distribute across the week",
    description:
      "The scheduler respects platform cadence and per-account cooldown. Items that exceed safe capacity move to the backlog automatically.",
  },
  {
    number: 9,
    title: "Watch the discoverability loop",
    description:
      "Search-to-social, social-to-search, refresh windows, internal linking, evergreen distribution. Discoverability is its own surface, not a posting feed.",
  },
];

export default function HowItWorksPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-semibold text-ink-900 leading-tight">
        How Signal works
      </h1>
      <p className="text-base text-ink-700 mt-3 leading-relaxed">
        One operating loop. Nine stages. Every stage is deterministic today —
        when external APIs ship, they slot in behind the existing types.
      </p>

      <ol className="mt-10 space-y-4">
        {stages.map((stage) => (
          <li key={stage.number} className="card p-5 flex items-start gap-4">
            <div className="shrink-0">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-ink-900 text-white text-sm font-semibold">
                {stage.number}
              </div>
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink-900">{stage.title}</h2>
              <p className="text-sm text-ink-700 mt-1 leading-relaxed">
                {stage.description}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <section className="mt-10 card-padded">
        <h2 className="text-lg font-semibold text-ink-900">
          What this is not
        </h2>
        <ul className="text-sm text-ink-700 mt-2 space-y-1 leading-relaxed">
          <li>· Not an auto-publisher.</li>
          <li>· Not an auto-commenter.</li>
          <li>· Not an indexing API or auto-indexer.</li>
          <li>· Not a feed of AI-generated posts.</li>
          <li>· Not a vendor of fake analytics — when the data isn&apos;t connected, Signal says so.</li>
        </ul>
      </section>

      <div className="mt-10 flex flex-wrap gap-2 text-sm">
        <Link href="/philosophy" className="btn">
          Philosophy
        </Link>
        <Link href="/security" className="btn">
          Security
        </Link>
        <Link href="/dashboard" className="btn-primary">
          Open the app
        </Link>
      </div>
    </div>
  );
}
