import { describe, expect, it } from "vitest";

import { runTrigger } from "./engine";
import { resolveRole } from "./roles";
import { contact, member, role, ruleFromRecipe, seeded } from "./testing";

const nurse = role("school_nurse");

describe("telling people on WhatsApp, SMS or push", () => {
  const prefersWhatsApp = contact("aminah", { phones: ["+60 12 345 6789"], preferred_channels: ["whatsapp"] });

  it("tells a person on their channel AND by email when the channel is available", () => {
    const r = resolveRole({ role: nurse, members: [member("school_nurse", "aminah")], contacts: [prefersWhatsApp], today: "2026-11-09", available: ["email", "whatsapp"] });
    expect(r.recipients.map((x) => [x.channel, x.address])).toEqual([
      ["whatsapp", "+60 12 345 6789"],
      ["email", "aminah@school.test"],
    ]);
  });

  it("falls back to email alone when the channel is not available", () => {
    const r = resolveRole({ role: nurse, members: [member("school_nurse", "aminah")], contacts: [prefersWhatsApp], today: "2026-11-09" });
    expect(r.recipients.map((x) => [x.channel, x.address])).toEqual([["email", "aminah@school.test"]]);
  });

  it("does not repeat the email for someone who prefers email", () => {
    const r = resolveRole({ role: nurse, members: [member("school_nurse", "aminah")], contacts: [contact("aminah", { phones: ["+60123456789"] })], today: "2026-11-09", available: ["email", "sms", "push"] });
    expect(r.recipients).toHaveLength(1);
  });

  it("uses the school's available channels when the rules run, and queues one row per channel", async () => {
    const s = seeded();
    s.channels = ["email", "whatsapp", "sms", "push"];
    s.directory.contacts = s.directory.contacts.map((c) => (c.id === "aminah" ? { ...c, phones: ["+60123456789"], preferred_channels: ["push"] as const } : c)) as typeof s.directory.contacts;
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(s.deliveries.filter((d) => d.role_key === "school_nurse").map((d) => [d.channel, d.address])).toEqual([
      ["push", "+60123456789"],
      ["email", "aminah@school.test"],
    ]);
  });

  it("queues email only for a school that has not set the channels up", async () => {
    const s = seeded();
    s.directory.contacts = s.directory.contacts.map((c) => (c.id === "aminah" ? { ...c, phones: ["+60123456789"], preferred_channels: ["push"] as const } : c)) as typeof s.directory.contacts;
    s.rules = [ruleFromRecipe("serious_injury", "r1")];
    await runTrigger(s, { incidentId: "i1", trigger: "raised" });
    expect(s.deliveries.filter((d) => d.role_key === "school_nurse").map((d) => d.channel)).toEqual(["email"]);
  });
});
