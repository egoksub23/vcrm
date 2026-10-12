/* eslint-disable @typescript-eslint/no-explicit-any -- rows and bodies are read loosely in a test */
// The Compliance requests services against the in-memory database: creating a case (validation, encryption, what is stored), the list (filters, counts,
// the workspace wall), the detail (masks, the 'view' event), reveal, edits, the steps (what is asked of the database functions), files and the type
// settings. The rules that live in SQL (the transition table, maker-checker, retention, the clocks) are proved by supabase/ci/verify-183-*.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { decrypt } from "@/lib/whatsapp/encryption";
import type { FakeDb } from "@/lib/sign/service/fake-db";

import { ComplianceError } from "../errors";
import {
  ACCOUNT,
  ACCOUNT_NUMBER,
  AGENT,
  BANK_NAME,
  CLOSURE_ANSWERS,
  HEAD,
  HOLDER,
  OFFICER,
  OPS,
  OTHER_ACCOUNT,
  callerFor,
  eventsOf,
  head,
  officer,
  ops,
  world,
} from "../test-support";
import { clockAction, revealSensitive, setStanding, tickStep, transitionRequest } from "./actions";
import { downloadFile, uploadFile, COMPLIANCE_BUCKET } from "./files";
import { countOpen, getRequestDetail, listRequests, parseListFilters, searchTerm } from "./read";
import { createType, updateType } from "./types-admin";
import { addNote, createComplianceRequest, editRequest } from "./write";
import { runClockSweep } from "./jobs";

let db: FakeDb;
let admin: ReturnType<FakeDb["client"]>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = world();
  admin = db.client();
});

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

const create = (over: Record<string, unknown> = {}) =>
  createComplianceRequest(admin, {
    accountId: ACCOUNT,
    typeKey: "closure",
    source: "staff",
    channel: "whatsapp",
    customerName: "Siti Aminah",
    customerEmail: "siti@example.test",
    customerPhone: "012-345 6789",
    answers: CLOSURE_ANSWERS,
    createdBy: OFFICER,
    ...over,
  } as any);

const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as ComplianceError | null;

describe("createComplianceRequest (the function Part B calls)", () => {
  it("makes a case: ordinary answers in data, the bank details only as ciphertext bound to the case, the phone normalised", async () => {
    const { id, reference } = await create();
    expect(reference).toMatch(/^CMP-\d{4}-\d{6}$/);
    const row = db.rows("compliance_requests")[0] as any;
    expect(row).toMatchObject({ id, account_id: ACCOUNT, type_key: "closure", source: "staff", channel: "whatsapp", customer_name: "Siti Aminah", customer_phone: "+60123456789", created_by: OFFICER, is_test: false });
    expect(row.data).toEqual({ confirm_closure: true, children_finished_school: true, allowances_cancelled: true, reason: "Moving abroad" });
    // the three bank answers are in the ciphertext and nowhere else
    expect(typeof row.data_enc).toBe("string");
    const opened = JSON.parse(decrypt(row.data_enc));
    expect(opened.r).toBe(id);
    expect(opened.v).toEqual({ bank_name: BANK_NAME, bank_account_number: ACCOUNT_NUMBER, bank_account_holder: HOLDER });
    const everything = JSON.stringify(db.tables);
    for (const secret of [ACCOUNT_NUMBER, BANK_NAME, HOLDER]) expect(everything).not.toContain(secret);
  });

  it("supports every source and a channel, and leaves createdBy empty for the public form", async () => {
    for (const source of ["form", "staff", "inbox", "ticket"] as const) {
      await create({ source, createdBy: source === "form" ? null : OFFICER });
    }
    const rows = db.rows("compliance_requests") as any[];
    expect(rows.map((r) => r.source)).toEqual(["form", "staff", "inbox", "ticket"]);
    expect(rows[0].created_by).toBeNull();
    expect(await fails(create({ source: "sms" }))).toMatchObject({ code: "invalid_request" });
  });

  it("refuses a missing required answer, an unticked acknowledgement, a bad phone, a bad email and an unknown or inactive type", async () => {
    const { bank_name: _drop, ...noBank } = CLOSURE_ANSWERS;
    void _drop;
    expect(await fails(create({ answers: noBank }))).toMatchObject({ code: "validation_failed", issues: [{ field: "bank_name", code: "required" }] });
    expect(await fails(create({ answers: { ...CLOSURE_ANSWERS, confirm_closure: false } }))).toMatchObject({ code: "validation_failed", issues: [{ field: "confirm_closure", code: "must_acknowledge" }] });
    expect(await fails(create({ customerPhone: "call me" }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(create({ customerEmail: "nope" }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(create({ customerName: "  " }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(create({ typeKey: "nothing" }))).toMatchObject({ code: "type_unavailable" });
    db.rows("compliance_request_types").find((t: any) => t.key === "closure")!.active = false;
    expect(await fails(create())).toMatchObject({ code: "type_unavailable" });
    expect(db.rows("compliance_requests")).toHaveLength(0);
  });

  it("creates a phone change with no bank details and no encrypted bag", async () => {
    await create({ typeKey: "phone_change", answers: { current_phone: "0123456789", new_phone: "+60 19-876 5432" } });
    const row = db.rows("compliance_requests")[0] as any;
    expect(row.data).toEqual({ current_phone: "+60123456789", new_phone: "+60198765432" });
    expect(row.data_enc).toBeNull();
  });

  it("passes the request date through (back-dating is the database's to audit) and rejects one that is not a date", async () => {
    await create({ receivedAt: "2026-10-01T09:00:00Z" });
    expect((db.rows("compliance_requests")[0] as any).received_at).toBe("2026-10-01T09:00:00.000Z");
    expect(await fails(create({ receivedAt: "yesterday-ish" }))).toMatchObject({ code: "validation_failed" });
  });

  it("answers a database refusal with a code, never the database's words", async () => {
    db.failNext.compliance_requests = "compliance_link_other_workspace: contact";
    const e = await fails(create());
    expect(e).toMatchObject({ code: "link_other_workspace", status: 400 });
    expect(e!.message).not.toContain("compliance_");
  });

  it("refuses a link that is not an id", async () => {
    expect(await fails(create({ contactId: "not-a-uuid" }))).toMatchObject({ code: "validation_failed" });
  });
});

describe("listRequests", () => {
  const seedCases = async () => {
    const day = 86_400_000;
    const now = Date.now();
    const iso = (d: number) => new Date(now - d * day).toISOString();
    const a = await create({ customerName: "Alice One", receivedAt: iso(1), customerPhone: "+60111111111" });
    const b = await create({ customerName: "Bob Two", customerEmail: "bob@example.test", receivedAt: iso(16), customerPhone: "+60122222222" });
    const c = await create({ customerName: "Cara Three", receivedAt: iso(24), customerPhone: "+60133333333" });
    const d = await create({ customerName: "Dan Four", receivedAt: iso(40), customerPhone: "+60144444444" });
    const w = await create({ typeKey: "withdrawal", customerName: "Wendy Five", receivedAt: iso(3), answers: { amount: "50", reason: "over top-up", bank_account_number: "123456789" } });
    return { a, b, c, d, w, iso };
  };
  // the database stamps the clocks; the fake needs them said
  const stamp = () => {
    for (const r of db.rows("compliance_requests") as any[]) {
      const t = db.rows("compliance_request_types").find((x: any) => x.key === r.type_key) as any;
      r.target_due_at = t.target_days ? new Date(Date.parse(r.received_at) + t.target_days * 86_400_000).toISOString() : null;
      r.hard_stop_at = t.hard_stop_days ? new Date(Date.parse(r.received_at) + t.hard_stop_days * 86_400_000).toISOString() : null;
      r.target_days = t.target_days;
      r.hard_stop_days = t.hard_stop_days;
    }
  };

  it("lists the workspace's cases newest request first, with the type's name and no answers", async () => {
    await seedCases();
    stamp();
    const list = await listRequests(admin, officer(), parseListFilters(new URLSearchParams()));
    expect(list.total).toBe(5);
    expect(list.rows.map((r) => r.customerName)).toEqual(["Alice One", "Wendy Five", "Bob Two", "Cara Three", "Dan Four"]);
    expect(list.rows[0]).toMatchObject({ typeKey: "closure", typeLabel: "Account closure", status: "received" });
    expect(JSON.stringify(list)).not.toContain(ACCOUNT_NUMBER);
    expect(Object.keys(list.rows[0])).not.toContain("data");
    expect(list.types.map((t) => t.key)).toEqual(["closure", "withdrawal", "phone_change"]);
  });

  it("never lists another workspace's cases", async () => {
    await seedCases();
    stamp();
    db.seed("compliance_requests", [{ id: "x1", account_id: OTHER_ACCOUNT, reference: "CMP-2026-000001", type_key: "closure", status: "received", received_at: new Date().toISOString(), source: "staff", customer_name: "Elsewhere", closed_at: null, clock_paused_at: null }]);
    const list = await listRequests(admin, officer(), {});
    expect(list.rows.map((r) => r.customerName)).not.toContain("Elsewhere");
    expect(list.counts.open).toBe(5);
    const other = await listRequests(admin, callerFor(OFFICER, ["compliance.review"], OTHER_ACCOUNT), {});
    expect(other.rows.map((r) => r.customerName)).toEqual(["Elsewhere"]);
  });

  it("counts the open cases once on the clock chips: past target (amber), near stop and breached (red)", async () => {
    await seedCases();
    stamp();
    const list = await listRequests(admin, officer(), {});
    // Alice day 2 on track, Bob day 17 past the 14-day target, Cara day 25 near the stop (6 days), Dan day 41 breached, Wendy no clock
    expect(list.counts).toMatchObject({ open: 5, needsIdentityCheck: 5, pastTarget: 1, nearStop: 1, breached: 1, inReview: 0, awaitingSignoff: 0, executing: 0 });
    const due = (k: string) => listRequests(admin, officer(), { due: k as any }).then((l) => l.rows.map((r) => r.customerName));
    expect(await due("on_track")).toEqual(["Alice One"]);
    expect(await due("target_passed")).toEqual(["Bob Two"]);
    expect(await due("near_stop")).toEqual(["Cara Three"]);
    expect(await due("breached")).toEqual(["Dan Four"]);
  });

  it("counts by stage: needs identity check, in review, awaiting sign-off, executing; finished cases are not open", () => {
    const base = { received_at: new Date().toISOString(), target_days: null, hard_stop_days: null, target_due_at: null, hard_stop_at: null, clock_paused_at: null, completed_at: null, closed_at: null };
    const counts = countOpen(
      [
        { ...base, status: "received" },
        { ...base, status: "identity_check" },
        { ...base, status: "officer_review" },
        { ...base, status: "awaiting_signoff" },
        { ...base, status: "approved" },
        { ...base, status: "executing" },
        { ...base, status: "completed" },
        { ...base, status: "closed" },
        { ...base, status: "rejected" },
      ],
      Date.now(),
    );
    expect(counts).toMatchObject({ open: 7, needsIdentityCheck: 2, inReview: 1, awaitingSignoff: 1, executing: 2 });
  });

  it("filters by type, status, assignee, mine, date and finds by reference, name, email or phone", async () => {
    const { a, b, w } = await seedCases();
    stamp();
    const rows = db.rows("compliance_requests") as any[];
    rows.find((r) => r.id === b.id).status = "officer_review";
    rows.find((r) => r.id === b.id).assigned_to = OFFICER;
    rows.find((r) => r.id === w.id).created_by = HEAD;
    const names = (f: any, who = officer()) => listRequests(admin, who, f).then((l) => l.rows.map((r) => r.customerName));
    expect(await names({ type: "withdrawal" })).toEqual(["Wendy Five"]);
    expect(await names({ statuses: ["officer_review"] })).toEqual(["Bob Two"]);
    expect(await names({ assignee: OFFICER })).toEqual(["Bob Two"]);
    expect((await names({ assignee: "none" })).length).toBe(4);
    expect(await names({ mine: true })).toEqual(["Alice One", "Bob Two", "Cara Three", "Dan Four"]);
    expect(await names({ mine: true }, head())).toEqual(["Wendy Five"]);
    expect(await names({ q: a.reference })).toEqual(["Alice One"]);
    expect(await names({ q: "bob@example" })).toEqual(["Bob Two"]);
    expect(await names({ q: "cara" })).toEqual(["Cara Three"]);
    expect(await names({ q: "012-222 2222" })).toEqual(["Bob Two"]);
    expect(await names({ q: "133333" })).toEqual(["Cara Three"]);
    expect(await names({ from: new Date(Date.now() - 5 * 86_400_000).toISOString() })).toEqual(["Alice One", "Wendy Five"]);
    expect(await names({ to: new Date(Date.now() - 30 * 86_400_000).toISOString() })).toEqual(["Dan Four"]);
  });

  it("pages", async () => {
    await seedCases();
    stamp();
    const p1 = await listRequests(admin, officer(), { pageSize: 2, page: 1 });
    const p3 = await listRequests(admin, officer(), { pageSize: 2, page: 3 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.total).toBe(5);
    expect(p3.rows.map((r) => r.customerName)).toEqual(["Dan Four"]);
  });

  it("offers the people who can see requests as assignees", async () => {
    const list = await listRequests(admin, officer(), {});
    expect(list.people.map((p) => p.name)).toEqual(["Harun Head", "Olivia Officer", "Omar Ops"]);
  });

  it("reads the query string carefully: unknown statuses, dues and ids are dropped, numbers are clamped", () => {
    const f = parseListFilters(new URLSearchParams("status=received,bogus,closed&due=nope&assignee=not-an-id&type=Bad Type&page=-3&page_size=9999&mine=1&q=%20abc%20"));
    expect(f).toMatchObject({ statuses: ["received", "closed"], due: "all", assignee: null, type: null, page: 1, pageSize: 100, mine: true, q: "abc" });
    expect(parseListFilters(new URLSearchParams(`assignee=none&type=closure&from=garbage&to=2026-10-01`))).toMatchObject({ assignee: "none", type: "closure", from: null, to: "2026-10-01T00:00:00.000Z" });
  });

  it("makes a search term that cannot add a condition of its own to the filter", () => {
    expect(searchTerm("a,customer_name.eq.x)(b%*\\_:'\"")).toBe("a customer name.eq.x b");
    expect(searchTerm("   ")).toBe("");
  });

  it("a search made only of filter syntax adds no condition and shows the list", async () => {
    await seedCases();
    stamp();
    const l = await listRequests(admin, officer(), { q: ",,()" });
    expect(l.total).toBe(5);
  });
});

describe("getRequestDetail", () => {
  it("returns the case with every sensitive answer as a mask, never the value, and writes a 'view' event first", async () => {
    const { id } = await create();
    const detail = await getRequestDetail(admin, officer(), id);
    expect(detail.sensitive.map((s) => [s.key, s.present])).toEqual([["bank_name", true], ["bank_account_number", true], ["bank_account_holder", true]]);
    expect(detail.sensitive.find((s) => s.key === "bank_account_number")!.masked).toBe("•••• 9012");
    expect(detail.sensitiveReadable).toBe(true);
    const wire = JSON.stringify(detail);
    for (const secret of [ACCOUNT_NUMBER, BANK_NAME, HOLDER, "data_enc"]) expect(wire).not.toContain(secret);
    expect(detail.data).toMatchObject({ reason: "Moving abroad" });
    expect(detail.checklist).toEqual([]); // the checklist is copied by the database trigger
    expect(eventsOf(db, id).map((e: any) => [e.kind, e.actor])).toEqual([["view", OFFICER]]);
    expect(detail.viewer).toMatchObject({ canReview: true, canApprove: false, canReveal: false });
    expect(detail.type?.key).toBe("closure");
  });

  it("says nothing when the view cannot be recorded", async () => {
    const { id } = await create();
    db.failNext.compliance_request_events = "disk full";
    expect(await fails(getRequestDetail(admin, officer(), id))).toMatchObject({ code: "audit_failed", status: 503 });
  });

  it("treats another workspace's case as not found", async () => {
    const { id } = await create();
    expect(await fails(getRequestDetail(admin, callerFor(OFFICER, ["compliance.review"], OTHER_ACCOUNT), id))).toMatchObject({ code: "not_found", status: 404 });
    expect(await fails(getRequestDetail(admin, officer(), "00000000-0000-4000-8000-00000000dead"))).toMatchObject({ code: "not_found" });
  });

  it("carries the checklist, files, links and the timeline newest first, with names", async () => {
    const { id } = await create();
    db.seed("compliance_request_checklist", [{ account_id: ACCOUNT, request_id: id, step_key: "refund", label: "Refund the balance", label_l10n: { en: "Refund the balance", ms: "Pulangkan baki" }, position: 1, done_by: OPS, done_at: "2026-10-05T10:00:00Z", note: "Done" }]);
    db.seed("compliance_request_files", [{ id: "f1", account_id: ACCOUNT, request_id: id, name: "letter.pdf", mime: "application/pdf", size_bytes: 1200, field_key: "authorization_letter", uploaded_by: OFFICER, uploaded_at: "2026-10-02T10:00:00Z", path: "account-x/y/letter.pdf" }]);
    db.seed("compliance_request_events", [{ account_id: ACCOUNT, request_id: id, kind: "created", actor: OFFICER, detail: { source: "staff" }, seq: -2, at: "2026-10-01T10:00:00Z" }, { account_id: ACCOUNT, request_id: id, kind: "note", actor: HEAD, detail: { text: "hello" }, seq: -1, at: "2026-10-01T11:00:00Z" }]);
    const d = await getRequestDetail(admin, head(), id);
    expect(d.checklist[0]).toMatchObject({ stepKey: "refund", done: true, doneBy: { name: "Omar Ops" }, labelL10n: { ms: "Pulangkan baki" } });
    expect(d.files[0]).toMatchObject({ name: "letter.pdf", size: 1200, fieldKey: "authorization_letter", uploadedBy: { name: "Olivia Officer" } });
    expect(JSON.stringify(d)).not.toContain("account-x/y");
    expect(d.events.map((e) => e.kind).slice(0, 3)).toEqual(["view", "note", "created"]);
    expect(d.events[1].actor).toEqual({ id: HEAD, name: "Harun Head" });
  });

  it("still shows the case when the stored sensitive answers cannot be read, and says so", async () => {
    const { id } = await create();
    (db.rows("compliance_requests")[0] as any).data_enc = "not-a-ciphertext";
    const d = await getRequestDetail(admin, officer(), id);
    expect(d.sensitiveReadable).toBe(false);
    expect(d.sensitive.every((s) => !s.present)).toBe(true);
  });
});

describe("revealSensitive", () => {
  it("returns the bank details of that one case and records the reveal first", async () => {
    const { id } = await create();
    const r = await revealSensitive(admin, head(), id);
    expect(r.fields.map((f) => [f.key, f.value])).toEqual([["bank_name", BANK_NAME], ["bank_account_number", ACCOUNT_NUMBER], ["bank_account_holder", HOLDER]]);
    expect(r.expiresInSeconds).toBe(120);
    const ev = eventsOf(db, id).find((e: any) => e.kind === "reveal") as any;
    expect(ev).toMatchObject({ actor: HEAD, detail: { allowed: true, fields: ["bank_name", "bank_account_number", "bank_account_holder"] } });
    // the trail names the fields, never a value
    for (const secret of [ACCOUNT_NUMBER, BANK_NAME, HOLDER]) expect(JSON.stringify(db.rows("compliance_request_events"))).not.toContain(secret);
  });

  it("is refused, and the attempt recorded, without compliance.reveal", async () => {
    const { id } = await create();
    expect(await fails(revealSensitive(admin, officer(), id))).toMatchObject({ code: "forbidden", status: 403 });
    expect(eventsOf(db, id)).toEqual([expect.objectContaining({ kind: "reveal", actor: OFFICER, detail: { allowed: false } })]);
  });

  it("returns nothing when the event cannot be written", async () => {
    const { id } = await create();
    db.failNext.compliance_request_events = "disk full";
    expect(await fails(revealSensitive(admin, head(), id))).toMatchObject({ code: "audit_failed" });
  });

  it("refuses a ciphertext that was copied onto another case", async () => {
    const a = await create();
    const b = await create({ customerName: "Other Parent" });
    const rows = db.rows("compliance_requests") as any[];
    rows.find((r) => r.id === b.id).data_enc = rows.find((r) => r.id === a.id).data_enc;
    expect(await fails(revealSensitive(admin, head(), b.id))).toMatchObject({ code: "encryption_unavailable" });
  });

  it("cannot reach a case of another workspace", async () => {
    const { id } = await create();
    expect(await fails(revealSensitive(admin, callerFor(HEAD, ["compliance.reveal"], OTHER_ACCOUNT), id))).toMatchObject({ code: "not_found" });
  });
});

describe("editRequest", () => {
  it("merges ordinary answers, normalises the phone, and asks the database function, which holds the rules", async () => {
    const { id } = await create();
    const calls: any[] = [];
    db.rpcHandlers.compliance_update_request = (args) => {
      calls.push(args);
      return { data: { id, changed: ["customer_phone", "data"] }, error: null };
    };
    const out = await editRequest(admin, officer(), id, { customerPhone: "019-876 5432", answers: { reason: "Changed my mind" }, assignedTo: HEAD });
    expect(out.changed).toEqual(["customer_phone", "data"]);
    expect(calls[0]).toMatchObject({ p_request: id, p_actor: OFFICER });
    expect(calls[0].p_patch).toMatchObject({ customer_phone: "+60198765432", assigned_to: HEAD });
    expect(calls[0].p_patch.data).toEqual({ confirm_closure: true, children_finished_school: true, allowances_cancelled: true, reason: "Changed my mind" });
    expect(calls[0].p_patch.data_enc).toBeUndefined();
  });

  it("needs compliance.reveal to change a bank detail, and re-seals the bag without losing the others", async () => {
    const { id } = await create();
    let patch: any = null;
    db.rpcHandlers.compliance_update_request = (args) => {
      patch = args.p_patch;
      return { data: { id, changed: ["sensitive_data"] }, error: null };
    };
    expect(await fails(editRequest(admin, officer(), id, { sensitive: { bank_account_number: "1111222233334444" } }))).toMatchObject({ code: "forbidden" });
    expect(patch).toBeNull();
    await editRequest(admin, head(), id, { sensitive: { bank_account_number: "1111222233334444" } });
    const opened = JSON.parse(decrypt(patch.data_enc));
    expect(opened).toMatchObject({ r: id, v: { bank_name: BANK_NAME, bank_account_number: "1111222233334444", bank_account_holder: HOLDER } });
    expect(JSON.stringify(patch)).not.toContain("1111222233334444");
  });

  it("refuses to edit the answers once the case is with the Head, but lets the links and the assignee change", async () => {
    const { id } = await create();
    (db.rows("compliance_requests")[0] as any).status = "awaiting_signoff";
    db.rpcHandlers.compliance_update_request = () => ({ data: { changed: [] }, error: null });
    expect(await fails(editRequest(admin, officer(), id, { answers: { reason: "x" } }))).toMatchObject({ code: "frozen" });
    expect(await fails(editRequest(admin, officer(), id, { customerName: "New Name" }))).toMatchObject({ code: "frozen" });
    await expect(editRequest(admin, officer(), id, { assignedTo: HEAD, ticketId: "00000000-0000-4000-8000-0000000000aa" })).resolves.toBeDefined();
  });

  it("is refused for someone with neither review nor approve, validates ids, and maps a database refusal to a code", async () => {
    const { id } = await create();
    expect(await fails(editRequest(admin, ops(), id, { assignedTo: HEAD }))).toMatchObject({ code: "forbidden" });
    expect(await fails(editRequest(admin, officer(), id, { ticketId: "nope" }))).toMatchObject({ code: "validation_failed" });
    db.rpcHandlers.compliance_update_request = () => ({ data: null, error: { message: "compliance_assignee_cannot_see_requests" } });
    expect(await fails(editRequest(admin, officer(), id, { assignedTo: AGENT }))).toMatchObject({ code: "assignee_cannot_see_requests" });
    expect(await editRequest(admin, officer(), id, {})).toEqual({ changed: [] });
  });
});

describe("notes", () => {
  it("adds a note to the timeline for a reviewer; an empty or over-long note is refused", async () => {
    const { id } = await create();
    await addNote(admin, officer(), id, "  Called the parent, will send the letter  ");
    expect(eventsOf(db, id).filter((e: any) => e.kind === "note")).toEqual([expect.objectContaining({ actor: OFFICER, detail: { text: "Called the parent, will send the letter" } })]);
    expect(await fails(addNote(admin, officer(), id, "   "))).toMatchObject({ code: "note_required" });
    expect(await fails(addNote(admin, officer(), id, "x".repeat(2001)))).toMatchObject({ code: "validation_failed" });
    expect(await fails(addNote(admin, ops(), id, "hi"))).toMatchObject({ code: "forbidden" });
  });
});

describe("transitionRequest (early checks; the database function is the rule)", () => {
  const rpc = () => {
    const calls: any[] = [];
    db.rpcHandlers.compliance_transition = (args) => {
      calls.push(args);
      return { data: { id: args.p_request, to: args.p_to }, error: null };
    };
    return calls;
  };
  const setStatus = (id: string, status: string, extra: Record<string, unknown> = {}) => Object.assign(db.rows("compliance_requests").find((r: any) => r.id === id)!, { status, ...extra });

  it("records the identity check: asks for a method and an outcome, and sends them with the note", async () => {
    const { id } = await create();
    const calls = rpc();
    expect(await fails(transitionRequest(admin, officer(), id, { to: "officer_review" }))).toMatchObject({ code: "identity_incomplete" });
    expect(await fails(transitionRequest(admin, officer(), id, { to: "officer_review", identity: { method: "other", outcome: "pass" } }))).toMatchObject({ code: "identity_incomplete" });
    expect(await fails(transitionRequest(admin, officer(), id, { to: "officer_review", identity: { method: "call_back", outcome: "fail" } }))).toMatchObject({ code: "note_required" });
    expect(await fails(transitionRequest(admin, officer(), id, { to: "officer_review", identity: { method: "telepathy", outcome: "pass" } }))).toMatchObject({ code: "identity_incomplete" });
    expect(calls).toHaveLength(0);
    const r = await transitionRequest(admin, officer(), id, { to: "officer_review", note: "Security questions answered", identity: { method: "call_back", outcome: "pass" } });
    expect(r).toEqual({ from: "received", to: "officer_review" });
    expect(calls[0]).toEqual({ p_request: id, p_to: "officer_review", p_actor: OFFICER, p_note: "Security questions answered", p_payload: { method: "call_back", method_other: null, outcome: "pass" } });
  });

  it("refuses a move that is not in the table before asking the database", async () => {
    const { id } = await create();
    const calls = rpc();
    for (const to of ["approved", "awaiting_signoff", "executing", "completed", "rejected", "received"] as const) {
      expect(await fails(transitionRequest(admin, head(), id, { to })), to).toMatchObject({ code: "invalid_transition", status: 409 });
    }
    expect(calls).toHaveLength(0);
  });

  it("hands over with a recommendation only", async () => {
    const { id } = await create();
    setStatus(id, "officer_review");
    const calls = rpc();
    expect(await fails(transitionRequest(admin, officer(), id, { to: "awaiting_signoff" }))).toMatchObject({ code: "recommendation_required" });
    expect(await fails(transitionRequest(admin, officer(), id, { to: "awaiting_signoff", recommendation: "maybe" }))).toMatchObject({ code: "recommendation_required" });
    await transitionRequest(admin, officer(), id, { to: "awaiting_signoff", recommendation: "approve", note: "Looks genuine" });
    expect(calls[0].p_payload).toEqual({ recommendation: "approve" });
  });

  it("lets only the approve permission sign off, and refuses the person who recorded the identity check, before and after the database", async () => {
    const { id } = await create();
    setStatus(id, "awaiting_signoff", { identity_check: { outcome: "pass", verified_by: HEAD, recorded_by: HEAD } });
    const calls = rpc();
    expect(await fails(transitionRequest(admin, officer(), id, { to: "approved" }))).toMatchObject({ code: "forbidden" });
    expect(await fails(transitionRequest(admin, head(), id, { to: "approved" }))).toMatchObject({ code: "maker_checker", status: 403 });
    expect(await fails(transitionRequest(admin, head(), id, { to: "rejected", note: "No" }))).toMatchObject({ code: "maker_checker" });
    expect(calls).toHaveLength(0);
    // someone else recorded it: the Head may sign off; a rejection needs a reason; an override reason travels in the payload
    setStatus(id, "awaiting_signoff", { identity_check: { outcome: "pass", verified_by: OFFICER, recorded_by: OFFICER } });
    expect(await fails(transitionRequest(admin, head(), id, { to: "rejected" }))).toMatchObject({ code: "note_required" });
    await transitionRequest(admin, head(), id, { to: "approved", overrideReason: "  Settled in cash  " });
    expect(calls[0]).toMatchObject({ p_to: "approved", p_actor: HEAD, p_payload: { override_reason: "Settled in cash" } });
  });

  it("sending a case back needs approve and a note", async () => {
    const { id } = await create();
    setStatus(id, "awaiting_signoff", { identity_check: { outcome: "pass", verified_by: OFFICER } });
    const calls = rpc();
    expect(await fails(transitionRequest(admin, officer(), id, { to: "officer_review", note: "x" }))).toMatchObject({ code: "forbidden" });
    expect(await fails(transitionRequest(admin, head(), id, { to: "officer_review" }))).toMatchObject({ code: "note_required" });
    await transitionRequest(admin, head(), id, { to: "officer_review", note: "Check the holder's name" });
    expect(calls).toHaveLength(1);
  });

  it("execution needs compliance.execute", async () => {
    const { id } = await create();
    setStatus(id, "approved");
    const calls = rpc();
    expect(await fails(transitionRequest(admin, head(), id, { to: "executing" }))).toMatchObject({ code: "forbidden" });
    await transitionRequest(admin, ops(), id, { to: "executing" });
    expect(calls[0]).toMatchObject({ p_to: "executing", p_actor: OPS });
  });

  it("maps what the database says to a code, and never passes its words on", async () => {
    const { id } = await create();
    setStatus(id, "executing");
    db.rpcHandlers.compliance_transition = () => ({ data: null, error: { message: "compliance_checklist_incomplete", code: "23514" } });
    const e = await fails(transitionRequest(admin, ops(), id, { to: "completed" }));
    expect(e).toMatchObject({ code: "checklist_incomplete", status: 409 });
    db.rpcHandlers.compliance_transition = () => ({ data: null, error: { message: "something about a table called secret_things", code: "XX000" } });
    const e2 = await fails(transitionRequest(admin, ops(), id, { to: "completed" }));
    expect(e2).toMatchObject({ code: "server_error", status: 500 });
    expect(e2!.message).not.toContain("secret_things");
  });

  it("cannot move a case of another workspace", async () => {
    const { id } = await create();
    rpc();
    expect(await fails(transitionRequest(admin, callerFor(OFFICER, ["compliance.review"], OTHER_ACCOUNT), id, { to: "identity_check" }))).toMatchObject({ code: "not_found" });
  });
});

describe("the checklist, the dues standing and the clock", () => {
  it("tick: needs compliance.execute, validates the step key, sends the actor and the note", async () => {
    const { id } = await create();
    const calls: any[] = [];
    db.rpcHandlers.compliance_tick_step = (a) => (calls.push(a), { data: {}, error: null });
    expect(await fails(tickStep(admin, officer(), id, "refund", true))).toMatchObject({ code: "forbidden" });
    expect(await fails(tickStep(admin, ops(), id, "Bad Key", true))).toMatchObject({ code: "invalid_request" });
    await tickStep(admin, ops(), id, "refund", true, " Paid ");
    expect(calls).toEqual([{ p_request: id, p_step: "refund", p_done: true, p_actor: OPS, p_note: "Paid" }]);
    db.rpcHandlers.compliance_tick_step = () => ({ data: null, error: { message: "compliance_not_ready_to_execute" } });
    expect(await fails(tickStep(admin, ops(), id, "refund", true))).toMatchObject({ code: "not_ready_to_execute" });
  });

  it("standing: a yes or no from a reviewer", async () => {
    const { id } = await create();
    const calls: any[] = [];
    db.rpcHandlers.compliance_set_standing = (a) => (calls.push(a), { data: {}, error: null });
    expect(await fails(setStanding(admin, ops(), id, true))).toMatchObject({ code: "forbidden" });
    expect(await fails(setStanding(admin, officer(), id, "yes" as any))).toMatchObject({ code: "invalid_request" });
    await setStanding(admin, officer(), id, true, "Two unpaid allowances");
    expect(calls[0]).toEqual({ p_request: id, p_actor: OFFICER, p_dues: true, p_notes: "Two unpaid allowances" });
  });

  it("clock: only the approve permission, with a note", async () => {
    const { id } = await create();
    const calls: any[] = [];
    db.rpcHandlers.compliance_clock = (a) => (calls.push(a), { data: {}, error: null });
    expect(await fails(clockAction(admin, officer(), id, "pause", "waiting"))).toMatchObject({ code: "forbidden" });
    expect(await fails(clockAction(admin, head(), id, "pause", "  "))).toMatchObject({ code: "note_required" });
    expect(await fails(clockAction(admin, head(), id, "stop" as any, "x"))).toMatchObject({ code: "invalid_request" });
    await clockAction(admin, head(), id, "pause", "Waiting for the parent's letter");
    expect(calls[0]).toEqual({ p_request: id, p_actor: HEAD, p_action: "pause", p_note: "Waiting for the parent's letter" });
    db.rpcHandlers.compliance_clock = () => ({ data: null, error: { message: "compliance_pause_not_allowed" } });
    expect(await fails(clockAction(admin, head(), id, "pause", "x"))).toMatchObject({ code: "pause_not_allowed" });
  });
});

describe("evidence files", () => {
  it("stores a PDF in the private bucket under the workspace's folder, records its hash, and refuses what is not a PDF, JPEG or PNG by its bytes", async () => {
    const { id } = await create();
    const f = await uploadFile(admin, officer(), id, { bytes: PDF, name: "../../Letter of Authority.pdf" }, "authorization_letter");
    expect(f).toMatchObject({ mime: "application/pdf", size: PDF.byteLength });
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    const row = db.rows("compliance_request_files")[0] as any;
    expect(row.path).toBe(`account-${ACCOUNT}/${id}/${f.id}-${f.name}`);
    expect(row.path).not.toContain("..");
    expect(row).toMatchObject({ field_key: "authorization_letter", uploaded_by: OFFICER, request_id: id });
    expect(db.files.has(row.path)).toBe(true);
    // a PNG is fine; a page of HTML with a .pdf name, an empty file and a field that is not a file field are not
    await expect(uploadFile(admin, officer(), id, { bytes: PNG, name: "scan.png" }, null)).resolves.toMatchObject({ mime: "image/png" });
    expect(await fails(uploadFile(admin, officer(), id, { bytes: HTML, name: "letter.pdf" }, null))).toMatchObject({ code: "unsupported_file" });
    expect(await fails(uploadFile(admin, officer(), id, { bytes: new Uint8Array(), name: "x.pdf" }, null))).toMatchObject({ code: "unsupported_file" });
    expect(await fails(uploadFile(admin, officer(), id, { bytes: PDF, name: "x.pdf" }, "bank_name"))).toMatchObject({ code: "invalid_request" });
    expect(db.rows("compliance_request_files")).toHaveLength(2);
  });

  it("enforces the size and count limits and the permission, and leaves no object behind when the row cannot be written", async () => {
    const { id } = await create();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    expect(await fails(uploadFile(admin, officer(), id, { bytes: big, name: "big.pdf" }, null))).toMatchObject({ code: "file_too_large", status: 413 });
    expect(await fails(uploadFile(admin, ops(), id, { bytes: PDF, name: "x.pdf" }, null))).toMatchObject({ code: "forbidden" });
    db.failNext.compliance_request_files = "boom";
    expect(await fails(uploadFile(admin, officer(), id, { bytes: PDF, name: "x.pdf" }, null))).toMatchObject({ code: "server_error" });
    expect(db.files.size).toBe(0);
    for (let i = 0; i < 15; i++) await uploadFile(admin, officer(), id, { bytes: PDF, name: `f${i}.pdf` }, null);
    expect(await fails(uploadFile(admin, officer(), id, { bytes: PDF, name: "one-too-many.pdf" }, null))).toMatchObject({ code: "too_many_files" });
    (db.rows("compliance_requests")[0] as any).status = "closed";
    expect(await fails(uploadFile(admin, officer(), id, { bytes: PDF, name: "late.pdf" }, null))).toMatchObject({ code: "closed" });
  });

  it("downloads the bytes after writing a 'view' event, and not from another workspace or another case", async () => {
    const { id } = await create();
    const other = await create({ customerName: "Another" });
    const f = await uploadFile(admin, officer(), id, { bytes: PDF, name: "letter.pdf" }, null);
    const got = await downloadFile(admin, head(), id, f.id);
    expect(got).toMatchObject({ name: "letter.pdf", mime: "application/pdf" });
    expect(Array.from(got.bytes)).toEqual(Array.from(PDF));
    expect(eventsOf(db, id).find((e: any) => e.kind === "view")).toMatchObject({ actor: HEAD, detail: { file: f.id, name: "letter.pdf" } });
    expect(await fails(downloadFile(admin, head(), other.id, f.id))).toMatchObject({ code: "not_found" });
    expect(await fails(downloadFile(admin, callerFor(HEAD, ["compliance.approve"], OTHER_ACCOUNT), id, f.id))).toMatchObject({ code: "not_found" });
    expect(await fails(downloadFile(admin, ops(), id, f.id))).toMatchObject({ code: "forbidden" });
    db.failNext.compliance_request_events = "disk full";
    // (failNext applies to writes: the view event is a write)
    expect(await fails(downloadFile(admin, head(), id, f.id))).toMatchObject({ code: "audit_failed" });
  });

  it("uses the bucket the migration creates", () => {
    expect(COMPLIANCE_BUCKET).toBe("compliance-files");
  });
});

describe("request type settings", () => {
  it("need compliance.manage; edit labels, clocks (for new cases), the checklist and switches", async () => {
    const mgr = callerFor(HEAD, ["compliance.manage"]);
    expect(await fails(updateType(admin, officer(), "closure", { targetDays: 10 }))).toMatchObject({ code: "forbidden" });
    const t = await updateType(admin, mgr, "closure", { label: "Closing an account", labelL10n: { ms: "Menutup akaun", zh: "" }, targetDays: 10, hardStopDays: 25, allowPause: true, checklist: [{ key: "one", label: { en: "One" } }] });
    expect(t).toMatchObject({ label: "Closing an account", targetDays: 10, hardStopDays: 25, allowPause: true, labelL10n: { ms: "Menutup akaun" } });
    expect(t.checklist.map((c) => c.key)).toEqual(["one"]);
    const row = db.rows("compliance_request_types").find((r: any) => r.key === "closure") as any;
    expect(row).toMatchObject({ target_days: 10, hard_stop_days: 25, allow_pause: true });
  });

  it("refuses a hard stop before the target, whole days only, a bad checklist, and any change to a system type's fields", async () => {
    const mgr = callerFor(HEAD, ["compliance.manage"]);
    expect(await fails(updateType(admin, mgr, "closure", { hardStopDays: 5 }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(updateType(admin, mgr, "closure", { targetDays: 2.5 }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(updateType(admin, mgr, "closure", { targetDays: 0 }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(updateType(admin, mgr, "closure", { checklist: [{ key: "Bad Key", label: { en: "x" } }] }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(updateType(admin, mgr, "closure", { fields: [] }))).toMatchObject({ code: "invalid_request" });
    expect(await fails(updateType(admin, mgr, "nothing", { label: "x" }))).toMatchObject({ code: "not_found" });
    // clocks can be cleared
    const cleared = await updateType(admin, mgr, "closure", { targetDays: null, hardStopDays: null });
    expect(cleared).toMatchObject({ targetDays: null, hardStopDays: null });
  });

  it("adds a custom type with its fields validated", async () => {
    const mgr = callerFor(HEAD, ["compliance.manage"]);
    const t = await createType(admin, mgr, {
      key: "address_change",
      label: "Address change",
      fields: [{ key: "new_address", type: "multiline", required: true, sensitive: true, label: { en: "New address" } }],
      targetDays: 7,
    });
    expect(t).toMatchObject({ key: "address_change", isSystem: false, targetDays: 7 });
    expect(await fails(createType(admin, mgr, { key: "address_change", label: "Again", fields: [] }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(createType(admin, mgr, { key: "Bad", label: "x", fields: [] }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(createType(admin, mgr, { key: "needs_label", label: "x", fields: [{ key: "k", type: "file", sensitive: true, label: { en: "K" } }] }))).toMatchObject({ code: "validation_failed" });
    expect(await fails(createType(admin, officer(), { key: "sneaky", label: "x", fields: [] }))).toMatchObject({ code: "forbidden" });
  });
});

describe("the clock sweep job", () => {
  it("calls the database function once and reports its counts", async () => {
    const calls: any[] = [];
    db.rpcHandlers.compliance_clock_alert_sweep = (a) => (calls.push(a), { data: { alerted: 2, notified: 5 }, error: null });
    const r = await runClockSweep(admin, new Date("2026-10-12T10:00:00Z"));
    expect(r).toEqual({ alerted: 2, notified: 5 });
    expect(calls).toEqual([{ p_now: "2026-10-12T10:00:00.000Z" }]);
    db.rpcHandlers.compliance_clock_alert_sweep = () => ({ data: null, error: { message: "boom" } });
    await expect(runClockSweep(admin)).rejects.toThrow("compliance clock sweep failed");
  });
});
