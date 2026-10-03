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

  it("accepts a daily broadcast cap well above the seat ceiling, and clears it with null", () => {
    expect(parseUpdateTenant({ limits: { broadcast_per_day: 50_000 } })).toEqual({
      ok: true,
      value: { limits: { broadcast_per_day: 50_000 } },
    });
    expect(parseUpdateTenant({ limits: { broadcast_per_day: null } })).toEqual({
      ok: true,
      value: { limits: { broadcast_per_day: null } },
    });
  });

  it("still bounds seats and rejects a nonsense broadcast cap", () => {
    expect(parseUpdateTenant({ limits: { seats: 10_000_000 } }).ok).toBe(false);
    expect(parseUpdateTenant({ limits: { broadcast_per_day: 0 } }).ok).toBe(false);
    expect(parseUpdateTenant({ limits: { broadcast_per_day: 2_000_000 } }).ok).toBe(false);
  });

  it("accepts the usage limits (migration 152) and refuses zero, fractions and values past their ceiling", () => {
    const ok = parseUpdateTenant({ limits: { contacts: 5000, messages_per_month: 100000, ai_tokens_per_month: 2_000_000, storage_mb: 10240, contacts_x: null } });
    expect(ok.ok).toBe(false); // unknown key
    expect(parseUpdateTenant({ limits: { contacts: 5000, messages_per_month: 100000, ai_tokens_per_month: 2_000_000, storage_mb: 10240 } })).toEqual({
      ok: true,
      value: { limits: { contacts: 5000, messages_per_month: 100000, ai_tokens_per_month: 2_000_000, storage_mb: 10240 } },
    });
    expect(parseUpdateTenant({ limits: { contacts: 0 } }).ok).toBe(false);
    expect(parseUpdateTenant({ limits: { storage_mb: 1.5 } }).ok).toBe(false);
    expect(parseUpdateTenant({ limits: { contacts: 100_000_001 } }).ok).toBe(false);
    expect(parseUpdateTenant({ limits: { contacts: null, storage_mb: null } }).ok).toBe(true);
  });
});
