import { describe, expect, it } from "vitest";

import {
  bannerFor,
  bannerTone,
  detailErrorKey,
  documentActions,
  recipientProblems,
  shouldPoll,
  signerActions,
  signersWithUndelivered,
  REMIND_GAP_MS,
  type BannerDoc,
  type BannerSigner,
} from "./logic";

const doc = (over: Partial<BannerDoc> = {}): BannerDoc => ({ status: "in_progress", completed_at: null, expires_at: null, void_reason: null, seal_error: null, ...over });
const signer = (name: string, status: string, order = 1, over: Partial<BannerSigner> = {}): BannerSigner => ({ full_name: name, status: status as BannerSigner["status"], order_no: order, declined_at: null, decline_reason: null, ...over });

describe("shouldPoll", () => {
  it("polls while someone may sign or sealing may finish", () => {
    for (const s of ["sent", "in_progress", "sealing"]) expect(shouldPoll(s)).toBe(true);
    for (const s of ["draft", "completed", "declined", "expired", "voided", "failed"]) expect(shouldPoll(s)).toBe(false);
  });
});

describe("bannerFor", () => {
  const caps = { settings: false };

  it("says who is waited on and how many have signed", () => {
    const b = bannerFor(doc(), [signer("Ali", "signed", 1), signer("Siti", "viewed", 2), signer("Raj", "pending", 3)], caps);
    expect(b).toEqual({ kind: "waiting", names: ["Siti"], more: 0, done: 1, total: 3 });
  });

  it("waits on everyone invited at once when there is no order, and counts the rest", () => {
    const b = bannerFor(doc({ status: "sent" }), [signer("A", "sent"), signer("B", "sent"), signer("C", "viewed")], caps);
    expect(b).toMatchObject({ kind: "waiting", names: ["A", "B"], more: 1, done: 0, total: 3 });
  });

  it("reads sealing, completed and the final states", () => {
    expect(bannerFor(doc({ status: "sealing" }), [], caps)).toEqual({ kind: "sealing" });
    expect(bannerFor(doc({ status: "completed", completed_at: "2026-10-01T00:00:00Z" }), [], caps)).toEqual({ kind: "completed", at: "2026-10-01T00:00:00Z" });
    expect(bannerFor(doc({ status: "expired", expires_at: "2026-10-02T00:00:00Z" }), [], caps)).toEqual({ kind: "expired", at: "2026-10-02T00:00:00Z" });
    expect(bannerFor(doc({ status: "voided", void_reason: "  Wrong terms " }), [], caps)).toEqual({ kind: "voided", reason: "Wrong terms" });
  });

  it("names the first person who declined, with their reason", () => {
    const b = bannerFor(
      doc({ status: "declined" }),
      [signer("Ali", "signed"), signer("Siti", "declined", 2, { declined_at: "2026-10-03T10:00:00Z", decline_reason: "Fee is wrong" })],
      caps,
    );
    expect(b).toEqual({ kind: "declined", by: "Siti", reason: "Fee is wrong" });
  });

  it("says a sealing that keeps failing is stuck, with the reason only for people with sign.settings, and a calm one is not", () => {
    expect(bannerFor(doc({ status: "sealing", seal_error: null }), [], { settings: true })).toEqual({ kind: "sealing" });
    expect(bannerFor(doc({ status: "sealing", seal_error: "  " }), [], { settings: true })).toEqual({ kind: "sealing" });
    const stuck = doc({ status: "sealing", seal_error: "ENOENT: font" });
    expect(bannerFor(stuck, [], { settings: false })).toEqual({ kind: "sealing", stuck: true, error: null });
    expect(bannerFor(stuck, [], { settings: true })).toEqual({ kind: "sealing", stuck: true, error: "ENOENT: font" });
  });

  it("shows the technical note of a failed seal only to people with sign.settings", () => {
    const d = doc({ status: "failed", seal_error: "certificate missing" });
    expect(bannerFor(d, [], { settings: false })).toEqual({ kind: "failed", error: null });
    expect(bannerFor(d, [], { settings: true })).toEqual({ kind: "failed", error: "certificate missing" });
  });

  it("has a tone for every state, never only colour", () => {
    expect(bannerTone({ kind: "completed", at: null })).toBe("success");
    expect(bannerTone({ kind: "failed", error: null })).toBe("danger");
    expect(bannerTone({ kind: "sealing" })).toBe("warning");
    expect(bannerTone({ kind: "voided", reason: null })).toBe("muted");
    expect(bannerTone({ kind: "waiting", names: [], more: 0, done: 0, total: 1 })).toBe("info");
  });
});

describe("documentActions", () => {
  const files = { base_path: "a/base.pdf", final_path: null, original_path: "a/orig.docx" };

  it("offers the signed copy only once it is completed and sealed", () => {
    expect(documentActions({ status: "completed", ...files, final_path: "a/final.pdf" }, { void: true })).toEqual({ downloadSigned: true, viewKind: "final", downloadOriginal: true, void: false });
    expect(documentActions({ status: "sealing", ...files }, { void: true }).downloadSigned).toBe(false);
    expect(documentActions({ status: "completed", ...files }, { void: true }).downloadSigned).toBe(false);
  });

  it("views the file as sent until there is a sealed copy", () => {
    expect(documentActions({ status: "in_progress", ...files }, { void: false }).viewKind).toBe("base");
    expect(documentActions({ status: "in_progress", ...files, base_path: null }, { void: false }).viewKind).toBeNull();
  });

  it("allows voiding only while it is open and only with sign.void", () => {
    expect(documentActions({ status: "sent", ...files }, { void: true }).void).toBe(true);
    expect(documentActions({ status: "in_progress", ...files }, { void: true }).void).toBe(true);
    expect(documentActions({ status: "in_progress", ...files }, { void: false }).void).toBe(false);
    for (const s of ["sealing", "completed", "declined", "expired", "voided", "failed"]) expect(documentActions({ status: s, ...files }, { void: true }).void).toBe(false);
  });

  it("offers the original only when there is one", () => {
    expect(documentActions({ status: "sent", ...files, original_path: null }, { void: true }).downloadOriginal).toBe(false);
  });
});

describe("signerActions", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const caps = { send: true };

  it("offers every action to someone who was invited and has not finished", () => {
    for (const status of ["sent", "viewed"]) {
      const a = signerActions("in_progress", { status: status as "sent", last_reminded_at: null }, caps, now);
      expect(a).toMatchObject({ open: true, remind: true, resend: true, changeRecipient: true, notInvited: false });
    }
  });

  it("offers none to people who finished or to a closed document", () => {
    expect(signerActions("in_progress", { status: "signed", last_reminded_at: null }, caps, now).open).toBe(false);
    expect(signerActions("in_progress", { status: "declined", last_reminded_at: null }, caps, now).open).toBe(false);
    for (const s of ["sealing", "completed", "declined", "expired", "voided", "failed"]) {
      expect(signerActions(s, { status: "sent", last_reminded_at: null }, caps, now)).toMatchObject({ open: false, remind: false, resend: false, changeRecipient: false });
    }
  });

  it("needs sign.send", () => {
    expect(signerActions("sent", { status: "sent", last_reminded_at: null }, { send: false }, now)).toMatchObject({ open: true, remind: false, resend: false, changeRecipient: false });
  });

  it("holds a reminder back for a day and says until when", () => {
    const last = new Date(now.getTime() - 3_600_000).toISOString();
    const a = signerActions("sent", { status: "sent", last_reminded_at: last }, caps, now);
    expect(a.remind).toBe(false);
    expect(a.remindAfter?.getTime()).toBe(new Date(last).getTime() + REMIND_GAP_MS);
    expect(a.resend).toBe(true);
    const later = signerActions("sent", { status: "sent", last_reminded_at: new Date(now.getTime() - REMIND_GAP_MS - 1).toISOString() }, caps, now);
    expect(later.remind).toBe(true);
    expect(later.remindAfter).toBeNull();
  });

  it("marks someone not yet reached in an ordered document", () => {
    expect(signerActions("in_progress", { status: "pending", last_reminded_at: null }, caps, now)).toMatchObject({ notInvited: true, open: false, remind: false });
    expect(signerActions("declined", { status: "pending", last_reminded_at: null }, caps, now).notInvited).toBe(false);
  });
});

describe("recipientProblems", () => {
  const ok = { fullName: "Ali", email: "ali@example.com", phone: "", channel: "email" as const };
  it("accepts a name and an email", () => expect(recipientProblems(ok)).toEqual([]));
  it("asks for a name and a real email", () => {
    expect(recipientProblems({ ...ok, fullName: "  ", email: "ali" })).toEqual(["name", "email"]);
  });
  it("needs an international number only for WhatsApp, and checks one if given", () => {
    expect(recipientProblems({ ...ok, channel: "whatsapp" })).toEqual(["phone"]);
    expect(recipientProblems({ ...ok, channel: "whatsapp", phone: "+60 12-345 6789" })).toEqual([]);
    expect(recipientProblems({ ...ok, phone: "0123456789" })).toEqual(["phone"]);
    expect(recipientProblems({ ...ok, phone: "" })).toEqual([]);
  });
});

describe("signersWithUndelivered", () => {
  const e = (doc_seq: number, type: string, signer_id: string | null, detail: Record<string, unknown> | null = null) => ({ doc_seq, type, signer_id, detail });

  it("flags a person whose invitation did not arrive", () => {
    expect([...signersWithUndelivered([e(1, "sent", null), e(2, "invited", "a"), e(3, "delivery_failed", "a", { channel: "email" })])]).toEqual(["a"]);
  });

  it("clears the flag when a later message to the same person goes through", () => {
    const events = [e(1, "invited", "a"), e(2, "delivery_failed", "a"), e(3, "resent", "a")];
    expect(signersWithUndelivered(events).size).toBe(0);
  });

  it("keeps the flag when the new message fails too, and handles other people separately", () => {
    const events = [e(1, "invited", "a"), e(2, "invited", "b"), e(3, "delivery_failed", "a"), e(4, "recipient_changed", "a"), e(5, "delivery_failed", "a")];
    expect([...signersWithUndelivered(events)]).toEqual(["a"]);
  });

  it("ignores a failure to deliver the signed copy, and unordered input", () => {
    expect(signersWithUndelivered([e(2, "delivery_failed", "a", { kind: "completed" })]).size).toBe(0);
    expect([...signersWithUndelivered([e(3, "delivery_failed", "a"), e(1, "invited", "a")])]).toEqual(["a"]);
  });
});

describe("detailErrorKey", () => {
  it("words the codes this screen knows and falls back for the rest", () => {
    expect(detailErrorKey("signer_not_open")).toBe("errors.signer_not_open");
    expect(detailErrorKey("reason_required")).toBe("errors.reason_required");
    expect(detailErrorKey("something_new")).toBe("errors.generic");
    expect(detailErrorKey(null)).toBe("errors.generic");
  });
});
