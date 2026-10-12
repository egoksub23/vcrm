/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// The emails about a case: to the customer (received, more information, approved, rejected, completed) and to staff (waiting for sign-off, a clock alert),
// with an injected sender. Once-only claims, the language, the failures recorded and never thrown, the text refused when it carries a bank detail, the
// preview that writes nothing, and what the moves (transitionRequest) send. The wording itself is in messages.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceMailDeps } from "@/lib/email/workspace-mail";
import type { FakeDb } from "@/lib/sign/service/fake-db";

import { ComplianceError } from "../errors";
import { ACCOUNT, ACCOUNT_NUMBER, AGENT, BANK_NAME, CLOSURE_ANSWERS, HEAD, HOLDER, OFFICER, OPS, callerFor, eventsOf, head, officer, publicWorld } from "../test-support";
import { transitionRequest } from "./actions";
import { emailClockAlerts, languageFor, notifySignoffWaiting, previewCustomerNotice, sendCustomerNotice, staffRecipients, type NoticeDeps } from "./notices";
import { createComplianceRequest } from "./write";

const NOW = Date.parse("2026-10-13T10:00:00Z");

let db: FakeDb;
let sent: { to: string; subject: string; html: string; text: string }[];
let mailMode: "ok" | "throw" | "none";
let deps: NoticeDeps;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = publicWorld();
  sent = [];
  mailMode = "ok";
  const mail: WorkspaceMailDeps = {
    emailConfigured: () => mailMode !== "none",
    sendEmail: async (m: any) => {
      if (mailMode === "throw") throw new Error("mailbox_reconnect: reconnect the mailbox");
      sent.push({ to: m.to, subject: m.subject, html: m.html, text: m.text });
    },
    loadIdentity: async () => ({ fromName: "Vircle", replyTo: null }),
  };
  deps = { mail, now: () => new Date(NOW) };
  // holders: approvers are the Head; reviewers the officer and the Head
  db.rpcHandlers.compliance_holders = (args) => ({ data: args.p_cap === "compliance.approve" ? [HEAD] : args.p_cap === "compliance.review" ? [OFFICER, HEAD] : [OFFICER, HEAD, OPS], error: null });
  for (const p of db.rows("profiles") as any[]) p.locale = null;
});

const admin = () => db.client();
const make = (over: Record<string, unknown> = {}) =>
  createComplianceRequest(admin(), { accountId: ACCOUNT, typeKey: "closure", source: "form", channel: "web_form", customerName: "Siti Aminah", customerEmail: "siti@example.test", customerPhone: "+60123344556", answers: CLOSURE_ANSWERS, customerLocale: "ms", ...over } as any);
const row = (id: string) => (db.rows("compliance_requests") as any[]).find((r) => r.id === id);
const notices = () => db.rows("compliance_notices") as any[];
const noticeEvents = () => (db.rows("compliance_request_events") as any[]).filter((e) => e.kind === "notice");
const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as ComplianceError | null;

describe("emails to the customer", () => {
  it("sends the confirmation in the case's language, once, and records it on the case", async () => {
    const { id, reference } = await make();
    const r = await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "received", actor: null });
    expect(r).toEqual({ status: "sent", language: "ms" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("siti@example.test");
    expect(sent[0].subject).toContain(reference);
    expect(sent[0].text).toContain("14 hari");
    expect(notices()[0]).toMatchObject({ kind: "received", key: "once", audience: "customer", status: "sent", language: "ms", recipients: 1, claimed_by: null });
    expect(noticeEvents()).toHaveLength(1);
    expect(noticeEvents()[0].detail).toMatchObject({ notice: "received", audience: "customer", status: "sent", language: "ms" });
    // a retry, a second click and a second server send nothing more
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "received", actor: null })).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
    expect(noticeEvents()).toHaveLength(1);
  });

  it("treats the loser of a race for the claim as a duplicate: only the holder of the claim sends", async () => {
    const { id } = await make();
    db.failNext.compliance_notices = "duplicate key value violates unique constraint";
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD })).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(0);
    // and two callers at once: one email
    const results = await Promise.all([1, 2, 3].map(() => sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "approved", actor: HEAD })));
    expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it("never throws for a failed delivery: the result is recorded with a named reason and no address", async () => {
    const { id } = await make();
    mailMode = "throw";
    const r = await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD });
    expect(r.status).toBe("failed");
    expect(r.detail).toBe("mailbox_reconnect");
    expect(notices()[0]).toMatchObject({ kind: "completed", status: "failed", detail: "mailbox_reconnect", recipients: 0 });
    expect(JSON.stringify(noticeEvents())).not.toContain("siti@example.test");
    mailMode = "none";
    db.tables.compliance_notices = [];
    expect((await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD })).detail).toBe("not_set_up");
  });

  it("lets a failed notice be sent again, once, and never one that was sent", async () => {
    const { id } = await make();
    mailMode = "throw";
    await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD });
    mailMode = "ok";
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD })).toEqual({ status: "duplicate" });
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD, retry: true })).toMatchObject({ status: "sent" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0].status).toBe("sent");
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD, retry: true })).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
  });

  it("takes over a claim whose server died, but not one that is still fresh", async () => {
    const { id } = await make();
    db.seed("compliance_notices", [{ id: "n1", account_id: ACCOUNT, request_id: id, kind: "approved", key: "once", audience: "customer", status: "claimed", claimed_at: new Date(NOW - 60_000).toISOString() }]);
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "approved", actor: HEAD, retry: true })).toEqual({ status: "duplicate" });
    (notices()[0] as any).claimed_at = new Date(NOW - 11 * 60_000).toISOString();
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "approved", actor: HEAD, retry: true })).toMatchObject({ status: "sent" });
  });

  it("records 'skipped' when the case has no address, and sends nothing", async () => {
    const { id } = await make({ customerEmail: null });
    expect(await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "completed", actor: HEAD })).toMatchObject({ status: "skipped", detail: "no_address" });
    expect(sent).toHaveLength(0);
    expect(noticeEvents()[0].detail).toMatchObject({ status: "skipped", reason: "no_address" });
  });

  it("asks for more information with the officer's words, who sent it on the case, once per nonce", async () => {
    const { id } = await make();
    const send = (nonce: string, text = "Please send a clearer copy of the letter.") => sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "more_info", text, key: nonce, actor: OFFICER });
    expect(await send("nonce-0001")).toMatchObject({ status: "sent" });
    expect(sent[0].text).toContain("Please send a clearer copy of the letter.");
    expect(sent[0].html).toContain("Please send a clearer copy of the letter.");
    expect(noticeEvents()[0]).toMatchObject({ actor: OFFICER });
    expect(noticeEvents()[0].detail).toMatchObject({ notice: "more_info", text: "Please send a clearer copy of the letter." });
    expect(await send("nonce-0001")).toEqual({ status: "duplicate" });
    expect(await send("nonce-0002", "And the front of the card.")).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(2);
    // no nonce, or a nonce that is not one, is refused before anything is claimed
    expect(await fails(sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "more_info", text: "x", actor: OFFICER }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "more_info", text: "x", key: "a b", actor: OFFICER }))).toMatchObject({ code: "validation_failed" });
    expect(notices()).toHaveLength(2);
  });

  it("refuses a text for the customer that carries the bank account number or the phone number, before anything is claimed", async () => {
    const { id } = await make();
    const send = (text: string) => sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "more_info", text, key: "nonce-0003", actor: OFFICER });
    expect(await fails(send(`Is your account ${ACCOUNT_NUMBER} still open?`))).toMatchObject({ code: "validation_failed", issues: [{ code: "contains_bank_detail" }] });
    expect(await fails(send(`Is account 8800-1234-5678-9012 right?`))).toMatchObject({ code: "validation_failed" });
    expect(await fails(send("Call us on +60 12-334 4556 please"))).toMatchObject({ code: "validation_failed", issues: [{ code: "contains_phone" }] });
    expect(await fails(send("   "))).toMatchObject({ code: "note_required" });
    expect(await fails(send("x".repeat(1001)))).toMatchObject({ code: "validation_failed" });
    expect(notices()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("never carries a bank detail, the full phone or a staff link in any customer email, in any language", async () => {
    for (const locale of ["en", "ms", "zh", "ko"] as const) {
      db.tables.compliance_notices = [];
      sent.length = 0;
      const { id } = await make({ customerLocale: locale, customerEmail: `p-${locale}@example.test` });
      for (const kind of ["received", "approved", "completed"] as const) await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind, actor: HEAD });
      await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "rejected", text: "We could not match the details.", actor: HEAD });
      await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "more_info", text: "More detail please.", key: `nonce-${locale}-1`, actor: OFFICER });
      expect(sent).toHaveLength(5);
      for (const m of sent) {
        const body = `${m.subject}\n${m.text}\n${m.html}`;
        for (const bad of [ACCOUNT_NUMBER, "8800", BANK_NAME, HOLDER, "+60123344556", "123344556", "0123", "/compliance", "http", "hard stop", "regulat"]) expect(body, `${locale} ${m.subject} ${bad}`).not.toContain(bad);
      }
    }
  });

  it("writes the customer's language from the case, else the contact, else English", async () => {
    const a = await make({ customerLocale: null });
    expect(await languageFor(admin(), row(a.id))).toBe("en");
    const contact = "c0000000-0000-4000-8000-000000000001";
    db.seed("contacts", [{ id: contact, account_id: ACCOUNT, language: "zh-CN" }]);
    const b = await make({ customerLocale: null, customerEmail: "b@example.test", contactId: contact });
    expect(await languageFor(admin(), row(b.id))).toBe("zh");
    const c = await make({ customerLocale: "ko", customerEmail: "c@example.test", contactId: contact });
    expect(await languageFor(admin(), row(c.id))).toBe("ko");
    db.rows("contacts")[0].language = "fr";
    expect(await languageFor(admin(), row(b.id))).toBe("en");
  });

  it("lets a language be named for one email", async () => {
    const { id } = await make();
    await sendCustomerNotice(admin(), deps, { accountId: ACCOUNT, requestId: id, kind: "approved", actor: HEAD, language: "ko" });
    expect(sent[0].subject).toContain("승인");
    expect(notices()[0].language).toBe("ko");
  });
});

describe("the preview", () => {
  it("shows the subject and the body in the customer's language, writes nothing and sends nothing", async () => {
    const { id, reference } = await make({ customerLocale: "zh" });
    const p = await previewCustomerNotice(admin(), officer(), id, { kind: "rejected", text: "资料不完整。" });
    expect(p.language).toBe("zh");
    expect(p.hasAddress).toBe(true);
    expect(p.subject).toContain(reference);
    expect(p.body).toContain("资料不完整。");
    expect(sent).toHaveLength(0);
    expect(notices()).toHaveLength(0);
    expect(noticeEvents()).toHaveLength(0);
  });

  it("applies the same text rules as sending, and needs review or approve", async () => {
    const { id } = await make();
    expect(await fails(previewCustomerNotice(admin(), officer(), id, { kind: "more_info", text: `my account is ${ACCOUNT_NUMBER}` }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(previewCustomerNotice(admin(), officer(), id, { kind: "more_info", text: "" }))).toMatchObject({ code: "note_required" });
    expect(await fails(previewCustomerNotice(admin(), callerFor(OPS, ["compliance.execute"]), id, { kind: "completed" }))).toMatchObject({ code: "forbidden" });
    const p = await previewCustomerNotice(admin(), officer(), id, { kind: "completed", language: "ko" });
    expect(p.language).toBe("ko");
  });

  it("does not reach another workspace's case", async () => {
    const { id } = await make();
    expect(await fails(previewCustomerNotice(admin(), callerFor(OFFICER, ["compliance.review"], "a0000000-0000-4000-8000-000000000002"), id, { kind: "completed" }))).toMatchObject({ code: "not_found" });
  });
});

describe("emails to staff: waiting for sign-off", () => {
  async function awaiting() {
    const { id } = await make();
    Object.assign(row(id), { status: "awaiting_signoff", review: { recommendation: "approve", at: "2026-10-13T09:00:00.000Z", by: OFFICER }, identity_check: { verified_by: OFFICER, recorded_by: OFFICER, outcome: "pass" } });
    return id;
  }

  it("emails the holders of compliance.approve and puts a notification in front of them, once per hand-over", async () => {
    const id = await awaiting();
    const r = await notifySignoffWaiting(admin(), deps, ACCOUNT, id);
    expect(r).toMatchObject({ status: "sent" });
    expect(sent.map((m) => m.to)).toEqual(["harun@example.test"]);
    expect(sent[0].subject).toContain(row(id).reference);
    expect(sent[0].text).toContain("approve");
    const n = db.rows("notifications") as any[];
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ account_id: ACCOUNT, user_id: HEAD, type: "compliance_signoff", compliance_request_id: id });
    expect(notices()[0]).toMatchObject({ kind: "signoff_waiting", audience: "staff", status: "sent", recipients: 1 });
    expect(JSON.stringify(noticeEvents())).not.toContain("harun@example.test");
    expect(await notifySignoffWaiting(admin(), deps, ACCOUNT, id)).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
    expect(db.rows("notifications")).toHaveLength(1);
  });

  it("is a new notice when the case is sent back and handed over again", async () => {
    const id = await awaiting();
    await notifySignoffWaiting(admin(), deps, ACCOUNT, id);
    row(id).review = { recommendation: "reject", at: "2026-10-14T09:00:00.000Z", by: OFFICER };
    expect((await notifySignoffWaiting(admin(), deps, ACCOUNT, id)).status).toBe("sent");
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain("reject");
  });

  it("does not email the person who did the identity check (they cannot sign it off), the people without an address or a case that is not waiting", async () => {
    const id = await awaiting();
    row(id).identity_check = { verified_by: HEAD, recorded_by: HEAD, outcome: "pass" };
    expect(await notifySignoffWaiting(admin(), deps, ACCOUNT, id)).toMatchObject({ status: "skipped", detail: "no_recipients" });
    expect(sent).toHaveLength(0);
    row(id).status = "officer_review";
    expect(await notifySignoffWaiting(admin(), deps, ACCOUNT, id)).toEqual({ status: "skipped", detail: "not_waiting" });
  });

  it("does nothing when the workspace's Compliance flag is off", async () => {
    const id = await awaiting();
    (db.rows("account_platform")[0] as any).features = { compliance: false };
    expect(await notifySignoffWaiting(admin(), deps, ACCOUNT, id)).toEqual({ status: "skipped", detail: "not_waiting" });
    expect(sent).toHaveLength(0);
  });

  it("writes each person's email in their own language", async () => {
    const id = await awaiting();
    (db.rows("profiles") as any[]).find((p) => p.user_id === HEAD).locale = "ko";
    await notifySignoffWaiting(admin(), deps, ACCOUNT, id);
    expect(sent[0].subject).toContain("최종 승인");
    const rec = await staffRecipients(admin(), ACCOUNT, ["compliance.approve", "compliance.review"], [OFFICER]);
    expect(rec.map((r) => r.userId)).toEqual([HEAD]);
    expect(rec[0].locale).toBe("ko");
  });
});

describe("emails to staff: the clock alerts", () => {
  const alert = (requestId: string, threshold: number, daysLeft: number, at = new Date(NOW - 3600_000).toISOString()) =>
    db.seed("compliance_request_events", [{ id: `e-${requestId}-${threshold}`, account_id: ACCOUNT, request_id: requestId, kind: "clock_alert", actor: null, at, detail: { threshold, days_left: daysLeft } }]);

  it("emails the approvers and reviewers for the 5-day and the breach alerts the sweep raised, once; the 10-day alert is the in-app notification only", async () => {
    const { id } = await make();
    alert(id, 10, 10);
    expect(await emailClockAlerts(admin(), deps)).toEqual({ looked: 1, sent: 0, skipped: 1, failed: 0 });
    expect(sent).toHaveLength(0);
    expect(notices()).toHaveLength(0);

    alert(id, 5, 5);
    const r = await emailClockAlerts(admin(), deps);
    expect(r).toEqual({ looked: 2, sent: 1, skipped: 1, failed: 0 });
    expect(sent.map((m) => m.to).sort()).toEqual(["harun@example.test", "olivia@example.test"]);
    expect(sent[0].subject).toContain("5 days");
    expect(notices()[0]).toMatchObject({ kind: "clock_alert", key: "t5", audience: "staff", status: "sent", recipients: 2 });
    // the next hourly run alerts nobody again
    expect(await emailClockAlerts(admin(), deps)).toEqual({ looked: 2, sent: 0, skipped: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    // the breach is a new email
    alert(id, 0, 0);
    expect((await emailClockAlerts(admin(), deps)).sent).toBe(1);
    expect(sent.at(-1)!.subject).toContain("has been reached");
    expect(notices().map((n) => n.key).sort()).toEqual(["t0", "t5"]);
  });

  it("skips an alert of a case that has finished, of a workspace with the flag off, and one older than three days", async () => {
    const a = await make();
    const b = await make({ customerEmail: "b@example.test" });
    alert(a.id, 5, 5);
    row(a.id).closed_at = new Date(NOW - 1000).toISOString();
    alert(b.id, 5, 5, new Date(NOW - 4 * 86_400_000).toISOString());
    expect(await emailClockAlerts(admin(), deps)).toEqual({ looked: 1, sent: 0, skipped: 1, failed: 0 });
    row(a.id).closed_at = null;
    (db.rows("account_platform")[0] as any).features = { compliance: false };
    expect((await emailClockAlerts(admin(), deps)).skipped).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("records a failure and goes on, with no address in the record", async () => {
    const { id } = await make();
    alert(id, 5, 5);
    mailMode = "throw";
    expect(await emailClockAlerts(admin(), deps)).toEqual({ looked: 1, sent: 0, skipped: 0, failed: 1 });
    expect(notices()[0]).toMatchObject({ status: "failed", detail: "mailbox_reconnect" });
    expect(JSON.stringify(noticeEvents())).not.toContain("example.test");
  });
});

describe("what the moves send", () => {
  /** The database function: moves the row and answers. */
  function moves() {
    db.rpcHandlers.compliance_transition = (args) => {
      const r = row(String(args.p_request));
      r.status = String(args.p_to);
      if (args.p_to === "rejected") r.signoff = { decision: "rejected", ...(args.p_payload as any) };
      return { data: { id: r.id, from: "x", to: args.p_to }, error: null };
    };
  }
  const reject = (id: string, over: Record<string, unknown> = {}) =>
    transitionRequest(admin(), head(), id, { to: "rejected", note: "Mismatch with the records.", reasonCategory: "identity_failed", customerReason: "We could not match your details to the account.", ...over } as any, deps);
  const at = async (status: string) => {
    const { id } = await make();
    row(id).status = status;
    moves();
    return id;
  };

  it("a rejection needs a category and the customer's words, before anything moves", async () => {
    const id = await at("awaiting_signoff");
    expect(await fails(reject(id, { reasonCategory: null }))).toMatchObject({ code: "category_required" });
    expect(await fails(reject(id, { reasonCategory: "because" }))).toMatchObject({ code: "category_required" });
    expect(await fails(reject(id, { customerReason: "  " }))).toMatchObject({ code: "customer_reason_required" });
    expect(await fails(reject(id, { customerReason: `Your account ${ACCOUNT_NUMBER}` }))).toMatchObject({ code: "validation_failed" });
    expect(row(id).status).toBe("awaiting_signoff");
    expect(db.rpcCalls.filter((c) => c.name === "compliance_transition")).toHaveLength(0);
  });

  it("a rejection passes the category and the customer's words to the database and emails the customer by default", async () => {
    const id = await at("awaiting_signoff");
    const r = await reject(id);
    expect(r).toMatchObject({ from: "awaiting_signoff", to: "rejected", notice: { status: "sent" } });
    const call = db.rpcCalls.find((c) => c.name === "compliance_transition")!;
    expect(call.args).toMatchObject({ p_to: "rejected", p_note: "Mismatch with the records.", p_payload: { reason_category: "identity_failed", customer_reason: "We could not match your details to the account." } });
    expect(sent[0].text).toContain("We could not match your details to the account.");
    expect(sent[0].text).not.toContain("Mismatch with the records.");
    expect(noticeEvents()[0]).toMatchObject({ actor: HEAD });
  });

  it("the Head can turn the email off for a rejection, and the move still happens", async () => {
    const id = await at("awaiting_signoff");
    const r = await reject(id, { notify: false });
    expect(r.notice).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(row(id).status).toBe("rejected");
  });

  it("approving emails the customer only when asked; completing emails by default", async () => {
    const a = await at("awaiting_signoff");
    expect((await transitionRequest(admin(), head(), a, { to: "approved" }, deps)).notice).toBeUndefined();
    expect(sent).toHaveLength(0);
    const b = await at("awaiting_signoff");
    expect((await transitionRequest(admin(), head(), b, { to: "approved", notify: true }, deps)).notice).toMatchObject({ status: "sent" });
    expect(sent.at(-1)!.subject).toContain(row(b).reference);
    const c = await at("executing");
    const done = await transitionRequest(admin(), callerFor(OPS, ["compliance.execute"]), c, { to: "completed" }, deps);
    expect(done.notice).toMatchObject({ status: "sent" });
    expect(sent.at(-1)!.subject).toContain("selesai");
    const d = await at("executing");
    expect((await transitionRequest(admin(), callerFor(OPS, ["compliance.execute"]), d, { to: "completed", notify: false }, deps)).notice).toBeUndefined();
  });

  it("a failed email never blocks the move: the result says so", async () => {
    const id = await at("executing");
    mailMode = "throw";
    const r = await transitionRequest(admin(), callerFor(OPS, ["compliance.execute"]), id, { to: "completed" }, deps);
    expect(r).toMatchObject({ to: "completed", notice: { status: "failed", detail: "mailbox_reconnect" } });
    expect(row(id).status).toBe("completed");
  });

  it("handing a case to the Head of Compliance tells the Head", async () => {
    const id = await at("officer_review");
    row(id).identity_check = { verified_by: OFFICER, recorded_by: OFFICER, outcome: "pass" };
    row(id).review = { recommendation: "approve", at: "2026-10-13T08:00:00.000Z", by: OFFICER };
    await transitionRequest(admin(), officer(), id, { to: "awaiting_signoff", recommendation: "approve" }, deps);
    expect(sent.map((m) => m.to)).toEqual(["harun@example.test"]);
    expect(eventsOf(db, id).some((e: any) => e.kind === "notice")).toBe(true);
  });

  it("closing a case sends nothing (the customer was told when it was rejected or completed)", async () => {
    const id = await at("completed");
    await transitionRequest(admin(), officer(), id, { to: "closed", note: "Customer told" }, deps);
    expect(sent).toHaveLength(0);
    void AGENT;
  });
});
