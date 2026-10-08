import { describe, expect, it } from "vitest";

import { CANCEL_REASON_MAX, CANCEL_REASON_MIN, canCancelRow, cancelReasonProblem, characterCount, cleanCancelReason, isCancellable, isCancelled } from "./cancel";
import { CANCELLED_BADGE, documentBadgeClass, documentStatusKey, showsCancelled } from "./client/status";

describe("the reason", () => {
  it("is 3 to 500 characters once trimmed", () => {
    expect([CANCEL_REASON_MIN, CANCEL_REASON_MAX]).toEqual([3, 500]);
    expect(cancelReasonProblem("")).toBe("required");
    expect(cancelReasonProblem(cleanCancelReason("   "))).toBe("required");
    expect(cancelReasonProblem("ab")).toBe("short");
    expect(cancelReasonProblem(cleanCancelReason("  ab  "))).toBe("short");
    expect(cancelReasonProblem("abc")).toBeNull();
    expect(cancelReasonProblem("x".repeat(500))).toBeNull();
    expect(cancelReasonProblem("x".repeat(501))).toBe("long");
  });

  it("counts characters the way the database does (one for a character outside the basic plane)", () => {
    expect(characterCount("😀😀")).toBe(2);
    expect("😀😀".length).toBe(4);
    expect(cancelReasonProblem("😀".repeat(500))).toBeNull();
    expect(cancelReasonProblem("😀".repeat(501))).toBe("long");
  });

  it("trims what was typed, and treats anything that is not text as nothing", () => {
    expect(cleanCancelReason("  Wrong price \n")).toBe("Wrong price");
    for (const bad of [undefined, null, 5, {}, []]) expect(cleanCancelReason(bad)).toBe("");
  });
});

describe("cancelled and cancellable", () => {
  it("is cancelled only when completed AND stamped; it can be cancelled only when completed and not stamped", () => {
    expect(isCancelled({ status: "completed", cancelled_at: "2026-10-06T08:00:00Z" })).toBe(true);
    expect(isCancelled({ status: "completed", cancelled_at: null })).toBe(false);
    expect(isCancelled({ status: "completed" })).toBe(false);
    expect(isCancelled({ status: "sent", cancelled_at: "2026-10-06T08:00:00Z" })).toBe(false);
    expect(isCancelled(null)).toBe(false);
    expect(isCancellable({ status: "completed", cancelled_at: null })).toBe(true);
    expect(isCancellable({ status: "completed", cancelled_at: "2026-10-06T08:00:00Z" })).toBe(false);
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) expect(isCancellable({ status }), status).toBe(false);
    expect(isCancellable(undefined)).toBe(false);
  });
});

describe("who is offered Cancel document", () => {
  const completed = { status: "completed", cancelled_at: null, created_by: "maker" };
  it("is the person who made it, and an admin or owner", () => {
    expect(canCancelRow(completed, { userId: "maker", isAdmin: false })).toBe(true);
    expect(canCancelRow(completed, { userId: "someone", isAdmin: true })).toBe(true);
    expect(canCancelRow(completed, { userId: "someone", isAdmin: false })).toBe(false);
    expect(canCancelRow(completed, { userId: null, isAdmin: false })).toBe(false);
    expect(canCancelRow(completed, { userId: undefined, isAdmin: false })).toBe(false);
    // a row with no maker (the login was deleted) is for admins only, never for "nobody"
    expect(canCancelRow({ ...completed, created_by: null }, { userId: undefined, isAdmin: false })).toBe(false);
    expect(canCancelRow({ ...completed, created_by: null }, { userId: "x", isAdmin: true })).toBe(true);
  });

  it("is never offered for a row that is not completed or is cancelled already, whoever looks", () => {
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) {
      expect(canCancelRow({ ...completed, status }, { userId: "maker", isAdmin: true }), status).toBe(false);
    }
    expect(canCancelRow({ ...completed, cancelled_at: "2026-10-06T08:00:00Z" }, { userId: "maker", isAdmin: true })).toBe(false);
  });
});

describe("how a cancelled document reads", () => {
  it("is Cancelled instead of Completed, in a pair of colours for light and dark that never uses Tailwind's dark variant", () => {
    expect(documentStatusKey("completed", true)).toBe("status.cancelled");
    expect(documentStatusKey("completed", false)).toBe("status.document.completed");
    expect(documentStatusKey("completed")).toBe("status.document.completed");
    expect(CANCELLED_BADGE).toContain("light-dark(");
    expect(CANCELLED_BADGE).not.toMatch(/\bdark:/);
    expect(documentBadgeClass("completed", true)).toBe(CANCELLED_BADGE);
    expect(documentBadgeClass("completed", false)).toContain("emerald");
  });

  it("is Cancelled only for a completed document: any other status keeps its own word", () => {
    expect(showsCancelled("completed", true)).toBe(true);
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) {
      expect(showsCancelled(status, true), status).toBe(false);
      expect(documentStatusKey(status, true), status).toBe(`status.document.${status}`);
    }
  });
});
