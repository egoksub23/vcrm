import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { deliverCode, deliverCompleted, deliverInvitation, deliverOutcome, deliverReminder, signerLink, verifyLink, type DocFacts, type NotifyDeps, type Workspace } from "./notify";
import type { Invitation } from "./types";

const doc: DocFacts = { accountId: "acct", title: "Merchant Application", reference: "SGN-2026-000001", locale: "en", expiresAt: new Date("2026-10-20T00:00:00Z"), codeRequired: false, message: null };
const ws: Workspace = { name: "Vircle", senderName: "Gokula", settings: { sender_name: null, whatsapp_template_name: "sign_invite", whatsapp_template_language: "ms" } };
const inv = (over: Partial<Invitation> = {}): Invitation => ({ signer_id: "s1", token: "t".repeat(64), name: "Ali", email: "ali@example.invalid", phone: "+60123456789", channel: "email", role_key: "merchant", kind: "signer", order_no: 1, ...over });
const admin = {} as SupabaseClient;

function deps(over: Partial<NotifyDeps> = {}): NotifyDeps & { sentEmails: Parameters<NotifyDeps["sendEmail"]>[0][]; sentWa: unknown[] } {
  const sentEmails: Parameters<NotifyDeps["sendEmail"]>[0][] = [];
  const sentWa: unknown[] = [];
  return {
    emailConfigured: () => true,
    sendEmail: async (a) => void sentEmails.push(a),
    loadIdentity: async () => ({ fromName: "Vircle", replyTo: "hello@vircle.example" }),
    sendWhatsApp: async (_a, args) => void sentWa.push(args),
    ...over,
    sentEmails,
    sentWa,
  };
}

describe("links", () => {
  it("builds the signer and verification addresses", () => {
    expect(signerLink("https://halo.vircle.tech/", "abc")).toBe("https://halo.vircle.tech/s/abc");
    expect(verifyLink("https://halo.vircle.tech", "doc-1")).toBe("https://halo.vircle.tech/verify/doc-1");
  });
});

describe("deliverInvitation", () => {
  it("emails the signer under the workspace's name, with the link", async () => {
    const d = deps();
    const r = await deliverInvitation(admin, d, "https://halo.vircle.tech", doc, ws, inv());
    expect(r).toEqual({ channel: "email", status: "sent" });
    expect(d.sentEmails).toHaveLength(1);
    expect(d.sentEmails[0]).toMatchObject({ to: "ali@example.invalid", fromName: "Vircle", replyTo: "hello@vircle.example" });
    expect(d.sentEmails[0].text).toContain(`https://halo.vircle.tech/s/${"t".repeat(64)}`);
    expect(d.sentWa).toHaveLength(0);
  });

  it("uses the sender name from Secure Sign settings when there is one", async () => {
    const d = deps();
    await deliverInvitation(admin, d, "https://x", doc, { ...ws, settings: { ...ws.settings!, sender_name: "Vircle Merchant Team" } }, inv());
    expect(d.sentEmails[0].fromName).toBe("Vircle Merchant Team");
  });

  it("says so when email is not configured, and when it fails", async () => {
    expect(await deliverInvitation(admin, deps({ emailConfigured: () => false }), "https://x", doc, ws, inv())).toMatchObject({ channel: "email", status: "not_configured" });
    const failing = deps({ sendEmail: async () => { throw new Error("Resend 422: invalid recipient"); } });
    expect(await deliverInvitation(admin, failing, "https://x", doc, ws, inv())).toEqual({ channel: "email", status: "failed", detail: "Resend 422: invalid recipient" });
  });

  it("sends WhatsApp only when chosen, through the approved template with name, title and link", async () => {
    const d = deps();
    const r = await deliverInvitation(admin, d, "https://halo.vircle.tech", doc, ws, inv({ channel: "whatsapp" }));
    expect(r).toEqual({ channel: "whatsapp", status: "sent" });
    expect(d.sentEmails).toHaveLength(0);
    expect(d.sentWa[0]).toEqual({ accountId: "acct", to: "+60123456789", templateName: "sign_invite", language: "ms", params: ["Ali", "Merchant Application", `https://halo.vircle.tech/s/${"t".repeat(64)}`] });
  });

  it("does not send WhatsApp without a number or a template", async () => {
    expect(await deliverInvitation(admin, deps(), "https://x", doc, ws, inv({ channel: "whatsapp", phone: "0123" }))).toMatchObject({ status: "failed" });
    const noTemplate = { ...ws, settings: { ...ws.settings!, whatsapp_template_name: null } };
    expect(await deliverInvitation(admin, deps(), "https://x", doc, noTemplate, inv({ channel: "whatsapp" }))).toMatchObject({ channel: "whatsapp", status: "not_configured" });
  });

  it("reports a WhatsApp workspace that is not connected as not configured", async () => {
    const d = deps({ sendWhatsApp: async () => { throw new Error("whatsapp_not_configured"); } });
    expect(await deliverInvitation(admin, d, "https://x", doc, ws, inv({ channel: "whatsapp" }))).toMatchObject({ status: "not_configured" });
  });

  it("asks a filler to complete", async () => {
    const d = deps();
    await deliverInvitation(admin, d, "https://x", doc, ws, inv({ kind: "filler" }), { fill: true });
    expect(d.sentEmails[0].subject).toContain("complete");
  });
});

describe("the other deliveries", () => {
  it("sends a reminder, a code (always by email) and outcomes", async () => {
    const d = deps();
    expect(await deliverReminder(admin, d, "https://x", doc, ws, inv())).toMatchObject({ status: "sent" });
    expect(d.sentEmails[0].subject).toContain("Reminder");
    expect(await deliverCode(d, doc, ws, "ali@example.invalid", "123456")).toMatchObject({ status: "sent" });
    expect(d.sentEmails[1].text).toContain("123456");
    expect(await deliverOutcome(d, doc, ws, { name: "G", email: "g@example.invalid", channel: "email", locale: "en" }, { kind: "declined", by: "Ali", reason: "No" })).toMatchObject({ status: "sent" });
    expect(d.sentEmails[2].text).toContain("Ali declined");
    expect(await deliverOutcome(d, doc, ws, { name: "G", email: "g@example.invalid", channel: "email", locale: "ms" }, { kind: "expired" })).toMatchObject({ status: "sent" });
    expect(d.sentEmails[3].subject).toContain("Tamat tempoh");
  });

  it("attaches the signed copy when it is small enough, and only links it when it is not", async () => {
    const d = deps();
    const to = { name: "Ali", email: "ali@example.invalid", channel: "email" as const, locale: "en" as const };
    await deliverCompleted(d, doc, ws, to, { bytes: new Uint8Array([1, 2, 3]), filename: "Merchant Application.pdf" }, "https://x/d");
    expect(d.sentEmails[0].attachments).toEqual([{ filename: "Merchant Application.pdf", content: Buffer.from([1, 2, 3]).toString("base64") }]);
    expect(d.sentEmails[0].text).toContain("attached");
    await deliverCompleted(d, doc, ws, to, { bytes: new Uint8Array(21 * 1024 * 1024), filename: "big.pdf" }, "https://x/d");
    expect(d.sentEmails[1].attachments).toBeUndefined();
    expect(d.sentEmails[1].text).not.toContain("attached");
    expect(d.sentEmails[1].text).toContain("https://x/d");
  });

  it("never throws", async () => {
    const boom = deps({ loadIdentity: async () => { throw new Error("db down"); } });
    await expect(deliverCode(boom, doc, ws, "a@example.invalid", "1")).resolves.toMatchObject({ status: "failed" });
    void vi;
  });
});
