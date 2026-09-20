import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadCapabilities: vi.fn(),
  requireAnyCapability: vi.fn(),
  requireCapability: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: h.getCurrentAccount,
  loadCapabilities: h.loadCapabilities,
  requireAnyCapability: h.requireAnyCapability,
  requireCapability: h.requireCapability,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "x" },
      { status: (err as { status?: number }).status ?? 500 },
    ),
}));

import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";

const ID = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f";
const USER = "9a8b7c6d-1111-4222-8333-444455556666";

interface Op {
  op: string;
  args: unknown[];
}

function makeClient(opts: { rows?: unknown[]; rpc?: (fn: string, args: unknown) => unknown }) {
  const ops: Op[] = [];
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const b: Record<string, unknown> = {};
  for (const op of ["select", "order", "eq", "insert", "update", "delete"]) {
    b[op] = (...args: unknown[]) => {
      ops.push({ op, args });
      return b;
    };
  }
  b.single = () => Promise.resolve({ data: { id: ID }, error: null });
  b.then = (resolve: (v: unknown) => unknown) => resolve({ data: opts.rows ?? [], error: null });
  return {
    ops,
    rpcCalls,
    client: {
      from: () => b,
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve(opts.rpc ? opts.rpc(fn, args) : { data: { id: ID, mode: "proposed" }, error: null });
      },
    },
  };
}

const ctx = (client: unknown, caps: string[]) => ({
  supabase: client,
  userId: USER,
  accountId: "acct",
  role: "agent",
  account: { id: "acct", name: "A" },
  capabilities: new Set(caps),
});

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/quick-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/quick-replies/${ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ID }) },
  );

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
});

describe("POST /api/quick-replies", () => {
  it("writes the snippet directly for someone who can manage (today's behaviour)", async () => {
    const db = makeClient({});
    h.requireAnyCapability.mockResolvedValue(ctx(db.client, ["snippets.manage", "snippets.propose"]));
    const res = await post({ title: "Hours", kind: "text", content_text: "We open at 9" });
    expect(res.status).toBe(201);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.ops.some((o) => o.op === "insert")).toBe(true);
    expect(h.requireAnyCapability).toHaveBeenCalledWith(["snippets.manage", "snippets.propose"]);
  });

  it("records a proposal for someone who can only propose, and never touches the table", async () => {
    const db = makeClient({});
    h.requireAnyCapability.mockResolvedValue(ctx(db.client, ["snippets.propose"]));
    const res = await post({ title: "Hours", kind: "text", content_text: "We open at 9" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ pending: true, id: ID });
    expect(db.ops.some((o) => o.op === "insert")).toBe(false);
    expect(db.rpcCalls).toEqual([
      {
        fn: "propose_snippet",
        args: { p_title: "Hours", p_kind: "text", p_content_text: "We open at 9", p_interactive_payload: null },
      },
    ]);
  });

  it("still validates before proposing", async () => {
    const db = makeClient({});
    h.requireAnyCapability.mockResolvedValue(ctx(db.client, ["snippets.propose"]));
    expect((await post({ title: "", content_text: "x" })).status).toBe(400);
    expect((await post({ title: "Hours", kind: "text", content_text: "  " })).status).toBe(400);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("is denied without either capability", async () => {
    h.requireAnyCapability.mockRejectedValue(
      Object.assign(new Error("This action requires the 'snippets.manage' or 'snippets.propose' permission"), {
        status: 403,
      }),
    );
    expect((await post({ title: "x", content_text: "x" })).status).toBe(403);
  });

  it("maps a database refusal to the friendly code", async () => {
    const db = makeClient({ rpc: () => ({ data: null, error: { message: "invalid_content", code: "22023" } }) });
    h.requireAnyCapability.mockResolvedValue(ctx(db.client, ["snippets.propose"]));
    const res = await post({ title: "Hours", kind: "text", content_text: "We open at 9" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_content");
  });
});

describe("PATCH /api/quick-replies/[id]", () => {
  it("edits the live snippet for someone who can manage", async () => {
    const db = makeClient({});
    h.requireAnyCapability.mockResolvedValue(ctx(db.client, ["snippets.manage"]));
    const res = await patch({ title: "Hours v2" });
    expect(res.status).toBe(200);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.ops.find((o) => o.op === "update")?.args[0]).toEqual({ title: "Hours v2" });
  });

  it("stores a pending edit for someone who can only propose; the live snippet is not written", async () => {
    const db = makeClient({});
    h.requireAnyCapability.mockResolvedValue(ctx(db.client, ["snippets.propose"]));
    const res = await patch({ title: "Hours v2", content_text: "We open at 10" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pending: true });
    expect(db.ops.some((o) => o.op === "update")).toBe(false);
    expect(db.rpcCalls).toEqual([
      {
        fn: "propose_snippet_edit",
        args: { p_id: ID, p_patch: { title: "Hours v2", content_text: "We open at 10" } },
      },
    ]);
  });

  it("relays 'an edit is already waiting' and 'nothing changed'", async () => {
    for (const [message, sqlstate, status] of [
      ["edit_pending", "P0001", 409],
      ["no_changes", "22023", 400],
    ] as const) {
      const db = makeClient({ rpc: () => ({ data: null, error: { message, code: sqlstate } }) });
      h.requireAnyCapability.mockResolvedValue(ctx(db.client, ["snippets.propose"]));
      const res = await patch({ title: "Other" });
      expect(res.status, message).toBe(status);
      expect((await res.json()).code, message).toBe(message);
    }
  });
});

describe("DELETE /api/quick-replies/[id]", () => {
  it("needs snippets.manage: proposing is not enough", async () => {
    h.requireCapability.mockRejectedValue(
      Object.assign(new Error("This action requires the 'snippets.manage' permission"), { status: 403 }),
    );
    const res = await DELETE(new Request(`http://localhost/api/quick-replies/${ID}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: ID }),
    });
    expect(res.status).toBe(403);
    expect(h.requireCapability).toHaveBeenCalledWith("snippets.manage");
  });
});

describe("GET /api/quick-replies", () => {
  const pending = {
    id: "a",
    approval_status: "pending",
    proposed_by: "someone-else",
    pending_edit: { title: "secret" },
    edit_status: "pending",
  };

  it("lists what RLS shows and strips a pending edit the caller may not see", async () => {
    const db = makeClient({ rows: [pending, { ...pending, id: "b", proposed_by: USER }] });
    h.getCurrentAccount.mockResolvedValue(ctx(db.client, []));
    h.loadCapabilities.mockResolvedValue(new Set(["snippets.propose"]));
    const body = await (await GET(new Request("http://localhost/api/quick-replies"))).json();
    expect(body.quick_replies[0].pending_edit).toBeNull();
    expect(body.quick_replies[1].pending_edit).toEqual({ title: "secret" });
  });

  it("keeps a pending edit for reviewers", async () => {
    const db = makeClient({ rows: [pending] });
    h.getCurrentAccount.mockResolvedValue(ctx(db.client, []));
    h.loadCapabilities.mockResolvedValue(new Set(["approvals.review"]));
    const body = await (await GET(new Request("http://localhost/api/quick-replies"))).json();
    expect(body.quick_replies[0].pending_edit).toEqual({ title: "secret" });
  });

  it("?usable=1 asks for approved snippets only (what every picker uses)", async () => {
    const db = makeClient({ rows: [] });
    h.getCurrentAccount.mockResolvedValue(ctx(db.client, []));
    h.loadCapabilities.mockResolvedValue(new Set());
    await GET(new Request("http://localhost/api/quick-replies?usable=1"));
    expect(db.ops).toContainEqual({ op: "eq", args: ["approval_status", "approved"] });

    const all = makeClient({ rows: [] });
    h.getCurrentAccount.mockResolvedValue(ctx(all.client, []));
    await GET(new Request("http://localhost/api/quick-replies"));
    expect(all.ops.some((o) => o.op === "eq")).toBe(false);
  });
});
