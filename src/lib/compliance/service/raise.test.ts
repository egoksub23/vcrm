/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// Raising a request from the Inbox or a ticket: the dialog's context, the case that is made (source, links, the note left behind), the duplicate check,
// the request date that needs a reason, and above all what a RAISER gets to see: the reference, the type and the status, never the customer's details.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceMailDeps } from "@/lib/email/workspace-mail";
import { FakeDb } from "@/lib/sign/service/fake-db";

import { ComplianceError } from "../errors";
import { ACCOUNT, ACCOUNT_NUMBER, AGENT, CLOSURE_ANSWERS, HEAD, OFFICER, OTHER_ACCOUNT, publicWorld } from "../test-support";
import type { NoticeDeps } from "./notices";
import { PUBLIC_ONLY_FIELDS, raiseContext, raiseFieldsOf, raiseRequest, raisedByMe, raiserStatus, type RaiseCaller, type RaiseInput } from "./raise";

const NOW = Date.parse("2026-10-13T10:00:00Z");
const CONV = "c1000000-0000-4000-8000-000000000001";
const CONV_OTHER = "c1000000-0000-4000-8000-000000000002";
const TICKET = "d1000000-0000-4000-8000-000000000001";
const CONTACT = "e1000000-0000-4000-8000-000000000001";
const CONTACT_OTHER = "e1000000-0000-4000-8000-000000000002";

let db: FakeDb;
let userDb: FakeDb;
let sent: { to: string; subject: string; text: string }[];
let deps: NoticeDeps;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = publicWorld();
  db.seed("contacts", [
    { id: CONTACT, account_id: ACCOUNT, name: "Siti Aminah", phone: "012-334 4556", email: "Siti@Example.test", language: "ms", deleted_at: null },
    { id: CONTACT_OTHER, account_id: ACCOUNT, name: "Ahmad", phone: "+60199998888", email: null, language: null, deleted_at: null },
  ]);
  db.seed("conversations", [
    { id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp" },
    { id: CONV_OTHER, account_id: ACCOUNT, contact_id: CONTACT_OTHER, last_channel_type: "email" },
  ]);
  db.seed("tickets", [{ id: TICKET, account_id: ACCOUNT, contact_id: CONTACT }]);
  // what the person's own session can open (row level security): the first conversation and the ticket, not the second conversation
  userDb = new FakeDb();
  userDb.seed("conversations", [{ id: CONV, account_id: ACCOUNT, contact_id: CONTACT, last_channel_type: "whatsapp" }]);
  userDb.seed("tickets", [{ id: TICKET, account_id: ACCOUNT, contact_id: CONTACT }]);
  sent = [];
  const mail: WorkspaceMailDeps = { emailConfigured: () => true, sendEmail: async (m: any) => void sent.push({ to: m.to, subject: m.subject, text: m.text }), loadIdentity: async () => ({}) };
  deps = { mail, now: () => new Date(NOW) };
});

const caller = (sees = false, userId = AGENT, account = ACCOUNT, client = userDb): RaiseCaller => ({ accountId: account, userId, userDb: client.client(), sees });
const admin = () => db.client();
const cases = () => db.rows("compliance_requests") as any[];
const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as ComplianceError | null;

const closureInput = (over: Partial<RaiseInput> = {}): RaiseInput => ({
  typeKey: "closure",
  target: { conversationId: CONV },
  customerName: "Siti Aminah",
  customerEmail: "siti@example.test",
  customerPhone: "012-334 4556",
  answers: CLOSURE_ANSWERS,
  ...over,
});
const phoneInput = (over: Partial<RaiseInput> = {}): RaiseInput => ({
  typeKey: "phone_change",
  target: { conversationId: CONV },
  customerName: "Siti Aminah",
  answers: { current_phone: "012-334 4556", new_phone: "019 888 7766" },
  channel: "whatsapp",
  note: "Verified by call back at 10:05",
  ...over,
});

describe("the dialog's context", () => {
  it("prefills the customer from the contact, names the channel, and lists the types with the fields a person fills", async () => {
    const c = await raiseContext(admin(), caller(), { conversationId: CONV });
    expect(c.contact).toMatchObject({ id: CONTACT, name: "Siti Aminah", phone: "012-334 4556", email: "Siti@Example.test", language: "ms" });
    expect(c.channel).toBe("whatsapp");
    expect(c.types.map((t) => t.key)).toEqual(["closure", "withdrawal", "phone_change"]);
    const closure = c.types.find((t) => t.key === "closure")!;
    expect(closure.fields.map((f) => f.key)).toContain("bank_account_number");
    expect(closure.fields.map((f) => f.key)).not.toContain("authorization_letter");
    expect(closure.fields.map((f) => f.key)).not.toContain("declaration");
    expect(c.types.find((t) => t.key === "withdrawal")!.fields.map((f) => f.key)).not.toEqual(expect.arrayContaining(["proof"]));
    expect(c.types.find((t) => t.key === "phone_change")!.fields.map((f) => f.key)).toEqual(["current_phone", "new_phone"]);
    expect(c.open).toEqual([]);
  });

  it("works from a ticket, hides types that are off, and says which types already have an open request WITHOUT naming it", async () => {
    (db.rows("compliance_request_types").find((t: any) => t.key === "withdrawal") as any).active = false;
    await raiseRequest(admin(), caller(), closureInput(), deps);
    const c = await raiseContext(admin(), caller(), { ticketId: TICKET });
    expect(c.types.map((t) => t.key)).toEqual(["closure", "phone_change"]);
    expect(c.open).toEqual(["closure"]);
    expect(JSON.stringify(c)).not.toContain("CMP-");
  });

  it("is not found for a conversation the person cannot open, or one in another workspace, or a malformed id", async () => {
    expect(await fails(raiseContext(admin(), caller(), { conversationId: CONV_OTHER }))).toMatchObject({ code: "not_found" });
    expect(await fails(raiseContext(admin(), caller(false, AGENT, OTHER_ACCOUNT), { conversationId: CONV }))).toMatchObject({ code: "not_found" });
    expect(await fails(raiseContext(admin(), caller(), { conversationId: "nope" }))).toMatchObject({ code: "invalid_request" });
    expect(await fails(raiseContext(admin(), caller(), { conversationId: CONV, ticketId: TICKET } as any))).toMatchObject({ code: "invalid_request" });
  });

  it("filters out files and the public form's own helper fields", () => {
    const fields = (db.rows("compliance_request_types").find((t: any) => t.key === "withdrawal") as any).fields;
    const kept = raiseFieldsOf(fields).map((f) => f.key);
    for (const k of [...PUBLIC_ONLY_FIELDS, "authorization_letter"]) expect(kept).not.toContain(k);
    expect(kept).toContain("amount");
  });
});

describe("raising", () => {
  it("makes the case from a conversation: source inbox, the channel, the links, the person who raised it; and says so on the conversation", async () => {
    const r = await raiseRequest(admin(), caller(), closureInput(), deps);
    expect(r).toEqual({ reference: expect.stringMatching(/^CMP-\d{4}-\d{6}$/), status: "received" });
    expect(cases()).toHaveLength(1);
    expect(cases()[0]).toMatchObject({ account_id: ACCOUNT, type_key: "closure", source: "inbox", channel: "whatsapp", contact_id: CONTACT, conversation_id: CONV, ticket_id: null, created_by: AGENT, customer_name: "Siti Aminah", customer_phone: "+60123344556" });
    expect(cases()[0].data_enc).toEqual(expect.any(String));
    const note = (db.rows("messages") as any[])[0];
    expect(note).toMatchObject({ conversation_id: CONV, is_internal: true, sender_id: AGENT, content_text: `Compliance request ${r.reference} raised` });
    expect(note.content_text).not.toMatch(/Siti|8800|example/);
  });

  it("makes the case from a ticket and leaves a comment on it", async () => {
    const r = await raiseRequest(admin(), caller(), closureInput({ target: { ticketId: TICKET } }), deps);
    expect(cases()[0]).toMatchObject({ source: "ticket", ticket_id: TICKET, conversation_id: null, contact_id: CONTACT, channel: "ticket" });
    expect(db.rows("ticket_comments")[0]).toMatchObject({ ticket_id: TICKET, account_id: ACCOUNT, author_id: AGENT, body: `Compliance request ${r.reference} raised` });
  });

  it("gives a raiser the reference and status only, and a person who holds a compliance permission the case's id as well", async () => {
    const a = await raiseRequest(admin(), caller(false), closureInput(), deps);
    expect(Object.keys(a).sort()).toEqual(["reference", "status"]);
    const b = await raiseRequest(admin(), caller(true), phoneInput(), deps);
    expect(b.id).toBe(cases().find((c) => c.reference === b.reference).id);
  });

  it("takes a phone change with its note and how it arrived, and refuses a number that is not one", async () => {
    expect(await fails(raiseRequest(admin(), caller(), phoneInput({ answers: { current_phone: "x", new_phone: "019 888 7766" } }), deps))).toMatchObject({ code: "validation_failed" });
    expect(cases()).toHaveLength(0);
    const r = await raiseRequest(admin(), caller(), phoneInput(), deps);
    expect(cases()[0]).toMatchObject({ type_key: "phone_change", channel: "whatsapp" });
    expect(cases()[0].data).toEqual({ current_phone: "+60123344556", new_phone: "+60198887766" });
    const notes = (db.rows("compliance_request_events") as any[]).filter((e) => e.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ actor: AGENT, request_id: cases()[0].id });
    expect(notes[0].detail.text).toBe("Verified by call back at 10:05");
    expect(r.reference).toBe(cases()[0].reference);
  });

  it("refuses a closure without its acknowledgements and writes nothing", async () => {
    const e = await fails(raiseRequest(admin(), caller(), closureInput({ answers: { ...CLOSURE_ANSWERS, children_finished_school: false } }), deps));
    expect(e).toMatchObject({ code: "validation_failed" });
    expect(cases()).toHaveLength(0);
    expect(db.rows("messages")).toHaveLength(0);
  });

  it("refuses an unknown or switched-off type, and a conversation the person cannot open", async () => {
    expect(await fails(raiseRequest(admin(), caller(), closureInput({ typeKey: "nothing" }), deps))).toMatchObject({ code: "type_unavailable" });
    expect(await fails(raiseRequest(admin(), caller(), closureInput({ target: { conversationId: CONV_OTHER } }), deps))).toMatchObject({ code: "not_found" });
    expect(cases()).toHaveLength(0);
  });

  it("does not fail the raise when the note on the conversation cannot be written", async () => {
    db.failNext.messages = "boom";
    const r = await raiseRequest(admin(), caller(), closureInput(), deps);
    expect(r.reference).toBeTruthy();
    expect(cases()).toHaveLength(1);
  });

  it("emails the customer the confirmation only when asked and an address is given", async () => {
    const r = await raiseRequest(admin(), caller(), closureInput({ notify: true }), deps);
    expect(r.notice).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("siti@example.test");
    // no address: nothing to send to
    const none = await raiseRequest(admin(), caller(), phoneInput({ customerEmail: null, notify: true }), deps);
    expect(none.notice).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});

describe("a customer with an open request", () => {
  it("is refused for the same type, without the reference for a person who holds no compliance permission", async () => {
    await raiseRequest(admin(), caller(), closureInput(), deps);
    const e = await fails(raiseRequest(admin(), caller(false), closureInput(), deps));
    expect(e).toMatchObject({ code: "duplicate_open", status: 409 });
    expect(e!.issues).toBeUndefined();
    expect(e!.message).not.toContain("CMP-");
    expect(cases()).toHaveLength(1);
  });

  it("names the reference to a person who holds a compliance permission", async () => {
    const first = await raiseRequest(admin(), caller(true), closureInput(), deps);
    const e = await fails(raiseRequest(admin(), caller(true), closureInput(), deps));
    expect(e!.issues).toEqual([{ field: "reference", code: first.reference }]);
  });

  it("is a different type, a different customer, or a finished request: allowed", async () => {
    await raiseRequest(admin(), caller(), closureInput(), deps);
    expect((await raiseRequest(admin(), caller(), phoneInput(), deps)).reference).toBeTruthy();
    expect((await raiseRequest(admin(), caller(), closureInput({ target: { conversationId: CONV }, customerName: "Other", customerEmail: "other@example.test", customerPhone: "+60112223333" }), deps).catch((e) => e)).code).toBe("duplicate_open");
    cases().find((c) => c.type_key === "closure").status = "completed";
    expect((await raiseRequest(admin(), caller(), closureInput(), deps)).reference).toBeTruthy();
  });

  it("also matches on the email address or the phone number when the contact differs", async () => {
    db.seed("compliance_requests", [{ id: "x1", account_id: ACCOUNT, reference: "CMP-2026-000800", type_key: "closure", source: "form", status: "officer_review", customer_email: "SITI@example.test", customer_name: "x", contact_id: null }]);
    expect(await fails(raiseRequest(admin(), caller(), closureInput(), deps))).toMatchObject({ code: "duplicate_open" });
    cases()[0].customer_email = null;
    cases()[0].customer_phone = "+60123344556";
    expect(await fails(raiseRequest(admin(), caller(), closureInput({ customerEmail: null }), deps))).toMatchObject({ code: "duplicate_open" });
    cases()[0].customer_phone = "+60100000000";
    expect((await raiseRequest(admin(), caller(), closureInput({ customerEmail: null }), deps)).reference).toBeTruthy();
  });
});

describe("the request date", () => {
  it("is now unless an earlier time is given with a reason, which goes on the timeline", async () => {
    const earlier = new Date(NOW - 3 * 3600_000).toISOString();
    expect(await fails(raiseRequest(admin(), caller(), closureInput({ receivedAt: earlier }), deps))).toMatchObject({ code: "note_required" });
    expect(await fails(raiseRequest(admin(), caller(), closureInput({ receivedAt: earlier, receivedAtReason: "  " }), deps))).toMatchObject({ code: "note_required" });
    expect(cases()).toHaveLength(0);
    await raiseRequest(admin(), caller(), closureInput({ receivedAt: earlier, receivedAtReason: "The customer asked this morning on a call" }), deps);
    expect(cases()[0].received_at).toBe(earlier);
    const notes = (db.rows("compliance_request_events") as any[]).filter((e) => e.kind === "note");
    expect(notes[0].detail.text).toContain("The customer asked this morning on a call");
    expect(notes[0].actor).toBe(AGENT);
  });

  it("needs no reason for a time within a couple of minutes of now, and refuses one that is not a date", async () => {
    const r = await raiseRequest(admin(), caller(), closureInput({ receivedAt: new Date(NOW - 60_000).toISOString() }), deps);
    expect(r.reference).toBeTruthy();
    expect(cases()[0].received_at).not.toBe(new Date(NOW - 60_000).toISOString());
    expect(await fails(raiseRequest(admin(), caller(), phoneInput({ receivedAt: "yesterday" }), deps))).toMatchObject({ code: "validation_failed" });
  });
});

describe("what a raiser sees afterwards", () => {
  const rows = async (c: RaiseCaller, scope = {}) => raisedByMe(admin(), c, scope);

  it("is the reference, the type, the status and the date, and nothing of the customer", async () => {
    await raiseRequest(admin(), caller(), closureInput(), deps);
    const items = await rows(caller());
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(["raisedAt", "reference", "status", "typeKey", "typeLabel", "typeLabelL10n"]);
    expect(items[0]).toMatchObject({ typeKey: "closure", typeLabel: "Account closure", status: "received" });
    const text = JSON.stringify(items);
    for (const bad of ["Siti", "siti@", "+6012", ACCOUNT_NUMBER, "Maybank", "Moving abroad", "customer_", "data_enc", "notes"]) expect(text).not.toContain(bad);
  });

  it("shows only what THEY raised, in their workspace, narrowed to one conversation or ticket when asked", async () => {
    await raiseRequest(admin(), caller(false, AGENT), closureInput(), deps);
    await raiseRequest(admin(), caller(false, AGENT), phoneInput({ target: { ticketId: TICKET } }), deps);
    await raiseRequest(admin(), caller(false, OFFICER), phoneInput({ customerName: "Y", answers: { current_phone: "0111111111", new_phone: "0122222222" } }), deps).catch(() => undefined);
    db.seed("compliance_requests", [{ id: "w1", account_id: OTHER_ACCOUNT, reference: "CMP-2026-000001", type_key: "closure", source: "inbox", status: "received", customer_name: "z", created_by: AGENT }]);
    expect(await rows(caller())).toHaveLength(2);
    expect((await rows(caller(), { conversationId: CONV })).map((i) => i.typeKey)).toEqual(["closure"]);
    expect((await rows(caller(), { ticketId: TICKET })).map((i) => i.typeKey)).toEqual(["phone_change"]);
    expect(await rows(caller(false, HEAD))).toHaveLength(0);
    expect(await rows(caller(false, AGENT, OTHER_ACCOUNT))).toHaveLength(1);
    expect(await fails(rows(caller(), { conversationId: "nope" }))).toMatchObject({ code: "invalid_request" });
  });

  it("carries the case's id only for a person who holds a compliance permission", async () => {
    await raiseRequest(admin(), caller(), closureInput(), deps);
    expect((await rows(caller(false)))[0]).not.toHaveProperty("id");
    expect((await rows(caller(true)))[0]).toHaveProperty("id", cases()[0].id);
  });

  it("follows the case's status in a few plain words", async () => {
    await raiseRequest(admin(), caller(), closureInput(), deps);
    const status = async (s: string) => {
      cases()[0].status = s;
      return (await rows(caller()))[0].status;
    };
    expect(await status("received")).toBe("received");
    for (const s of ["identity_check", "officer_review", "awaiting_signoff"]) expect(await status(s)).toBe("in_review");
    for (const s of ["approved", "executing"]) expect(await status(s)).toBe("in_progress");
    expect(await status("completed")).toBe("done");
    expect(await status("rejected")).toBe("not_approved");
    expect(await status("closed")).toBe("closed");
    expect(raiserStatus("received")).toBe("received");
  });
});
