import { describe, expect, it } from "vitest";

import type { SignDocumentRow } from "../types";
import { optionsFromDocument, optionsPatch } from "./draft-options";
import { EMPTY_FILTERS, GROUP_STATUSES, STATUS_GROUPS } from "./list-filters";
import { DOCUMENT_COLUMN, linksAfterContactChange, linksAfterRecord, newDocumentHref, recordSearchClause, safeSearch, ticketLabel, type RecordOption } from "./record-links";

describe("naming and searching records", () => {
  it("names a ticket by its number and subject", () => {
    expect(ticketLabel(12, "  Printer jammed ")).toBe("#12 Printer jammed");
    expect(ticketLabel("7", "")).toBe("#7");
  });

  it("makes a typed search safe for a filter list", () => {
    expect(safeSearch(' a,b(c)"d*e%f\\g ')).toBe("a b c d e f g");
    expect(safeSearch("x".repeat(200))).toHaveLength(80);
  });

  it("finds a ticket by subject, and by number when a number (or #number) is typed; a deal by its title", () => {
    expect(recordSearchClause("ticket", "printer")).toBe("subject.ilike.%printer%");
    expect(recordSearchClause("ticket", "12")).toBe("ticket_number.eq.12,subject.ilike.%12%");
    expect(recordSearchClause("ticket", "#12")).toBe("ticket_number.eq.12,subject.ilike.%#12%");
    expect(recordSearchClause("ticket", "12 printers")).toBe("subject.ilike.%12 printers%");
    expect(recordSearchClause("deal", "renewal")).toBe("title.ilike.%renewal%");
    expect(recordSearchClause("deal", "  ")).toBeNull();
    // nothing typed can add a condition of its own
    expect(recordSearchClause("ticket", "a),id.neq.0,(b")).toBe("subject.ilike.%a id.neq.0 b%");
  });

  it("knows which column holds each kind of record", () => {
    expect(DOCUMENT_COLUMN).toEqual({ contact: "contact_id", ticket: "ticket_id", deal: "deal_id" });
  });
});

describe("the links of a draft as the sender changes them", () => {
  const none = { contactId: null, ticketId: null, dealId: null };
  const ticket: RecordOption = { id: "t1", label: "#1 A", sub: "open", contactId: "ali" };

  it("drops the ticket and the deal when the contact changes, and keeps everything when it does not", () => {
    const prev = { contactId: "ali", ticketId: "t1", dealId: "d1" };
    expect(linksAfterContactChange(prev, "bala")).toEqual({ contactId: "bala", ticketId: null, dealId: null });
    expect(linksAfterContactChange(prev, null)).toEqual({ contactId: null, ticketId: null, dealId: null });
    expect(linksAfterContactChange(prev, "ali")).toBe(prev);
  });

  it("takes the record's contact when the document has none, and never replaces one it has", () => {
    expect(linksAfterRecord(none, "ticket", ticket)).toEqual({ contactId: "ali", ticketId: "t1", dealId: null });
    expect(linksAfterRecord({ ...none, contactId: "ali" }, "deal", { ...ticket, id: "d9" })).toEqual({ contactId: "ali", ticketId: null, dealId: "d9" });
    expect(linksAfterRecord({ contactId: "ali", ticketId: "t1", dealId: null }, "ticket", null)).toEqual({ contactId: "ali", ticketId: null, dealId: null });
    expect(linksAfterRecord(none, "deal", { id: "d", label: "D", sub: "", contactId: null })).toEqual({ contactId: null, ticketId: null, dealId: "d" });
  });
});

describe("the address of 'send a document'", () => {
  it("carries only what is given, as query parameters", () => {
    expect(newDocumentHref({})).toBe("/sign/new");
    expect(newDocumentHref({ contactId: "c 1" })).toBe("/sign/new?contactId=c+1");
    expect(newDocumentHref({ contactId: "c", ticketId: "t", dealId: "d", templateId: "x" })).toBe("/sign/new?contactId=c&ticketId=t&dealId=d&templateId=x");
    expect(newDocumentHref({ ticketId: "t", contactId: null })).toBe("/sign/new?ticketId=t");
  });
});

describe("the Test group of the documents list", () => {
  it("is every status, only the tests, and is not the default", () => {
    expect(STATUS_GROUPS).toContain("test");
    expect(GROUP_STATUSES.test).toBeNull();
    expect(EMPTY_FILTERS.group).toBe("all");
  });
});

describe("the ticket and deal in a draft's options", () => {
  const NOW = new Date(2026, 9, 6, 10, 0, 0);
  const doc = { title: "A", category_id: null, contact_id: "ali", ticket_id: "t1", deal_id: null, locale: "en", message: null, expires_at: null, reminder_days: [3, 7], code_required: false, sign_in_order: false } as unknown as SignDocumentRow;
  const base = optionsFromDocument(doc);

  it("reads them from the document and saves only what changed", () => {
    expect(base).toMatchObject({ contactId: "ali", ticketId: "t1", dealId: null });
    expect(optionsPatch(base, base, NOW)).toEqual({});
    expect(optionsPatch(base, { ...base, dealId: "d1" }, NOW)).toEqual({ dealId: "d1" });
    expect(optionsPatch(base, { ...base, ticketId: null }, NOW)).toEqual({ ticketId: null });
    // a change of contact that also detaches the ticket is one patch the server accepts
    expect(optionsPatch(base, { ...base, contactId: "bala", ticketId: null }, NOW)).toEqual({ contactId: "bala", ticketId: null });
  });

  it("treats a document that knows nothing of them (an older row) as having none", () => {
    const old = optionsFromDocument({ ...doc, ticket_id: undefined, deal_id: undefined } as unknown as SignDocumentRow);
    expect(old).toMatchObject({ ticketId: null, dealId: null });
    expect(optionsPatch(old, { ...old, ticketId: undefined, dealId: undefined }, NOW)).toEqual({});
  });
});
