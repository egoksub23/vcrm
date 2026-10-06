import { describe, expect, it } from "vitest";

import { EVENT_TYPES } from "@/lib/sign/types";

import { chainState, describeEvent, orderEvents, visibleDetails, type DescribeContext, type SignEventRow } from "./events";

const ctx = (over: Partial<DescribeContext> = {}): DescribeContext => ({
  signers: [
    { id: "s1", full_name: "Ali", order_no: 1 },
    { id: "s2", full_name: "Siti", order_no: 2 },
  ],
  signInOrder: false,
  userName: (id) => (id === "u1" ? "Gokula" : null),
  someone: "Someone",
  teammate: "A teammate",
  ...over,
});

const row = (over: Partial<SignEventRow>): SignEventRow => ({
  id: "e" + (over.doc_seq ?? 1),
  doc_seq: 1,
  signer_id: null,
  type: "sent",
  actor_type: "user",
  actor_user_id: null,
  detail: {},
  ip: null,
  device: null,
  created_at: "2026-10-06T09:00:00Z",
  ...over,
});

describe("describeEvent", () => {
  it("has a message key for every event type the chain carries", () => {
    for (const type of EVENT_TYPES) {
      const line = describeEvent(row({ type }), ctx());
      expect(line.key).toBe(`events.${type}`);
    }
  });

  it("never shows a raw type: an unknown one reads as the generic line", () => {
    const line = describeEvent(row({ type: "something_new" }), ctx());
    expect(line.key).toBe("events.unknown");
    expect(line.values.type).toBe("something_new");
  });

  it("names the signer as the actor and the teammate as the sender", () => {
    const signed = describeEvent(row({ type: "signed", actor_type: "signer", signer_id: "s1" }), ctx());
    expect(signed.values.actor).toBe("Ali");
    expect(signed.actorName).toBe("Ali");
    const sent = describeEvent(row({ type: "sent", actor_user_id: "u1" }), ctx());
    expect(sent.values.sender).toBe("Gokula");
    expect(sent.actorName).toBe("Gokula");
    const gone = describeEvent(row({ type: "voided", actor_user_id: "u9" }), ctx());
    expect(gone.values.sender).toBe("A teammate");
    expect(gone.actorName).toBeNull();
  });

  it("falls back when the signer is not on the document any more", () => {
    expect(describeEvent(row({ type: "viewed", actor_type: "signer", signer_id: "gone" }), ctx()).values.actor).toBe("Someone");
  });

  it("words an ordered invitation by who finished before", () => {
    const line = describeEvent(row({ type: "invited", signer_id: "s2", actor_type: "system" }), ctx({ signInOrder: true }));
    expect(line.key).toBe("events.invitedAfter");
    expect(line.values.previous).toBe("Ali");
    expect(describeEvent(row({ type: "invited", signer_id: "s1", actor_type: "system" }), ctx({ signInOrder: true })).key).toBe("events.invited");
    expect(describeEvent(row({ type: "invited", signer_id: "s2", actor_type: "system" }), ctx()).key).toBe("events.invited");
  });

  it("words a change of recipient with both addresses when it has them", () => {
    const line = describeEvent(row({ type: "recipient_changed", signer_id: "s1", detail: { from_email: "a@x.com", to_email: "b@x.com" } }), ctx());
    expect(line.key).toBe("events.recipient_changedFromTo");
    expect(line.values).toMatchObject({ from: "a@x.com", to: "b@x.com" });
    expect(describeEvent(row({ type: "recipient_changed", signer_id: "s1" }), ctx()).key).toBe("events.recipient_changed");
  });

  it("flags what did not go through, with a word on screen and a reason in the details", () => {
    const line = describeEvent(row({ type: "delivery_failed", actor_type: "system", signer_id: "s1", detail: { channel: "email", status: "failed", reason: "mailbox full" } }), ctx());
    expect(line.failed).toBe(true);
    expect(line.details).toEqual([
      { kind: "channel", value: "email" },
      { kind: "delivery", value: "mailbox full" },
    ]);
    expect(describeEvent(row({ type: "delivery_failed", detail: { kind: "completed" } }), ctx()).key).toBe("events.delivery_failedCompletedSender");
    expect(describeEvent(row({ type: "delivery_failed", signer_id: "s1", detail: { kind: "completed" } }), ctx()).key).toBe("events.delivery_failedCompleted");
    expect(describeEvent(row({ type: "code_failed", actor_type: "signer", signer_id: "s1" }), ctx()).failed).toBe(true);
    expect(describeEvent(row({ type: "signed", actor_type: "signer", signer_id: "s1" }), ctx()).failed).toBe(false);
  });

  it("keeps network address and device in the details, and the reason a person gave", () => {
    const line = describeEvent(row({ type: "declined", actor_type: "signer", signer_id: "s1", ip: "203.0.113.5", device: "Android Chrome", detail: { reason: "Fee is wrong" } }), ctx());
    expect(line.reason).toBe("Fee is wrong");
    expect(line.details).toEqual([
      { kind: "ip", value: "203.0.113.5" },
      { kind: "device", value: "Android Chrome" },
    ]);
    expect(describeEvent(row({ type: "consented", actor_type: "signer", signer_id: "s1", detail: { version: "2026-10" } }), ctx()).details).toContainEqual({ kind: "consent", value: "2026-10" });
    expect(describeEvent(row({ type: "sealed", actor_type: "system", detail: { final_sha256: "ab".repeat(32) } }), ctx()).details).toContainEqual({ kind: "fingerprint", value: "ab".repeat(32) });
  });

  it("marks autosaves as minor and hides the technical error from people without sign.settings", () => {
    expect(describeEvent(row({ type: "saved", actor_type: "signer", signer_id: "s1" }), ctx()).minor).toBe(true);
    const line = describeEvent(row({ type: "seal_attempt_failed", actor_type: "system", detail: { error: "font missing" } }), ctx());
    expect(line.failed).toBe(true);
    expect(visibleDetails(line, false)).toEqual([]);
    expect(visibleDetails(line, true)).toEqual([{ kind: "error", value: "font missing" }]);
  });
});

describe("orderEvents", () => {
  const rows = [row({ doc_seq: 2, id: "b" }), row({ doc_seq: 1, id: "a" }), row({ doc_seq: 3, id: "c" })];
  it("follows the chain's own sequence", () => {
    expect(orderEvents(rows, false).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(orderEvents(rows, true).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
  it("does not change its input", () => {
    orderEvents(rows, true);
    expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});

describe("chainState", () => {
  it("reads the answer of sign_verify_chain", () => {
    expect(chainState({ ok: true, events: 7, head: "abc" })).toEqual({ state: "intact", events: 7 });
    expect(chainState({ ok: false, events: 4, broken_at: 3 })).toEqual({ state: "broken", at: 3 });
    expect(chainState({ ok: false })).toEqual({ state: "broken", at: null });
    expect(chainState(null)).toEqual({ state: "unknown" });
    expect(chainState("nope")).toEqual({ state: "unknown" });
    expect(chainState({})).toEqual({ state: "unknown" });
  });
});
