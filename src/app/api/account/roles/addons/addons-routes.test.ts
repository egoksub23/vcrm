import { beforeEach, describe, expect, it, vi } from "vitest";

// The add-on role routes (migration 191): list / create, edit / delete, and giving a member their add-ons. The rules themselves live in the database functions
// (verified by supabase/ci/verify-191-addon-roles.sql); these tests prove the routes check what they are sent, call the right function with the right
// arguments, require the right permission, and word each refusal in the right status.

const h = vi.hoisted(() => ({ requireCapability: vi.fn(), getCurrentAccount: vi.fn(), loadCapabilities: vi.fn() }));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  getCurrentAccount: h.getCurrentAccount,
  loadCapabilities: h.loadCapabilities,
  toErrorResponse: (err: unknown) => Response.json({ error: err instanceof Error ? err.message : "x" }, { status: (err as { status?: number }).status ?? 500 }),
}));

import { __resetRateLimitForTests } from "@/lib/rate-limit";

import { GET as list, POST as create } from "./route";
import { DELETE as remove, PATCH as edit } from "./[id]/route";
import { PUT as setMemberAddons } from "../../members/[userId]/addons/route";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const U1 = "33333333-3333-4333-8333-333333333333";

type Rpc = { fn: string; args: Record<string, unknown> };
function makeSupabase(opts: { byTable?: Record<string, { data: unknown; error?: unknown }>; rpc?: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown } } = {}) {
  const rpcs: Rpc[] = [];
  const from = (table: string) => {
    const result = opts.byTable?.[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const op of ["select", "eq", "order"]) builder[op] = () => builder;
    builder.then = (resolve: (v: unknown) => unknown) => resolve({ error: null, ...result });
    return builder;
  };
  return {
    rpcs,
    client: {
      from,
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return Promise.resolve(opts.rpc ? opts.rpc(fn, args) : { data: null, error: null });
      },
    },
  };
}

const ctx = (supabase: unknown) => ({ supabase, userId: "u-editor", accountId: "acct", role: "admin", account: { id: "acct", name: "A" }, capabilities: new Set<string>() });
const denied = () => Object.assign(new Error("This action requires the 'roles.manage' permission"), { status: 403 });
const json = (body: unknown, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.requireCapability.mockReset();
  h.getCurrentAccount.mockReset();
  h.loadCapabilities.mockReset();
  __resetRateLimitForTests();
});

describe("GET /api/account/roles/addons", () => {
  const byTable = {
    account_addon_roles: {
      data: [
        { id: A1, name: "KYC reviewer", description: "ID checks", account_addon_role_capabilities: [{ capability: "kyc.view" }, { capability: "kyc.decide" }, { capability: "menu.kyc" }] },
        { id: A2, name: "Reports", description: null, account_addon_role_capabilities: [{ capability: "reports.view" }] },
      ],
    },
    member_addon_roles: { data: [{ addon_role_id: A1 }, { addon_role_id: A1 }, { addon_role_id: A2 }] },
  };

  it("lists the workspace's add-ons with how many people hold each and the lowest base role they fully apply to; the keys go only to people who manage roles", async () => {
    const { client } = makeSupabase({ byTable });
    h.getCurrentAccount.mockResolvedValue(ctx(client));
    h.loadCapabilities.mockResolvedValue(new Set(["roles.manage"]));
    const body = await (await list()).json();
    expect(body.addons).toEqual([
      { id: A1, name: "KYC reviewer", description: "ID checks", memberCount: 2, capabilityCount: 3, minBaseRole: "agent", editable: true, capabilities: ["kyc.decide", "kyc.view", "menu.kyc"] },
      { id: A2, name: "Reports", description: null, memberCount: 1, capabilityCount: 1, minBaseRole: "viewer", editable: true, capabilities: ["reports.view"] },
    ]);

    h.loadCapabilities.mockResolvedValue(new Set(["members.change-role"]));
    const plain = await (await list()).json();
    expect(plain.addons[0]).toMatchObject({ id: A1, name: "KYC reviewer", memberCount: 2, capabilityCount: 3, minBaseRole: "agent", editable: false });
    expect(plain.addons[0]).not.toHaveProperty("capabilities");
  });

  it("is never cached, and fails with a 500 when it cannot read", async () => {
    const { client } = makeSupabase({ byTable });
    h.getCurrentAccount.mockResolvedValue(ctx(client));
    h.loadCapabilities.mockResolvedValue(new Set());
    expect((await list()).headers.get("cache-control")).toBe("no-store");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = makeSupabase({ byTable: { ...byTable, account_addon_roles: { data: null, error: { code: "XX000", message: "boom" } } } });
    h.getCurrentAccount.mockResolvedValue(ctx(broken.client));
    expect((await list()).status).toBe(500);
  });
});

describe("POST /api/account/roles/addons", () => {
  it("needs roles.manage", async () => {
    h.requireCapability.mockRejectedValue(denied());
    const res = await create(new Request("http://x", json({ name: "x" })));
    expect(h.requireCapability).toHaveBeenCalledWith("roles.manage");
    expect(res.status).toBe(403);
  });

  it("makes the add-on through create_addon_role, with the name trimmed, no description as null and the keys once each", async () => {
    const s = makeSupabase({ rpc: () => ({ data: A1, error: null }) });
    h.requireCapability.mockResolvedValue(ctx(s.client));
    const res = await create(new Request("http://x", json({ name: "  KYC reviewer ", capabilities: ["menu.kyc", "kyc.view", "menu.kyc"] })));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: A1 });
    expect(s.rpcs).toEqual([{ fn: "create_addon_role", args: { p_account_id: "acct", p_name: "KYC reviewer", p_description: null, p_capabilities: ["menu.kyc", "kyc.view"] } }]);
  });

  it("passes a description on, and allows an add-on with no permissions yet", async () => {
    const s = makeSupabase({ rpc: () => ({ data: A1, error: null }) });
    h.requireCapability.mockResolvedValue(ctx(s.client));
    await create(new Request("http://x", json({ name: "Empty", description: " Looks at things " })));
    expect(s.rpcs[0].args).toMatchObject({ p_description: "Looks at things", p_capabilities: [] });
  });

  it("refuses a blank or long name, a long description, an unknown permission and a list that is not a list, before the database is asked", async () => {
    const s = makeSupabase();
    h.requireCapability.mockResolvedValue(ctx(s.client));
    for (const body of [{ name: "  " }, { name: "x".repeat(81) }, { name: "ok", description: "y".repeat(301) }, { name: "ok", capabilities: ["not.a.capability"] }, { name: "ok", capabilities: "menu.kyc" }, {}, { name: 5 }]) {
      const res = await create(new Request("http://x", json(body)));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await create(new Request("http://x", { method: "POST", body: "not json" }))).status).toBe(400);
    expect(s.rpcs).toHaveLength(0);
  });

  it("words the database's refusals: 403 for a permission the caller lacks, 400 for bad input, 409 for a name already taken, 500 for the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases: [string, number, string | RegExp][] = [
      ["42501", 403, "You cannot grant 'kyc.decide' because you do not hold it yourself"],
      ["22023", 400, "Unknown capability: x"],
      ["23505", 409, /already a role with that name/],
      ["XX000", 500, "Failed to create the add-on role"],
    ];
    for (const [code, status, message] of cases) {
      const s = makeSupabase({ rpc: () => ({ data: null, error: { code, message: typeof message === "string" ? message : "dup" } }) });
      h.requireCapability.mockResolvedValue(ctx(s.client));
      const res = await create(new Request("http://x", json({ name: "x", capabilities: ["menu.kyc"] })));
      expect(res.status, code).toBe(status);
      const error = (await res.json()).error as string;
      if (typeof message === "string") expect(error).toBe(message);
      else expect(error).toMatch(message);
    }
  });
});

describe("PATCH and DELETE /api/account/roles/addons/[id]", () => {
  it("need roles.manage and a real id", async () => {
    h.requireCapability.mockRejectedValue(denied());
    expect((await edit(new Request("http://x", json({ name: "x" }, "PATCH")), idParams(A1))).status).toBe(403);
    expect((await remove(new Request("http://x", { method: "DELETE" }), idParams(A1))).status).toBe(403);
    const s = makeSupabase();
    h.requireCapability.mockResolvedValue(ctx(s.client));
    expect((await edit(new Request("http://x", json({ name: "x" }, "PATCH")), idParams("nope"))).status).toBe(404);
    expect((await remove(new Request("http://x", { method: "DELETE" }), idParams("nope"))).status).toBe(404);
    expect(s.rpcs).toHaveLength(0);
  });

  it("edits through update_addon_role, sending null for what is not being changed and the whole set for the permissions", async () => {
    const s = makeSupabase({ rpc: () => ({ data: { added: 1, removed: 0 }, error: null }) });
    h.requireCapability.mockResolvedValue(ctx(s.client));
    const res = await edit(new Request("http://x", json({ capabilities: ["menu.kyc", "kyc.view"] }, "PATCH")), idParams(A1));
    expect(await res.json()).toEqual({ ok: true, added: 1, removed: 0 });
    expect(s.rpcs[0]).toEqual({ fn: "update_addon_role", args: { p_addon_role_id: A1, p_name: null, p_description: null, p_capabilities: ["menu.kyc", "kyc.view"] } });
    await edit(new Request("http://x", json({ name: " New name ", description: null }, "PATCH")), idParams(A1));
    expect(s.rpcs[1].args).toEqual({ p_addon_role_id: A1, p_name: "New name", p_description: "", p_capabilities: null });
    // an empty set is a real change: it takes every permission out
    await edit(new Request("http://x", json({ capabilities: [] }, "PATCH")), idParams(A1));
    expect(s.rpcs[2].args.p_capabilities).toEqual([]);
  });

  it("refuses an edit that changes nothing, and bad input", async () => {
    const s = makeSupabase();
    h.requireCapability.mockResolvedValue(ctx(s.client));
    for (const body of [{}, { name: "" }, { name: "x".repeat(81) }, { capabilities: ["nope"] }, { description: "y".repeat(301) }]) {
      expect((await edit(new Request("http://x", json(body, "PATCH")), idParams(A1))).status, JSON.stringify(body)).toBe(400);
    }
    expect(s.rpcs).toHaveLength(0);
  });

  it("deletes through delete_addon_role and says how many people held it", async () => {
    const s = makeSupabase({ rpc: () => ({ data: { members: 3 }, error: null }) });
    h.requireCapability.mockResolvedValue(ctx(s.client));
    const res = await remove(new Request("http://x", { method: "DELETE" }), idParams(A1));
    expect(await res.json()).toEqual({ ok: true, members: 3 });
    expect(s.rpcs).toEqual([{ fn: "delete_addon_role", args: { p_addon_role_id: A1 } }]);
  });

  it("words the database's refusals", async () => {
    for (const [code, status] of [["42501", 403], ["22023", 400], ["23505", 409]] as const) {
      const s = makeSupabase({ rpc: () => ({ data: null, error: { code, message: "refused" } }) });
      h.requireCapability.mockResolvedValue(ctx(s.client));
      expect((await edit(new Request("http://x", json({ name: "x" }, "PATCH")), idParams(A1))).status).toBe(status);
      expect((await remove(new Request("http://x", { method: "DELETE" }), idParams(A1))).status).toBe(code === "23505" ? 409 : status);
    }
  });
});

describe("PUT /api/account/members/[userId]/addons", () => {
  const put = (body: unknown, userId = U1) => setMemberAddons(new Request("http://x", json(body, "PUT")), { params: Promise.resolve({ userId }) });

  it("needs members.change-role", async () => {
    h.requireCapability.mockRejectedValue(Object.assign(new Error("denied"), { status: 403 }));
    expect((await put({ addonRoleIds: [A1] })).status).toBe(403);
    expect(h.requireCapability).toHaveBeenCalledWith("members.change-role");
  });

  it("sets the whole list through set_member_addon_roles for that person, each id once, lower-cased", async () => {
    const s = makeSupabase({ rpc: () => ({ data: { added: 1, removed: 1 }, error: null }) });
    h.requireCapability.mockResolvedValue(ctx(s.client));
    const res = await put({ addonRoleIds: [A1.toUpperCase(), A2, A1] });
    expect(await res.json()).toEqual({ ok: true, added: 1, removed: 1 });
    expect(s.rpcs).toEqual([{ fn: "set_member_addon_roles", args: { p_user_id: U1, p_addon_role_ids: [A1, A2] } }]);
    // an empty list takes every add-on away
    await put({ addonRoleIds: [] });
    expect(s.rpcs[1].args.p_addon_role_ids).toEqual([]);
  });

  it("refuses a body that is not a list of ids, a missing list, and a person that is not an id", async () => {
    const s = makeSupabase();
    h.requireCapability.mockResolvedValue(ctx(s.client));
    for (const body of [{}, { addonRoleIds: "x" }, { addonRoleIds: ["nope"] }, { addonRoleIds: [1] }, { addonRoleIds: Array.from({ length: 51 }, () => A1) }, null]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await put({ addonRoleIds: [] }, "nope")).status).toBe(404);
    expect(s.rpcs).toHaveLength(0);
  });

  it("words the database's refusals: a member above the caller, the owner, oneself, an add-on the caller cannot give", async () => {
    for (const [code, status, message] of [
      ["42501", 403, "You can only change members whose role is below your own"],
      ["22023", 400, "The account owner already holds every permission"],
      ["42501", 403, "You cannot give 'KYC reviewer' because it includes 'kyc.decide', which you do not hold yourself"],
    ] as const) {
      const s = makeSupabase({ rpc: () => ({ data: null, error: { code, message } }) });
      h.requireCapability.mockResolvedValue(ctx(s.client));
      const res = await put({ addonRoleIds: [A1] });
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(message);
    }
  });
});
