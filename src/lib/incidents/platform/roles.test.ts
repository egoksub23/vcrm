import { describe, expect, it } from "vitest";

import {
  addressesFor,
  cleanList,
  isAway,
  isPlausibleEmail,
  labelOf,
  resolveRole,
  type IncidentContact,
  type IncidentRoleMember,
} from "./roles";

const contact = (id: string, over: Partial<IncidentContact> = {}): IncidentContact => ({
  id,
  account_id: "a1",
  user_id: null,
  name: id,
  kind: "staff",
  emails: [`${id}@school.test`],
  phones: [],
  preferred_channels: ["email"],
  is_active: true,
  ...over,
});

const member = (contactId: string, position: number, over: Partial<IncidentRoleMember> = {}): IncidentRoleMember => ({
  id: `m-${contactId}`,
  account_id: "a1",
  role_id: "r1",
  contact_id: contactId,
  position,
  away_from: null,
  away_to: null,
  is_backup: false,
  ...over,
});

const fixedRole = { key: "head_of_sport", kind: "fixed" as const, dynamic_source: null, notify_mode: "all" as const };

describe("labelOf", () => {
  it("reads the language asked for and falls back to English", () => {
    expect(labelOf({ en: "Principal", ms: "Pengetua" }, "ms")).toBe("Pengetua");
    expect(labelOf({ en: "Principal" }, "zh")).toBe("Principal");
    expect(labelOf(null)).toBe("");
  });
});

describe("isAway", () => {
  it("is inclusive at both ends and open-ended when one end is missing", () => {
    expect(isAway({ away_from: "2026-11-10", away_to: "2026-11-20" }, "2026-11-10")).toBe(true);
    expect(isAway({ away_from: "2026-11-10", away_to: "2026-11-20" }, "2026-11-20")).toBe(true);
    expect(isAway({ away_from: "2026-11-10", away_to: "2026-11-20" }, "2026-11-21")).toBe(false);
    expect(isAway({ away_from: "2026-11-10", away_to: null }, "2027-01-01")).toBe(true);
    expect(isAway({ away_from: null, away_to: "2026-11-20" }, "2026-01-01")).toBe(true);
    expect(isAway({ away_from: null, away_to: null }, "2026-11-11")).toBe(false);
  });
});

describe("addressesFor", () => {
  it("sends email to every address the person has", () => {
    expect(addressesFor({ emails: ["a@x.test", "b@x.test"], phones: [] })).toEqual({ channel: "email", addresses: ["a@x.test", "b@x.test"] });
  });
  it("uses a channel with an adapter, but falls back to email when the preferred one does not exist yet", () => {
    expect(addressesFor({ emails: ["a@x.test"], phones: ["+601"], preferred_channels: ["whatsapp", "email"] })).toEqual({ channel: "email", addresses: ["a@x.test"] });
    expect(addressesFor({ emails: ["a@x.test"], phones: ["+601"], preferred_channels: ["whatsapp"] })).toEqual({ channel: "email", addresses: ["a@x.test"] });
  });
  it("uses WhatsApp the day an adapter exists", () => {
    expect(addressesFor({ emails: ["a@x.test"], phones: ["+601", "+602"], preferred_channels: ["whatsapp", "email"] }, ["email", "whatsapp"])).toEqual({ channel: "whatsapp", addresses: ["+601"] });
  });
  it("returns null when there is nowhere to send", () => {
    expect(addressesFor({ emails: [" "], phones: ["+601"] })).toBeNull();
  });
});

describe("resolveRole for a fixed role", () => {
  const contacts = [contact("rahim"), contact("tan", { emails: ["tan@school.test", "sports@school.test"] }), contact("lim")];

  it("tells every active member, in order, on every address", () => {
    const out = resolveRole({ role: fixedRole, members: [member("tan", 2), member("rahim", 1)], contacts, today: "2026-11-11" });
    expect(out.recipients.map((r) => r.address)).toEqual(["rahim@school.test", "tan@school.test", "sports@school.test"]);
    expect(out.recipients.every((r) => r.roleKey === "head_of_sport" && r.channel === "email")).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it("skips a member who is away and tells the backup instead", () => {
    const members = [member("tan", 1, { away_from: "2026-11-10", away_to: "2026-11-20" }), member("lim", 2, { is_backup: true })];
    const out = resolveRole({ role: fixedRole, members, contacts, today: "2026-11-11" });
    expect(out.recipients.map((r) => r.name)).toEqual(["lim"]);
  });

  it("does not tell a backup while a regular member is present", () => {
    const members = [member("rahim", 1), member("lim", 2, { is_backup: true })];
    const out = resolveRole({ role: fixedRole, members, contacts, today: "2026-11-11" });
    expect(out.recipients.map((r) => r.name)).toEqual(["rahim"]);
  });

  it("tells the first available only when the role says so", () => {
    const members = [member("rahim", 1, { away_from: "2026-11-01", away_to: "2026-11-30" }), member("tan", 2), member("lim", 3)];
    const out = resolveRole({ role: { ...fixedRole, notify_mode: "first_available" }, members, contacts, today: "2026-11-11" });
    expect(out.recipients.map((r) => r.name)).toEqual(["tan", "tan"]);
  });

  it("warns when the role has nobody, when everyone is away, and when a person has no address", () => {
    expect(resolveRole({ role: fixedRole, members: [], contacts, today: "2026-11-11" }).warnings).toEqual(["no_members"]);
    const away = [member("rahim", 1, { away_from: "2026-11-01", away_to: "2026-11-30" })];
    expect(resolveRole({ role: fixedRole, members: away, contacts, today: "2026-11-11" })).toEqual({ recipients: [], warnings: ["everyone_away"] });
    const noMail = [contact("ghost", { emails: [], phones: [] })];
    expect(resolveRole({ role: fixedRole, members: [member("ghost", 1)], contacts: noMail, today: "2026-11-11" })).toEqual({ recipients: [], warnings: ["no_address"] });
  });

  it("ignores inactive contacts and members whose contact is unknown", () => {
    const people = [contact("rahim", { is_active: false })];
    const out = resolveRole({ role: fixedRole, members: [member("rahim", 1), member("nobody", 2)], contacts: people, today: "2026-11-11" });
    expect(out).toEqual({ recipients: [], warnings: ["no_members"] });
  });
});

describe("resolveRole for a per-incident role", () => {
  const reporter = { key: "reporter", kind: "per_incident" as const, dynamic_source: "reporter" as const, notify_mode: "all" as const };

  it("uses the people worked out from the incident", () => {
    const out = resolveRole({
      role: reporter,
      members: [],
      contacts: [],
      dynamic: { reporter: [{ name: "Coach Rahim", emails: ["rahim@club.test"], phones: [] }] },
      today: "2026-11-11",
    });
    expect(out.recipients).toEqual([
      { contactId: null, userId: null, name: "Coach Rahim", channel: "email", address: "rahim@club.test", roleKey: "reporter" },
    ]);
  });

  it("warns when the incident has nobody for the role, or nobody reachable", () => {
    expect(resolveRole({ role: reporter, members: [], contacts: [], today: "2026-11-11" }).warnings).toEqual(["no_people_on_incident"]);
    const out = resolveRole({ role: reporter, members: [], contacts: [], dynamic: { reporter: [{ name: "X", emails: [], phones: [] }] }, today: "2026-11-11" });
    expect(out.warnings).toEqual(["no_address"]);
  });
});

describe("form helpers", () => {
  it("accepts plausible emails only", () => {
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(isPlausibleEmail("a@b")).toBe(false);
    expect(isPlausibleEmail("a b@c.com")).toBe(false);
  });
  it("cleans a pasted list", () => {
    expect(cleanList([" A@x.test ", "a@x.test", "", "b@x.test"], true)).toEqual(["a@x.test", "b@x.test"]);
  });
});
