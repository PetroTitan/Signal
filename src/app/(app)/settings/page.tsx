import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { workspace, products, accounts } from "@/lib/mock";
import { LockIcon } from "@/components/icons";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <Topbar
        title="Settings"
        description="Workspace identity, philosophy, and operating principles."
      />

      <div className="px-6 lg:px-8 py-6 max-w-3xl space-y-6">
        <section className="card">
          <Header title="Workspace" />
          <div className="px-5 py-4 space-y-2 text-sm">
            <Row label="Name" value={workspace.name} />
            <Row label="Owner" value={workspace.ownerName} />
            <Row label="Owner email" value={workspace.ownerEmail} />
            <Row
              label="Created"
              value={new Date(workspace.createdAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            />
          </div>
        </section>

        <section className="card">
          <Header title="Philosophy" />
          <div className="px-5 py-4 text-sm text-ink-800 leading-relaxed">
            {workspace.philosophy}
          </div>
        </section>

        <section className="card">
          <Header
            title="What Signal is not"
            hint="Operating principles, surfaced where you can see them."
          />
          <ul className="px-5 py-4 text-sm text-ink-800 space-y-1.5">
            <li>· Signal is not a spam bot.</li>
            <li>· Signal is not an anti-detect browser.</li>
            <li>· Signal is not an account farm manager.</li>
            <li>· Signal is not a proxy or fingerprint system.</li>
            <li>· Signal is not a mass automation tool.</li>
            <li>· Signal is not a password manager.</li>
          </ul>
        </section>

        <section className="card">
          <Header title="OAuth and credentials" />
          <div className="px-5 py-4 flex items-start gap-3 text-sm">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-ink-100 text-ink-700 shrink-0">
              <LockIcon />
            </span>
            <div>
              <div className="font-semibold text-ink-900">
                Connect accounts only via official OAuth.
              </div>
              <p className="text-ink-700 mt-0.5 leading-relaxed">
                Signal does not request, store, or transmit passwords. Platform
                OAuth integrations are not yet enabled; when they ship, every
                connection happens through the platform&apos;s own authorization
                flow.
              </p>
            </div>
          </div>
        </section>

        <section className="card">
          <Header title="Footprint" />
          <div className="px-5 py-4 text-sm text-ink-800 space-y-1">
            <div>{products.length} products configured</div>
            <div>{accounts.length} accounts defined</div>
          </div>
        </section>
      </div>
    </>
  );
}

function Header({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-5 py-3.5 border-b border-ink-100">
      <div className="text-sm font-semibold text-ink-900">{title}</div>
      {hint ? <div className="text-xs text-ink-500 mt-0.5">{hint}</div> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <span className="text-ink-500">{label}</span>
      <span className="text-ink-900 font-medium">{value}</span>
    </div>
  );
}
