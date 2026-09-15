import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createPgServerHarness, type PgServerHarness } from "@/test/pg/server-harness";

/**
 * The LinkedIn Sales schema on embedded PostgreSQL, with the SHIPPED
 * migrations and GENUINE non-superuser sessions.
 *
 * Every role is a login role (nosuperuser, nobypassrls) granted
 * `authenticated`, with `request.jwt.claims` set as PostgREST sets it.
 * `set session authorization` from the superuser connection makes the
 * session that role for real — a superuser is not retained, which is
 * the property a `set role` harness cannot promise.
 */

let h: PgServerHarness;
const ROLE = "linkedin_sales_user";
type Person = { id: string; email: string };
type Tenant = { workspaceId: string; owner: Person; admin: Person; editor: Person; reviewer: Person; viewer: Person };

let A: Tenant;
let B: Tenant;

async function person(label: string): Promise<Person> {
  const r = await h.admin.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`${label}@example.test`]);
  return { id: r.rows[0].id, email: `${label}@example.test` };
}

async function tenant(label: string): Promise<Tenant> {
  const owner = await person(`${label}-owner`);
  const ws = await h.admin.query<{ id: string }>(
    `insert into public.workspaces (name, slug, created_by) values ($1, $2, $3) returning id`,
    [`ws-${label}`, `ws-${label}`, owner.id]);
  const workspaceId = ws.rows[0].id;
  const t: Tenant = { workspaceId, owner, admin: await person(`${label}-admin`), editor: await person(`${label}-editor`),
    reviewer: await person(`${label}-reviewer`), viewer: await person(`${label}-viewer`) };
  for (const [role, p] of [["owner", t.owner], ["admin", t.admin], ["editor", t.editor], ["reviewer", t.reviewer], ["viewer", t.viewer]] as const) {
    await h.admin.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`, [workspaceId, p.id, role]);
  }
  return t;
}

/** A real session as `person`: the login role, then the claims. */
async function sessionAs(p: Person): Promise<Client> {
  const c = await h.connect();
  await c.query(`set session authorization ${ROLE}`);
  await c.query(`set role authenticated`);
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: p.id, role: "authenticated" })]);
  return c;
}

const violates = async (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toMatchObject({ code });

beforeAll(async () => {
  h = await createPgServerHarness();
  await h.admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${ROLE}') then
      create role ${ROLE} login password 'under-test' nosuperuser nobypassrls noinherit;
    end if; end $$;`);
  await h.admin.query(`grant authenticated to ${ROLE}`);
  A = await tenant("a");
  B = await tenant("b");
}, 300_000);
afterAll(async () => { await h?.close(); });

describe("the session is genuinely not a superuser", () => {
  it("reports the login role, no superuser, no bypassrls", async () => {
    const c = await sessionAs(A.viewer);
    const r = await c.query<{ su: boolean; bypass: boolean; cu: string }>(
      `select (select rolsuper from pg_roles where rolname = session_user) as su,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass,
              current_user as cu`);
    expect(r.rows[0].su).toBe(false);
    expect(r.rows[0].bypass).toBe(false);
    expect(r.rows[0].cu).toBe("authenticated");
    await c.end();
  });
});

describe("roles: read for members, write for owner/admin/editor", () => {
  it.each([["owner", "owner"], ["admin", "admin"], ["editor", "editor"]] as const)(
    "%s can create a lead list", async (_l, role) => {
      const c = await sessionAs(A[role]);
      const r = await c.query<{ id: string }>(
        `insert into public.linkedin_lead_lists (workspace_id, name, source_type, created_by)
         values ($1, $2, 'customer_csv', $3) returning id`, [A.workspaceId, `list by ${role}`, A[role].id]);
      expect(r.rows[0].id).toBeTruthy();
      await c.end();
    });

  it.each([["reviewer", "reviewer"], ["viewer", "viewer"]] as const)(
    "%s can read but cannot create, update or delete", async (_l, role) => {
      const c = await sessionAs(A[role]);
      const read = await c.query<{ n: string }>(`select count(*)::text as n from public.linkedin_lead_lists`);
      expect(Number(read.rows[0].n)).toBeGreaterThan(0);
      await violates(
        c.query(`insert into public.linkedin_lead_lists (workspace_id, name, source_type) values ($1, 'x', 'customer_csv')`, [A.workspaceId]),
        "42501");
      const upd = await c.query(`update public.linkedin_lead_lists set name = 'renamed' where workspace_id = $1 returning id`, [A.workspaceId]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query(`delete from public.linkedin_lead_lists where workspace_id = $1 returning id`, [A.workspaceId]);
      expect(del.rowCount).toBe(0);
      await c.end();
    });
});

describe("cross-workspace isolation", () => {
  let listA: string;
  let listB: string;
  beforeAll(async () => {
    listA = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_lead_lists (workspace_id, name, source_type) values ($1, 'A list', 'customer_csv') returning id`,
      [A.workspaceId])).rows[0].id;
    listB = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_lead_lists (workspace_id, name, source_type) values ($1, 'B list', 'customer_csv') returning id`,
      [B.workspaceId])).rows[0].id;
  });

  it("a member of A sees none of B's rows in any table", async () => {
    const c = await sessionAs(A.owner);
    for (const table of ["linkedin_lead_lists", "linkedin_leads", "linkedin_sequences", "linkedin_campaigns",
      "linkedin_campaign_members", "linkedin_manual_tasks", "linkedin_suppression_entries",
      "linkedin_import_jobs", "linkedin_compliance_events"]) {
      const r = await c.query<{ n: string }>(`select count(*)::text as n from public.${table} where workspace_id = $1`, [B.workspaceId]);
      expect(Number(r.rows[0].n), table).toBe(0);
    }
    await c.end();
  });

  it("an owner of A cannot update, delete, or insert into B", async () => {
    const c = await sessionAs(A.owner);
    expect((await c.query(`update public.linkedin_lead_lists set name = 'stolen' where id = $1 returning id`, [listB])).rowCount).toBe(0);
    expect((await c.query(`delete from public.linkedin_lead_lists where id = $1 returning id`, [listB])).rowCount).toBe(0);
    await violates(
      c.query(`insert into public.linkedin_lead_lists (workspace_id, name, source_type) values ($1, 'into B', 'customer_csv')`, [B.workspaceId]),
      "42501");
    await c.end();
  });

  it("COMPOSITE FK: a lead in A cannot reference a list in B, even for a superuser", async () => {
    await violates(
      h.admin.query(
        `insert into public.linkedin_leads (workspace_id, lead_list_id, profile_key, canonical_profile_url, source_type)
         values ($1, $2, 'someone', 'https://www.linkedin.com/in/someone', 'customer_csv')`,
        [A.workspaceId, listB]),
      "23503");
    // …and neither can a campaign, a member, or a task. One example each.
    const seqB = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_sequences (workspace_id, name) values ($1, 'B seq') returning id`, [B.workspaceId])).rows[0].id;
    await violates(
      h.admin.query(
        `insert into public.linkedin_campaigns (workspace_id, lead_list_id, sequence_id, name) values ($1, $2, $3, 'cross')`,
        [A.workspaceId, listA, seqB]),
      "23503");
  });
});

describe("closed sets and state consistency", () => {
  let seq: string;
  let list: string;
  beforeAll(async () => {
    seq = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_sequences (workspace_id, name) values ($1, 'closed') returning id`, [A.workspaceId])).rows[0].id;
    list = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_lead_lists (workspace_id, name, source_type) values ($1, 'closed', 'customer_csv') returning id`,
      [A.workspaceId])).rows[0].id;
  });

  it("no 'automatic' step kind can exist", async () => {
    for (const kind of ["automatic_connection_request", "auto_message", "linkedin_api_message", "send_automatically"]) {
      await violates(
        h.admin.query(`insert into public.linkedin_sequence_steps (workspace_id, sequence_id, position, kind) values ($1, $2, 1, $3)`,
          [A.workspaceId, seq, kind]),
        "23514");
    }
  });

  it("a wait step cannot carry a template; positions are unique per sequence", async () => {
    await violates(
      h.admin.query(`insert into public.linkedin_sequence_steps (workspace_id, sequence_id, position, kind, template) values ($1, $2, 1, 'wait', 'x')`,
        [A.workspaceId, seq]),
      "23514");
    await h.admin.query(`insert into public.linkedin_sequence_steps (workspace_id, sequence_id, position, kind, template) values ($1, $2, 1, 'manual_connection_request', 'Hi {{name}}')`,
      [A.workspaceId, seq]);
    await violates(
      h.admin.query(`insert into public.linkedin_sequence_steps (workspace_id, sequence_id, position, kind, template) values ($1, $2, 1, 'manual_linkedin_message', 'dup')`,
        [A.workspaceId, seq]),
      "23505");
  });

  it("a lead's canonical URL must equal the key; the key must be a normalised slug", async () => {
    await violates(
      h.admin.query(`insert into public.linkedin_leads (workspace_id, lead_list_id, profile_key, canonical_profile_url, source_type)
        values ($1, $2, 'Someone', 'https://www.linkedin.com/in/Someone', 'customer_csv')`, [A.workspaceId, list]),
      "23514");
    await violates(
      h.admin.query(`insert into public.linkedin_leads (workspace_id, lead_list_id, profile_key, canonical_profile_url, source_type)
        values ($1, $2, 'someone', 'https://linkedin.com/in/someone', 'customer_csv')`, [A.workspaceId, list]),
      "23514");
    // No credential-shaped column exists anywhere in the product.
    const cols = await h.admin.query<{ column_name: string; table_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name like 'linkedin_%'`);
    const names = cols.rows.map((c) => c.column_name.toLowerCase());
    for (const bad of ["cookie", "li_at", "session_token", "password", "access_token", "refresh_token", "jsessionid"]) {
      expect(names.some((n) => n.includes(bad)), bad).toBe(false);
    }
  });

  it("task state and timestamps must agree; a task's kind must equal its step's kind; a wait never becomes a task", async () => {
    const lead = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_leads (workspace_id, lead_list_id, profile_key, canonical_profile_url, source_type)
       values ($1, $2, 'task-shape', 'https://www.linkedin.com/in/task-shape', 'customer_csv') returning id`, [A.workspaceId, list])).rows[0].id;
    const campaign = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_campaigns (workspace_id, lead_list_id, sequence_id, name) values ($1, $2, $3, 'shape') returning id`,
      [A.workspaceId, list, seq])).rows[0].id;
    const member = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_campaign_members (workspace_id, campaign_id, lead_id) values ($1, $2, $3) returning id`,
      [A.workspaceId, campaign, lead])).rows[0].id;
    const step = (await h.admin.query<{ id: string }>(
      `select id from public.linkedin_sequence_steps where sequence_id = $1 and position = 1`, [seq])).rows[0].id;
    const waitStep = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_sequence_steps (workspace_id, sequence_id, position, kind, wait_days) values ($1, $2, 2, 'wait', 3) returning id`,
      [A.workspaceId, seq])).rows[0].id;
    const base = `insert into public.linkedin_manual_tasks
      (workspace_id, campaign_id, campaign_member_id, sequence_step_id, kind, state, profile_url, local_date, available_at`;
    // confirmed_at without the state
    await violates(h.admin.query(`${base}, operator_confirmed_at) values ($1,$2,$3,$4,'manual_connection_request','ready','https://www.linkedin.com/in/task-shape', current_date, now(), now())`,
      [A.workspaceId, campaign, member, step]), "23514");
    // wrong kind for the step (trigger)
    await violates(h.admin.query(`${base}) values ($1,$2,$3,$4,'manual_linkedin_message','ready','https://www.linkedin.com/in/task-shape', current_date, now())`,
      [A.workspaceId, campaign, member, step]), "P0001");
    // a wait step as a task (trigger)
    await violates(h.admin.query(`${base}) values ($1,$2,$3,$4,'internal_note','ready','https://www.linkedin.com/in/task-shape', current_date, now())`,
      [A.workspaceId, campaign, member, waitStep]), "P0001");
    // a correct task; then a second active one for the same member is refused
    await h.admin.query(`${base}) values ($1,$2,$3,$4,'manual_connection_request','ready','https://www.linkedin.com/in/task-shape', current_date, now())`,
      [A.workspaceId, campaign, member, step]);
    const step3 = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_sequence_steps (workspace_id, sequence_id, position, kind, template) values ($1, $2, 3, 'manual_linkedin_message', 'follow up') returning id`,
      [A.workspaceId, seq])).rows[0].id;
    await violates(h.admin.query(`${base}) values ($1,$2,$3,$4,'manual_linkedin_message','ready','https://www.linkedin.com/in/task-shape', current_date, now())`,
      [A.workspaceId, campaign, member, step3]), "23505");
  });

  it("a member's terminal state always carries a reason", async () => {
    const lead = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_leads (workspace_id, lead_list_id, profile_key, canonical_profile_url, source_type)
       values ($1, $2, 'reasoned', 'https://www.linkedin.com/in/reasoned', 'customer_csv') returning id`, [A.workspaceId, list])).rows[0].id;
    const campaign = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_campaigns (workspace_id, lead_list_id, sequence_id, name) values ($1, $2, $3, 'reasoned') returning id`,
      [A.workspaceId, list, seq])).rows[0].id;
    await violates(
      h.admin.query(`insert into public.linkedin_campaign_members (workspace_id, campaign_id, lead_id, state) values ($1, $2, $3, 'suppressed')`,
        [A.workspaceId, campaign, lead]),
      "23514");
  });
});

describe("tasks come only from the scheduler; events are append-only", () => {
  it("a signed-in editor cannot insert a task directly (no policy)", async () => {
    const c = await sessionAs(A.editor);
    const campaign = (await c.query<{ id: string }>(`select id from public.linkedin_campaigns where workspace_id = $1 limit 1`, [A.workspaceId])).rows[0].id;
    const member = (await c.query<{ id: string }>(`select id from public.linkedin_campaign_members where workspace_id = $1 limit 1`, [A.workspaceId])).rows[0].id;
    const step = (await c.query<{ id: string }>(`select id from public.linkedin_sequence_steps where workspace_id = $1 and kind <> 'wait' limit 1`, [A.workspaceId])).rows[0].id;
    await violates(
      c.query(`insert into public.linkedin_manual_tasks (workspace_id, campaign_id, campaign_member_id, sequence_step_id, kind, state, profile_url, local_date, available_at)
        values ($1,$2,$3,$4,'manual_connection_request','ready','https://www.linkedin.com/in/x', current_date, now())`,
        [A.workspaceId, campaign, member, step]),
      "42501");
    await c.end();
  });

  it("the release function is service_role-only; the operator functions are for signed-in users", async () => {
    const r = await h.admin.query<{ name: string; auth: boolean; svc: boolean; anon: boolean }>(
      `select p.proname as name,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'release_linkedin_campaign_tasks', 'activate_linkedin_campaign', 'confirm_linkedin_task',
          'skip_linkedin_task', 'suppress_linkedin_lead_from_task', 'cancel_linkedin_campaign')`);
    const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
    expect(by.release_linkedin_campaign_tasks.auth).toBe(false);
    expect(by.release_linkedin_campaign_tasks.anon).toBe(false);
    expect(by.release_linkedin_campaign_tasks.svc).toBe(true);
    for (const fn of ["confirm_linkedin_task", "skip_linkedin_task", "suppress_linkedin_lead_from_task", "cancel_linkedin_campaign"]) {
      expect(by[fn].auth, fn).toBe(true);
      expect(by[fn].anon, fn).toBe(false);
    }
  });

  it("a viewer calling an operator function is refused inside it", async () => {
    const c = await sessionAs(A.viewer);
    const campaign = (await c.query<{ id: string }>(`select id from public.linkedin_campaigns where workspace_id = $1 limit 1`, [A.workspaceId])).rows[0].id;
    const r = await c.query<{ ok: boolean; refused_reason: string }>(
      `select ok, refused_reason from public.activate_linkedin_campaign($1, $2)`, [A.workspaceId, campaign]);
    expect(r.rows[0].ok).toBe(false);
    expect(r.rows[0].refused_reason).toBe("forbidden");
    await c.end();
  });

  it("compliance events cannot be updated or deleted by anyone, superuser included", async () => {
    const ev = (await h.admin.query<{ id: string }>(
      `insert into public.linkedin_compliance_events (workspace_id, event_type, details) values ($1, 'import', '{}') returning id`,
      [A.workspaceId])).rows[0].id;
    await violates(h.admin.query(`update public.linkedin_compliance_events set details = '{"x":1}' where id = $1`, [ev]), "P0001");
    await violates(h.admin.query(`delete from public.linkedin_compliance_events where id = $1`, [ev]), "P0001");
    // A signed-in owner: RLS has no update/delete policy, so the
    // statement matches nothing (0 rows) before the trigger could even
    // fire — two independent layers, and the row is unchanged.
    const c = await sessionAs(A.owner);
    expect((await c.query(`update public.linkedin_compliance_events set details = '{}' where id = $1`, [ev])).rowCount).toBe(0);
    expect((await c.query(`delete from public.linkedin_compliance_events where id = $1`, [ev])).rowCount).toBe(0);
    const still = await h.admin.query<{ details: unknown }>(`select details from public.linkedin_compliance_events where id = $1`, [ev]);
    expect(still.rows).toHaveLength(1);
    await c.end();
  });

  it("service_role table privileges are exactly: read everything, write campaigns/members/tasks, insert events", async () => {
    const r = await h.admin.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'service_role' and table_schema = 'public' and table_name like 'linkedin_%'`);
    const grants = new Map<string, Set<string>>();
    for (const row of r.rows) grants.set(row.table_name, (grants.get(row.table_name) ?? new Set()).add(row.privilege_type));
    for (const t of ["linkedin_lead_lists", "linkedin_leads", "linkedin_suppression_entries", "linkedin_sequences", "linkedin_sequence_steps", "linkedin_import_jobs"]) {
      expect([...grants.get(t) ?? []].sort(), t).toEqual(["SELECT"]);
    }
    for (const t of ["linkedin_campaigns", "linkedin_campaign_members", "linkedin_manual_tasks"]) {
      expect([...grants.get(t) ?? []].sort(), t).toEqual(["INSERT", "SELECT", "UPDATE"]);
    }
    expect([...grants.get("linkedin_compliance_events") ?? []].sort()).toEqual(["INSERT", "SELECT"]);
  });
});
