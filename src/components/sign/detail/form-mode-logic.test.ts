import { describe, expect, it } from "vitest";

import { templateEditorHref } from "@/lib/sign/client/template-library";

import { describeEvent, type DescribeContext, type SignEventRow } from "./events";
import { bannerFor, documentActions } from "./logic";

// A form WITHOUT a signature (migration 169) on the sender's detail screen: what the banner says it is, what can be viewed, how the
// history words each event, and where a template opens. An agreement is unchanged.

const caps = { settings: false };
const signer = (status: string, over: Record<string, unknown> = {}) => ({ full_name: "Ali", status, order_no: 1, declined_at: null, decline_reason: null, ...over }) as never;
const doc = (status: string, mode?: string) => ({ status, completed_at: "2026-10-06T08:00:00Z", expires_at: null, void_reason: null, seal_error: null, retain_until: null, ...(mode ? { mode } : {}) });

describe("the banner of a form", () => {
  it("is marked as a form while it waits, seals, completes and is declined", () => {
    expect(bannerFor(doc("sent", "form"), [signer("sent")], caps)).toMatchObject({ kind: "waiting", form: true, done: 0, total: 1 });
    expect(bannerFor(doc("sealing", "form"), [signer("signed")], caps)).toEqual({ kind: "sealing", form: true });
    expect(bannerFor(doc("completed", "form"), [signer("signed")], caps)).toMatchObject({ kind: "completed", form: true });
    expect(bannerFor(doc("declined", "form"), [signer("declined", { declined_at: "2026-10-06T09:00:00Z" })], caps)).toMatchObject({ kind: "declined", form: true, by: "Ali" });
  });

  it("is not marked for an agreement, or a document with no mode (an older one)", () => {
    for (const mode of ["sign", undefined]) {
      expect(bannerFor(doc("sent", mode), [signer("sent")], caps)).not.toHaveProperty("form");
      expect(bannerFor(doc("sealing", mode), [signer("signed")], caps)).toEqual({ kind: "sealing" });
      expect(bannerFor(doc("completed", mode), [signer("signed")], caps)).not.toHaveProperty("form");
    }
  });

  it("is the same whatever else is true: an expiry and a cancellation are not about signing", () => {
    expect(bannerFor(doc("expired", "form"), [], caps)).toEqual({ kind: "expired", at: null });
    expect(bannerFor(doc("voided", "form"), [], caps)).toEqual({ kind: "voided", reason: null });
  });
});

describe("what the sender may view of a form", () => {
  const files = { base_path: "p/base.pdf", final_path: null as string | null, original_path: null };

  it("offers no document while it is open (its base file is only a stand-in), and the record once there is one", () => {
    expect(documentActions({ status: "sent", mode: "form", ...files }, { void: true })).toMatchObject({ viewKind: null, downloadSigned: false, void: true });
    expect(documentActions({ status: "sealing", mode: "form", ...files }, { void: true })).toMatchObject({ viewKind: null });
    expect(documentActions({ status: "completed", mode: "form", ...files, final_path: "p/final.pdf" }, { void: false })).toMatchObject({ viewKind: "final", downloadSigned: true });
  });

  it("still shows an agreement's file as it was sent while it is open", () => {
    expect(documentActions({ status: "sent", mode: "sign", ...files }, { void: true }).viewKind).toBe("base");
    expect(documentActions({ status: "sent", ...files }, { void: true }).viewKind).toBe("base");
  });
});

describe("the history of a form", () => {
  const ctx = (mode?: string | null): DescribeContext => ({
    signers: [{ id: "s1", full_name: "Ali bin Ahmad", order_no: 1 }],
    signInOrder: false,
    userName: () => "Gokula",
    someone: "Someone",
    teammate: "A teammate",
    mode,
  });
  const row = (type: string, over: Partial<SignEventRow> = {}): SignEventRow => ({ id: type, doc_seq: 1, signer_id: "s1", type, actor_type: "signer", actor_user_id: null, detail: {}, ip: null, device: null, created_at: "2026-10-06T08:00:00Z", ...over });

  it("words each event as the form's own, when the document is a form", () => {
    for (const type of ["created", "sent", "viewed", "consented", "submitted", "declined", "sealed", "completed", "downloaded"]) {
      expect(describeEvent(row(type), ctx("form")).key, type).toBe(`events.${type}Form`);
      expect(describeEvent(row(type), ctx("sign")).key, type).toBe(`events.${type}`);
      expect(describeEvent(row(type), ctx()).key, type).toBe(`events.${type}`);
    }
  });

  it("knows everyone had submitted, and keeps events that have no form wording as they were", () => {
    expect(describeEvent(row("all_submitted", { actor_type: "system", signer_id: null }), ctx("form")).key).toBe("events.all_submitted");
    expect(describeEvent(row("invited"), ctx("form")).key).toBe("events.invited");
    expect(describeEvent(row("delivery_failed"), ctx("form")).key).toBe("events.delivery_failed");
  });

  it("reads the mode the database put on the sent and consent events, even without the document's own", () => {
    expect(describeEvent(row("sent", { detail: { mode: "form" } }), ctx()).key).toBe("events.sentForm");
    expect(describeEvent(row("consented", { detail: { mode: "form", version: "default-form-v1-en" } }), ctx()).key).toBe("events.consentedForm");
    expect(describeEvent(row("sent", { detail: { ordered: false } }), ctx()).key).toBe("events.sent");
  });
});

describe("where a template opens", () => {
  it("is the form builder for a form without a signature and the page editor for an agreement", () => {
    expect(templateEditorHref("t1")).toBe("/sign/templates/t1");
    expect(templateEditorHref("t1", "sign")).toBe("/sign/templates/t1");
    expect(templateEditorHref("t1", "form")).toBe("/sign/templates/t1/form");
  });
});
