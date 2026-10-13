/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// Raising from the Inbox with the closure form sent in the chat, and raising an Account change (migration 185): the case is made FIRST and stands whatever
// happens to the chat, the form goes out only when asked, a ticket has no chat, the dialog is told whether the chat can take it, and the new type's fields
// are validated by choice. The database functions are their in-memory stand-in (chat-link/test-support.ts); the SQL is proved by verify-185.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SendMessageError } from "@/lib/whatsapp/send-message";
import { FakeDb } from "@/lib/sign/service/fake-db";

import { ACCOUNT, AGENT, CLOSURE_ANSWERS, publicWorld } from "../test-support";
import type { ChatLinkDeps } from "../chat-link/service";
import { ACCOUNT_CHANGE_FIELDS, installLinkRpc, useAccountChange } from "../chat-link/test-support";
import type { ComplianceError } from "../errors";
import { raiseContext, raiseRequest, type RaiseCaller, type RaiseInput } from "./raise";
import type { NoticeDeps } from "./notices";

const NOW = Date.parse("2026-10-13T10:00:00Z");
const CONV = "c1000000-0000-4000-8000-000000000001";
const TICKET = "d1000000-0000-4000-8000-000000000001";
const CONTACT = "e1000000-0000-4000-8000-000000000001";

let db: FakeDb;
let userDb: FakeDb;
let windowOpen: boolean;
let send: ReturnType<typeof vi.fn>;
let sendError: unknown;

const noticeDeps = (): NoticeDeps => ({ mail: { emailConfigured: () => false, sendEmail: async () => undefined, loadIdentity: async () => ({}) } as never, now: () => new Date(NOW) });
const chat = (): ChatLinkDeps => ({ now: () => new Date(NOW), origin: () => "https://halo.test", windowOpen: async () => windowOpen, send: send as never });
const caller = (sees = false): RaiseCaller => ({ accountId: ACCOUNT, userId: AGENT, userDb: userDb.client(), sees });
const admin = () => db.client();
const cases = () => db.rows("compliance_requests") as any[];
const links = () => db.rows("compliance_form_links") as any[];
const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as ComplianceError | null;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = publicWorld();
  windowOpen = true;
  sendError = null;
  db.seed("contacts", [{ id: CONTACT, account_id: ACCOUNT, name: "Siti Aminah", phone: "012-334 4556", email: "siti@example.test", language: "ms", deleted_at: null }]);
  db.seed("conversations", [{ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp", contact: { language: "ms" } }]);
  db.seed("tickets", [{ id: TICKET, account_id: ACCOUNT, contact_id: CONTACT }]);
  installLinkRpc(db, { now: () => NOW });
  userDb = new FakeDb();
  userDb.seed("conversations", [{ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp" }]);
  userDb.seed("tickets", [{ id: TICKET, account_id: ACCOUNT, contact_id: CONTACT }]);
  send = vi.fn(async () => {
    if (sendError) throw sendError;
    return { messageId: "m0000000-0000-4000-8000-000000000001", whatsappMessageId: "w" };
  });
});

const setChannel = (c: string) => {
  for (const t of [db, userDb]) for (const r of t.rows("conversations") as any[]) r.last_channel_type = c;
};

const closureFormInput = (over: Partial<RaiseInput> = {}): RaiseInput => ({
  typeKey: "closure",
  target: { conversationId: CONV },
  customerName: "Siti Aminah",
  customerEmail: "siti@example.test",
  customerPhone: "012-334 4556",
  // the agent has only the optional reason: the customer fills in the acknowledgements and the bank details
  answers: { reason: "Moving abroad" },
  sendClosureForm: true,
  note: "Customer asked in the chat",
  ...over,
});

describe("an account closure raised with the form sent in the chat", () => {
  it("makes the case first (source inbox, linked, received), then the link, then the card", async () => {
    const r = await raiseRequest(admin(), caller(true), closureFormInput(), noticeDeps(), chat());
    expect(cases()).toHaveLength(1);
    expect(cases()[0]).toMatchObject({ source: "inbox", type_key: "closure", status: "received", contact_id: CONTACT, conversation_id: CONV, created_by: AGENT, channel: "whatsapp", customer_phone: "+60123344556", customer_email: "siti@example.test" });
    expect(cases()[0].identity_check).toEqual({});
    // answers: only what the agent had; no acknowledgements, no bank details yet
    expect(cases()[0].data).toEqual({ reason: "Moving abroad" });
    expect(cases()[0].data_enc ?? null).toBeNull();
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ request_id: cases()[0].id, conversation_id: CONV, channel: "whatsapp", created_by: AGENT });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][2] as any).messageType).toBe("link_card");
    expect(r).toMatchObject({ reference: cases()[0].reference, status: "received", id: cases()[0].id, chatLink: { status: "sent", mode: "card", channel: "whatsapp" } });
    expect(JSON.stringify(r.chatLink)).not.toContain("http");
  });

  it("leaves the usual note on the conversation, and the description on the case's timeline", async () => {
    await raiseRequest(admin(), caller(), closureFormInput(), noticeDeps(), chat());
    const events = db.rows("compliance_request_events") as any[];
    expect(events.find((e) => e.kind === "note")?.detail.text).toBe("Customer asked in the chat");
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["note", "form_link"]));
    expect((db.rows("messages") as any[]).some((m) => /raised$/.test(String(m.content_text)))).toBe(true);
  });

  it("does not ask the agent for the acknowledgements or the bank details when the form is sent, but does when it is not", async () => {
    const without = await fails(raiseRequest(admin(), caller(), closureFormInput({ sendClosureForm: false }), noticeDeps(), chat()));
    expect(without).toMatchObject({ code: "validation_failed" });
    expect(cases()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    const ok = await raiseRequest(admin(), caller(), closureFormInput({ sendClosureForm: false, answers: CLOSURE_ANSWERS }), noticeDeps(), chat());
    expect(ok.chatLink).toBeUndefined();
    expect(links()).toHaveLength(0);
    expect(cases()[0].data.confirm_closure).toBe(true);
  });

  it("still checks what the agent did give (a bad value is refused even when the rest comes from the customer)", async () => {
    const err = await fails(raiseRequest(admin(), caller(), closureFormInput({ answers: { reason: "x".repeat(2500) } }), noticeDeps(), chat()));
    expect(err).toMatchObject({ code: "validation_failed" });
    expect(cases()).toHaveLength(0);
  });

  it("keeps the case and gives the link to copy when the 24-hour window has closed", async () => {
    windowOpen = false;
    const r = await raiseRequest(admin(), caller(), closureFormInput(), noticeDeps(), chat());
    expect(cases()).toHaveLength(1);
    expect(r.chatLink).toMatchObject({ status: "not_sent", reason: "window_expired", channel: "whatsapp" });
    expect((r.chatLink as any).url).toMatch(/^https:\/\/halo\.test\/c\/link\//);
    expect(send).not.toHaveBeenCalled();
    // the address is in the answer and nowhere stored
    const token = (r.chatLink as any).url.split("/c/link/")[1];
    expect(JSON.stringify(db.tables)).not.toContain(token.split(".")[1]);
  });

  it("keeps the case and gives the link to copy when the channel cannot carry it or the send fails", async () => {
    setChannel("web_widget");
    expect((await raiseRequest(admin(), caller(), closureFormInput({ customerEmail: "a@example.test", customerPhone: "019 111 2222" }), noticeDeps(), chat())).chatLink).toMatchObject({ status: "not_sent", reason: "channel_unsupported" });
    setChannel("whatsapp");
    // the first case is finished, so the customer may have another
    cases()[0].status = "closed";
    sendError = new SendMessageError("meta_error", "Meta API error: boom", 502);
    const failed = await raiseRequest(admin(), caller(), closureFormInput({ customerEmail: "b@example.test", customerPhone: "019 333 4444" }), noticeDeps(), chat());
    expect(failed.chatLink).toMatchObject({ status: "not_sent", reason: "send_failed" });
    expect(cases()).toHaveLength(2);
  });

  it("never fails the raise because the link could not be made", async () => {
    db.rpcHandlers.compliance_mint_form_link = () => ({ data: null, error: { message: "boom" } });
    const r = await raiseRequest(admin(), caller(), closureFormInput(), noticeDeps(), chat());
    expect(r.reference).toMatch(/^CMP-/);
    expect(r.chatLink).toBeUndefined();
    expect(cases()).toHaveLength(1);
  });

  it("sends nothing from a ticket (there is no chat) and asks for the whole form as before", async () => {
    const err = await fails(raiseRequest(admin(), caller(), closureFormInput({ target: { ticketId: TICKET } }), noticeDeps(), chat()));
    expect(err).toMatchObject({ code: "validation_failed" });
    const r = await raiseRequest(admin(), caller(), closureFormInput({ target: { ticketId: TICKET }, answers: CLOSURE_ANSWERS }), noticeDeps(), chat());
    expect(r.chatLink).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
  });

  it("sends the form only for a closure", async () => {
    useAccountChange(db);
    const r = await raiseRequest(admin(), caller(), { typeKey: "phone_change", target: { conversationId: CONV }, customerName: "Siti", sendClosureForm: true, answers: { what_changes: "parent_phone", current_phone: "012-334 4556", new_phone: "019 888 7766" } }, noticeDeps(), chat());
    expect(r.chatLink).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the dialog is told whether the chat can take the closure form", () => {
  it("says yes for a channel that can, and for WhatsApp inside the 24-hour window", async () => {
    expect((await raiseContext(admin(), caller(), { conversationId: CONV }, chat())).chatLink).toEqual({ available: true });
    setChannel("messenger");
    windowOpen = false;
    expect((await raiseContext(admin(), caller(), { conversationId: CONV }, chat())).chatLink).toEqual({ available: true });
  });

  it("says why not: the window is closed, the web chat cannot, a ticket has no chat", async () => {
    windowOpen = false;
    expect((await raiseContext(admin(), caller(), { conversationId: CONV }, chat())).chatLink).toEqual({ available: false, reason: "window_expired" });
    setChannel("web_widget");
    expect((await raiseContext(admin(), caller(), { conversationId: CONV }, chat())).chatLink).toEqual({ available: false, reason: "channel_unsupported" });
    expect((await raiseContext(admin(), caller(), { ticketId: TICKET }, chat())).chatLink).toEqual({ available: false, reason: "no_channel" });
  });
});

describe("Account change", () => {
  beforeEach(() => useAccountChange(db));
  const change = (answers: Record<string, unknown>, over: Partial<RaiseInput> = {}): RaiseInput => ({ typeKey: "phone_change", target: { conversationId: CONV }, customerName: "Siti Aminah", channel: "whatsapp", answers, ...over });
  const issues = async (answers: Record<string, unknown>) => ((await fails(raiseRequest(admin(), caller(), change(answers), noticeDeps(), chat()))) as ComplianceError | null)?.issues ?? null;

  it("is labelled Account change and offers a parent's phone number, a parent's email address or a child's name, never a parent's name", () => {
    const t = (db.rows("compliance_request_types") as any[]).find((x) => x.key === "phone_change");
    expect(t.label).toBe("Account change");
    const what = ACCOUNT_CHANGE_FIELDS[0] as { options: { value: string }[]; required: boolean };
    expect(what.options.map((o) => o.value)).toEqual(["parent_phone", "parent_email", "child_name"]);
    expect(what.required).toBe(true);
    expect(JSON.stringify(what.options)).not.toMatch(/parent_name|Parent name/i);
  });

  it("requires what is changing", async () => {
    expect(await issues({})).toEqual([{ field: "what_changes", code: "required" }]);
    expect(await issues({ current_phone: "012-334 4556", new_phone: "019 888 7766" })).toEqual([{ field: "what_changes", code: "required" }]);
  });

  it("refuses a parent's name, and anything else that is not one of the three", async () => {
    expect(await issues({ what_changes: "parent_name" })).toEqual([{ field: "what_changes", code: "not_a_choice" }]);
    expect(await issues({ what_changes: "" })).toEqual([{ field: "what_changes", code: "required" }]);
  });

  it("a parent's phone number: both numbers are required and valid, and are kept in the +60 form", async () => {
    expect((await issues({ what_changes: "parent_phone" }))?.map((i) => i.field)).toEqual(["current_phone", "new_phone"]);
    expect((await issues({ what_changes: "parent_phone", current_phone: "abc", new_phone: "019 888 7766" }))?.[0]).toEqual({ field: "current_phone", code: "invalid" });
    await raiseRequest(admin(), caller(), change({ what_changes: "parent_phone", current_phone: "012-334 4556", new_phone: "019 888 7766" }), noticeDeps(), chat());
    expect(cases()[0].data).toEqual({ what_changes: "parent_phone", current_phone: "+60123344556", new_phone: "+60198887766" });
  });

  it("a parent's email address: both addresses are required and valid", async () => {
    expect((await issues({ what_changes: "parent_email" }))?.map((i) => i.field)).toEqual(["current_email", "new_email"]);
    expect((await issues({ what_changes: "parent_email", current_email: "siti@example.test", new_email: "not-an-email" }))).toEqual([{ field: "new_email", code: "invalid" }]);
    await raiseRequest(admin(), caller(), change({ what_changes: "parent_email", current_email: "siti@example.test", new_email: "siti.new@example.test" }), noticeDeps(), chat());
    expect(cases()[0].data).toEqual({ what_changes: "parent_email", current_email: "siti@example.test", new_email: "siti.new@example.test" });
  });

  it("a child's name: which child (the current name) and the new name are both required", async () => {
    expect((await issues({ what_changes: "child_name" }))?.map((i) => i.field)).toEqual(["child_current_name", "child_new_name"]);
    expect(await issues({ what_changes: "child_name", child_current_name: "Aiman" })).toEqual([{ field: "child_new_name", code: "required" }]);
    await raiseRequest(admin(), caller(), change({ what_changes: "child_name", child_current_name: "Aiman Hakim", child_new_name: "Muhammad Aiman Hakim" }), noticeDeps(), chat());
    expect(cases()[0].data).toEqual({ what_changes: "child_name", child_current_name: "Aiman Hakim", child_new_name: "Muhammad Aiman Hakim" });
  });

  it("does not keep the answers of a choice that was not made", async () => {
    await raiseRequest(admin(), caller(), change({ what_changes: "parent_email", current_email: "a@example.test", new_email: "b@example.test", current_phone: "012-334 4556", new_phone: "bad", child_new_name: "X" }), noticeDeps(), chat());
    expect(Object.keys(cases()[0].data).sort()).toEqual(["current_email", "new_email", "what_changes"]);
  });

  it("shows the dialog only the fields of the choice (the context carries the definitions, with the conditions)", async () => {
    const c = await raiseContext(admin(), caller(), { conversationId: CONV }, chat());
    const type = c.types.find((t) => t.key === "phone_change")!;
    expect(type.fields.map((f) => f.key)).toEqual(["what_changes", "current_phone", "new_phone", "current_email", "new_email", "child_current_name", "child_new_name"]);
    expect(type.fields.find((f) => f.key === "new_email")?.showIf).toEqual({ field: "what_changes", in: ["parent_email"] });
    expect(type.label).toBe("Account change");
  });

  it("still lets an edit change one value of a case without sending the choice again", async () => {
    const { checkAnswers } = await import("../fields");
    const r = checkAnswers(ACCOUNT_CHANGE_FIELDS as never, { new_phone: "019 111 2222" }, { partial: true, context: { what_changes: "parent_phone" } });
    expect(r).toMatchObject({ ok: true, answers: { data: { new_phone: "+60191112222" } } });
    // without the stored choice the value belongs to nothing that is asked, so it is dropped
    expect(checkAnswers(ACCOUNT_CHANGE_FIELDS as never, { new_phone: "019 111 2222" }, { partial: true })).toMatchObject({ ok: true, answers: { data: {} } });
  });
});
