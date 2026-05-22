# Mock-to-database transition

This document plans how Signal moves from the current mock-driven architecture to Supabase persistence without rewrites. **No code is changed today.** This is the strategy.

## The principle

Signal's pure cores (`src/core/scheduler`, `src/core/risk`, `src/core/approval`, `src/core/onboarding`, `src/core/content-intelligence`, `src/core/comment-intelligence`, `src/core/discoverability`, `src/core/activity`, `src/core/search`) **must not know** whether their input came from a mock module or from a Supabase table.

That means: the migration is a wiring change, not a logic change.

## Where the seams already are

Today:

- The store seeds itself from `src/lib/mock/*` at module load.
- The store reducer mutates an in-memory `SignalState`.
- Pure cores consume `SignalState` slices and return derived values.
- Pages read from the store via `useSignal`, `useAccounts`, etc.

The seam to introduce is between the **store** and the **mock data**: insert a thin **repository layer** that the store consumes. The mock module becomes one implementation of the repository; Supabase becomes another.

## Proposed repository interfaces

These are **type-only sketches**, not committed code. They live in `src/core/data/` when introduced.

```ts
// src/core/data/repositories.ts (future)

import type {
  ApprovalEvent,
  BacklogItem,
  ContentAsset,
  DiscussionOpportunity,
  GrowthAccount,
  ProductProfile,
  SourceInsight,
  WeeklyPlan,
  WeeklyPlanItem,
} from "@/types";

export interface ProductRepository {
  listByWorkspace(workspaceId: string): Promise<ProductProfile[]>;
  getById(id: string): Promise<ProductProfile | null>;
  upsert(input: ProductProfile): Promise<ProductProfile>;
  softDelete(id: string): Promise<void>;
}

export interface AccountRepository {
  listByWorkspace(workspaceId: string): Promise<GrowthAccount[]>;
  getById(id: string): Promise<GrowthAccount | null>;
  create(input: Omit<GrowthAccount, "id" | "createdAt">): Promise<GrowthAccount>;
  updateStatus(id: string, status: GrowthAccount["status"]): Promise<void>;
  toggleChecklistItem(id: string, itemId: string, done: boolean): Promise<void>;
  regenerateKit(id: string): Promise<GrowthAccount>;
}

export interface WeeklyPlanRepository {
  getCurrent(workspaceId: string): Promise<WeeklyPlan | null>;
  listItems(planId: string): Promise<WeeklyPlanItem[]>;
  upsertItem(item: WeeklyPlanItem): Promise<WeeklyPlanItem>;
  setItemStatus(itemId: string, status: WeeklyPlanItem["status"]): Promise<void>;
  redistribute(planId: string): Promise<void>;
}

export interface ApprovalRepository {
  logEvent(input: Omit<ApprovalEvent, "id" | "occurredAt">): Promise<ApprovalEvent>;
  listForItem(itemId: string): Promise<ApprovalEvent[]>;
}

export interface BacklogRepository {
  listByWorkspace(workspaceId: string): Promise<BacklogItem[]>;
  moveToBacklog(itemId: string, reason: string): Promise<BacklogItem>;
  restoreToPlan(backlogId: string, planId: string): Promise<WeeklyPlanItem>;
}

export interface ContentIntelligenceRepository {
  listInsights(workspaceId: string): Promise<SourceInsight[]>;
  createInsight(input: Omit<SourceInsight, "id" | "createdAt">): Promise<SourceInsight>;
  archiveInsight(id: string): Promise<void>;
  // opportunities, drafts: persisted only when curated; see migration-phases.md
}

export interface DiscoverabilityRepository {
  listAssets(workspaceId: string): Promise<ContentAsset[]>;
  upsertAsset(input: ContentAsset): Promise<ContentAsset>;
  archiveAsset(id: string): Promise<void>;
}

export interface DiscussionRepository {
  listOpportunities(workspaceId: string): Promise<DiscussionOpportunity[]>;
  saveOpportunity(input: DiscussionOpportunity): Promise<DiscussionOpportunity>;
}

export interface ActivityRepository {
  listRecent(workspaceId: string, limit?: number): Promise<ActivityEvent[]>;
  // Inserts happen server-side only.
}
```

Every method is `async` even when the mock implementation is sync — making the contract uniform up-front means the migration day is a config swap.

## The two implementations

### `MockRepository` (today's behavior, wrapped)

A small adapter that returns `Promise.resolve(...)` over the current `src/lib/mock/*` modules and the store's in-memory mutations. The MockRepository is the path Signal will keep using until Phase 10A lands.

### `SupabaseRepository`

One repository per file (`src/core/data/supabase/product-repository.ts`, etc.). Each calls Supabase JS, scoped by `workspace_id`. No business logic — only translation between row shape and TypeScript type.

## Where repositories are injected

The store provider takes the repositories as part of its seed:

```ts
// Sketch only.
<SignalProvider repositories={makeMockRepositories()}>{children}</SignalProvider>
```

A small `SIGNAL_DATA_SOURCE` env var (`'mock'` / `'supabase'`) chooses the factory. Pages and engines never know the difference.

## Reducer responsibilities

The reducer stays exactly as it is today. Mutations remain synchronous against the in-memory state. The repository is invoked separately by an effect or a server action when persistence is required.

In other words, the reducer doesn't get awaited. The repository writes happen alongside, and the store optimistically updates. On failure, the action is rolled back and an error surfaces.

This split keeps the existing UI snappy and the engines pure.

## Migration order

1. **Introduce the repository interfaces.** Type-only.
2. **Ship MockRepository.** Behavior-identical to today.
3. **Wire `SignalProvider` to consume the repositories.** Still mock data.
4. **Add the Supabase client + auth scaffolding** (in a small dedicated PR).
5. **Add `SupabaseRepository` for Phase 10A tables.** Behind the env var.
6. **Run side-by-side in dev.** Compare mock vs Supabase results for the same actions.
7. **Flip the dev environment to Supabase.** Mock remains available for tests.
8. **Roll forward through Phases B, C, D, E, F.**

Each phase adds repository methods, never replaces the contract.

## Tests stay valuable

The mock data continues to power tests as fixtures. The repository interface lets every page render in tests against `MockRepository` even after production runs on Supabase.

Engines (scheduler, risk, approval, content intelligence, comment intelligence, discoverability) stay pure: they take typed inputs and return typed outputs. They never know about the repositories.

## What this transition never does

- **Never** lets UI components call Supabase directly. All access goes through the repository layer.
- **Never** lets a page break because of a network error. Repository failures surface as toasts or banners; the cached store state remains.
- **Never** removes the mock module. It stays as the default test fixture indefinitely.
- **Never** changes engine signatures. The contract `(insight, product, others) → opportunities` is the contract — forever.

## Why this works

- The state-readiness audit ([state-readiness-audit.md](../architecture/state-readiness-audit.md)) already names the stable entities.
- The engines never read from a global; everything is parameterized.
- The store reducer's action shape is stable across every phase.
- The repository interface is small enough to fit in one file.

When Phase 10A ships, the diff is the size of a single new directory plus a provider seed change. No page is rewritten.
