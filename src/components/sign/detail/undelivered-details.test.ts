import { describe, expect, it } from "vitest";

import { signersWithUndelivered, undeliveredDetails, type DeliveryEvent } from "./logic";

const ev = (seq: number, type: string, signer: string | null, detail: Record<string, unknown> | null = null): DeliveryEvent => ({ doc_seq: seq, type, signer_id: signer, detail });

describe("why a person's last message did not arrive", () => {
  it("is the reason recorded with the failure, for each person who still has one", () => {
    const events = [
      ev(1, "invited", "a"),
      ev(2, "delivery_failed", "a", { channel: "email", status: "failed", reason: "daily_limit: Daily user sending quota exceeded." }),
      ev(3, "invited", "b"),
      ev(4, "delivery_failed", "b", { channel: "email", status: "not_configured", reason: "not_set_up" }),
    ];
    expect(Object.fromEntries(undeliveredDetails(events))).toEqual({ a: "daily_limit: Daily user sending quota exceeded.", b: "not_set_up" });
  });

  it("is null for a failure recorded without one (older records), and the person is still undelivered", () => {
    const events = [ev(1, "delivery_failed", "a", { channel: "email", status: "failed", reason: null }), ev(2, "delivery_failed", "b", { channel: "email" })];
    expect(Object.fromEntries(undeliveredDetails(events))).toEqual({ a: null, b: null });
  });

  it("ends when the person is invited, reminded, sent a new link or given a new recipient and it then goes through; a later failure is the new reason", () => {
    const events = [
      ev(1, "delivery_failed", "a", { reason: "rate_limited" }),
      ev(2, "resent", "a"),
      ev(3, "delivery_failed", "b", { reason: "address_rejected" }),
      ev(4, "recipient_changed", "b"),
      ev(5, "delivery_failed", "a", { reason: "mailbox_reconnect" }),
    ];
    expect(Object.fromEntries(undeliveredDetails(events))).toEqual({ a: "mailbox_reconnect" });
  });

  it("does not count a failure to deliver the signed copy, which is not about getting someone to sign", () => {
    expect(undeliveredDetails([ev(1, "delivery_failed", "a", { kind: "completed", reason: "daily_limit" })]).size).toBe(0);
  });

  it("is the same set of people as before", () => {
    const events = [ev(1, "delivery_failed", "a", { reason: "x" }), ev(2, "delivery_failed", "b", null), ev(3, "invited", "b")];
    expect([...signersWithUndelivered(events)]).toEqual(["a"]);
    expect([...undeliveredDetails(events).keys()]).toEqual(["a"]);
  });
});
