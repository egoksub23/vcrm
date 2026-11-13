import { describe, expect, it } from "vitest";

import { channelHint, parseContact, parseMemberPatch, parseRole, roleKeyFrom } from "./input";

describe("parseContact", () => {
  it("accepts a person with several emails and phones, tidying them", () => {
    const r = parseContact({ name: " Ms Tan ", emails: ["Tan@School.test", "tan@school.test", "sports@school.test"], phones: ["+60 12 000 0002"], kind: "staff" });
    expect(r).toEqual({ ok: true, value: { name: "Ms Tan", kind: "staff", emails: ["tan@school.test", "sports@school.test"], phones: ["+60 12 000 0002"] } });
  });
  it("needs a name and at least one good email on create", () => {
    expect(parseContact({ emails: ["a@b.co"] })).toEqual({ ok: false, error: "Give the person a name." });
    expect(parseContact({ name: "X", emails: [] })).toMatchObject({ ok: false, error: expect.stringContaining("at least one email") });
    expect(parseContact({ name: "X", emails: ["nope"] })).toMatchObject({ ok: false, error: '"nope" does not look like an email address.' });
  });
  it("lets an update change one thing, but never leave a person with no email", () => {
    expect(parseContact({ is_active: false }, true)).toEqual({ ok: true, value: { is_active: false } });
    expect(parseContact({ emails: [] }, true)).toMatchObject({ ok: false });
  });
  it("rejects a bad phone, an unknown channel and too many addresses", () => {
    expect(parseContact({ name: "X", emails: ["a@b.co"], phones: ["abc"] })).toMatchObject({ ok: false });
    expect(parseContact({ name: "X", emails: ["a@b.co"], preferred_channels: ["pigeon"] })).toMatchObject({ ok: false, error: "Unknown channel." });
    const many = Array.from({ length: 6 }, (_, i) => `p${i}@b.co`);
    expect(parseContact({ name: "X", emails: many })).toMatchObject({ ok: false });
  });
  it("rejects a body that is not an object", () => {
    expect(parseContact(null)).toMatchObject({ ok: false });
    expect(parseContact([])).toMatchObject({ ok: false });
  });
});

describe("roles", () => {
  it("makes a stable key from the English name", () => {
    expect(roleKeyFrom("Head of Sport")).toBe("head_of_sport");
    expect(roleKeyFrom("  Pengetua / Principal! ")).toBe("pengetua_principal");
    expect(roleKeyFrom("2nd lead")).toBe("role_2nd_lead");
  });
  it("validates a role", () => {
    expect(parseRole({ name: "Bursar", notify_mode: "first_available" })).toEqual({ ok: true, value: { name: "Bursar", notify_mode: "first_available" } });
    expect(parseRole({ name: "x" })).toMatchObject({ ok: false });
    expect(parseRole({ name: "Bursar", notify_mode: "some" })).toMatchObject({ ok: false });
    expect(parseRole({ notify_mode: "all" }, true)).toEqual({ ok: true, value: { notify_mode: "all" } });
  });
});

describe("parseMemberPatch", () => {
  it("accepts order, backup and away dates", () => {
    expect(parseMemberPatch({ position: 2, is_backup: true, away_from: "2026-11-10", away_to: "2026-11-20" })).toEqual({
      ok: true,
      value: { position: 2, is_backup: true, away_from: "2026-11-10", away_to: "2026-11-20" },
    });
    expect(parseMemberPatch({ away_from: null, away_to: null })).toEqual({ ok: true, value: { away_from: null, away_to: null } });
  });
  it("rejects reversed or malformed dates", () => {
    expect(parseMemberPatch({ away_from: "2026-11-20", away_to: "2026-11-10" })).toMatchObject({ ok: false });
    expect(parseMemberPatch({ away_from: "20 Nov" })).toMatchObject({ ok: false });
    expect(parseMemberPatch({ position: -1 })).toMatchObject({ ok: false });
  });
});

describe("channelHint", () => {
  it("says when a preferred channel is not connected yet", () => {
    expect(channelHint(["email"])).toBeNull();
    expect(channelHint(["whatsapp", "email"])).toMatch(/whatsapp will be used when it is connected/);
  });
});
