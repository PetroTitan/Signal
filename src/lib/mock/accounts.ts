import { buildSetupKit } from "@/core/onboarding/kits";
import type {
  AccountRole,
  AccountStatus,
  ChecklistItem,
  GrowthAccount,
  PlatformId,
} from "@/types";
import { productsById } from "./products";

interface SeedAccount {
  id: string;
  platform: PlatformId;
  productId: string;
  role: AccountRole;
  handle: string | null;
  displayName: string;
  status: AccountStatus;
  oauthConnected: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  checklistOverrides?: Partial<Record<string, boolean>>;
}

const seeds: SeedAccount[] = [
  {
    id: "acc_petro_x_founder",
    platform: "x",
    productId: "prod_helperg",
    role: "founder",
    handle: "@petro_helperg",
    displayName: "Petro · HELPERG",
    status: "active",
    oauthConnected: false,
    createdAt: "2025-09-04T10:12:00.000Z",
    lastActivityAt: "2026-05-20T16:42:00.000Z",
    checklistOverrides: {
      manual_account_created: true,
      email_verified: true,
      "2fa_enabled": true,
      profile_completed: true,
      first_warmup_planned: true,
      ready_for_planning: true,
    },
  },
  {
    id: "acc_petro_linkedin_founder",
    platform: "linkedin",
    productId: "prod_helperg",
    role: "founder",
    handle: "petro-helperg",
    displayName: "Petro — HELPERG",
    status: "active",
    oauthConnected: false,
    createdAt: "2025-09-04T10:12:00.000Z",
    lastActivityAt: "2026-05-19T11:05:00.000Z",
    checklistOverrides: {
      manual_account_created: true,
      email_verified: true,
      "2fa_enabled": true,
      profile_completed: true,
      first_warmup_planned: true,
      ready_for_planning: true,
    },
  },
  {
    id: "acc_wmi_x_product",
    platform: "x",
    productId: "prod_webmasterid",
    role: "product",
    handle: "@webmasterid",
    displayName: "WebmasterID",
    status: "warming",
    oauthConnected: false,
    createdAt: "2026-03-01T09:30:00.000Z",
    lastActivityAt: "2026-05-18T14:00:00.000Z",
    checklistOverrides: {
      manual_account_created: true,
      email_verified: true,
      "2fa_enabled": true,
      profile_completed: true,
      first_warmup_planned: true,
    },
  },
  {
    id: "acc_cw_x_product",
    platform: "x",
    productId: "prod_cash_workspace",
    role: "product",
    handle: "@cashworkspace",
    displayName: "Cash Workspace",
    status: "ready_to_connect",
    oauthConnected: false,
    createdAt: "2026-04-22T13:00:00.000Z",
    lastActivityAt: null,
    checklistOverrides: {
      manual_account_created: true,
      email_verified: true,
      "2fa_enabled": true,
      profile_completed: true,
    },
  },
  {
    id: "acc_wmi_reddit",
    platform: "reddit",
    productId: "prod_webmasterid",
    role: "research",
    handle: null,
    displayName: "WebmasterID · Reddit",
    status: "planned",
    oauthConnected: false,
    createdAt: "2026-04-15T09:00:00.000Z",
    lastActivityAt: null,
  },
];

function applyOverrides(
  baseChecklist: ChecklistItem[],
  overrides?: Partial<Record<string, boolean>>,
): ChecklistItem[] {
  if (!overrides) return baseChecklist;
  return baseChecklist.map((item) =>
    overrides[item.id] === undefined
      ? item
      : { ...item, done: !!overrides[item.id] },
  );
}

function readinessFor(checklist: ChecklistItem[]): number {
  const weights: Record<string, number> = {
    kit_generated: 5,
    manual_account_created: 20,
    email_verified: 10,
    "2fa_enabled": 10,
    profile_completed: 15,
    first_warmup_planned: 10,
    oauth_connected: 15,
    ready_for_planning: 15,
  };
  const max = Object.values(weights).reduce((a, b) => a + b, 0);
  const total = checklist.reduce(
    (sum, item) => sum + (item.done ? (weights[item.id] ?? 5) : 0),
    0,
  );
  return Math.round((total / max) * 100);
}

function build(seed: SeedAccount): GrowthAccount {
  const product = productsById[seed.productId];
  const kit = buildSetupKit({
    platform: seed.platform,
    product,
    role: seed.role,
    existingHandle: seed.handle,
    generatedAt: seed.createdAt,
  });
  const checklist = applyOverrides(kit.checklist, seed.checklistOverrides);
  const setup = { ...kit, checklist };
  return {
    id: seed.id,
    platform: seed.platform,
    productId: seed.productId,
    role: seed.role,
    handle: seed.handle,
    displayName: seed.displayName,
    status: seed.status,
    readinessScore: readinessFor(checklist),
    oauthConnected: seed.oauthConnected,
    setup,
    createdAt: seed.createdAt,
    lastActivityAt: seed.lastActivityAt,
  };
}

export const accounts: GrowthAccount[] = seeds.map(build);

export const accountsById = Object.fromEntries(
  accounts.map((a) => [a.id, a]),
) as Record<string, GrowthAccount>;
