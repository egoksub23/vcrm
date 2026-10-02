import { describe, expect, it } from "vitest";

import { parseCreateTenant, parseUpdateTenant } from "./validate";

describe("parseCreateTenant", () => {
  it("accepts a minimal body and normalises the email", () => {
    const r = parseCreateTenant({ companyName: " Acme Sdn Bhd ", ownerEmail: " Boss@Acme.COM " });
    expect(r).toEqual({
      ok: true,
      value: { companyName: "Acme Sdn Bhd", ownerEmail: "boss@acme.com", ownerName: null, plan: null, seats: null },
    });
  });

  it("accepts optional owner name, plan and seats", () => {
    const r = parseCreateTenant({
      companyName: "Acme",
      ownerEmail: "a@b.co",
      ownerName: "Ann",
      plan: "pro",
      seats: "12",
    });
    expect(r).toMatchObject({ ok: true, value: { ownerName: "Ann", plan: "pro", seats: 12 } });
  });

  it.each([
    [{}, /companyName/],
    [{ companyName: "x" }, /ownerEmail/],
    [{ companyName: "x", ownerEmail: "nope" }, /ownerEmail/],
    [{ companyName: "x".repeat(121), ownerEmail: "a@b.co" }, /companyName/],
    [{ companyName: "x", ownerEmail: "a@b.co", seats: 0 }, /seats/],
    [{ companyName: "x", ownerEmail: "a@b.co", seats: 1.5 }, /seats/],
    [{ companyName: "x", ownerEmail: "a@b.co", plan: "p".repeat(41) }, /plan/],
  ])("rejects %j", (body, message) => {
    const r = parseCreateTenant(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it("rejects a non-object body", () => {
    expect(parseCreateTenant(null).ok).toBe(false);
    expect(parseCreateTenant([]).ok).toBe(false);
  });
});

describe("parseUpdateTenant", () => {
  it("accepts status, plan, limits and features together", () => {
    const r = parseUpdateTenant({
      status: "suspended",
      reason: " unpaid ",
      plan: "pro",
      limits: { seats: 10 },
      features: { incidents: false },
    });
    expect(r).toEqual({
      ok: true,
      value: { status: "suspended", reason: "unpaid", plan: "pro", limits: { seats: 10 }, features: { incidents: false } },
    });
  });

  it("accepts a reseed request on its own", () => {
    expect(parseUpdateTenant({ reseed: true })).toEqual({ ok: true, value: { reseed: true } });
    expect(parseUpdateTenant({ reseed: false }).ok).toBe(false);
  });

  it("lets null clear a limit or a feature override", () => {
    const r = parseUpdateTenant({ limits: { seats: null }, features: { incidents: null } });
    expect(r).toEqual({ ok: true, value: { limits: { seats: null }, features: { incidents: null } } });
  });

  it.each([
    [{}, /Nothing to update/],
    [{ status: "banned" }, /status/],
    [{ plan: "" }, /plan/],
    [{ limits: { widgets: 3 } }, /Unknown limit/],
    [{ limits: { seats: 0 } }, /seats/],
    [{ limits: [] }, /limits/],
    [{ features: { teleport: true } }, /Unknown feature/],
    [{ features: { incidents: "yes" } }, /incidents/],
    [{ reason: "r".repeat(501) }, /reason/],
  ])("rejects %j", (body, message) => {
    const r = parseUpdateTenant(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});
