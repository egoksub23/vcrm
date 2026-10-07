import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { MailboxState, OutgoingEmail } from "@/lib/email/mailbox-types";
import { MailSendError } from "@/lib/email/send-reason";
import { GMAIL_ATTACH_BYTES } from "@/lib/email/gmail-sender";
import { MS365_ATTACH_BYTES } from "@/lib/email/ms365-sender";

import {
  chooseEmailTransport,
  deliverCode,
  deliverCompleted,
  deliverCopy,
  deliverEnvelopeCompleted,
  deliverEnvelopeCopy,
  deliverInvitation,
  deliverTestEmail,
  realDeps,
  SIGN_MAIL_HEADERS,
  type DocFacts,
  type EnvelopeFacts,
  type NotifyDeps,
  type Workspace,
} from "./notify";
import type { Invitation } from "./types";

// Which way Doc Sign email goes (the workspace's connected mailbox, else the platform sender, else nowhere) and what that does to the message: the
// words, files and identity are the same whichever way; only the last step differs, and the files that fit differ by transport.

const MB = 1024 * 1024;
const doc: DocFacts = { accountId: "acct", title: "Merchant Application", reference: "SGN-1", locale: "en", expiresAt: null, codeRequired: false, message: null };
const env: EnvelopeFacts = { accountId: "acct", title: "Onboarding pack", reference: "COL-1", locale: "en", expiresAt: null, codeRequired: false, message: null, documents: ["One", "Two"] };
const ws: Workspace = { name: "Vircle", senderName: "Gokula", settings: null };
const to = { name: "Ali", email: "ali@example.com", channel: "email" as const, locale: "en" as const };
const inv: Invitation = { signer_id: "s1", token: "t".repeat(64), name: "Ali", email: "ali@example.com", phone: null, channel: "email", role_key: "merchant", kind: "signer", order_no: 1 };
const admin = {} as SupabaseClient;
const pdf = (mb: number, filename = "signed.pdf") => ({ bytes: new Uint8Array(Math.floor(mb * MB)).fill(1), filename });

interface World {
  deps: NotifyDeps;
  platform: OutgoingEmail[];
  mailbox: OutgoingEmail[];
}

function world(opts: { state?: MailboxState | (() => Promise<MailboxState>); platform?: boolean } = {}): World {
  const platform: OutgoingEmail[] = [];
  const mailbox: OutgoingEmail[] = [];
  const state: MailboxState | (() => Promise<MailboxState>) = opts.state ?? readyMailbox(mailbox);
  const resolved = typeof state === "function" ? state : async () => state;
  const deps: NotifyDeps = {
    emailConfigured: () => opts.platform ?? false,
    sendEmail: async (a) => void platform.push(a as unknown as OutgoingEmail),
    loadIdentity: async () => ({ fromName: "Vircle", replyTo: "hello@vircle.example" }),
    sendWhatsApp: async () => {},
    mailbox: resolved,
  };
  return { deps, platform, mailbox };
}

/** A ready mailbox that records what it is given, and can be made to fail. */
function readyMailbox(sent: OutgoingEmail[], over: { attachBytes?: number; fail?: Error; provider?: "microsoft365" | "gmail" } = {}): MailboxState {
  return {
    kind: "ready",
    provider: over.provider ?? "microsoft365",
    address: "support@vircle.com",
    attachBytes: over.attachBytes ?? MS365_ATTACH_BYTES,
    send: async (m) => {
      if (over.fail) throw over.fail;
      sent.push(m);
    },
  };
}

describe("which way email goes", () => {
  it("goes through a ready connected mailbox, not the platform sender, even when the platform sender is set up", async () => {
    const sent: OutgoingEmail[] = [];
    const w = world({ platform: true, state: readyMailbox(sent) });
    expect(await deliverInvitation(admin, w.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "sent" });
    expect(sent).toHaveLength(1);
    expect(w.platform).toHaveLength(0);
    // the words, identity and recipient are the shared ones
    expect(sent[0]).toMatchObject({ to: "ali@example.com", fromName: "Vircle", replyTo: "hello@vircle.example" });
    expect(sent[0].text).toContain(`https://halo.test/s/${"t".repeat(64)}`);
  });

  it("goes through the platform sender when there is no mailbox, and says it is not set up when there is neither", async () => {
    const w = world({ platform: true, state: { kind: "none" } });
    expect(await deliverInvitation(admin, w.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "sent" });
    expect(w.platform).toHaveLength(1);

    const none = world({ platform: false, state: { kind: "none" } });
    const d = await deliverInvitation(admin, none.deps, "https://halo.test", doc, ws, inv);
    expect(d.status).toBe("not_configured");
    expect(d.detail).toMatch(/^not_set_up: /);
    // no instruction to set an environment variable in a message a workspace's sender reads
    expect(d.detail).not.toMatch(/RESEND/);
  });

  it("is the old behaviour exactly when the deps predate the mailbox (no `mailbox` at all)", async () => {
    const w = world({ platform: true });
    delete (w.deps as { mailbox?: unknown }).mailbox;
    expect(await deliverInvitation(admin, w.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "sent" });
    expect(w.platform).toHaveLength(1);
  });

  it("falls back to the platform sender when the mailbox cannot send, and reports why only when nothing can", async () => {
    const problem: MailboxState = { kind: "problem", provider: "microsoft365", address: "support@vircle.com", problem: "reconnect" };
    const withPlatform = world({ platform: true, state: problem });
    expect(await deliverInvitation(admin, withPlatform.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "sent" });
    expect(withPlatform.platform).toHaveLength(1);
    expect(await chooseEmailTransport(withPlatform.deps, "acct")).toMatchObject({ via: "platform", skipped: { provider: "microsoft365", address: "support@vircle.com", problem: "reconnect" } });

    const alone = world({ platform: false, state: problem });
    expect(await deliverInvitation(admin, alone.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "failed", detail: "mailbox_reconnect: mailbox support@vircle.com" });
    const paused = world({ platform: false, state: { kind: "problem", provider: "gmail", address: "sales@vircle.com", problem: "paused" } });
    expect((await deliverCode(paused.deps, doc, ws, "ali@example.com", "123456")).detail).toBe("mailbox_paused: mailbox sales@vircle.com");
  });

  it("treats a mailbox that cannot be read as one that cannot send, never as a crash", async () => {
    const w = world({
      platform: false,
      state: async () => {
        throw new Error("database down");
      },
    });
    expect(await deliverInvitation(admin, w.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "failed", detail: "service_unavailable" });
    const withPlatform = world({
      platform: true,
      state: async () => {
        throw new Error("database down");
      },
    });
    expect((await deliverInvitation(admin, withPlatform.deps, "https://halo.test", doc, ws, inv)).status).toBe("sent");
  });

  it("puts the named reason of a failed send in the delivery's detail, and plain text for a failure it cannot name", async () => {
    const limited = world({ state: readyMailbox([], { fail: new MailSendError("daily_limit", "Daily user sending quota exceeded.") }) });
    expect(await deliverInvitation(admin, limited.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "failed", detail: "daily_limit: Daily user sending quota exceeded." });
    const odd = world({ state: readyMailbox([], { fail: new Error("something odd") }) });
    expect(await deliverInvitation(admin, odd.deps, "https://halo.test", doc, ws, inv)).toEqual({ channel: "email", status: "failed", detail: "something odd" });
  });

  it("marks every message of the workspace's mailbox with the Doc Sign header the inbox ingestion refuses", () => {
    expect(SIGN_MAIL_HEADERS).toEqual({ "X-Halo-Sign": "1" });
    expect(typeof realDeps.mailbox).toBe("function");
  });
});

describe("the files that fit through each transport", () => {
  it("through Microsoft 365 a signed copy over 2.5 MB is not attached and the message carries the link instead; under it, it is attached", async () => {
    const small: OutgoingEmail[] = [];
    await deliverCompleted(world({ state: readyMailbox(small) }).deps, doc, ws, to, pdf(2), "https://halo.test/dl");
    expect(small[0].attachments).toHaveLength(1);
    expect(small[0].text).toContain("attached to this message");

    const big: OutgoingEmail[] = [];
    await deliverCompleted(world({ state: readyMailbox(big) }).deps, doc, ws, to, pdf(3), "https://halo.test/dl");
    expect(big[0].attachments).toBeUndefined();
    expect(big[0].text).not.toContain("attached to this message");
    expect(big[0].html).toContain("https://halo.test/dl");
  });

  it("through Gmail the limit is 17 MB of raw files (25 MB for the whole message, base64 a third larger)", async () => {
    expect(GMAIL_ATTACH_BYTES).toBe(17 * MB);
    const fits: OutgoingEmail[] = [];
    await deliverCompleted(world({ state: readyMailbox(fits, { provider: "gmail", attachBytes: GMAIL_ATTACH_BYTES }) }).deps, doc, ws, to, pdf(16.9), "https://halo.test/dl");
    expect(fits[0].attachments).toHaveLength(1);
    const tooBig: OutgoingEmail[] = [];
    await deliverCompleted(world({ state: readyMailbox(tooBig, { provider: "gmail", attachBytes: GMAIL_ATTACH_BYTES }) }).deps, doc, ws, to, pdf(17.1), "https://halo.test/dl");
    expect(tooBig[0].attachments).toBeUndefined();
    expect(tooBig[0].text).not.toContain("attached to this message");
    expect(tooBig[0].html).toContain("https://halo.test/dl");
  });

  it("through the platform sender the limit is still 20 MB, and a mailbox never raises it above that", async () => {
    const w = world({ platform: true, state: { kind: "none" } });
    await deliverCompleted(w.deps, doc, ws, to, pdf(19), "https://halo.test/dl");
    expect(w.platform[0].attachments).toHaveLength(1);
    const huge: OutgoingEmail[] = [];
    await deliverCompleted(world({ state: readyMailbox(huge, { attachBytes: 50 * MB }) }).deps, doc, ws, to, pdf(21), "https://halo.test/dl");
    expect(huge[0].attachments).toBeUndefined();
  });

  it("fits a collection's files in the transport's budget, in order: the first that fits, then any later one that still does", async () => {
    const sent: OutgoingEmail[] = [];
    const gmail = world({ state: readyMailbox(sent, { provider: "gmail", attachBytes: GMAIL_ATTACH_BYTES }) });
    await deliverEnvelopeCompleted(gmail.deps, env, ws, to, [pdf(10, "One.pdf"), pdf(10, "Two.pdf"), pdf(5, "Three.pdf")]);
    expect(sent[0].attachments!.map((a) => a.filename)).toEqual(["One.pdf", "Three.pdf"]);

    const ms: OutgoingEmail[] = [];
    await deliverEnvelopeCompleted(world({ state: readyMailbox(ms) }).deps, env, ws, to, [pdf(2, "One.pdf"), pdf(1, "Two.pdf"), pdf(0.4, "Three.pdf")]);
    expect(ms[0].attachments!.map((a) => a.filename)).toEqual(["One.pdf", "Three.pdf"]);
  });

  it("applies the same budget to the people who receive a copy, and names the file left out with the page that checks it", async () => {
    const one: OutgoingEmail[] = [];
    await deliverCopy(world({ state: readyMailbox(one) }).deps, doc, ws, { name: "Cara", email: "cara@example.com" }, pdf(3), "https://halo.test/verify/d1");
    expect(one[0].attachments).toBeUndefined();
    expect(one[0].text).toContain("https://halo.test/verify/d1");

    const many: OutgoingEmail[] = [];
    const files = [
      { ...pdf(2, "One.pdf"), title: "One", verifyUrl: "https://halo.test/verify/1" },
      { ...pdf(2, "Two.pdf"), title: "Two", verifyUrl: "https://halo.test/verify/2" },
    ];
    await deliverEnvelopeCopy(world({ state: readyMailbox(many) }).deps, env, ws, { name: "Cara", email: "cara@example.com" }, files);
    expect(many[0].attachments!.map((a) => a.filename)).toEqual(["One.pdf"]);
    expect(many[0].text).toContain("Two: https://halo.test/verify/2");
  });

  it("never throws, even when building the message fails", async () => {
    const w = world({ platform: true, state: { kind: "none" } });
    const broken = { get bytes(): Uint8Array { throw new Error("file unreadable"); }, filename: "x.pdf" } as unknown as { bytes: Uint8Array; filename: string };
    expect(await deliverCompleted(w.deps, doc, ws, to, broken, "https://halo.test/dl")).toEqual({ channel: "email", status: "failed", detail: "file unreadable" });
  });
});

describe("the transport in use", () => {
  it("is the mailbox first, else the platform, else none", async () => {
    expect(await chooseEmailTransport(world({ state: readyMailbox([]), platform: true }).deps, "a")).toMatchObject({ via: "mailbox", provider: "microsoft365", address: "support@vircle.com", attachBytes: MS365_ATTACH_BYTES });
    expect(await chooseEmailTransport(world({ state: { kind: "none" }, platform: true }).deps, "a")).toMatchObject({ via: "platform", skipped: null });
    expect(await chooseEmailTransport(world({ state: { kind: "none" }, platform: false }).deps, "a")).toEqual({ via: "none", problem: null });
  });
});

describe("the test email", () => {
  it("is one short message through the transport in use, and says which", async () => {
    const sent: OutgoingEmail[] = [];
    const r = await deliverTestEmail(world({ state: readyMailbox(sent) }).deps, "acct", "me@vircle.com", "ko", "Vircle", null);
    expect(r).toMatchObject({ delivery: { status: "sent" }, via: "mailbox", provider: "microsoft365", from: "support@vircle.com" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("me@vircle.com");
    expect(sent[0].subject).toBe("Doc Sign 테스트 이메일");
    expect(sent[0].text).not.toMatch(/https?:\/\//);

    const p = world({ platform: true, state: { kind: "none" } });
    expect(await deliverTestEmail(p.deps, "acct", "me@vircle.com", "en", "Vircle", "Vircle Team")).toMatchObject({ delivery: { status: "sent" }, via: "platform", provider: null, from: null });
    expect(p.platform[0].fromName).toBe("Vircle Team");
  });

  it("reports the real reason when it did not go", async () => {
    const r = await deliverTestEmail(world({ state: readyMailbox([], { fail: new MailSendError("mailbox_reconnect", "token revoked") }) }).deps, "acct", "me@vircle.com", "en", "Vircle", null);
    expect(r.delivery).toEqual({ channel: "email", status: "failed", detail: "mailbox_reconnect: token revoked" });
    const none = await deliverTestEmail(world({ state: { kind: "none" } }).deps, "acct", "me@vircle.com", "en", "Vircle", null);
    expect(none).toMatchObject({ delivery: { status: "not_configured" }, via: "none" });
  });
});
