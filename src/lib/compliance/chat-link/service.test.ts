/* eslint-disable @typescript-eslint/no-explicit-any -- rows and calls are read loosely in a test */
// Sending the personal closure form in a chat (migration 185) against the in-memory database, with the database functions as their stand-in
// (test-support.ts) and an injected send pipeline: the order (the case first, then the link, then the card), every channel's plan, the window, a failed
// send, sending again, withdrawing, who may, and that the address is never stored. The SQL is proved by supabase/ci/verify-185-compliance-chat-link.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeDb } from "@/lib/sign/service/fake-db";
import { SendMessageError } from "@/lib/whatsapp/send-message";

import { ACCOUNT, AGENT, HEAD, OFFICER, OPS, publicWorld } from "../test-support";
import { cardStatuses, linksOfRequest, mayActOnLink, type LinkActor } from "./read";
import { reasonOfSendError, resendClosureForm, revokeClosureForm, sendClosureForm, type ChatLinkDeps } from "./service";
import { installLinkRpc } from "./test-support";

const CONV = "c1000000-0000-4000-8000-000000000001";
const CONTACT = "e1000000-0000-4000-8000-000000000001";
const REQ = "d1000000-0000-4000-8000-000000000001";
const ORIGIN = "https://halo.test";

let db: FakeDb;
let nowMs: number;
let windowOpen: boolean;
let send: ReturnType<typeof vi.fn>;
let sendError: unknown;

const deps = (): ChatLinkDeps => ({
  now: () => new Date(nowMs),
  origin: () => ORIGIN,
  windowOpen: async () => windowOpen,
  send: send as never,
});
const admin = () => db.client();
const links = () => db.rows("compliance_form_links") as any[];
const events = () => (db.rows("compliance_request_events") as any[]).filter((e) => e.request_id === REQ);
const input = (over: Record<string, unknown> = {}) => ({ accountId: ACCOUNT, requestId: REQ, actor: AGENT, conversationId: CONV, resend: false, ...over });
const actor = (over: Partial<LinkActor> = {}): LinkActor => ({ accountId: ACCOUNT, userId: AGENT, canReview: false, canRaise: true, ...over });

function seedConversation(channel: string, language: string | null = "ms") {
  const rows = db.rows("conversations") as any[];
  rows.length = 0;
  rows.push({ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: channel, contact: { language } });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = publicWorld();
  nowMs = Date.UTC(2026, 9, 13, 10, 0, 0);
  windowOpen = true;
  sendError = null;
  installLinkRpc(db, { now: () => nowMs });
  db.seed("contacts", [{ id: CONTACT, account_id: ACCOUNT, name: "Siti Aminah", phone: "+60123456881", email: null, language: "ms", deleted_at: null }]);
  db.seed("conversations", []);
  seedConversation("whatsapp");
  db.seed("compliance_requests", [
    { id: REQ, account_id: ACCOUNT, reference: "CMP-2026-000001", type_key: "closure", status: "received", source: "inbox", channel: "whatsapp", customer_name: "Siti Aminah", customer_email: null, customer_phone: "+60123456881", conversation_id: CONV, contact_id: CONTACT, created_by: AGENT, data: {}, data_enc: null, customer_locale: null },
  ]);
  send = vi.fn(async () => {
    if (sendError) throw sendError;
    return { messageId: "m0000000-0000-4000-8000-000000000001", whatsappMessageId: "wamid.1" };
  });
});

const everything = () => JSON.stringify(db.tables);

describe("sending the closure form in the chat: the case first, then the link, then the card", () => {
  it("mints a link for the existing case and puts a card in the conversation, in the contact's language", async () => {
    const out = await sendClosureForm(admin(), deps(), input());
    expect(out).toMatchObject({ status: "sent", mode: "card", channel: "whatsapp" });
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ request_id: REQ, account_id: ACCOUNT, conversation_id: CONV, channel: "whatsapp", locale: "ms", created_by: AGENT });
    expect(links()[0].sent_at).not.toBeNull();
    expect(links()[0].message_id).toBe("m0000000-0000-4000-8000-000000000001");
    // the case was not touched: still the one case, still received, still linked
    expect(db.rows("compliance_requests")).toHaveLength(1);
    // the card went through the shared pipeline as a link card, with the address in the call and the language of the contact
    expect(send).toHaveBeenCalledTimes(1);
    const [, accountId, params] = send.mock.calls[0] as [unknown, string, any];
    expect(accountId).toBe(ACCOUNT);
    expect(params).toMatchObject({ conversationId: CONV, messageType: "link_card", senderType: "agent", senderUserId: AGENT, channelOverride: "whatsapp", persistFailedAttempt: true });
    expect(params.linkCard.locale).toBe("ms");
    expect(params.linkCard.linkId).toBe(links()[0].id);
    expect(params.linkCard.url).toMatch(new RegExp(`^${ORIGIN}/c/link/${String(links()[0].id).replace(/-/g, "")}\\.[A-Za-z0-9_-]{43}$`));
  });

  it("answers without the address when it was sent", async () => {
    const out = await sendClosureForm(admin(), deps(), input());
    expect(JSON.stringify(out)).not.toMatch(/https?:|\/c\/link/);
    expect(Object.keys(out).sort()).toEqual(["channel", "expiresAt", "linkId", "mode", "status"]);
  });

  it("never stores the address or the token: not in the link, the events or anything else", async () => {
    await sendClosureForm(admin(), deps(), input());
    const url = (send.mock.calls[0][2] as any).linkCard.url as string;
    const token = url.split("/c/link/")[1];
    const all = everything();
    expect(all).not.toContain(token);
    expect(all).not.toContain(token.split(".")[1]);
    expect(all).not.toContain("/c/link/");
    expect(links()[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(links()[0].token_hash).not.toContain(token.split(".")[1]);
  });

  it("writes the timeline: minted, then sent, naming the channel and the link and nothing else", async () => {
    await sendClosureForm(admin(), deps(), input());
    const acts = events().filter((e) => e.kind === "form_link");
    expect(acts.map((e) => e.detail.action)).toEqual(["minted", "sent"]);
    expect(acts[0].detail).toMatchObject({ link: links()[0].id, channel: "whatsapp" });
    expect(acts[1].actor).toBe(AGENT);
    expect(JSON.stringify(acts)).not.toMatch(/https?:|\/c\/link/);
  });

  it("uses the contact's language, else the case's, else English", async () => {
    seedConversation("whatsapp", null);
    (db.rows("compliance_requests") as any[])[0].customer_locale = "ko";
    await sendClosureForm(admin(), deps(), input());
    expect((send.mock.calls[0][2] as any).linkCard.locale).toBe("ko");
    seedConversation("whatsapp", null);
    (db.rows("compliance_requests") as any[])[0].customer_locale = null;
    await sendClosureForm(admin(), deps(), input({ resend: true }));
    expect((send.mock.calls[1][2] as any).linkCard.locale).toBe("en");
  });

  it("refuses anything but a closure, and a person the database does not allow", async () => {
    (db.rows("compliance_requests") as any[])[0].type_key = "withdrawal";
    expect(await sendClosureForm(admin(), deps(), input())).toEqual({ status: "unavailable", reason: "not_closure" });
    expect(links()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    (db.rows("compliance_requests") as any[])[0].type_key = "closure";
    installLinkRpc(db, { allowed: new Set([OFFICER]), now: () => nowMs });
    await expect(sendClosureForm(admin(), deps(), input({ actor: OPS }))).rejects.toMatchObject({ code: "forbidden" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a closure that has moved on to sign-off or a form that already came back", async () => {
    (db.rows("compliance_requests") as any[])[0].status = "awaiting_signoff";
    await expect(sendClosureForm(admin(), deps(), input())).rejects.toMatchObject({ code: "form_link_not_allowed" });
    (db.rows("compliance_requests") as any[])[0].status = "received";
    links().push({ id: "b9", request_id: REQ, account_id: ACCOUNT, token_hash: "0".repeat(64), submitted_at: "2026-10-13T09:00:00Z", expires_at: "2026-10-26T10:00:00Z" });
    await expect(sendClosureForm(admin(), deps(), input())).rejects.toMatchObject({ code: "form_link_submitted" });
  });
});

describe("what each channel does with the card", () => {
  it.each([
    ["messenger", "card"],
    ["instagram", "card"],
    ["email", "card"],
    ["gmail", "card"],
    ["vircle_chat", "text"],
  ])("%s is sent as %s", async (channel, mode) => {
    seedConversation(channel);
    const out = await sendClosureForm(admin(), deps(), input());
    expect(out).toMatchObject({ status: "sent", mode, channel });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][2] as any).channelOverride).toBe(channel);
  });

  it("does not send on WhatsApp once the 24-hour window has closed: the link is made, the agent is told why, with the address once", async () => {
    windowOpen = false;
    const out = await sendClosureForm(admin(), deps(), input());
    expect(out).toMatchObject({ status: "not_sent", reason: "window_expired", channel: "whatsapp" });
    expect((out as any).url).toMatch(/^https:\/\/halo\.test\/c\/link\//);
    expect(send).not.toHaveBeenCalled();
    expect(links()).toHaveLength(1);
    expect(links()[0].sent_at).toBeNull();
    expect(events().filter((e) => e.kind === "form_link").map((e) => [e.detail.action, e.detail.reason])).toEqual([["minted", undefined], ["not_sent", "window_expired"]]);
    // even then the address is in the answer only
    expect(everything()).not.toContain((out as any).url.split("/c/link/")[1]);
  });

  it("does not ask the window question for a channel that has no such window", async () => {
    seedConversation("messenger");
    const asked = vi.fn(async () => false);
    await sendClosureForm(admin(), { ...deps(), windowOpen: asked }, input());
    expect(asked).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
  });

  it("does not send in the web chat (its visitor reads the message rows, so the address would be stored): Copy link instead", async () => {
    seedConversation("web_widget");
    const out = await sendClosureForm(admin(), deps(), input());
    expect(out).toMatchObject({ status: "not_sent", reason: "channel_unsupported" });
    expect(send).not.toHaveBeenCalled();
  });

  it("makes the link but sends nothing when the case has no conversation, or a channel nobody knows", async () => {
    expect(await sendClosureForm(admin(), deps(), input({ conversationId: null }))).toMatchObject({ status: "not_sent", reason: "no_channel", channel: null });
    seedConversation("sms");
    expect(await sendClosureForm(admin(), deps(), input({ resend: true }))).toMatchObject({ status: "not_sent", reason: "no_channel" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("when the send fails", () => {
  it("leaves the case and the link, records the failed message, and gives the agent the link to copy", async () => {
    sendError = new SendMessageError("meta_error", "Meta API error: boom", 502, { failedMessageId: "f0000000-0000-4000-8000-000000000009" });
    const out = await sendClosureForm(admin(), deps(), input());
    expect(out).toMatchObject({ status: "not_sent", reason: "send_failed" });
    expect((out as any).url).toContain("/c/link/");
    expect(db.rows("compliance_requests")).toHaveLength(1);
    expect(links()[0]).toMatchObject({ sent_at: null, message_id: "f0000000-0000-4000-8000-000000000009" });
    expect(events().find((e) => e.detail.action === "not_sent")?.detail.reason).toBe("send_failed");
  });

  it("words the reason without the provider's words", () => {
    expect(reasonOfSendError(new SendMessageError("window_closed", "The 24-hour WhatsApp window has closed", 409))).toBe("window_expired");
    expect(reasonOfSendError(new SendMessageError("link_card_unsupported", "x", 400))).toBe("channel_unsupported");
    expect(reasonOfSendError(new SendMessageError("whatsapp_not_configured", "x", 400))).toBe("not_configured");
    expect(reasonOfSendError(new SendMessageError("channel_disabled", "x", 400))).toBe("not_configured");
    expect(reasonOfSendError(new SendMessageError("meta_error", "Meta API error: 131047 re-engagement", 502))).toBe("send_failed");
    expect(reasonOfSendError(new Error("anything else"))).toBe("send_failed");
  });

  it("treats a window that closed between the check and the send like a closed window", async () => {
    sendError = new SendMessageError("window_closed", "closed", 409);
    expect(await sendClosureForm(admin(), deps(), input())).toMatchObject({ status: "not_sent", reason: "window_expired" });
  });
});

describe("sending again and withdrawing", () => {
  it("makes a new link and the old one stops working; the timeline says it was sent again", async () => {
    await sendClosureForm(admin(), deps(), input());
    nowMs += 3_600_000;
    const out = await resendClosureForm(admin(), deps(), actor({ canReview: true }), REQ);
    expect(out).toMatchObject({ status: "sent" });
    expect(links()).toHaveLength(2);
    expect(links().filter((l) => !l.revoked_at && !l.submitted_at)).toHaveLength(1);
    expect(links()[0]).toMatchObject({ revoked_reason: "replaced", revoked_by: AGENT });
    expect(events().filter((e) => e.kind === "form_link").map((e) => e.detail.action)).toEqual(["minted", "sent", "revoked", "minted", "resent"]);
  });

  it("resends into the conversation the case is linked to, and gives the address once when that cannot be done", async () => {
    windowOpen = false;
    const out = await resendClosureForm(admin(), deps(), actor({ canReview: true }), REQ);
    expect(out).toMatchObject({ status: "not_sent", reason: "window_expired" });
    expect((out as any).url).toContain("/c/link/");
  });

  it("is for a person who holds review or approve (any case) or compliance.raise (a case they raised), and no one else", async () => {
    const officer = actor({ userId: OFFICER, canReview: true, canRaise: false });
    const other = actor({ userId: OPS, canReview: false, canRaise: true });
    const nobody = actor({ userId: HEAD, canReview: false, canRaise: false });
    expect(mayActOnLink(officer, { created_by: AGENT })).toBe(true);
    expect(mayActOnLink(actor(), { created_by: AGENT })).toBe(true);
    expect(mayActOnLink(other, { created_by: AGENT })).toBe(false);
    expect(mayActOnLink(other, { created_by: null })).toBe(false);
    expect(mayActOnLink(nobody, { created_by: HEAD })).toBe(false);
    await expect(resendClosureForm(admin(), deps(), other, REQ)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeClosureForm(admin(), other, REQ)).rejects.toMatchObject({ code: "forbidden" });
    expect(send).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
  });

  it("will not touch a case of another workspace", async () => {
    await expect(resendClosureForm(admin(), deps(), actor({ accountId: "a0000000-0000-4000-8000-000000000002" }), REQ)).rejects.toMatchObject({ code: "not_found" });
  });

  it("withdraws the active link, once", async () => {
    await sendClosureForm(admin(), deps(), input());
    expect(await revokeClosureForm(admin(), actor(), REQ)).toEqual({ revoked: true });
    expect(links()[0]).toMatchObject({ revoked_reason: "revoked", revoked_by: AGENT });
    expect(await revokeClosureForm(admin(), actor(), REQ)).toEqual({ revoked: false });
    expect(events().filter((e) => e.kind === "form_link").map((e) => e.detail.action)).toEqual(["minted", "sent", "revoked"]);
  });
});

describe("reading the links", () => {
  it("lists a case's links newest first with their state, without any address", async () => {
    await sendClosureForm(admin(), deps(), input());
    nowMs += 60_000;
    await resendClosureForm(admin(), deps(), actor({ canReview: true }), REQ);
    const view = await linksOfRequest(admin(), ACCOUNT, REQ, new Date(nowMs));
    expect(view.map((l) => l.state)).toEqual(["sent", "replaced"]);
    expect(JSON.stringify(view)).not.toMatch(/token|https?:|\/c\/link/);
  });

  it("gives the Inbox cards their state, and the case's id only to a person who may act on it", async () => {
    await sendClosureForm(admin(), deps(), input());
    const id = links()[0].id as string;
    const mine = await cardStatuses(admin(), actor(), CONV, null, new Date(nowMs));
    expect(mine).toEqual([{ id, state: "sent", expiresAt: links()[0].expires_at, canManage: true, requestId: REQ }]);
    const theirs = await cardStatuses(admin(), actor({ userId: OPS }), CONV, [id], new Date(nowMs));
    expect(theirs).toEqual([{ id, state: "sent", expiresAt: links()[0].expires_at, canManage: false }]);
    expect(Object.keys(theirs[0])).not.toContain("requestId");
    expect(await cardStatuses(admin(), actor(), "c9000000-0000-4000-8000-000000000009", null)).toEqual([]);
  });

  it("shows a link as expired, opened and submitted from the row alone", async () => {
    await sendClosureForm(admin(), deps(), input());
    const l = links()[0];
    l.opened_at = "2026-10-13T11:00:00Z";
    expect((await cardStatuses(admin(), actor(), CONV, null, new Date(nowMs)))[0].state).toBe("opened");
    expect((await cardStatuses(admin(), actor(), CONV, null, new Date(nowMs + 15 * 86_400_000)))[0].state).toBe("expired");
    l.submitted_at = "2026-10-13T12:00:00Z";
    expect((await cardStatuses(admin(), actor(), CONV, null, new Date(nowMs + 15 * 86_400_000)))[0].state).toBe("submitted");
  });
});
