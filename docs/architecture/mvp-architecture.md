# MVP architecture

Signal's MVP is intentionally narrow: architecture, UI, workflows, and mock data — without any third-party integrations.

## Stack

- Next.js (App Router)
- TypeScript (strict)
- Tailwind CSS
- No database
- No Supabase
- No Stripe
- No real AI APIs
- No platform OAuth integrations

## Source layout

```
src/
├── app/
│   ├── (app)/              # authenticated shell routes
│   │   ├── dashboard/
│   │   ├── products/
│   │   │   └── [slug]/
│   │   ├── accounts/
│   │   │   └── [id]/
│   │   ├── weekly-plan/
│   │   ├── approval-queue/
│   │   ├── scheduler/
│   │   ├── risk-center/
│   │   ├── analytics/
│   │   └── settings/
│   ├── layout.tsx          # html/body, global metadata
│   ├── page.tsx            # root → /dashboard
│   └── globals.css         # Tailwind layer + component primitives
├── components/             # shared UI (sidebar, topbar, badges, icons)
├── lib/
│   ├── format.ts           # date/time helpers
│   └── mock/                # in-memory mock data, the single source of truth for now
└── types/                   # domain models (Workspace, Product, Account, Plan, …)
```

## Domain models

Located in `src/types`:

- `Workspace`
- `Platform`
- `ProductProfile`
- `GrowthAccount`
- `AccountSetupProfile`
- `WeeklyPlan`
- `WeeklyPlanItem`
- `ContentDraft`
- `ApprovalEvent`
- `ScheduledPost`
- `RiskEvent`
- `TrackingLink`
- `PerformanceMetric`

## Mock data

All mock data lives under `src/lib/mock`. There is no persistence layer: data is imported directly into pages. When Supabase is introduced, the mock module is the contract — same shapes, real source.

## Routing convention

The `(app)` route group hosts the authenticated shell (sidebar + topbar). When marketing pages are introduced, they can live outside the group to opt out of the shell.

## Visual system

Tailwind config defines a calm, infrastructure-grade palette: `ink` (neutral slate), `signal` (calm blue), and three risk tones. Component primitives are declared in `globals.css` (`.card`, `.btn`, `.badge`, etc.) to keep page code tight and consistent.

## Future integrations

- **WebmasterID**: outbound link parameters and tracking schema are already shaped; the analytics page surfaces readiness.
- **Supabase**: data layer will replace the `lib/mock` module behind the same domain types.
- **Platform OAuth**: accounts page already communicates the OAuth-first model and exposes disabled connect controls.
