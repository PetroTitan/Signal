"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import {
  GEO_MODE_DESCRIPTIONS,
  GEO_MODE_LABELS,
  GEO_MODES,
  PROXY_PROTOCOL_LABELS,
  REGION_LABELS,
  SUPPORTED_PROXY_PROTOCOLS,
  SUPPORTED_REGIONS,
  type GeoMode,
  type ProxyProtocol,
  type SupportedRegion,
} from "@/types/geo";
import {
  MOCK_WORKSPACE_REGION,
  REGION_METADATA,
  REGION_POLICY_PRINCIPLES,
  cadenceProfileFor,
  defaultLanguageForRegion,
  defaultTimezoneForRegion,
  defaultWindowsForRegion,
  scoreRegionConsistency,
  validateWorkspaceRegion,
} from "@/core/geo";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface ProxyFormState {
  label: string;
  region: SupportedRegion;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
}

const EMPTY_PROXY: ProxyFormState = {
  label: "",
  region: "us_east",
  protocol: "https",
  host: "",
  port: "",
  username: "",
  password: "",
};

export default function NetworkSettingsPage() {
  const [region, setRegion] = useState<SupportedRegion>(
    MOCK_WORKSPACE_REGION.workspaceRegion,
  );
  const [timezone, setTimezone] = useState(MOCK_WORKSPACE_REGION.timezone);
  const [language, setLanguage] = useState(MOCK_WORKSPACE_REGION.primaryLanguage);
  const [geoMode, setGeoMode] = useState<GeoMode>(MOCK_WORKSPACE_REGION.geoMode);
  const [publishingRegion, setPublishingRegion] = useState<SupportedRegion>(
    MOCK_WORKSPACE_REGION.publishingRegion,
  );
  const [routingEnabled, setRoutingEnabled] = useState(
    MOCK_WORKSPACE_REGION.regionalRoutingEnabled,
  );
  const [proxy, setProxy] = useState<ProxyFormState>(EMPTY_PROXY);

  const config = useMemo(
    () => ({
      ...MOCK_WORKSPACE_REGION,
      workspaceRegion: region,
      timezone,
      primaryLanguage: language,
      publishingRegion,
      geoMode,
      regionalRoutingEnabled: routingEnabled,
      networkProfileId: null,
      preferredPublishingWindows: defaultWindowsForRegion(region),
    }),
    [region, timezone, language, geoMode, publishingRegion, routingEnabled],
  );

  const validation = useMemo(() => validateWorkspaceRegion(config), [config]);
  const consistency = useMemo(
    () =>
      scoreRegionConsistency({
        workspaceRegion: config,
        networkProfile: null,
        recentHistory: [],
      }),
    [config],
  );
  const cadence = cadenceProfileFor(region);

  function applyRegionDefaults(next: SupportedRegion) {
    setRegion(next);
    setTimezone(defaultTimezoneForRegion(next));
    setLanguage(defaultLanguageForRegion(next));
    if (geoMode === "local_only") setPublishingRegion(next);
  }

  return (
    <>
      <Topbar
        title="Region & network"
        description="Workspace-level operational region. Configure once."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <p className="text-xs text-ink-500 leading-relaxed">
          Signal operates as a stable regional identity. This is not anti-detect
          tooling. Routing is workspace-level and never bypasses approval,
          cadence, or risk checks.{" "}
          <Link href="/settings" className="underline">
            Back to settings
          </Link>
          .
        </p>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Workspace region
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Pick the region your business operates from. Stable identity matters
            more than rotation.
          </p>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Operational region">
              <select
                value={region}
                onChange={(e) =>
                  applyRegionDefaults(e.target.value as SupportedRegion)
                }
                className="input w-full"
              >
                {SUPPORTED_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {REGION_LABELS[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Timezone">
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="input w-full font-mono text-xs"
              />
              <div className="text-[11px] text-ink-500 mt-1">
                Region default: {REGION_METADATA[region].defaultTimezone}
              </div>
            </Field>
            <Field label="Primary language">
              <input
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="input w-full font-mono text-xs"
              />
              <div className="text-[11px] text-ink-500 mt-1">
                Region default: {REGION_METADATA[region].defaultLanguage}
              </div>
            </Field>
            <Field label="Geo mode">
              <select
                value={geoMode}
                onChange={(e) => setGeoMode(e.target.value as GeoMode)}
                className="input w-full"
              >
                {GEO_MODES.map((m) => (
                  <option key={m} value={m}>
                    {GEO_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
              <div className="text-[11px] text-ink-500 mt-1 leading-relaxed">
                {GEO_MODE_DESCRIPTIONS[geoMode]}
              </div>
            </Field>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Publishing windows
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Calm regional windows. Approved items distribute within these hours.
            Nothing publishes automatically.
          </p>
          <ul className="mt-4 space-y-2">
            {config.preferredPublishingWindows.map((w, i) => (
              <li
                key={`${w.label}-${i}`}
                className="rounded-md border border-ink-100 p-3 flex items-start justify-between gap-3"
              >
                <div>
                  <div className="text-sm font-medium text-ink-900">
                    {w.label}
                  </div>
                  <div className="text-[11px] text-ink-500 mt-0.5">
                    {w.daysOfWeek.map((d) => DAY_LABELS[d]).join(" · ")}
                  </div>
                </div>
                <div className="text-xs text-ink-700 font-mono shrink-0">
                  {String(w.startHourLocal).padStart(2, "0")}:00 –{" "}
                  {String(w.endHourLocal).padStart(2, "0")}:00
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Regional routing
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Optional. Workspace-level outbound network profile for regional
            publishing. No rotation, no pools. One stable profile.
          </p>
          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-sm text-ink-800">
              {routingEnabled ? "Routing enabled" : "Routing disabled"}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={routingEnabled}
              onClick={() => setRoutingEnabled((v) => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                routingEnabled ? "bg-signal-600" : "bg-ink-200"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  routingEnabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
          {geoMode === "international_operations" ? (
            <div className="mt-3 flex items-center gap-3">
              <Field label="Publishing region">
                <select
                  value={publishingRegion}
                  onChange={(e) =>
                    setPublishingRegion(e.target.value as SupportedRegion)
                  }
                  className="input w-full"
                >
                  {SUPPORTED_REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {REGION_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Outbound network profile (optional)
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Use only if your business operates from a different network than
            this device. Credentials are encrypted server-side and never reach
            the browser.
          </p>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Label">
              <input
                type="text"
                value={proxy.label}
                onChange={(e) => setProxy({ ...proxy, label: e.target.value })}
                placeholder="US East publishing route"
                className="input w-full"
              />
            </Field>
            <Field label="Protocol">
              <select
                value={proxy.protocol}
                onChange={(e) =>
                  setProxy({ ...proxy, protocol: e.target.value as ProxyProtocol })
                }
                className="input w-full"
              >
                {SUPPORTED_PROXY_PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {PROXY_PROTOCOL_LABELS[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Host">
              <input
                type="text"
                value={proxy.host}
                onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                placeholder="proxy.example.com"
                className="input w-full font-mono text-xs"
              />
            </Field>
            <Field label="Port">
              <input
                type="number"
                value={proxy.port}
                onChange={(e) => setProxy({ ...proxy, port: e.target.value })}
                placeholder="8443"
                className="input w-full font-mono text-xs"
              />
            </Field>
            <Field label="Username (optional)">
              <input
                type="text"
                value={proxy.username}
                onChange={(e) =>
                  setProxy({ ...proxy, username: e.target.value })
                }
                className="input w-full font-mono text-xs"
                autoComplete="off"
              />
            </Field>
            <Field label="Password (optional)">
              <input
                type="password"
                value={proxy.password}
                onChange={(e) =>
                  setProxy({ ...proxy, password: e.target.value })
                }
                className="input w-full font-mono text-xs"
                autoComplete="new-password"
              />
              <div className="text-[11px] text-ink-500 mt-1">
                Encrypted server-side. The browser never sees a stored value.
              </div>
            </Field>
          </div>
          <div className="mt-4 text-[11px] text-ink-500 leading-relaxed">
            Saving an outbound profile is not enabled in this preview. The form
            is here so the model and the validation rules are visible. Pending
            server-side integration.
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Region consistency
          </h2>
          <div className="mt-1 text-xs text-ink-500">
            Deterministic score. {consistency.summary} ·{" "}
            <span className="font-mono">{Math.round(consistency.score * 100)}%</span>
          </div>
          <ul className="mt-3 space-y-1 text-xs">
            {consistency.reasons.map((r) => (
              <li key={r.signal} className="flex items-start gap-2">
                <span
                  className={`mt-0.5 inline-block h-2 w-2 rounded-full shrink-0 ${
                    r.ok ? "bg-emerald-500" : "bg-amber-500"
                  }`}
                />
                <span className="text-ink-700">{r.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Regional cadence guidance
          </h2>
          <div className="text-xs text-ink-500 mt-1">
            Subtle hints applied during platform adaptation.
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <HintGroup title="Tone" items={cadence.toneHints} />
            <HintGroup title="Pacing" items={cadence.pacingHints} />
            <HintGroup
              title="Discoverability"
              items={cadence.discoverabilityHints}
            />
          </div>
        </section>

        {validation.issues.length > 0 ? (
          <section className="card p-5 border-amber-200 bg-amber-50/40">
            <h2 className="text-sm font-semibold text-ink-900">
              Configuration notes
            </h2>
            <ul className="mt-2 space-y-1 text-xs text-ink-700">
              {validation.issues.map((i, idx) => (
                <li key={`${i.code}-${idx}`}>· {i.message}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="card p-5 text-xs text-ink-600 leading-relaxed">
          <div className="font-semibold text-ink-900 mb-2">Operating principles</div>
          <ul className="space-y-1">
            {REGION_POLICY_PRINCIPLES.map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}

function HintGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
        {title}
      </div>
      <ul className="space-y-0.5 text-ink-700">
        {items.map((it) => (
          <li key={it}>· {it}</li>
        ))}
      </ul>
    </div>
  );
}
