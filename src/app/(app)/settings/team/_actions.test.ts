import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase F10 — /settings/team server action tests.
 *
 * Focuses on the OWNER-INVARIANT GUARDS and the outcome-shape contract
 * the UI depends on:
 *
 *   - non-owner caller → permission_denied (no DB write)
 *   - email lookup returns null → must_sign_up (no DB write)
 *   - target user already a member → already_member (no DB write)
 *   - owner adds existing user → ok + addWorkspaceMember called
 *   - owner removes a non-owner member → ok
 *   - owner removes the last owner (themselves) → cannot_remove_self_last_owner
 *   - owner removes the last owner (someone else) → cannot_remove_last_owner
 *   - removal does NOT delete auth.users (we only call
 *     removeWorkspaceMember; no admin.deleteUser call is wired up at
 *     all)
 *
 * Repository + auth-lookup modules are mocked; the action's job is to
 * compose them safely.
 */

const hoisted = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  getPrimaryWorkspaceMock: vi.fn(),
  isCallerWorkspaceOwnerMock: vi.fn(),
  isWorkspaceMemberMock: vi.fn(),
  listWorkspaceMembersMock: vi.fn(),
  countWorkspaceOwnersMock: vi.fn(),
  addWorkspaceMemberMock: vi.fn(),
  removeWorkspaceMemberMock: vi.fn(),
  findAuthUserIdByEmailMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: hoisted.revalidatePathMock,
}));

vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => ({
    auth: {
      getUser: hoisted.getUserMock,
    },
  }),
}));

vi.mock("@/repositories/workspace-repository", () => ({
  getPrimaryWorkspace: hoisted.getPrimaryWorkspaceMock,
  isCallerWorkspaceOwner: hoisted.isCallerWorkspaceOwnerMock,
  isWorkspaceMember: hoisted.isWorkspaceMemberMock,
  listWorkspaceMembers: hoisted.listWorkspaceMembersMock,
  countWorkspaceOwners: hoisted.countWorkspaceOwnersMock,
  addWorkspaceMember: hoisted.addWorkspaceMemberMock,
  removeWorkspaceMember: hoisted.removeWorkspaceMemberMock,
}));

vi.mock("@/repositories/auth-user-lookup", () => ({
  findAuthUserIdByEmail: hoisted.findAuthUserIdByEmailMock,
}));

import { addMemberAction, removeMemberAction } from "./_actions";

const CALLER_USER_ID = "user-owner-1";
const WORKSPACE_ID = "ws-1";

function ownerCallerSetup() {
  hoisted.getUserMock.mockResolvedValue({
    data: { user: { id: CALLER_USER_ID } },
  });
  hoisted.getPrimaryWorkspaceMock.mockResolvedValue({
    workspace: { id: WORKSPACE_ID, name: "Acme" },
  });
  hoisted.isCallerWorkspaceOwnerMock.mockResolvedValue(true);
}

function nonOwnerCallerSetup() {
  hoisted.getUserMock.mockResolvedValue({
    data: { user: { id: "user-editor-1" } },
  });
  hoisted.getPrimaryWorkspaceMock.mockResolvedValue({
    workspace: { id: WORKSPACE_ID, name: "Acme" },
  });
  hoisted.isCallerWorkspaceOwnerMock.mockResolvedValue(false);
}

function unauthenticatedCallerSetup() {
  hoisted.getUserMock.mockResolvedValue({ data: { user: null } });
}

function noWorkspaceSetup() {
  hoisted.getUserMock.mockResolvedValue({
    data: { user: { id: CALLER_USER_ID } },
  });
  hoisted.getPrimaryWorkspaceMock.mockResolvedValue(null);
}

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  for (const m of Object.values(hoisted)) m.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================
// addMemberAction
// =====================================================================

describe("addMemberAction — input validation", () => {
  it("missing email → missing_email (no DB read, no DB write)", async () => {
    ownerCallerSetup();
    const out = await addMemberAction(null, fd({ email: "" }));
    expect(out).toEqual({ kind: "missing_email" });
    expect(hoisted.findAuthUserIdByEmailMock).not.toHaveBeenCalled();
    expect(hoisted.addWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("trims whitespace and rejects whitespace-only as missing_email", async () => {
    ownerCallerSetup();
    const out = await addMemberAction(null, fd({ email: "   " }));
    expect(out).toEqual({ kind: "missing_email" });
  });
});

describe("addMemberAction — permission gating", () => {
  it("unauthenticated caller → permission_denied (no DB writes)", async () => {
    unauthenticatedCallerSetup();
    const out = await addMemberAction(
      null,
      fd({ email: "worker@example.com" }),
    );
    expect(out.kind).toBe("permission_denied");
    expect(hoisted.findAuthUserIdByEmailMock).not.toHaveBeenCalled();
    expect(hoisted.addWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("no workspace → no_workspace", async () => {
    noWorkspaceSetup();
    const out = await addMemberAction(
      null,
      fd({ email: "worker@example.com" }),
    );
    expect(out.kind).toBe("no_workspace");
    expect(hoisted.addWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("non-owner caller → permission_denied (no DB writes)", async () => {
    nonOwnerCallerSetup();
    const out = await addMemberAction(
      null,
      fd({ email: "worker@example.com" }),
    );
    expect(out.kind).toBe("permission_denied");
    expect(hoisted.findAuthUserIdByEmailMock).not.toHaveBeenCalled();
    expect(hoisted.addWorkspaceMemberMock).not.toHaveBeenCalled();
  });
});

describe("addMemberAction — email resolution paths", () => {
  it("unknown email (worker hasn't signed up) → must_sign_up (no insert)", async () => {
    ownerCallerSetup();
    hoisted.findAuthUserIdByEmailMock.mockResolvedValue(null);
    const out = await addMemberAction(
      null,
      fd({ email: "no-such@example.com" }),
    );
    expect(out).toEqual({
      kind: "must_sign_up",
      email: "no-such@example.com",
    });
    expect(hoisted.addWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("user exists but is already a member → already_member (no insert)", async () => {
    ownerCallerSetup();
    hoisted.findAuthUserIdByEmailMock.mockResolvedValue({
      id: "user-worker-1",
      email: "worker@example.com",
    });
    hoisted.isWorkspaceMemberMock.mockResolvedValue(true);
    const out = await addMemberAction(
      null,
      fd({ email: "worker@example.com" }),
    );
    expect(out).toEqual({
      kind: "already_member",
      email: "worker@example.com",
    });
    expect(hoisted.addWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("owner adds existing user → addWorkspaceMember called with editor role", async () => {
    ownerCallerSetup();
    hoisted.findAuthUserIdByEmailMock.mockResolvedValue({
      id: "user-worker-1",
      email: "worker@example.com",
    });
    hoisted.isWorkspaceMemberMock.mockResolvedValue(false);
    hoisted.addWorkspaceMemberMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      userId: "user-worker-1",
      role: "editor",
      isPrimary: false,
      createdAt: "2026-05-29T00:00:00Z",
    });
    const out = await addMemberAction(
      null,
      fd({ email: "worker@example.com" }),
    );
    expect(out).toMatchObject({
      kind: "ok",
      addedUserId: "user-worker-1",
      addedEmail: "worker@example.com",
    });
    expect(hoisted.addWorkspaceMemberMock).toHaveBeenCalledTimes(1);
    expect(hoisted.addWorkspaceMemberMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: "user-worker-1",
      role: "editor",
    });
    expect(hoisted.revalidatePathMock).toHaveBeenCalledWith("/settings/team");
  });

  it("addWorkspaceMember throwing → error outcome (no crash)", async () => {
    ownerCallerSetup();
    hoisted.findAuthUserIdByEmailMock.mockResolvedValue({
      id: "user-worker-1",
      email: "worker@example.com",
    });
    hoisted.isWorkspaceMemberMock.mockResolvedValue(false);
    hoisted.addWorkspaceMemberMock.mockRejectedValue(
      new Error("RLS denied insert"),
    );
    const out = await addMemberAction(
      null,
      fd({ email: "worker@example.com" }),
    );
    expect(out.kind).toBe("error");
  });
});

// =====================================================================
// removeMemberAction
// =====================================================================

describe("removeMemberAction — input + permission", () => {
  it("missing user_id → missing_user_id", async () => {
    ownerCallerSetup();
    const out = await removeMemberAction(null, fd({ user_id: "" }));
    expect(out).toEqual({ kind: "missing_user_id" });
    expect(hoisted.removeWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("non-owner caller → permission_denied", async () => {
    nonOwnerCallerSetup();
    const out = await removeMemberAction(
      null,
      fd({ user_id: "user-worker-1" }),
    );
    expect(out.kind).toBe("permission_denied");
    expect(hoisted.removeWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("no workspace → no_workspace", async () => {
    noWorkspaceSetup();
    const out = await removeMemberAction(
      null,
      fd({ user_id: "user-worker-1" }),
    );
    expect(out.kind).toBe("no_workspace");
  });

  it("target not in workspace → not_a_member", async () => {
    ownerCallerSetup();
    hoisted.listWorkspaceMembersMock.mockResolvedValue([
      {
        workspaceId: WORKSPACE_ID,
        userId: CALLER_USER_ID,
        role: "owner",
        isPrimary: true,
        createdAt: "2026-05-01T00:00:00Z",
      },
    ]);
    const out = await removeMemberAction(
      null,
      fd({ user_id: "user-stranger" }),
    );
    expect(out.kind).toBe("not_a_member");
    expect(hoisted.removeWorkspaceMemberMock).not.toHaveBeenCalled();
  });
});

describe("removeMemberAction — owner invariants", () => {
  it("removes a non-owner member → ok (one removeWorkspaceMember call)", async () => {
    ownerCallerSetup();
    hoisted.listWorkspaceMembersMock.mockResolvedValue([
      {
        workspaceId: WORKSPACE_ID,
        userId: CALLER_USER_ID,
        role: "owner",
        isPrimary: true,
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        workspaceId: WORKSPACE_ID,
        userId: "user-worker-1",
        role: "editor",
        isPrimary: false,
        createdAt: "2026-05-02T00:00:00Z",
      },
    ]);
    hoisted.removeWorkspaceMemberMock.mockResolvedValue(undefined);
    const out = await removeMemberAction(
      null,
      fd({ user_id: "user-worker-1" }),
    );
    expect(out).toEqual({ kind: "ok", removedUserId: "user-worker-1" });
    expect(hoisted.removeWorkspaceMemberMock).toHaveBeenCalledTimes(1);
    expect(hoisted.removeWorkspaceMemberMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: "user-worker-1",
    });
    // Crucially: never touches auth.users — we don't even mock a
    // delete-user fn because no such call exists in the action.
    expect(hoisted.revalidatePathMock).toHaveBeenCalledWith("/settings/team");
  });

  it("owner tries to remove themselves when they are the only owner → cannot_remove_self_last_owner", async () => {
    ownerCallerSetup();
    hoisted.listWorkspaceMembersMock.mockResolvedValue([
      {
        workspaceId: WORKSPACE_ID,
        userId: CALLER_USER_ID,
        role: "owner",
        isPrimary: true,
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        workspaceId: WORKSPACE_ID,
        userId: "user-worker-1",
        role: "editor",
        isPrimary: false,
        createdAt: "2026-05-02T00:00:00Z",
      },
    ]);
    hoisted.countWorkspaceOwnersMock.mockResolvedValue(1);
    const out = await removeMemberAction(
      null,
      fd({ user_id: CALLER_USER_ID }),
    );
    expect(out.kind).toBe("cannot_remove_self_last_owner");
    expect(hoisted.removeWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("owner tries to remove the only other owner → cannot_remove_last_owner", async () => {
    ownerCallerSetup();
    hoisted.listWorkspaceMembersMock.mockResolvedValue([
      {
        workspaceId: WORKSPACE_ID,
        userId: CALLER_USER_ID,
        role: "owner",
        isPrimary: true,
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        workspaceId: WORKSPACE_ID,
        userId: "user-other-owner",
        role: "owner",
        isPrimary: false,
        createdAt: "2026-05-02T00:00:00Z",
      },
    ]);
    // Pretend the caller already gave up their own owner role —
    // tests the explicit "owner_count<=1" guard with the OTHER owner
    // being the last one.
    hoisted.countWorkspaceOwnersMock.mockResolvedValue(1);
    const out = await removeMemberAction(
      null,
      fd({ user_id: "user-other-owner" }),
    );
    expect(out.kind).toBe("cannot_remove_last_owner");
    expect(hoisted.removeWorkspaceMemberMock).not.toHaveBeenCalled();
  });

  it("owner can remove an owner when at least one other owner remains", async () => {
    ownerCallerSetup();
    hoisted.listWorkspaceMembersMock.mockResolvedValue([
      {
        workspaceId: WORKSPACE_ID,
        userId: CALLER_USER_ID,
        role: "owner",
        isPrimary: true,
        createdAt: "2026-05-01T00:00:00Z",
      },
      {
        workspaceId: WORKSPACE_ID,
        userId: "user-co-owner",
        role: "owner",
        isPrimary: false,
        createdAt: "2026-05-02T00:00:00Z",
      },
    ]);
    hoisted.countWorkspaceOwnersMock.mockResolvedValue(2);
    hoisted.removeWorkspaceMemberMock.mockResolvedValue(undefined);
    const out = await removeMemberAction(
      null,
      fd({ user_id: "user-co-owner" }),
    );
    expect(out).toEqual({ kind: "ok", removedUserId: "user-co-owner" });
  });
});

// =====================================================================
// Hard boundary: actions never reach into auth.users delete
// =====================================================================

describe("Auth user safety — the actions module never touches auth.users delete", () => {
  it("source does not reference auth.admin.deleteUser, supabase.auth.admin.delete, or workspace deletion", async () => {
    // We re-import as text to assert by surface area rather than by
    // mocking the call (which would be circular). The boundary is a
    // documented contract; this test guards against silent drift.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./_actions.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).not.toContain("auth.admin.deleteUser");
    expect(src).not.toContain("admin.deleteUser");
    expect(src).not.toMatch(/from\(["']workspaces["']\).*delete/);
    expect(src).not.toMatch(/\.delete\(\)[\s\S]{0,30}\.eq\(["']id["']/);
  });
});
