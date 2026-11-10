import { describe, expect, it } from "vitest";

import { toldAtEscalation, type ToldDelivery } from "./escalation-told";

const d = (over: Partial<ToldDelivery>): ToldDelivery => ({ reason: "escalated", created_at: "2026-11-10T01:00:05Z", recipient_name: "Principal Lim", role_key: "principal", status: "sent", ...over });

describe("toldAtEscalation", () => {
  it("lists the people the escalation rules told, once each", () => {
    const rows = [d({}), d({ recipient_name: "Head of Sport", role_key: "head_of_sport" }), d({ created_at: "2026-11-10T01:00:06Z" })];
    expect(toldAtEscalation("2026-11-10T01:00:00Z", null, rows)).toEqual([
      { name: "Principal Lim", roleKey: "principal", failed: false },
      { name: "Head of Sport", roleKey: "head_of_sport", failed: false },
    ]);
  });

  it("ignores notices for other reasons, test incidents, and other escalations", () => {
    const rows = [
      d({ reason: "raised" }),
      d({ is_test: true }),
      d({ created_at: "2026-11-10T00:00:00Z" }), // before this escalation
      d({ created_at: "2026-11-10T03:00:00Z" }), // belongs to a later one
    ];
    expect(toldAtEscalation("2026-11-10T01:00:00Z", "2026-11-10T02:00:00Z", rows)).toEqual([]);
  });

  it("stops at the next escalation", () => {
    const rows = [d({ created_at: "2026-11-10T01:00:05Z" }), d({ recipient_name: "Owner", role_key: "owner", created_at: "2026-11-10T01:05:00Z" })];
    expect(toldAtEscalation("2026-11-10T01:00:00Z", "2026-11-10T01:03:00Z", rows).map((p) => p.name)).toEqual(["Principal Lim"]);
  });

  it("marks someone as failed only when none of their notices went out", () => {
    expect(toldAtEscalation("2026-11-10T01:00:00Z", null, [d({ status: "failed" })])[0].failed).toBe(true);
    expect(toldAtEscalation("2026-11-10T01:00:00Z", null, [d({ status: "failed" }), d({ status: "sent" })])[0].failed).toBe(false);
  });
});
