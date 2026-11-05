/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are read loosely in a test */
// Raising an incident under a template, and switching templates / frameworks
// (migration 206), against the in-memory stand-in for the database. The
// triggers (one active template, catalogue validation, obligation sync) are
// SQL and are pinned by src/lib/incidents/migration-206.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const h = vi.hoisted(() => ({
  db: null as unknown,
  caps: new Set<string>(["incidents.raise", "incidents.manage"]),
}));

vi.mock("@/lib/auth/account", () => {
  const denied = (what: string) => Object.assign(new Error(`This action requires the '${what}' permission`), { status: 403 });
  return {
    requireCapability: async (c: string) => {
      if (!h.caps.has(c)) throw denied(c);
      return { userId: "u1", accountId: "acct", role: "admin", supabase: (h.db as FakeDb).client() };
    },
    toErrorResponse: (err: unknown) =>
      new Response(JSON.stringify({ error: String((err as Error).message) }), { status: (err as { status?: number }).status ?? 500 }),
  };
});

import { POST as raise } from "./route";
import { GET as getStandards, PATCH as patchStandard } from "./settings/standard/route";

const BNM = "00000000-0000-4000-8000-0000000000b1";
const SCHOOL = "00000000-0000-4000-8000-0000000000c1";
const PDPA = "00000000-0000-4000-8000-0000000000d1";
const ISO45001 = "00000000-0000-4000-8000-0000000000d2";

let db: FakeDb;

const json = (method: string, body?: unknown) =>
  new Request("https://halo.test/api/incidents", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
const active = (standardId: string) => (db.rows("account_incident_standards") as any[]).find((r) => r.standard_id === standardId)?.is_active;

function seedWorld(activeStandards: string[]) {
  db = new FakeDb();
  h.db = db;
  db.seed("incident_standards", [
    { id: BNM, slug: "bnm_rmit", name: "BNM RMiT", kind: "template", created_at: "2026-01-01" },
    { id: SCHOOL, slug: "school_incident", name: "School Incident Management", kind: "template", created_at: "2026-02-01" },
    { id: PDPA, slug: "pdpa_my", name: "PDPA", kind: "framework", created_at: "2026-03-01" },
    { id: ISO45001, slug: "iso_45001", name: "ISO 45001", kind: "framework", created_at: "2026-04-01" },
  ]);
  db.seed("account_incident_standards", activeStandards.map((id) => ({ account_id: "acct", standard_id: id, is_active: true })));
  db.seed("incident_type_catalogue", [
    { standard_id: BNM, code: "DB", name: "Data breach", default_flags: ["personal_data", "infosec"], position: 1 },
    { standard_id: SCHOOL, code: "CCA", name: "CCA / sports injury", default_flags: ["injury", "child_involved"], position: 1 },
    { standard_id: SCHOOL, code: "NMS", name: "Mishap / near miss", default_flags: [], position: 2 },
  ]);
  db.seed("incident_severity_levels", [
    { standard_id: BNM, slug: "P1", label: "Critical", position: 1 },
    { standard_id: BNM, slug: "P2", label: "High", position: 2 },
    { standard_id: BNM, slug: "P3", label: "Medium", position: 3 },
    { standard_id: BNM, slug: "P4", label: "Low", position: 4 },
    { standard_id: SCHOOL, slug: "critical", label: "Critical", position: 1 },
    { standard_id: SCHOOL, slug: "high", label: "Serious", position: 2 },
    { standard_id: SCHOOL, slug: "medium", label: "Moderate", position: 3 },
    { standard_id: SCHOOL, slug: "low", label: "Minor / near miss", position: 4 },
  ]);
  db.seed("incident_obligation_rules", [
    { standard_id: PDPA, code: "PDPA_COMMISSIONER", title: "Notify the PDP Commissioner", trigger_flag: "personal_data", due_hours: 72 },
    { standard_id: ISO45001, code: "ISO45001_AID", title: "First aid", trigger_flag: "injury", due_hours: 1 },
    { standard_id: ISO45001, code: "ISO45001_VERIFY", title: "Check it worked", trigger_flag: "injury", due_hours: 720 },
  ]);
  db.rpcHandlers.next_incident_number = async () => ({ data: 7, error: null });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.NEXT_PUBLIC_SITE_URL;
  __resetRateLimitForTests();
  h.caps = new Set(["incidents.raise", "incidents.manage"]);
  seedWorld([SCHOOL, PDPA, ISO45001]);
});

describe("POST /api/incidents under the School template", () => {
  it("raises a CCA injury with the category's flags and the school severity scale", async () => {
    const { status, body } = await read(await raise(json("POST", { title: "Sprained ankle at football", incidentType: "CCA", severity: "high" })));
    expect(status).toBe(201);
    expect(body.incident).toMatchObject({ incident_type: "CCA", severity: "high", standard_id: SCHOOL, incident_flags: ["injury", "child_involved"] });
  });

  it("uses the flags the reporter ticked, not the category's defaults", async () => {
    const { status, body } = await read(
      await raise(json("POST", { title: "Fall in the canteen", incidentType: "NMS", severity: "low", flags: ["injury", "outside_agency", "injury"] })),
    );
    expect(status).toBe(201);
    expect(body.incident.incident_flags).toEqual(["injury", "outside_agency"]);
  });

  it("lets the reporter clear every flag", async () => {
    const { body } = await read(await raise(json("POST", { title: "Just a near miss", incidentType: "CCA", severity: "low", flags: [] })));
    expect(body.incident.incident_flags).toEqual([]);
  });

  it("starts at the second-lowest level when the client sends no severity", async () => {
    const { body } = await read(await raise(json("POST", { title: "Broken window", incidentType: "NMS" })));
    expect(body.incident.severity).toBe("medium");
  });

  it("rejects a BNM type and a BNM severity", async () => {
    expect((await read(await raise(json("POST", { title: "x", incidentType: "DB", severity: "high" })))).status).toBe(400);
    expect((await read(await raise(json("POST", { title: "x", incidentType: "CCA", severity: "P2" })))).status).toBe(400);
  });

  it("rejects an unknown flag", async () => {
    const { status, body } = await read(await raise(json("POST", { title: "x", incidentType: "CCA", severity: "low", flags: ["injury", "bogus"] })));
    expect(status).toBe(400);
    expect(body.error).toMatch(/flag/);
  });

  it("does not mistake an active framework for the template", async () => {
    seedWorld([PDPA, ISO45001, SCHOOL]);
    const { body } = await read(await raise(json("POST", { title: "x", incidentType: "CCA", severity: "high" })));
    expect(body.incident.standard_id).toBe(SCHOOL);
  });

  it("refuses when the account has frameworks but no template", async () => {
    seedWorld([PDPA]);
    const { status } = await read(await raise(json("POST", { title: "x", incidentType: "CCA", severity: "high" })));
    expect(status).toBe(422);
  });
});

describe("POST /api/incidents under BNM RMiT (unchanged)", () => {
  it("still takes P1-P4 and defaults to P3", async () => {
    seedWorld([BNM]);
    const { status, body } = await read(await raise(json("POST", { title: "Leaked export", incidentType: "DB" })));
    expect(status).toBe(201);
    expect(body.incident).toMatchObject({ incident_type: "DB", severity: "P3", standard_id: BNM, incident_flags: ["personal_data", "infosec"] });
  });
});

describe("/api/incidents/settings/standard", () => {
  it("lists templates and frameworks with counts and which are active", async () => {
    const { body } = await read(await getStandards(json("GET")));
    const bySlug = Object.fromEntries((body.standards as any[]).map((s) => [s.slug, s]));
    expect(bySlug.school_incident).toMatchObject({ kind: "template", is_active: true, type_count: 2, severity_count: 4 });
    expect(bySlug.bnm_rmit).toMatchObject({ kind: "template", is_active: false });
    expect(bySlug.iso_45001).toMatchObject({ kind: "framework", is_active: true, rule_count: 2 });
    expect(body.active_standard_id).toBe(SCHOOL);
  });

  it("switches a framework on and off without touching the others", async () => {
    const off = await read(await patchStandard(json("PATCH", { standard_id: PDPA, is_active: false })));
    expect(off.status).toBe(200);
    expect(active(PDPA)).toBe(false);
    expect(active(ISO45001)).toBe(true);
    expect(active(SCHOOL)).toBe(true);

    await patchStandard(json("PATCH", { standard_id: PDPA, is_active: true }));
    expect(active(PDPA)).toBe(true);
  });

  it("defaults to switching on and activates a standard the account never had", async () => {
    seedWorld([SCHOOL]);
    const { status, body } = await read(await patchStandard(json("PATCH", { standard_id: ISO45001 })));
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: "framework", is_active: true });
    expect(active(ISO45001)).toBe(true);
  });

  it("will not switch a template off", async () => {
    const { status } = await read(await patchStandard(json("PATCH", { standard_id: SCHOOL, is_active: false })));
    expect(status).toBe(400);
    expect(active(SCHOOL)).toBe(true);
  });

  it("switches to another template", async () => {
    const { status, body } = await read(await patchStandard(json("PATCH", { standard_id: BNM })));
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: "template", is_active: true });
    expect(active(BNM)).toBe(true);
  });

  it("rejects a missing, unknown or malformed request", async () => {
    expect((await read(await patchStandard(json("PATCH", {})))).status).toBe(400);
    expect((await read(await patchStandard(json("PATCH", { standard_id: PDPA, is_active: "yes" })))).status).toBe(400);
    expect((await read(await patchStandard(json("PATCH", { standard_id: "00000000-0000-4000-8000-0000000000ff" })))).status).toBe(404);
  });

  it("needs incidents.manage", async () => {
    h.caps = new Set(["incidents.raise"]);
    expect((await read(await getStandards(json("GET")))).status).toBe(403);
    expect((await read(await patchStandard(json("PATCH", { standard_id: PDPA })))).status).toBe(403);
  });
});
