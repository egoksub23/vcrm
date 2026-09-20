import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  getCurrentAccount: vi.fn(),
  loadCapabilities: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  getCurrentAccount: h.getCurrentAccount,
  loadCapabilities: h.loadCapabilities,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "x" },
      { status: (err as { status?: number }).status ?? 500 },
    ),
}));

import { GET as getMatrix } from "./route";
import { PUT as putRole } from "./[role]/route";
import { GET as getLog } from "./log/route";
import { GET as getMine } from "../capabilities/route";
import { DEFAULT_CAPABILITIES } from "@/lib/auth/capabilities";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

// Minimal chainable Supabase mock keyed by table.
function makeSupabase(opts: {
  byTable?: Record<string, { data: unknown; error?: unknown }>;
  rpc?: (fn: string, args: unknown) => { data: unknown; error: unknown };
}) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const from = (table: string) => {
    const call = { table, ops: [] as [string, unknown[]][] };
    calls.push(call);
    const result = opts.byTable?.[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const op of ["select", "eq", "in", "order", "limit", "lt"]) {
      builder[op] = (...args: unknown[]) => {
        call.ops.push([op, args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) =>
      resolve({ error: null, ...result });
    return builder;
  };
  return {
    calls,
    client: {
      from,
      rpc: (fn: string, args: unknown) =>
        Promise.resolve(opts.rpc ? opts.rpc(fn, args) : { data: null, error: null }),
    },
  };
}

function ctx(role: "owner" | "admin", supabase: unknown) {
  return {
    supabase,
    userId: "u-editor",
    accountId: "acct",
    role,
    account: { id: "acct", name: "A" },
    capabilities: DEFAULT_CAPABILITIES[role],
  };
}

const put = (role: string, body: unknown) =>
  putRole(
    new Request(`http://localhost/api/account/roles/${role}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ role }) },
  );

beforeEach(() => {
  h.requireCapability.mockReset();
  h.getCurrentAccount.mockReset();
  h.loadCapabilities.mockReset();
  __resetRateLimitForTests();
});

describe("GET /api/account/capabilities", () => {
  it("returns the role and the sorted effective set", async () => {
    h.getCurrentAccount.mockResolvedValue({ role: "agent" });
    h.loadCapabilities.mockResolvedValue(new Set(["b.x", "a.y"]));
    const res = await getMine();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "agent", capabilities: ["a.y", "b.x"] });
  });
});

describe("GET /api/account/roles", () => {
  it("requires roles.manage", async () => {
    h.requireCapability.mockRejectedValue(
      Object.assign(new Error("denied"), { status: 403 }),
    );
    const res = await getMatrix();
    expect(h.requireCapability).toHaveBeenCalledWith("roles.manage");
    expect(res.status).toBe(403);
  });

  it("builds the matrix with counts, overrides, editability and who changed what", async () => {
    const { client } = makeSupabase({
      byTable: {
        role_capabilities: {
          data: [
            {
              role: "agent",
              capability: "broadcasts.send",
              granted: false,
              changed_by: "u-editor",
              changed_at: "2026-09-20T10:00:00Z",
            },
            {
              role: "agent",
              capability: "channels.manage",
              granted: true,
              changed_by: null,
              changed_at: "2026-09-20T11:00:00Z",
            },
          ],
        },
        profiles: {
          data: [
            { user_id: "u-editor", full_name: "Ada", email: "a@x", account_role: "admin" },
            { user_id: "u2", full_name: null, email: "b@x", account_role: "agent" },
            { user_id: "u3", full_name: "C", email: "c@x", account_role: "agent" },
          ],
        },
      },
    });
    h.requireCapability.mockResolvedValue(ctx("admin", client));

    const res = await getMatrix();
    const body = await res.json();
    expect(body.role).toBe("admin");
    expect(body.roles.map((r: { role: string }) => r.role)).toEqual([
      "owner",
      "admin",
      "agent",
      "viewer",
    ]);
    const byRole = Object.fromEntries(
      body.roles.map((r: { role: string }) => [r.role, r]),
    );
    expect(byRole.owner.editable).toBe(false);
    expect(byRole.admin.editable).toBe(false);
    expect(byRole.agent.editable).toBe(true);
    expect(byRole.viewer.editable).toBe(true);
    expect(byRole.agent.memberCount).toBe(2);
    expect(byRole.viewer.memberCount).toBe(0);
    expect(byRole.agent.overrides).toEqual({
      "broadcasts.send": false,
      "channels.manage": true,
    });
    expect(byRole.agent.effective).not.toContain("broadcasts.send");
    expect(byRole.agent.effective).toContain("channels.manage");
    expect(byRole.agent.changed["broadcasts.send"].by).toEqual({
      id: "u-editor",
      name: "Ada",
    });
    expect(byRole.agent.changed["channels.manage"].by).toBeNull();
    expect(byRole.owner.overrides).toEqual({});
    expect(byRole.owner.effective.length).toBe(DEFAULT_CAPABILITIES.owner.size);
  });
});

describe("PUT /api/account/roles/[role]", () => {
  it("passes the changes to set_role_capabilities and reports the count", async () => {
    const rpc = vi.fn(() => ({ data: { changed: 2 }, error: null }));
    const { client } = makeSupabase({ rpc });
    h.requireCapability.mockResolvedValue(ctx("owner", client));
    const res = await put("agent", {
      changes: { "broadcasts.send": false, "channels.manage": null },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: 2 });
    expect(rpc).toHaveBeenCalledWith("set_role_capabilities", {
      target_account_id: "acct",
      target_role: "agent",
      changes: { "broadcasts.send": false, "channels.manage": null },
    });
  });

  it.each([
    ["admin", "admin", 403],
    ["admin", "owner", 403],
    ["owner", "owner", 403],
    ["owner", "nobody", 400],
  ])("%s editing %s is refused before the database (%s)", async (editor, target, status) => {
    const rpc = vi.fn();
    const { client } = makeSupabase({ rpc });
    h.requireCapability.mockResolvedValue(ctx(editor as "owner" | "admin", client));
    const res = await put(target, { changes: { "menu.reports": false } });
    expect(res.status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies, unknown capabilities and non-boolean values", async () => {
    const rpc = vi.fn();
    const { client } = makeSupabase({ rpc });
    h.requireCapability.mockResolvedValue(ctx("owner", client));
    expect((await put("agent", null)).status).toBe(400);
    expect((await put("agent", { changes: [] })).status).toBe(400);
    expect((await put("agent", { changes: { "nope.unknown": true } })).status).toBe(400);
    expect((await put("agent", { changes: { "menu.reports": "yes" } })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps database refusals: 42501 -> 403, 22023 -> 400, other -> 500", async () => {
    for (const [code, status] of [
      ["42501", 403],
      ["22023", 400],
      ["XX000", 500],
    ] as const) {
      const rpc = vi.fn(() => ({ data: null, error: { code, message: "db says no" } }));
      const { client } = makeSupabase({ rpc });
      h.requireCapability.mockResolvedValue(ctx("owner", client));
      const res = await put("agent", { changes: { "menu.reports": false } });
      expect(res.status).toBe(status);
    }
  });

  it("treats an empty change set as a no-op", async () => {
    const rpc = vi.fn();
    const { client } = makeSupabase({ rpc });
    h.requireCapability.mockResolvedValue(ctx("owner", client));
    const res = await put("agent", { changes: {} });
    expect(await res.json()).toEqual({ ok: true, changed: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/account/roles/log", () => {
  const get = (qs = "") => getLog(new Request(`http://localhost/api/account/roles/log${qs}`));

  it("returns entries newest first with actor names and a cursor", async () => {
    const rows = [3, 2, 1].map((id) => ({
      id,
      role: "agent",
      capability: "menu.reports",
      old_granted: true,
      new_granted: false,
      actor: id === 1 ? null : "u1",
      at: "2026-09-20T10:00:00Z",
    }));
    const { client } = makeSupabase({
      byTable: {
        role_capability_log: { data: rows },
        profiles: { data: [{ user_id: "u1", full_name: "Ada", email: "a@x" }] },
      },
    });
    h.requireCapability.mockResolvedValue(ctx("owner", client));
    const res = await get("?limit=2");
    const body = await res.json();
    expect(h.requireCapability).toHaveBeenCalledWith("roles.manage");
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      id: 3,
      oldGranted: true,
      newGranted: false,
      actor: { id: "u1", name: "Ada" },
    });
    expect(body.nextCursor).toBe(2);
  });

  it("validates the filters", async () => {
    const { client } = makeSupabase({});
    h.requireCapability.mockResolvedValue(ctx("owner", client));
    expect((await get("?role=boss")).status).toBe(400);
    expect((await get("?before=abc")).status).toBe(400);
    expect((await get("?role=agent&before=10")).status).toBe(200);
  });
});
