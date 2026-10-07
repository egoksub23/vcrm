import { beforeEach, describe, expect, it } from "vitest";

import type { MailboxState, OutgoingEmail } from "@/lib/email/mailbox-types";
import { MailSendError } from "@/lib/email/send-reason";

import type { NotifyDeps } from "../notify";
import type { SignCtx } from "./context";
import { describeEmail, sendTestEmail } from "./email-status";
import { FakeDb } from "./fake-db";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

let db: FakeDb;
let sent: OutgoingEmail[];
let platform: OutgoingEmail[];

function ctxWith(state: MailboxState | null, over: { platform?: boolean; userId?: string | null } = {}): SignCtx {
  const deps: NotifyDeps = {
    emailConfigured: () => over.platform ?? false,
    sendEmail: async (a) => void platform.push(a as unknown as OutgoingEmail),
    loadIdentity: async () => ({ fromName: "Vircle", replyTo: "hello@vircle.example" }),
    sendWhatsApp: async () => {},
    ...(state ? { mailbox: async () => state } : {}),
  };
  return { admin: db.client(), accountId: ACCT, userId: over.userId === undefined ? USER : over.userId, origin: "https://halo.test", deps, now: () => new Date("2026-10-07T08:00:00Z") };
}

const ready = (over: Partial<Extract<MailboxState, { kind: "ready" }>> = {}): MailboxState => ({
  kind: "ready",
  provider: "microsoft365",
  address: "support@vircle.com",
  attachBytes: 1024,
  send: async (m) => void sent.push(m),
  ...over,
});

beforeEach(() => {
  db = new FakeDb();
  sent = [];
  platform = [];
  db.seed("accounts", [{ id: ACCT, name: "Vircle Sdn Bhd", brand_name: "Vircle", timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("profiles", [{ user_id: USER, account_id: ACCT, full_name: "Gokula", email: "gokula@vircle.com" }]);
  db.seed("sign_settings", [{ id: "set1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "ms", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: "en" }]);
});

describe("describeEmail (the Email card)", () => {
  it("names the connected mailbox and its kind, and the name people see", async () => {
    expect(await describeEmail(ctxWith(ready()))).toEqual({ via: "mailbox", provider: "microsoft365", address: "support@vircle.com", problem: null, fromName: "Vircle" });
    expect(await describeEmail(ctxWith(ready({ provider: "gmail", address: "sales@vircle.com" })))).toMatchObject({ via: "mailbox", provider: "gmail", address: "sales@vircle.com" });
  });

  it("says the sender name Secure Sign settings set, when there is one", async () => {
    db.rows("sign_settings")[0].sender_name = "Vircle Merchant Team";
    expect((await describeEmail(ctxWith(ready()))).fromName).toBe("Vircle Merchant Team");
  });

  it("says the platform sender is used when there is no mailbox, or a mailbox that cannot send (and which)", async () => {
    expect(await describeEmail(ctxWith({ kind: "none" }, { platform: true }))).toMatchObject({ via: "platform", provider: null, address: null, problem: null });
    expect(await describeEmail(ctxWith({ kind: "problem", provider: "microsoft365", address: "support@vircle.com", problem: "reconnect" }, { platform: true }))).toMatchObject({ via: "platform", provider: "microsoft365", address: "support@vircle.com", problem: "reconnect" });
  });

  it("says it is not set up, or that the connected mailbox has a problem, when nothing can send", async () => {
    expect(await describeEmail(ctxWith({ kind: "none" }))).toMatchObject({ via: "none", provider: null, address: null, problem: null });
    expect(await describeEmail(ctxWith({ kind: "problem", provider: "gmail", address: "sales@vircle.com", problem: "paused" }))).toMatchObject({ via: "none", provider: "gmail", address: "sales@vircle.com", problem: "paused" });
  });

  it("reads nothing secret: only these fields", async () => {
    const e = await describeEmail(ctxWith(ready()));
    expect(Object.keys(e).sort()).toEqual(["address", "fromName", "problem", "provider", "via"]);
  });
});

describe("sendTestEmail", () => {
  it("sends one short email to the signed-in person's own profile address, in the workspace's language, through the mailbox", async () => {
    const r = await sendTestEmail(ctxWith(ready()));
    expect(r).toEqual({ sent: true, via: "mailbox", provider: "microsoft365", from: "support@vircle.com", to: "gokula@vircle.com", reason: null, detail: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "gokula@vircle.com", fromName: "Vircle", replyTo: "hello@vircle.example", subject: "E-mel ujian daripada Secure Sign" });
    expect(sent[0].attachments).toBeUndefined();
    expect(platform).toHaveLength(0);
  });

  it("goes through the platform sender when that is the transport", async () => {
    const r = await sendTestEmail(ctxWith({ kind: "none" }, { platform: true }));
    expect(r).toMatchObject({ sent: true, via: "platform", from: null, to: "gokula@vircle.com" });
    expect(platform).toHaveLength(1);
  });

  it("answers with the real reason when it did not go, and what the service said", async () => {
    const r = await sendTestEmail(ctxWith(ready({ send: async () => Promise.reject(new MailSendError("mailbox_reconnect", "The refresh token has expired.")) })));
    expect(r).toMatchObject({ sent: false, reason: "mailbox_reconnect", detail: "The refresh token has expired.", via: "mailbox" });

    const odd = await sendTestEmail(ctxWith(ready({ send: async () => Promise.reject(new Error("MailboxNotEnabledForRESTAPI")) })));
    expect(odd).toMatchObject({ sent: false, reason: null, detail: "MailboxNotEnabledForRESTAPI" });
  });

  it("answers not_set_up when nothing can send", async () => {
    const r = await sendTestEmail(ctxWith({ kind: "none" }));
    expect(r).toMatchObject({ sent: false, via: "none", reason: "not_set_up" });
  });

  it("never takes an address from the browser, and refuses when the profile has none", async () => {
    db.rows("profiles")[0].email = "";
    await expect(sendTestEmail(ctxWith(ready()))).rejects.toMatchObject({ code: "no_email", status: 400 });
    await expect(sendTestEmail(ctxWith(ready(), { userId: null }))).rejects.toMatchObject({ code: "no_email" });
    expect(sent).toHaveLength(0);
  });

  it("reads the profile of this workspace only", async () => {
    db.seed("profiles", [{ user_id: "33333333-3333-4333-8333-333333333333", account_id: "99999999-9999-4999-8999-999999999999", full_name: "Other", email: "other@else.com" }]);
    const r = await sendTestEmail(ctxWith(ready()));
    expect(r.to).toBe("gokula@vircle.com");
  });
});
