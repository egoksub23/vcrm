import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "x" },
      { status: (err as { status?: number }).status ?? 500 },
    ),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: h.admin }));

import { POST as postSchedule } from "./schedules/route";
import { PATCH as patchSchedule, DELETE as deleteSchedule } from "./schedules/[id]/route";
import { POST as postPolicy } from "./policies/route";
import { PATCH as patchPolicy, DELETE as deletePolicy } from "./policies/[id]/route";
import { PUT as putReorder } from "./policies/reorder/route";
import { POST as postApply } from "./apply/route";
import { GET as getCron } from "../../sla/tickets-cron/route";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const ID = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f";
const ID2 = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e60";
const USER = "9a8b7c6d-1111-4222-8333-444455556666";

interface Call {
  table: string;
  op: "insert" | "update" | "delete" | "select";
  payload?: unknown;
  filters: [string, unknown][];
}
type Result = { data?: unknown; error?: unknown; count?: number };
type Handler = (call: Call) => Result;

/** A recording fake of the parts of the Supabase client the routes use. */
function makeClient(handlers: Record<string, Handler> = {}, rpc?: (fn: string, args: unknown) => Result) {
  const calls: Call[] = [];
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    const run = (): Result => {
      calls.push(call);
      const r = (handlers[table] ?? (() => ({})))(call);
      return { data: r.data ?? null, error: r.error ?? null, count: r.count };
    };
    const b: Record<string, unknown> = {};
    b.insert = (payload: unknown) => ((call.op = "insert"), (call.payload = payload), b);
    b.update = (payload: unknown) => ((call.op = "update"), (call.payload = payload), b);
    b.delete = () => ((call.op = "delete"), b);
    b.select = () => b;
    b.eq = (c: string, v: unknown) => (call.filters.push([c, v]), b);
    b.in = (c: string, v: unknown) => (call.filters.push([c, v]), b);
    b.order = () => b;
    b.single = () => Promise.resolve(run());
    b.maybeSingle = () => Promise.resolve(run());
    b.then = (resolve: (v: unknown) => unknown) => resolve(run());
    return b;
  };
  return {
    calls,
    rpcCalls,
    client: {
      from,
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve({ data: null, error: null, ...(rpc ? rpc(fn, args) : {}) });
      },
    },
  };
}

function ctx(client: unknown) {
  return {
    supabase: client,
    userId: USER,
    accountId: "acct",
    role: "admin",
    account: { id: "acct", name: "A" },
    capabilities: new Set(["sla.configure"]),
  };
}

const forbidden = (cap: string) =>
  Object.assign(new Error(`This action requires the '${cap}' permission`), { status: 403 });

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/account/sla/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const weekly = { "1": [{ start: "09:00", end: "18:00" }] };
const goodSchedule = { name: "Support", timezone: "Asia/Kuala_Lumpur", weekly };
const goodPolicy = { name: "Urgent", conditions: { priorities: ["urgent"] }, first_response_minutes: 30, resolution_minutes: 240 };

beforeEach(() => {
  h.requireCapability.mockReset();
  h.admin.mockReset();
  __resetRateLimitForTests();
});

describe("every SLA settings route needs sla.configure", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["POST schedules", () => postSchedule(req("POST", goodSchedule))],
    ["PATCH schedule", () => patchSchedule(req("PATCH", { name: "x" }), params(ID))],
    ["DELETE schedule", () => deleteSchedule(req("DELETE"), params(ID))],
    ["POST policies", () => postPolicy(req("POST", goodPolicy))],
    ["PATCH policy", () => patchPolicy(req("PATCH", { is_active: false }), params(ID))],
    ["DELETE policy", () => deletePolicy(req("DELETE"), params(ID))],
    ["PUT reorder", () => putReorder(req("PUT", { ids: [ID] }))],
    ["POST apply", () => postApply(req("POST", { dryRun: true }))],
  ];
  for (const [name, call] of cases) {
    it(`${name} is refused without it and never touches the database`, async () => {
      h.requireCapability.mockRejectedValue(forbidden("sla.configure"));
      const res = await call();
      expect(res.status).toBe(403);
      expect(h.requireCapability).toHaveBeenCalledWith("sla.configure");
    });
  }
});

describe("POST /api/account/sla/schedules", () => {
  it("creates a schedule in the caller's account with its holidays", async () => {
    const db = makeClient({
      business_hours_schedules: (c) => ({ data: c.op === "insert" ? { id: ID, name: "Support" } : null }),
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postSchedule(
      req("POST", { ...goodSchedule, holidays: [{ date: "2026-12-25", name: "Christmas" }], account_id: "someone-else" }),
    );
    expect(res.status).toBe(201);
    const insert = db.calls.find((c) => c.table === "business_hours_schedules" && c.op === "insert")!;
    expect(insert.payload).toMatchObject({ account_id: "acct", name: "Support", timezone: "Asia/Kuala_Lumpur" });
    expect((insert.payload as Record<string, unknown>).account_id).toBe("acct");
    const holidays = db.calls.find((c) => c.table === "business_hours_holidays" && c.op === "insert")!;
    expect(holidays.payload).toEqual([{ schedule_id: ID, account_id: "acct", holiday_date: "2026-12-25", name: "Christmas" }]);
  });

  it("names the problem for bad input and touches nothing", async () => {
    const db = makeClient();
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const cases: [unknown, string][] = [
      [{ ...goodSchedule, timezone: "Mars/Base" }, "invalid_timezone"],
      [{ ...goodSchedule, name: "" }, "invalid_name"],
      [{ ...goodSchedule, weekly: { "1": [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] } }, "overlap"],
      [{ ...goodSchedule, weekly: { "1": [] } }, "no_open_day"],
      [{ ...goodSchedule, holidays: [{ date: "2026-02-30" }] }, "invalid_date"],
      [{ ...goodSchedule, holidays: [{ date: "2026-01-01" }, { date: "2026-01-01" }] }, "duplicate_holiday"],
    ];
    for (const [body, code] of cases) {
      const res = await postSchedule(req("POST", body));
      expect(res.status, code).toBe(code === "duplicate_holiday" ? 409 : 400);
      expect((await res.json()).error).toBe(code);
    }
    expect(db.calls).toHaveLength(0);
  });

  it("maps a database refusal and removes a half-made schedule when its holidays fail", async () => {
    const db = makeClient({
      business_hours_schedules: (c) => (c.op === "insert" ? { data: { id: ID } } : {}),
      business_hours_holidays: () => ({ error: { code: "23505", message: "duplicate key" } }),
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postSchedule(req("POST", { ...goodSchedule, holidays: [{ date: "2026-12-25" }] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("duplicate_holiday");
    const cleanup = db.calls.find((c) => c.table === "business_hours_schedules" && c.op === "delete");
    expect(cleanup?.filters).toContainEqual(["id", ID]);
  });

  it("a Postgres timezone refusal comes back as invalid_timezone", async () => {
    const db = makeClient({
      business_hours_schedules: () => ({ error: { code: "22023", message: "sla_timezone_invalid: X" } }),
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postSchedule(req("POST", goodSchedule));
    expect((await res.json()).error).toBe("invalid_timezone");
  });
});

describe("PATCH /api/account/sla/schedules/[id]", () => {
  it("rejects a malformed id and an empty patch", async () => {
    const db = makeClient();
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await patchSchedule(req("PATCH", { name: "x" }), params("nope"))).status).toBe(404);
    const res = await patchSchedule(req("PATCH", {}), params(ID));
    expect(res.status).toBe(400);
  });

  it("is 404 for a schedule outside the account", async () => {
    const db = makeClient({ business_hours_schedules: () => ({ data: null }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await patchSchedule(req("PATCH", { name: "x" }), params(ID));
    expect(res.status).toBe(404);
  });

  it("turns the holiday list into removes, renames and adds", async () => {
    const db = makeClient({
      business_hours_schedules: () => ({ data: { id: ID } }),
      business_hours_holidays: (c) =>
        c.op === "select"
          ? {
              data: [
                { id: "h1", holiday_date: "2026-01-01", name: "New Year" },
                { id: "h2", holiday_date: "2026-05-01", name: "Labour" },
                { id: "h3", holiday_date: "2026-12-25", name: "Xmas" },
              ],
            }
          : {},
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await patchSchedule(
      req("PATCH", {
        is_default: true,
        holidays: [
          { date: "2026-01-01", name: "New Year" },
          { date: "2026-12-25", name: "Christmas" },
          { date: "2026-08-31", name: "National Day" },
        ],
      }),
      params(ID),
    );
    expect(res.status).toBe(200);
    const holidayOps = db.calls.filter((c) => c.table === "business_hours_holidays" && c.op !== "select");
    expect(holidayOps.map((c) => c.op).sort()).toEqual(["delete", "insert", "update"]);
    expect(holidayOps.find((c) => c.op === "delete")!.filters).toContainEqual(["id", ["h2"]]);
    expect(holidayOps.find((c) => c.op === "update")!.payload).toEqual({ name: "Christmas" });
    expect(holidayOps.find((c) => c.op === "insert")!.payload).toEqual([
      { schedule_id: ID, account_id: "acct", holiday_date: "2026-08-31", name: "National Day" },
    ]);
    const update = db.calls.find((c) => c.table === "business_hours_schedules" && c.op === "update")!;
    expect(update.payload).toEqual({ is_default: true });
    expect(update.filters).toContainEqual(["account_id", "acct"]);
  });

  it("refuses to un-set the default directly", async () => {
    const db = makeClient({
      business_hours_schedules: (c) =>
        c.op === "update" ? { error: { code: "22023", message: "sla_default_required" } } : { data: { id: ID } },
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await patchSchedule(req("PATCH", { is_default: false }), params(ID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("default_required");
  });
});

describe("DELETE /api/account/sla/schedules/[id]", () => {
  it("is blocked with a friendly 409 while a policy uses the schedule", async () => {
    const db = makeClient({ ticket_sla_policies: () => ({ count: 2 }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await deleteSchedule(req("DELETE"), params(ID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("schedule_in_use");
    expect(db.calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("deletes inside the account and answers 404 for an unknown schedule", async () => {
    const db = makeClient({
      ticket_sla_policies: () => ({ count: 0 }),
      business_hours_schedules: () => ({ data: [{ id: ID }] }),
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await deleteSchedule(req("DELETE"), params(ID))).status).toBe(200);
    expect(db.calls.find((c) => c.op === "delete")!.filters).toEqual([
      ["id", ID],
      ["account_id", "acct"],
    ]);
    const none = makeClient({ ticket_sla_policies: () => ({ count: 0 }), business_hours_schedules: () => ({ data: [] }) });
    h.requireCapability.mockResolvedValue(ctx(none.client));
    expect((await deleteSchedule(req("DELETE"), params(ID))).status).toBe(404);
  });

  it("maps the foreign key refusal too", async () => {
    const db = makeClient({
      ticket_sla_policies: () => ({ count: 0 }),
      business_hours_schedules: () => ({
        error: { code: "23503", message: 'update or delete on table "business_hours_schedules" violates foreign key constraint' },
      }),
    });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await deleteSchedule(req("DELETE"), params(ID));
    expect(res.status).toBe(409);
  });
});

describe("policies", () => {
  it("POST creates in the caller's account and validates the targets", async () => {
    const db = makeClient({ ticket_sla_policies: () => ({ data: { id: ID, name: "Urgent" } }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const ok = await postPolicy(req("POST", { ...goodPolicy, account_id: "someone-else" }));
    expect(ok.status).toBe(201);
    expect((db.calls[0].payload as Record<string, unknown>).account_id).toBe("acct");
    expect(db.calls[0].payload).toMatchObject({ first_response_minutes: 30, resolution_minutes: 240, conditions: { priorities: ["urgent"] } });

    for (const [body, code] of [
      [{ name: "x" }, "invalid_targets"],
      [{ ...goodPolicy, first_response_minutes: 300, resolution_minutes: 60 }, "targets_order"],
      [{ ...goodPolicy, at_risk_percent: 20 }, "invalid_percent"],
      [{ ...goodPolicy, conditions: { priorities: ["asap"] } }, "invalid_conditions"],
      [{ ...goodPolicy, name: " " }, "invalid_name"],
    ] as [unknown, string][]) {
      const res = await postPolicy(req("POST", body));
      expect(res.status, code).toBe(400);
      expect((await res.json()).error).toBe(code);
    }
  });

  it("POST maps the database limits", async () => {
    const db = makeClient({ ticket_sla_policies: () => ({ error: { code: "54000", message: "sla_policy_limit" } }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postPolicy(req("POST", goodPolicy));
    expect((await res.json()).error).toBe("policy_limit");
    const db2 = makeClient({ ticket_sla_policies: () => ({ error: { code: "23503", message: "sla_schedule_missing" } }) });
    h.requireCapability.mockResolvedValue(ctx(db2.client));
    expect((await (await postPolicy(req("POST", goodPolicy))).json()).error).toBe("schedule_missing");
  });

  it("PATCH updates only what was sent, inside the account", async () => {
    const db = makeClient({ ticket_sla_policies: () => ({ data: { id: ID } }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await patchPolicy(req("PATCH", { is_active: false }), params(ID));
    expect(res.status).toBe(200);
    expect(db.calls[0].payload).toEqual({ is_active: false });
    expect(db.calls[0].filters).toEqual([
      ["id", ID],
      ["account_id", "acct"],
    ]);
    const nothing = makeClient({ ticket_sla_policies: () => ({ data: null }) });
    h.requireCapability.mockResolvedValue(ctx(nothing.client));
    expect((await patchPolicy(req("PATCH", { is_active: true }), params(ID))).status).toBe(404);
    expect((await patchPolicy(req("PATCH", {}), params(ID))).status).toBe(400);
  });

  it("DELETE is 404 when nothing was deleted", async () => {
    const db = makeClient({ ticket_sla_policies: () => ({ data: [] }) });
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await deletePolicy(req("DELETE"), params(ID))).status).toBe(404);
    const ok = makeClient({ ticket_sla_policies: () => ({ data: [{ id: ID }] }) });
    h.requireCapability.mockResolvedValue(ctx(ok.client));
    expect((await deletePolicy(req("DELETE"), params(ID))).status).toBe(200);
  });
});

describe("PUT /api/account/sla/policies/reorder", () => {
  it("sends the new order to the database in one call", async () => {
    const db = makeClient();
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await putReorder(req("PUT", { ids: [ID2, ID] }));
    expect(res.status).toBe(200);
    expect(db.rpcCalls).toEqual([{ fn: "sla_reorder_policies", args: { p_account: "acct", p_ids: [ID2, ID] } }]);
  });

  it("rejects an empty list, a repeat or a non-id", async () => {
    const db = makeClient();
    h.requireCapability.mockResolvedValue(ctx(db.client));
    for (const ids of [[], [ID, ID], ["nope"], "x", undefined]) {
      expect((await putReorder(req("PUT", { ids }))).status).toBe(400);
    }
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("maps a database refusal", async () => {
    const db = makeClient({}, () => ({ error: { code: "42501", message: "sla_reorder: not allowed" } }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    expect((await putReorder(req("PUT", { ids: [ID] }))).status).toBe(403);
  });
});

describe("POST /api/account/sla/apply", () => {
  it("passes dryRun through and returns the counts", async () => {
    const counts = { matched: 3, overdue: 1, examined: 9, truncated: false, applied: false };
    const db = makeClient({}, () => ({ data: counts }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    const res = await postApply(req("POST", { dryRun: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(counts);
    expect(db.rpcCalls[0]).toEqual({ fn: "sla_apply_to_open_tickets", args: { p_account: "acct", p_dry_run: true } });
    await postApply(req("POST", { dryRun: false }));
    expect(db.rpcCalls[1].args).toEqual({ p_account: "acct", p_dry_run: false });
  });

  it("needs an explicit boolean, so it can never apply by accident", async () => {
    const db = makeClient();
    h.requireCapability.mockResolvedValue(ctx(db.client));
    for (const body of [{}, { dryRun: "false" }, null]) {
      expect((await postApply(req("POST", body))).status).toBe(400);
    }
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("is rate limited", async () => {
    const db = makeClient({}, () => ({ data: {} }));
    h.requireCapability.mockResolvedValue(ctx(db.client));
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await postApply(req("POST", { dryRun: true }))).status;
    expect(last).toBe(429);
  });
});

describe("GET /api/sla/tickets-cron", () => {
  const cronReq = (secret?: string) =>
    new Request("http://localhost/api/sla/tickets-cron", { headers: secret === undefined ? {} : { "x-cron-secret": secret } });

  it("is not configured without the secret, and refuses a wrong one", async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    expect((await getCron(cronReq("x"))).status).toBe(503);
    process.env.AUTOMATION_CRON_SECRET = "s3cret";
    expect((await getCron(cronReq())).status).toBe(401);
    expect((await getCron(cronReq("wrong!"))).status).toBe(401);
    expect(h.admin).not.toHaveBeenCalled();
  });

  it("runs one sweep of 200 tickets and returns its counts", async () => {
    process.env.AUTOMATION_CRON_SECRET = "s3cret";
    const rpc = vi.fn().mockResolvedValue({ data: { breached: 2, tickets_notified: 2, notifications: 3 }, error: null });
    h.admin.mockReturnValue({ rpc });
    const res = await getCron(cronReq("s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ breached: 2, tickets_notified: 2, notifications: 3 });
    expect(rpc).toHaveBeenCalledWith("sla_sweep", { p_limit: 200 });
  });

  it("reports a database failure as 500", async () => {
    process.env.AUTOMATION_CRON_SECRET = "s3cret";
    h.admin.mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) });
    expect((await getCron(cronReq("s3cret"))).status).toBe(500);
  });
});
