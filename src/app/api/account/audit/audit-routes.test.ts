import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ requireCapability: vi.fn() }));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "x" },
      { status: (err as { status?: number }).status ?? 500 },
    ),
}));

import { GET as getList } from "./route";
import { GET as getEntity } from "./entity/route";
import { GET as getExport } from "./export/route";
import { GET as getRemoved } from "./removed/route";
import { POST as postRestore } from "./restore/route";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const ID = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f";
const ACTOR = "9a8b7c6d-1111-4222-8333-444455556666";

interface Call {
  table: string;
  ops: [string, unknown[]][];
}

// Chainable, thenable query builder keyed by table.
function makeSupabase(opts: {
  byTable?: Record<string, { data: unknown; error?: unknown } | ((call: Call) => { data: unknown; error?: unknown })>;
  rpc?: (fn: string, args: unknown) => { data: unknown; error: unknown };
}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const op of ["select", "eq", "in", "order", "limit", "or", "gte", "lt", "ilike"]) {
      builder[op] = (...args: unknown[]) => {
        call.ops.push([op, args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown) => {
      const r = opts.byTable?.[table];
      const result = typeof r === "function" ? r(call) : (r ?? { data: [] });
      return resolve({ error: null, ...result });
    };
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

function ctx(supabase: unknown) {
  return { supabase, userId: "u1", accountId: "acct", role: "admin", account: { id: "acct", name: "A" } };
}

const forbidden = Object.assign(new Error("This action requires the 'audit.view' permission"), { status: 403 });

const row = (over: Record<string, unknown> = {}) => ({
  id: "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e50",
  created_at: "2026-09-20T10:00:00.000000+00:00",
  actor_id: ACTOR,
  actor_kind: "user",
  actor_label: "Maya (snapshot)",
  action: "updated",
  entity_type: "tag",
  entity_id: ID,
  entity_label: "VIP",
  summary: { changes: { name: { from: "VIP", to: "VIP gold" } } },
  ...over,
});

const req = (path: string) => new Request(`http://localhost/api/account/audit${path}`);

beforeEach(() => {
  h.requireCapability.mockReset();
  __resetRateLimitForTests();
});

describe("GET /api/account/audit", () => {
  it("is refused without audit.view", async () => {
    h.requireCapability.mockRejectedValue(forbidden);
    const res = await getList(req(""));
    expect(res.status).toBe(403);
    expect(h.requireCapability).toHaveBeenCalledWith("audit.view");
  });

  it("returns entries newest first with the actor name, and whether the item still exists", async () => {
    const db = makeSupabase({
      byTable: {
        audit_log: { data: [row(), row({ id: "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e51", entity_id: "gone" })] },
        profiles: { data: [{ user_id: ACTOR, full_name: "Maya", email: "m@x.io" }] },
        tags: { data: [{ id: ID }] },
      },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));

    const res = await getList(req("?limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      actor: { id: ACTOR, kind: "user", name: "Maya" },
      action: "updated",
      entityType: "tag",
      entityLabel: "VIP",
      entityExists: true,
    });
    expect(body.entries[1].entityExists).toBe(false);

    const list = db.calls.find((c) => c.table === "audit_log")!;
    expect(list.ops).toContainEqual(["eq", ["account_id", "acct"]]);
    expect(list.ops).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(list.ops).toContainEqual(["order", ["id", { ascending: false }]]);
    expect(list.ops).toContainEqual(["limit", [11]]);
  });

  it("falls back to the name snapshot when the person has left", async () => {
    const db = makeSupabase({
      byTable: { audit_log: { data: [row()] }, profiles: { data: [] }, tags: { data: [] } },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const body = await (await getList(req(""))).json();
    expect(body.entries[0].actor.name).toBe("Maya (snapshot)");
  });

  it("hands out a cursor when there is another page", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      row({ id: `3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5${i}`, created_at: `2026-09-20T10:00:0${i}.000000+00:00` }),
    );
    const db = makeSupabase({ byTable: { audit_log: { data: rows }, profiles: { data: [] }, tags: { data: [] } } });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const body = await (await getList(req("?limit=2"))).json();
    expect(body.entries).toHaveLength(2);
    expect(body.nextCursor).toBe(`2026-09-20T10:00:01.000000+00:00_3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e51`);
  });

  it("applies the filters and the cursor to the query", async () => {
    const db = makeSupabase({ byTable: { audit_log: { data: [] } } });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const cursor = `2026-09-20T10:00:01.000000+00:00_${ID}`;
    const res = await getList(req(`?action=deleted&entity_type=tag&actor=${ACTOR}&q=vip&cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(200);
    const ops = db.calls.find((c) => c.table === "audit_log")!.ops;
    expect(ops).toContainEqual(["eq", ["action", "deleted"]]);
    expect(ops).toContainEqual(["eq", ["entity_type", "tag"]]);
    expect(ops).toContainEqual(["eq", ["actor_id", ACTOR]]);
    expect(ops).toContainEqual(["ilike", ["entity_label", "%vip%"]]);
    expect(ops.find(([op]) => op === "or")).toBeTruthy();
  });

  it("rejects bad filters and bad cursors with 400", async () => {
    const db = makeSupabase({});
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await getList(req("?action=explode"))).status).toBe(400);
    expect((await getList(req("?cursor=garbage"))).status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it("caps the page size", async () => {
    const db = makeSupabase({ byTable: { audit_log: { data: [] } } });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    await getList(req("?limit=5000"));
    expect(db.calls[0].ops).toContainEqual(["limit", [101]]);
  });

  it("surfaces a database error as 500 without leaking it", async () => {
    const db = makeSupabase({ byTable: { audit_log: { data: null, error: { message: "boom secret" } } } });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await getList(req(""));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});

describe("GET /api/account/audit/entity", () => {
  it("is refused without audit.view", async () => {
    h.requireCapability.mockRejectedValue(forbidden);
    expect((await getEntity(req(`/entity?entity_type=tag&entity_id=${ID}`))).status).toBe(403);
  });

  it("validates the item", async () => {
    const db = makeSupabase({});
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await getEntity(req(`/entity?entity_type=nope&entity_id=${ID}`))).status).toBe(400);
    expect((await getEntity(req("/entity?entity_type=tag&entity_id=1"))).status).toBe(400);
    expect((await getEntity(req("/entity?entity_type=tag"))).status).toBe(400);
  });

  it("returns only that item's history", async () => {
    const db = makeSupabase({
      byTable: {
        audit_log: { data: [row({ action: "created", summary: null })] },
        profiles: { data: [{ user_id: ACTOR, full_name: "Maya", email: null }] },
      },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await getEntity(req(`/entity?entity_type=article&entity_id=${ID}`));
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].actor.name).toBe("Maya");
    const ops = db.calls.find((c) => c.table === "audit_log")!.ops;
    expect(ops).toContainEqual(["eq", ["account_id", "acct"]]);
    expect(ops).toContainEqual(["eq", ["entity_type", "article"]]);
    expect(ops).toContainEqual(["eq", ["entity_id", ID]]);
  });
});

describe("GET /api/account/audit/removed", () => {
  it("is refused without audit.view", async () => {
    h.requireCapability.mockRejectedValue(forbidden);
    expect((await getRemoved()).status).toBe(403);
  });

  it("maps the database rows and drops types it cannot restore", async () => {
    const db = makeSupabase({
      rpc: (fn) => {
        expect(fn).toBe("audit_removed_items");
        return {
          error: null,
          data: [
            { entity_type: "tag", entity_id: ID, label: "VIP", kind: "both", deleted_at: "2026-09-20T09:00:00Z", deleted_by: ACTOR, deleted_by_name: "Maya" },
            { entity_type: "team", entity_id: ID, label: "X", kind: "", deleted_at: "2026-09-20T09:00:00Z", deleted_by: null, deleted_by_name: null },
          ],
        };
      },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const body = await (await getRemoved()).json();
    expect(body.items).toEqual([
      { entityType: "tag", entityId: ID, label: "VIP", kind: "both", deletedAt: "2026-09-20T09:00:00Z", deletedBy: ACTOR, deletedByName: "Maya" },
    ]);
  });

  it("500s when the function fails", async () => {
    const db = makeSupabase({ rpc: () => ({ data: null, error: { code: "XX000", message: "x" } }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await getRemoved()).status).toBe(500);
  });
});

describe("POST /api/account/audit/restore", () => {
  const post = (body: unknown) =>
    postRestore(
      new Request("http://localhost/api/account/audit/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("needs the capability of the item's own manage action", async () => {
    h.requireCapability.mockRejectedValue(forbidden);
    await post({ entity_type: "tag", entity_id: ID });
    expect(h.requireCapability).toHaveBeenLastCalledWith("tags.manage");
    await post({ entity_type: "snippet", entity_id: ID });
    expect(h.requireCapability).toHaveBeenLastCalledWith("snippets.manage");
    await post({ entity_type: "article", entity_id: ID });
    expect(h.requireCapability).toHaveBeenLastCalledWith("knowledge.publish");
    expect((await post({ entity_type: "tag", entity_id: ID })).status).toBe(403);
  });

  it("validates the body", async () => {
    expect((await post({ entity_type: "team", entity_id: ID })).status).toBe(400);
    expect((await post({ entity_type: "tag", entity_id: "x" })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(h.requireCapability).not.toHaveBeenCalled();
  });

  it("restores through the database function", async () => {
    const rpc = vi.fn(() => ({ data: { restored: true }, error: null }));
    const db = makeSupabase({ rpc });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await post({ entity_type: "snippet", entity_id: ID });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("restore_removed_item", { p_entity_type: "snippet", p_id: ID });
  });

  it("answers a name conflict with a friendly 409", async () => {
    const db = makeSupabase({ rpc: () => ({ data: null, error: { code: "23505", message: "name_conflict" } }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await post({ entity_type: "tag", entity_id: ID });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("name_conflict");
    expect(body.error).toMatch(/already exists/);
  });

  it("maps not found and permission errors from the database", async () => {
    const notFound = makeSupabase({ rpc: () => ({ data: null, error: { code: "P0002", message: "x" } }) });
    h.requireCapability.mockResolvedValue(ctx(notFound.client));
    expect((await post({ entity_type: "tag", entity_id: ID })).status).toBe(404);

    const denied = makeSupabase({ rpc: () => ({ data: null, error: { code: "42501", message: "x" } }) });
    h.requireCapability.mockResolvedValue(ctx(denied.client));
    expect((await post({ entity_type: "tag", entity_id: ID })).status).toBe(403);
  });
});

describe("GET /api/account/audit/export", () => {
  it("is refused without audit.view", async () => {
    h.requireCapability.mockRejectedValue(forbidden);
    expect((await getExport(req("/export"))).status).toBe(403);
  });

  it("rejects bad filters before streaming anything", async () => {
    const db = makeSupabase({});
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await getExport(req("/export?action=explode"))).status).toBe(400);
  });

  it("streams a CSV with a BOM, the header and guarded cells", async () => {
    const db = makeSupabase({
      byTable: {
        audit_log: { data: [row({ entity_label: "=cmd()", summary: null })] },
        profiles: { data: [{ user_id: ACTOR, full_name: "Maya", email: null }] },
      },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await getExport(req("/export?entity_type=tag"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // UTF-8 BOM so Excel opens non-ASCII names correctly
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes);
    expect(text.startsWith("Time (UTC),Actor,")).toBe(true);
    const lines = text.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(",Maya,user,updated,tag,'=cmd(),");
    // the filter reached the query
    expect(db.calls.find((c) => c.table === "audit_log")!.ops).toContainEqual(["eq", ["entity_type", "tag"]]);
  });

  it("stops at 10,000 rows", async () => {
    let served = 0;
    const db = makeSupabase({
      byTable: {
        audit_log: (call) => {
          const take = (call.ops.find(([op]) => op === "limit")![1] as number[])[0];
          const data = Array.from({ length: take }, (_, i) =>
            row({
              id: `00000000-0000-4000-8000-${String(served + i).padStart(12, "0")}`,
              created_at: "2026-09-20T10:00:00.000000+00:00",
            }),
          );
          served += take;
          return { data };
        },
        profiles: { data: [] },
      },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await getExport(req("/export"));
    const text = await res.text();
    expect(text.trimEnd().split("\r\n")).toHaveLength(10_001);
    expect(served).toBe(10_000);
  });
});
