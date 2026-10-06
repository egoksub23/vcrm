import { describe, expect, it } from "vitest";

import { myOpenPlace, turnState } from "./turn";

const NOW = new Date("2026-10-06T08:00:00Z");
const open = { status: "sent", expires_at: "2026-10-20T00:00:00Z" };

describe("turnState", () => {
  it("is open only for someone who has been invited and has not finished, on a document that can still be signed", () => {
    expect(turnState(open, { status: "sent" }, NOW)).toBe("open");
    expect(turnState(open, { status: "viewed" }, NOW)).toBe("open");
    expect(turnState({ ...open, status: "in_progress" }, { status: "sent" }, NOW)).toBe("open");
    expect(turnState({ status: "sent", expires_at: null }, { status: "sent" }, NOW)).toBe("open");
  });

  it("says 'not your turn' for a person who has not been invited (an ordered document, an earlier step is still open)", () => {
    expect(turnState(open, { status: "pending" }, NOW)).toBe("not_your_turn");
  });

  it("puts finished before closed, so 'you signed' is not hidden by a document that has since completed", () => {
    expect(turnState({ ...open, status: "completed" }, { status: "signed" }, NOW)).toBe("already_signed");
    expect(turnState(open, { status: "signed" }, NOW)).toBe("already_signed");
    expect(turnState(open, { status: "declined" }, NOW)).toBe("declined");
  });

  it("is closed for a document that is a draft, sealing, finished, cancelled or past its expiry, even when the expiry job has not run yet", () => {
    for (const status of ["draft", "sealing", "completed", "declined", "expired", "voided", "failed"]) expect(turnState({ ...open, status }, { status: "sent" }, NOW), status).toBe("document_closed");
    expect(turnState({ status: "sent", expires_at: "2026-10-06T07:59:59Z" }, { status: "sent" }, NOW)).toBe("document_closed");
    expect(turnState({ status: "sent", expires_at: "2026-10-06T08:00:00Z" }, { status: "sent" }, NOW)).toBe("document_closed");
  });
});

describe("myOpenPlace", () => {
  const places = [
    { id: "a", status: "signed", internal_user_id: "me", order_no: 1 },
    { id: "b", status: "sent", internal_user_id: "me", order_no: 3 },
    { id: "c", status: "sent", internal_user_id: "me", order_no: 2 },
    { id: "d", status: "sent", internal_user_id: "you", order_no: 1 },
    { id: "e", status: "sent", internal_user_id: null, order_no: 1 },
  ];

  it("finds the viewer's own open place, the earliest step first, and never someone else's", () => {
    expect(myOpenPlace(open, places, "me", NOW)?.id).toBe("c");
    expect(myOpenPlace(open, places, "you", NOW)?.id).toBe("d");
    expect(myOpenPlace(open, places, "nobody", NOW)).toBeNull();
  });

  it("finds nothing for a signed-out viewer, a closed document or a person who has finished", () => {
    expect(myOpenPlace(open, places, null, NOW)).toBeNull();
    expect(myOpenPlace(open, places, undefined, NOW)).toBeNull();
    expect(myOpenPlace({ ...open, status: "voided" }, places, "me", NOW)).toBeNull();
    expect(myOpenPlace(open, places.filter((p) => p.id === "a"), "me", NOW)).toBeNull();
  });
});
