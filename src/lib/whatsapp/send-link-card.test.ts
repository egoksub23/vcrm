/* eslint-disable @typescript-eslint/no-explicit-any -- rows and calls are read loosely in a test */
// The link card (Compliance requests, migration 185) through the shared send pipeline sendMessageToConversation, with the providers injected: the exact
// WhatsApp call-to-action payload, the 24-hour window, a failed send, what each other channel is given, and above all that the personal address is part of
// what goes to the channel and of NOTHING that is stored: not the message row, not the failed row, not the conversation's preview.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb } from "@/lib/sign/service/fake-db";
import { CARD_WORDS, storedCard } from "@/lib/compliance/chat-link/card";

const h = vi.hoisted(() => ({
  db: null as unknown,
  windowOpen: true,
  failWith: null as unknown,
  calls: [] as { fn: string; args: any }[],
}));

vi.mock("@/lib/platform/usage", () => ({ assertCanSendMessage: async () => undefined, UsageLimitError: class extends Error {} }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/messages/window", () => ({ loadWhatsappWindowOpen: async () => h.windowOpen, isWhatsappWindowOpen: () => h.windowOpen, WHATSAPP_WINDOW_HOURS: 24 }));
vi.mock("@/lib/whatsapp/meta-api", async (original) => {
  const real = await original<typeof import("@/lib/whatsapp/meta-api")>();
  const track = (fn: string) => async (args: any) => {
    h.calls.push({ fn, args });
    if (h.failWith) throw h.failWith;
    return { messageId: `wamid.${fn}` };
  };
  return { ...real, sendInteractiveCtaUrl: track("whatsapp"), sendTextMessage: track("whatsapp_text") };
});
vi.mock("@/lib/messenger/meta-api", async (original) => {
  const real = await original<typeof import("@/lib/messenger/meta-api")>();
  const track = (fn: string) => async (args: any) => {
    h.calls.push({ fn, args });
    if (h.failWith) throw h.failWith;
    return { messageId: `m.${fn}` };
  };
  return { ...real, sendMessengerButtonCard: track("messenger"), sendMessengerText: track("messenger_text") };
});
vi.mock("@/lib/instagram/meta-api", async (original) => {
  const real = await original<typeof import("@/lib/instagram/meta-api")>();
  const track = (fn: string) => async (args: any) => {
    h.calls.push({ fn, args });
    if (h.failWith) throw h.failWith;
    return { messageId: `i.${fn}` };
  };
  return { ...real, sendInstagramGenericCard: track("instagram"), sendInstagramText: track("instagram_text") };
});
vi.mock("@/lib/ms365/token", () => ({ getValidAccessToken: async () => "ms-token" }));
vi.mock("@/lib/ms365/mail-api", () => ({
  sendNewMail: async (a: any) => void h.calls.push({ fn: "email_new", args: a }),
  sendMailViaDraft: async () => ({ purge: Promise.resolve(true) }),
  sendReplyText: async (a: any) => void h.calls.push({ fn: "email_reply_text", args: a }),
  sendReplyWithAttachment: async (a: any) => void h.calls.push({ fn: "email_reply_attachment", args: a }),
  sendReplyHtml: async (a: any) => void h.calls.push({ fn: "email_reply_html", args: a }),
}));
vi.mock("@/lib/gmail/token", () => ({ getValidAccessToken: async () => "gm-token" }));
vi.mock("@/lib/gmail/gmail-api", () => ({
  sendNewMail: async (a: any) => void h.calls.push({ fn: "gmail_new", args: a }),
  sendReply: async (a: any) => void h.calls.push({ fn: "gmail_reply", args: a }),
  getThreadingInfo: async () => ({ threadId: "t1", rfc822MessageId: "<m@x>", subject: "Hello" }),
}));
vi.mock("@/lib/vircle-chat/config", () => ({ findConfigForAccount: async () => ({ id: "cfg", enabled: true, gateway_base_url: "https://gw.test" }), openConfig: () => ({ apiToken: "gw" }) }));
vi.mock("@/lib/vircle-chat/feature", () => ({ vircleChatEnabled: async () => true }));
vi.mock("@/lib/vircle-chat/gateway", () => ({
  GatewayError: class extends Error {},
  sendToGateway: async (_c: unknown, msg: any) => {
    h.calls.push({ fn: "vircle", args: msg });
    return { serverId: "srv1", conversationId: "vc1" };
  },
}));
vi.mock("@/lib/vircle-chat/read-receipts", () => ({ notifyVircleReads: async () => undefined }));

import { encrypt } from "@/lib/whatsapp/encryption";
import { ctaUrlPayload } from "@/lib/whatsapp/meta-api";
import { instagramGenericCardPayload } from "@/lib/instagram/meta-api";
import { messengerButtonCardPayload } from "@/lib/messenger/meta-api";
import { LINK_CARD_TYPE, SendMessageError, VALID_MESSAGE_TYPES, sendMessageToConversation, validateSendMessageParams, type SendMessageParams } from "./send-message";

const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
const CONV = "c1000000-0000-4000-8000-000000000001";
const LINK = "b1000000-0000-4000-8000-000000000001";
const AGENT = "44444444-4444-4444-8444-444444444444";
const URL_ = "https://halo.test/c/link/b1000000000040008000000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let db: FakeDb;

function world(channel: string) {
  db = new FakeDb();
  h.db = db;
  h.calls = [];
  h.windowOpen = true;
  h.failWith = null;
  db.seed("conversations", [
    {
      id: CONV,
      account_id: ACCOUNT,
      contact_id: "e1",
      last_channel_type: channel,
      vircle_conversation_id: null,
      contact: { id: "e1", name: "Siti", phone: "+60123456881", email: "siti@example.test", messenger_psid: "psid1", instagram_igsid: "igsid1", wallet_id: "wallet1" },
    },
  ]);
  db.seed("whatsapp_config", [{ id: "w1", account_id: ACCOUNT, phone_number_id: "pn1", access_token: encrypt("tok"), enabled: true }]);
  db.seed("messenger_config", [{ id: "m1", account_id: ACCOUNT, page_id: "pg1", page_access_token: encrypt("pt"), enabled: true }]);
  db.seed("instagram_config", [{ id: "i1", account_id: ACCOUNT, ig_business_account_id: "ig1", page_access_token: encrypt("pt"), enabled: true }]);
  db.seed("email_config", [{ id: "e1", account_id: ACCOUNT, enabled: true, inbox_enabled: true }]);
  db.seed("gmail_config", [{ id: "g1", account_id: ACCOUNT, enabled: true, inbox_enabled: true }]);
  db.seed("messages", []);
}

const card = (over: Partial<SendMessageParams> = {}): SendMessageParams => ({
  conversationId: CONV,
  messageType: LINK_CARD_TYPE,
  linkCard: { url: URL_, linkId: LINK, locale: "en" },
  senderUserId: AGENT,
  ...over,
});
const messages = () => db.rows("messages") as any[];
const everything = () => JSON.stringify(db.tables);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  world("whatsapp");
});

describe("on WhatsApp", () => {
  it("sends a call-to-action URL message: header, body, one button with the address", async () => {
    const res = await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fn).toBe("whatsapp");
    expect(h.calls[0].args).toMatchObject({
      phoneNumberId: "pn1",
      accessToken: "tok",
      to: "60123456881",
      headerText: CARD_WORDS.en.title,
      bodyText: CARD_WORDS.en.body,
      displayText: CARD_WORDS.en.button,
      url: URL_,
    });
    expect(res.whatsappMessageId).toBe("wamid.whatsapp");
  });

  it("writes the card in the contact's language", async () => {
    await sendMessageToConversation(db.client(), ACCOUNT, card({ linkCard: { url: URL_, linkId: LINK, locale: "ko" } }));
    expect(h.calls[0].args).toMatchObject({ headerText: CARD_WORDS.ko.title, bodyText: CARD_WORDS.ko.body, displayText: CARD_WORDS.ko.button });
  });

  it("stores a message row that has the card's words and the link's id and NOT the address", async () => {
    const res = await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(messages()).toHaveLength(1);
    const row = messages()[0];
    expect(row).toMatchObject({
      id: res.messageId,
      conversation_id: CONV,
      sender_type: "agent",
      sender_id: AGENT,
      content_type: "link_card",
      content_text: "Account closure form",
      channel_type: "whatsapp",
      message_id: "wamid.whatsapp",
      status: "sent",
      media_url: null,
      content_html: null,
    });
    expect(row.send_payload).toEqual({ link_card: storedCard(LINK, "en") });
    expect(everything()).not.toContain(SECRET);
    expect(everything()).not.toContain("/c/link/");
    expect(everything()).not.toContain("halo.test");
  });

  it("shows the title as the conversation's last message, and clears an earlier failure flag", async () => {
    (db.rows("conversations")[0] as any).last_message_failed = true;
    await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(db.rows("conversations")[0]).toMatchObject({ last_message_text: "Account closure form", last_channel_type: "whatsapp", awaiting_response: false, last_message_failed: false });
  });

  it("does not send once the 24-hour window has closed, and saves nothing", async () => {
    h.windowOpen = false;
    const err = await sendMessageToConversation(db.client(), ACCOUNT, card()).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err).toMatchObject({ code: "window_closed", status: 409 });
    expect(h.calls).toHaveLength(0);
    expect(messages()).toHaveLength(0);
  });

  it("keeps a failed card as a failed row, still without the address, and says what failed", async () => {
    h.failWith = Object.assign(new Error("Message failed to send because more than 24 hours have passed"), { code: 131047 });
    const err = (await sendMessageToConversation(db.client(), ACCOUNT, card()).catch((e) => e)) as SendMessageError;
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe("meta_error");
    expect(err.failedMessageId).toBe(messages()[0].id);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ content_type: "link_card", status: "failed", message_id: null, content_text: "Account closure form" });
    expect(messages()[0].send_payload).toEqual({ link_card: storedCard(LINK, "en") });
    expect(everything()).not.toContain(SECRET);
    expect(everything()).not.toContain("/c/link/");
  });

  it("is not a message the dashboard or the public API can send, or the resend route can repeat", () => {
    expect((VALID_MESSAGE_TYPES as readonly string[]).includes(LINK_CARD_TYPE)).toBe(false);
    expect(() => validateSendMessageParams({ messageType: LINK_CARD_TYPE })).toThrow(/needs its address/);
    expect(() => validateSendMessageParams({ messageType: LINK_CARD_TYPE, linkCard: { url: "javascript:alert(1)", linkId: LINK, locale: "en" } })).toThrow(/needs its address/);
    expect(() => validateSendMessageParams({ messageType: LINK_CARD_TYPE, linkCard: { url: URL_, linkId: "not-a-uuid", locale: "en" } })).toThrow(/needs its address/);
    expect(() => validateSendMessageParams({ messageType: LINK_CARD_TYPE, linkCard: { url: URL_, linkId: LINK, locale: "en" } })).not.toThrow();
  });

  it("is not sent as a plain text message when no card is given", async () => {
    await expect(sendMessageToConversation(db.client(), ACCOUNT, { conversationId: CONV, messageType: LINK_CARD_TYPE })).rejects.toMatchObject({ code: "bad_request" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("on the other channels", () => {
  it("Messenger gets a button template", async () => {
    world("messenger");
    await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(h.calls[0]).toMatchObject({ fn: "messenger", args: { pageId: "pg1", recipientPsid: "psid1", buttonTitle: CARD_WORDS.en.button, url: URL_ } });
    expect(h.calls[0].args.text).toBe(`${CARD_WORDS.en.title}\n${CARD_WORDS.en.body}`);
    expect(messages()[0]).toMatchObject({ content_type: "link_card", channel_type: "messenger", status: "sent" });
    expect(everything()).not.toContain(SECRET);
  });

  it("Instagram gets a generic template with a web button", async () => {
    world("instagram");
    await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(h.calls[0]).toMatchObject({ fn: "instagram", args: { igBusinessAccountId: "ig1", recipientIgsid: "igsid1", title: CARD_WORDS.en.title, subtitle: CARD_WORDS.en.body, buttonTitle: CARD_WORDS.en.button, url: URL_ } });
    expect(everything()).not.toContain(SECRET);
  });

  it("email gets an HTML button (a new mail titled with the card), and the stored row has no HTML", async () => {
    world("email");
    await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(h.calls[0].fn).toBe("email_new");
    expect(h.calls[0].args).toMatchObject({ accessToken: "ms-token", toAddress: "siti@example.test", subject: CARD_WORDS.en.title });
    expect(h.calls[0].args.html).toContain(`href="${URL_}"`);
    expect(h.calls[0].args.html).toContain(CARD_WORDS.en.button);
    expect(h.calls[0].args.text).toContain(URL_);
    expect(messages()[0]).toMatchObject({ content_type: "link_card", content_html: null, content_text: "Account closure form" });
    expect(everything()).not.toContain(SECRET);
  });

  it("email replies in the thread with the HTML button when there is a mail to answer", async () => {
    world("email");
    messages().push({ id: "in1", conversation_id: CONV, sender_type: "customer", channel_type: "email", message_id: "AAMk-in", created_at: "2026-10-12T00:00:00Z" });
    await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(h.calls[0].fn).toBe("email_reply_html");
    expect(h.calls[0].args.replyToMessageId).toBe("AAMk-in");
    expect(h.calls[0].args.html).toContain(URL_);
    expect(messages().at(-1)).toMatchObject({ content_html: null });
    expect(everything()).not.toContain(SECRET);
  });

  it("Gmail gets the same HTML button", async () => {
    world("gmail");
    await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(h.calls[0].fn).toBe("gmail_new");
    expect(h.calls[0].args).toMatchObject({ toAddress: "siti@example.test", subject: CARD_WORDS.en.title });
    expect(h.calls[0].args.html).toContain(`href="${URL_}"`);
    expect(everything()).not.toContain(SECRET);
  });

  it("Vircle Chat gets the plain line, because the gateway takes text", async () => {
    world("vircle_chat");
    await sendMessageToConversation(db.client(), ACCOUNT, card());
    expect(h.calls[0].fn).toBe("vircle");
    expect(h.calls[0].args).toMatchObject({ type: "text", text: `${CARD_WORDS.en.title}: ${URL_}`, walletId: "wallet1" });
    expect(messages()[0]).toMatchObject({ content_type: "link_card", content_text: "Account closure form" });
    expect(everything()).not.toContain(SECRET);
  });

  it("the web chat cannot carry it (its visitor reads the message rows), and nothing is saved", async () => {
    world("web_widget");
    const err = await sendMessageToConversation(db.client(), ACCOUNT, card()).catch((e) => e);
    expect(err).toMatchObject({ code: "link_card_unsupported", status: 400 });
    expect(h.calls).toHaveLength(0);
    expect(messages()).toHaveLength(0);
  });
});

describe("the payloads", () => {
  const base = { to: "+60123456881", bodyText: CARD_WORDS.en.body, displayText: CARD_WORDS.en.button, url: URL_, headerText: CARD_WORDS.en.title };

  it("WhatsApp: an interactive message of type cta_url with display_text and url", () => {
    expect(ctaUrlPayload(base)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+60123456881",
      type: "interactive",
      interactive: {
        type: "cta_url",
        header: { type: "text", text: "Account closure form" },
        body: { text: CARD_WORDS.en.body },
        action: { name: "cta_url", parameters: { display_text: "Open closure form", url: URL_ } },
      },
    });
  });

  it("WhatsApp: quotes a message when asked, and refuses what Meta would refuse", () => {
    expect((ctaUrlPayload({ ...base, contextMessageId: "wamid.x" }) as any).context).toEqual({ message_id: "wamid.x" });
    expect(() => ctaUrlPayload({ ...base, displayText: "x".repeat(21) })).toThrow(/1-20 characters/);
    expect(() => ctaUrlPayload({ ...base, displayText: "" })).toThrow(/1-20 characters/);
    expect(() => ctaUrlPayload({ ...base, url: "ftp://x.test/y" })).toThrow(/http or https/);
    expect(() => ctaUrlPayload({ ...base, url: "not a url" })).toThrow(/not a valid URL/);
    expect(() => ctaUrlPayload({ ...base, headerText: "h".repeat(61) })).toThrow();
    expect(() => ctaUrlPayload({ ...base, bodyText: "b".repeat(1025) })).toThrow();
  });

  it("every language's button fits WhatsApp's 20 characters", () => {
    for (const w of Object.values(CARD_WORDS)) expect(() => ctaUrlPayload({ ...base, displayText: w.button })).not.toThrow();
  });

  it("Messenger: a button template with one web_url button", () => {
    expect(messengerButtonCardPayload({ recipientPsid: "p1", text: "Hello", buttonTitle: "Open closure form", url: URL_ })).toEqual({
      recipient: { id: "p1" },
      message: { attachment: { type: "template", payload: { template_type: "button", text: "Hello", buttons: [{ type: "web_url", url: URL_, title: "Open closure form" }] } } },
      messaging_type: "RESPONSE",
    });
  });

  it("Instagram: a generic template with one web_url button", () => {
    expect(instagramGenericCardPayload({ recipientIgsid: "g1", title: "Account closure form", subtitle: "Body", buttonTitle: "Open closure form", url: URL_ })).toEqual({
      recipient: { id: "g1" },
      message: { attachment: { type: "template", payload: { template_type: "generic", elements: [{ title: "Account closure form", subtitle: "Body", buttons: [{ type: "web_url", url: URL_, title: "Open closure form" }] }] } } },
    });
  });
});
