import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  requireAnyCapability: vi.fn(),
  indexArticle: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  requireAnyCapability: h.requireAnyCapability,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "x" },
      { status: (err as { status?: number }).status ?? 500 },
    ),
}));

vi.mock("@/lib/knowledge/articles", () => ({ indexArticle: h.indexArticle }));

import { GET as getList } from "./route";
import { GET as getCount } from "./count/route";
import { POST as postDecide } from "./decide/route";
import { POST as postWithdraw } from "./withdraw/route";
import { GET as getSettings, PATCH as patchSettings } from "./settings/route";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const ID = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f";
const ID2 = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e60";
const USER = "9a8b7c6d-1111-4222-8333-444455556666";

type Rpc = (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown };

function makeClient(rpc: Rpc, tables: Record<string, unknown> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq"]) b[op] = () => b;
    b.maybeSingle = () => Promise.resolve({ data: tables[table] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
    return b;
  };
  return {
    calls,
    client: {
      from,
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve(rpc(fn, args));
      },
    },
  };
}

function ctx(client: unknown, extra: Record<string, unknown> = {}) {
  return {
    supabase: client,
    userId: USER,
    accountId: "acct",
    role: "admin",
    account: { id: "acct", name: "A" },
    capabilities: new Set(["approvals.review", "roles.manage", "snippets.manage", "knowledge.publish"]),
    ...extra,
  };
}

const forbidden = (cap: string) =>
  Object.assign(new Error(`This action requires the '${cap}' permission`), { status: 403 });

const json = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/account/approvals${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const pgError = (message: string, code: string) => ({ data: null, error: { message, code } });

beforeEach(() => {
  h.requireCapability.mockReset();
  h.requireAnyCapability.mockReset();
  h.indexArticle.mockReset();
  __resetRateLimitForTests();
});

describe("GET /api/account/approvals", () => {
  it("is refused without approvals.review", async () => {
    h.requireCapability.mockRejectedValue(forbidden("approvals.review"));
    const res = await getList(new Request("http://localhost/api/account/approvals"));
    expect(res.status).toBe(403);
    expect(h.requireCapability).toHaveBeenCalledWith("approvals.review");
  });

  it("passes the filters to approvals_list and returns its items", async () => {
    const db = makeClient(() => ({ data: [{ entity_type: "tag", entity_id: ID }], error: null }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await getList(
      new Request(
        `http://localhost/api/account/approvals?tab=decided&type=label&proposer=${USER}&since=2026-09-01T00:00:00Z&limit=20`,
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    expect(db.calls[0]).toEqual({
      fn: "approvals_list",
      args: {
        p_tab: "decided",
        p_type: "label",
        p_proposer: USER,
        p_since: "2026-09-01T00:00:00.000Z",
        p_limit: 20,
      },
    });
  });

  it("defaults to the pending tab and rejects bad filters", async () => {
    const db = makeClient(() => ({ data: [], error: null }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    await getList(new Request("http://localhost/api/account/approvals"));
    expect(db.calls[0].args).toMatchObject({ p_tab: "pending", p_type: null, p_proposer: null, p_limit: 200 });

    for (const q of ["?tab=other", "?type=deal", "?proposer=nope", "?since=yesterday"]) {
      const res = await getList(new Request(`http://localhost/api/account/approvals${q}`));
      expect(res.status, q).toBe(400);
    }
  });

  it("maps a database refusal to 403", async () => {
    const db = makeClient(() => pgError("This action requires the 'approvals.review' permission", "42501"));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await getList(new Request("http://localhost/api/account/approvals"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
  });
});

describe("GET /api/account/approvals/count", () => {
  it("is refused without approvals.review", async () => {
    h.requireCapability.mockRejectedValue(forbidden("approvals.review"));
    expect((await getCount()).status).toBe(403);
  });

  it("returns the badge number", async () => {
    const db = makeClient(() => ({ data: 4, error: null }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await getCount();
    expect(await res.json()).toEqual({ count: 4 });
    expect(db.calls[0].fn).toBe("approvals_pending_count");
  });
});

describe("POST /api/account/approvals/decide", () => {
  it("is refused without approvals.review", async () => {
    h.requireCapability.mockRejectedValue(forbidden("approvals.review"));
    const res = await postDecide(json("/decide", "POST", { entity_type: "tag", id: ID, decision: "approve" }));
    expect(res.status).toBe(403);
  });

  it("approves through decide_proposal with edited values", async () => {
    const db = makeClient(() => ({ data: { decision: "approve", mode: "new" }, error: null }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postDecide(
      json("/decide", "POST", { entity_type: "tag", id: ID, decision: "approve", edited: { name: "Wholesale pro" } }),
    );
    expect(res.status).toBe(200);
    expect(db.calls[0]).toEqual({
      fn: "decide_proposal",
      args: {
        p_entity_type: "tag",
        p_id: ID,
        p_decision: "approve",
        p_note: null,
        p_edited: { name: "Wholesale pro" },
      },
    });
  });

  it("needs a note of at least 3 characters to reject", async () => {
    const db = makeClient(() => ({ data: {}, error: null }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    for (const note of [undefined, "", "  ", "ab"]) {
      const res = await postDecide(
        json("/decide", "POST", { entity_type: "snippet", id: ID, decision: "reject", note }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("note_required");
    }
    expect(db.calls).toHaveLength(0);

    const ok = await postDecide(
      json("/decide", "POST", { entity_type: "snippet", id: ID, decision: "reject", note: "Too vague" }),
    );
    expect(ok.status).toBe(200);
    expect(db.calls[0].args).toMatchObject({ p_decision: "reject", p_note: "Too vague" });
  });

  it("validates the body", async () => {
    const db = makeClient(() => ({ data: {}, error: null }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const bad: unknown[] = [
      { entity_type: "tag", id: ID, decision: "maybe" },
      { entity_type: "deal", id: ID, decision: "approve" },
      { entity_type: "tag", id: "nope", decision: "approve" },
      { entity_type: "tag", id: ID, decision: "approve", edited: "x" },
      { entity_type: "tag", id: ID, decision: "reject", note: "Too vague", edited: { name: "x" } },
      { decision: "approve", items: [] },
      { decision: "approve", items: [{ entity_type: "tag", id: "nope" }] },
      { decision: "reject", note: "Too vague", items: [{ entity_type: "tag", id: ID }] },
    ];
    for (const body of bad) {
      const res = await postDecide(json("/decide", "POST", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(db.calls).toHaveLength(0);
  });

  it("turns a conflict, an own proposal and a decided item into friendly codes", async () => {
    for (const [message, sqlstate, status, code] of [
      ["name_conflict", "23505", 409, "name_conflict"],
      ["own_proposal", "42501", 403, "own_proposal"],
      ["not_pending", "P0001", 409, "not_pending"],
      ["not_found", "P0002", 404, "not_found"],
    ] as const) {
      const db = makeClient(() => pgError(message, sqlstate));
      h.requireCapability.mockResolvedValue(ctx(db.client));
      const res = await postDecide(json("/decide", "POST", { entity_type: "tag", id: ID, decision: "approve" }));
      expect(res.status, message).toBe(status);
      expect((await res.json()).code, message).toBe(code);
    }
  });

  it("does not leak an unknown database error", async () => {
    const db = makeClient(() => pgError("relation secret_table does not exist", "42P01"));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postDecide(json("/decide", "POST", { entity_type: "tag", id: ID, decision: "approve" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret_table");
  });

  it("re-indexes an approved (published) article and passes the warning on", async () => {
    const db = makeClient(() => ({ data: { decision: "approve", published: true }, error: null }), {
      ai_knowledge_documents: { id: ID, title: "Returns", content: "14 days", status: "published" },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    h.indexArticle.mockResolvedValue("Saved, but meaning-search indexing failed");
    const res = await postDecide(json("/decide", "POST", { entity_type: "article", id: ID, decision: "approve" }));
    expect(res.status).toBe(200);
    expect((await res.json()).warning).toContain("indexing failed");
    expect(h.indexArticle).toHaveBeenCalledWith(db.client, "acct", {
      id: ID,
      title: "Returns",
      content: "14 days",
      status: "published",
    });
  });

  it("approves several at once and reports the ones that failed", async () => {
    const db = makeClient((_fn, args) =>
      args.p_id === ID2 ? pgError("not_pending", "P0001") : { data: { decision: "approve" }, error: null },
    );
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postDecide(
      json("/decide", "POST", {
        decision: "approve",
        items: [
          { entity_type: "tag", id: ID },
          { entity_type: "snippet", id: ID2 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ approved: 1, failed: 1 });
    expect(body.results[1]).toMatchObject({ id: ID2, ok: false, code: "not_pending" });
    expect(db.calls.map((c) => c.fn)).toEqual(["decide_proposal", "decide_proposal"]);
  });
});

describe("POST /api/account/approvals/withdraw", () => {
  it("needs one of the propose capabilities", async () => {
    h.requireAnyCapability.mockRejectedValue(forbidden("tags.propose' or 'snippets.propose"));
    const res = await postWithdraw(json("/withdraw", "POST", { entity_type: "tag", id: ID }));
    expect(res.status).toBe(403);
    expect(h.requireAnyCapability).toHaveBeenCalledWith(["tags.propose", "snippets.propose"]);
  });

  it("withdraws through the RPC and validates the body", async () => {
    const db = makeClient(() => ({ data: { withdrawn: true }, error: null }));
    h.requireAnyCapability.mockResolvedValue(ctx(db.client));
    const ok = await postWithdraw(json("/withdraw", "POST", { entity_type: "snippet", id: ID }));
    expect(ok.status).toBe(200);
    expect(db.calls[0]).toEqual({ fn: "withdraw_proposal", args: { p_entity_type: "snippet", p_id: ID } });

    for (const body of [{ entity_type: "article", id: ID }, { entity_type: "tag", id: "nope" }, {}]) {
      expect((await postWithdraw(json("/withdraw", "POST", body))).status).toBe(400);
    }
  });

  it("only the proposer may withdraw", async () => {
    const db = makeClient(() => pgError("Only the person who proposed it can withdraw it", "42501"));
    h.requireAnyCapability.mockResolvedValue(ctx(db.client));
    const res = await postWithdraw(json("/withdraw", "POST", { entity_type: "tag", id: ID }));
    expect(res.status).toBe(403);
  });
});

describe("GET/PATCH /api/account/approvals/settings", () => {
  it("shows snippets as direct by default and tags as always reviewed", async () => {
    const db = makeClient(() => ({ data: null, error: null }), { role_capabilities: [] });
    h.requireAnyCapability.mockResolvedValue(ctx(db.client));
    const res = await getSettings();
    expect(await res.json()).toEqual({
      snippets: { needsApproval: false },
      tags: { needsApproval: true, locked: true },
      canEdit: true,
    });
  });

  it("reads an override that removed snippets.manage from Agents", async () => {
    const db = makeClient(() => ({ data: null, error: null }), {
      role_capabilities: [{ capability: "snippets.manage", granted: false }],
    });
    h.requireAnyCapability.mockResolvedValue(ctx(db.client));
    const body = await (await getSettings()).json();
    expect(body.snippets.needsApproval).toBe(true);
  });

  it("cannot be edited by a reviewer without roles.manage", async () => {
    const db = makeClient(() => ({ data: null, error: null }), { role_capabilities: [] });
    h.requireAnyCapability.mockResolvedValue(
      ctx(db.client, { capabilities: new Set(["approvals.review"]) }),
    );
    expect((await (await getSettings()).json()).canEdit).toBe(false);
  });

  it("PATCH is refused without roles.manage", async () => {
    h.requireCapability.mockRejectedValue(forbidden("roles.manage"));
    const res = await patchSettings(json("/settings", "PATCH", { snippets: true }));
    expect(res.status).toBe(403);
    expect(h.requireCapability).toHaveBeenCalledWith("roles.manage");
  });

  it("turns approval ON by revoking snippets.manage and OFF by resetting it, for the Agent role", async () => {
    const db = makeClient(() => ({ data: { changed: 1 }, error: null }));
    h.requireCapability.mockResolvedValue(ctx(db.client));

    await patchSettings(json("/settings", "PATCH", { snippets: true }));
    expect(db.calls[0]).toEqual({
      fn: "set_role_capabilities",
      args: { target_account_id: "acct", target_role: "agent", changes: { "snippets.manage": false } },
    });

    await patchSettings(json("/settings", "PATCH", { snippets: false }));
    expect(db.calls[1].args.changes).toEqual({ "snippets.manage": null });
  });

  it("validates the body and relays the database guardrails", async () => {
    const db = makeClient(() => pgError("You cannot grant 'snippets.manage' because you do not hold it yourself", "42501"));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await patchSettings(json("/settings", "PATCH", { snippets: "yes" }))).status).toBe(400);
    expect((await patchSettings(json("/settings", "PATCH", {}))).status).toBe(400);
    const res = await patchSettings(json("/settings", "PATCH", { snippets: false }));
    expect(res.status).toBe(403);
  });
});
