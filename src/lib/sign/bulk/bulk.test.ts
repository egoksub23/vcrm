import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/csv";

import type { PlacedField } from "../pdf/types";
import type { SignRole } from "../types";
import { checkRows, isPersonKey, parseBulkCsv, rawRowFromContact, rowIsClean } from "./parse";
import { buildSigners, expiryIso, keysNeedingColumns, parseOptions, planProblems, roleInfos, titleFor } from "./plan";
import { decodeProblem, encodeProblem, problemText, resultFileName, resultHeaderLine, resultLines } from "./results";
import { BULK_MAX_BYTES, BULK_MAX_ROWS, type BulkOptions } from "./types";

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "biz", type: "static_text", role: "sender", merge: "business_name", page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.04, required: false },
  { key: "fee", type: "static_text", role: "sender", merge: "fee", page: 0, x: 0.1, y: 0.15, w: 0.5, h: 0.04, required: false },
  { key: "msig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: "dsig", type: "signature", role: "director", page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

const options = (over: Partial<BulkOptions> = {}): BulkOptions => ({
  templateId: TEMPLATE_ID,
  personRole: "merchant",
  fixedSigners: [{ roleKey: "director", fullName: "Gokula", email: "gokula@vircle.example", channel: "email" }],
  channel: "email",
  title: null,
  categoryId: null,
  message: null,
  locale: null,
  expiryDays: null,
  codeRequired: null,
  signInOrder: null,
  reminderDays: null,
  ...over,
});

const KEYS = ["business_name", "fee"];
const csv = (...lines: string[]) => lines.join("\r\n") + "\r\n";

describe("parseBulkCsv", () => {
  it("reads a header and rows, with the template's values as columns", () => {
    const f = parseBulkCsv(csv("full_name,email,phone,business_name,fee", "Ali bin Ahmad,ali@kedai.example,+60 12-345 6789,Kedai Runcit Ali,RM 1.00", "Siti,siti@kedai.example,,Kedai Siti,RM 1.20"), KEYS);
    expect(f.problems).toEqual([]);
    expect(f.rows).toHaveLength(2);
    expect(f.rows[0]).toEqual({ rowNo: 1, cells: { full_name: "Ali bin Ahmad", email: "ali@kedai.example", phone: "+60 12-345 6789", business_name: "Kedai Runcit Ali", fee: "RM 1.00" } });
    expect(f.rows[1].rowNo).toBe(2);
  });

  it("accepts a UTF-8 byte order mark, LF line ends, and names that are not Latin", () => {
    const f = parseBulkCsv("﻿full_name,email\n김민수,minsu@example.com\n陈大文,dawen@example.com\n", []);
    expect(f.problems).toEqual([]);
    expect(f.rows.map((r) => r.cells.full_name)).toEqual(["김민수", "陈大文"]);
  });

  it("holds quoted cells with commas, quotes and line breaks", () => {
    const f = parseBulkCsv(csv('full_name,email,business_name', '"Tan, Ah Kow",ahkow@example.com,"Kedai ""Maju""\r\nJaya"'), KEYS);
    expect(f.rows[0].cells.full_name).toBe("Tan, Ah Kow");
    expect(f.rows[0].cells.business_name).toBe('Kedai "Maju" Jaya');
  });

  it("answers to the contacts export's columns and to common spellings of a header", () => {
    const f = parseBulkCsv(csv("Phone,Name,E-mail,company,tags,created_at", "+60123456789,Ali,ali@example.com,Kedai,vip,2026-01-01"), []);
    expect(f.problems).toEqual([]);
    expect(f.rows[0].cells).toEqual({ phone: "+60123456789", full_name: "Ali", email: "ali@example.com" });
    expect(f.ignoredColumns).toEqual(["company", "tags", "created_at"]);
  });

  it("matches a merge column whatever its case, and keeps the template's own spelling of the key", () => {
    const f = parseBulkCsv(csv("full_name,email,Business Name", "Ali,ali@example.com,Kedai"), KEYS);
    expect(f.rows[0].cells.business_name).toBe("Kedai");
  });

  it("reads back a cell the contacts export guarded against formulas", () => {
    const f = parseBulkCsv(csv("full_name,email,phone", "Ali,ali@example.com,'+60123456789"), []);
    expect(f.rows[0].cells.phone).toBe("+60123456789");
  });

  it("reports an empty file, a header without rows, and no header at all", () => {
    expect(parseBulkCsv("", []).problems).toEqual([{ code: "empty_file" }]);
    expect(parseBulkCsv("\r\n\r\n", []).problems).toEqual([{ code: "empty_file" }]);
    expect(parseBulkCsv(csv("full_name,email"), []).problems).toEqual([{ code: "no_rows" }]);
    expect(parseBulkCsv(csv(",,", "a,b,c"), []).problems).toEqual([{ code: "no_header" }]);
  });

  it("requires the name and email columns", () => {
    expect(parseBulkCsv(csv("email,phone", "a@example.com,1"), []).problems).toEqual([{ code: "missing_column", detail: "full_name" }]);
    expect(parseBulkCsv(csv("full_name", "Ali"), []).problems).toEqual([{ code: "missing_column", detail: "email" }]);
  });

  it("reports a column given twice and uses the first", () => {
    const f = parseBulkCsv(csv("full_name,name,email", "Ali,Ahmad,a@example.com"), []);
    expect(f.problems).toEqual([{ code: "duplicate_column", detail: "name" }]);
    expect(f.rows[0].cells.full_name).toBe("Ali");
  });

  it("ignores blank lines and rows with only empty cells, and counts people from 1", () => {
    const f = parseBulkCsv(csv("full_name,email", "", "Ali,ali@example.com", ",", "Siti,siti@example.com"), []);
    expect(f.rows.map((r) => [r.rowNo, r.cells.full_name])).toEqual([[1, "Ali"], [2, "Siti"]]);
  });

  it("keeps the first 500 people and says there were more", () => {
    const lines = ["full_name,email", ...Array.from({ length: BULK_MAX_ROWS + 20 }, (_, i) => `P${i},p${i}@example.com`)];
    const f = parseBulkCsv(csv(...lines), []);
    expect(f.rows).toHaveLength(BULK_MAX_ROWS);
    expect(f.problems).toEqual([{ code: "too_many_rows", detail: String(BULK_MAX_ROWS + 20) }]);
  });

  it("refuses a file over 1 MB (measured in bytes, not characters)", () => {
    const big = "full_name,email\r\n" + "é".repeat(BULK_MAX_BYTES / 2 + 10) + ",a@example.com\r\n";
    expect(big.length).toBeLessThan(BULK_MAX_BYTES);
    const f = parseBulkCsv(big, []);
    expect(f.rows).toEqual([]);
    expect(f.problems).toEqual([{ code: "too_large", detail: String(BULK_MAX_BYTES) }]);
  });

  it("strips control characters and turns line breaks inside a cell into spaces", () => {
    const f = parseBulkCsv(`full_name,email\r\n"Ali\u0000 bin\r\nAhmad",ali@example.com\r\n`, []);
    expect(f.rows[0].cells.full_name).toBe("Ali bin Ahmad");
  });
});

describe("checkRows", () => {
  const check = (lines: string[], over: Partial<Parameters<typeof checkRows>[1]> = {}) => {
    const f = parseBulkCsv(csv("full_name,email,phone,business_name,fee", ...lines), KEYS);
    return checkRows(f.rows, { mergeKeys: KEYS, channel: "email", ...over });
  };

  it("passes a complete row and carries its values", () => {
    const [r] = check(["Ali,ali@kedai.example,+60 12-345 6789,Kedai Ali,RM 1"]);
    expect(r.problems).toEqual([]);
    expect(rowIsClean(r)).toBe(true);
    expect(r).toMatchObject({ rowNo: 1, name: "Ali", email: "ali@kedai.example", phone: "+60123456789", merge: { business_name: "Kedai Ali", fee: "RM 1" }, contactId: null });
  });

  it("finds a missing name, a missing or bad email, and a name that is too long", () => {
    const rows = check([",ali@example.com,,K,1", "Siti,,,K,1", "Lim,not-an-email,,K,1", `${"x".repeat(161)},long@example.com,,K,1`]);
    expect(rows[0].problems).toEqual([{ code: "name_missing" }]);
    expect(rows[1].problems).toEqual([{ code: "email_missing" }]);
    expect(rows[2].problems).toEqual([{ code: "email_invalid" }]);
    expect(rows[3].problems).toEqual([{ code: "name_too_long" }]);
  });

  it("flags an address that was already used earlier in the file, ignoring case, and not the first use", () => {
    const rows = check(["Ali,Ali@Example.com,,K,1", "Ali Again,ali@example.com,,K,1", "Siti,siti@example.com,,K,1", "Ali Third,ALI@example.com,,K,1"]);
    expect(rows.map((r) => r.problems)).toEqual([[], [{ code: "email_duplicate", detail: "1" }], [], [{ code: "email_duplicate", detail: "1" }]]);
  });

  it("needs every value the template fills in, and says which", () => {
    const [r] = check(["Ali,ali@example.com,,,"]);
    expect(r.problems).toEqual([{ code: "merge_missing", detail: "business_name" }, { code: "merge_missing", detail: "fee" }]);
  });

  it("fills a value from the person when the template asks for their name, email or phone", () => {
    const f = parseBulkCsv(csv("full_name,email,phone", "Ali,ali@example.com,+60123456789"), ["full_name", "email", "phone", "Name"]);
    const [r] = checkRows(f.rows, { mergeKeys: ["full_name", "email", "phone", "Name"], channel: "email" });
    expect(r.problems).toEqual([]);
    expect(r.merge).toEqual({ full_name: "Ali", email: "ali@example.com", phone: "+60123456789", Name: "Ali" });
    expect(isPersonKey("email")).toBe(true);
    expect(isPersonKey("business_name")).toBe(false);
    expect(keysNeedingColumns(["email", "business_name"])).toEqual(["business_name"]);
  });

  it("refuses a value longer than a document takes", () => {
    const [r] = check([`Ali,ali@example.com,,${"x".repeat(2001)},1`]);
    expect(r.problems).toEqual([{ code: "merge_too_long", detail: "business_name" }]);
  });

  it("needs a phone number with a country code only when the person is reached by WhatsApp", () => {
    expect(check(["Ali,ali@example.com,0123456789,K,1"])[0].problems).toEqual([]);
    expect(check(["Ali,ali@example.com,0123456789,K,1"])[0].phone).toBe("0123456789");
    expect(check(["Ali,ali@example.com,0123456789,K,1"], { channel: "whatsapp" })[0].problems).toEqual([{ code: "phone_invalid" }]);
    expect(check(["Ali,ali@example.com,+60123456789,K,1"], { channel: "whatsapp" })[0]).toMatchObject({ problems: [], phone: "+60123456789" });
  });

  it("catches the same person on two roles when signing order is on", () => {
    const rows = check(["Gokula,GOKULA@vircle.example,,K,1"], { fixedEmails: ["gokula@vircle.example"], signInOrder: true });
    expect(rows[0].problems).toEqual([{ code: "same_person_twice" }]);
    expect(check(["Gokula,gokula@vircle.example,,K,1"], { fixedEmails: ["gokula@vircle.example"], signInOrder: false })[0].problems).toEqual([]);
  });

  it("checks a contact id is an id", () => {
    const f = parseBulkCsv(csv("full_name,email,contact_id", "Ali,ali@example.com,nope", "Siti,siti@example.com,22222222-2222-4222-8222-222222222222"), []);
    const rows = checkRows(f.rows, { mergeKeys: [], channel: "email" });
    expect(rows[0].problems).toEqual([{ code: "contact_invalid" }]);
    expect(rows[1]).toMatchObject({ problems: [], contactId: "22222222-2222-4222-8222-222222222222" });
  });

  it("builds a row from a contact", () => {
    const row = rawRowFromContact(3, { id: "c1", name: " Ali ", email: "ali@example.com", phone: null });
    expect(row).toEqual({ rowNo: 3, cells: { full_name: "Ali", email: "ali@example.com", phone: "", contact_id: "c1" } });
  });
});

describe("planProblems", () => {
  const plan = (o: BulkOptions, over: Partial<Parameters<typeof planProblems>[0]> = {}) => planProblems({ roles, fields, form: null, pageCount: 1, options: o, signInOrder: false, ...over });

  it("accepts a template whose other role has a fixed person", () => {
    expect(plan(options())).toEqual([]);
  });

  it("needs a person for every role that has something to complete", () => {
    expect(plan(options({ fixedSigners: [] }))).toEqual([{ code: "role_without_person", detail: "director" }]);
  });

  it("refuses a person role the template does not have, and fixed people for the wrong roles", () => {
    expect(plan(options({ personRole: "ghost" }))).toEqual([{ code: "bad_person_role" }]);
    const dup = options({ fixedSigners: [{ roleKey: "director", fullName: "A", email: "a@example.com", channel: "email" }, { roleKey: "director", fullName: "B", email: "b@example.com", channel: "email" }] });
    expect(plan(dup)).toEqual([{ code: "bad_fixed_signer", detail: "director" }]);
    expect(plan(options({ fixedSigners: [{ roleKey: "merchant", fullName: "A", email: "a@example.com", channel: "email" }] }))).toEqual([{ code: "bad_fixed_signer", detail: "merchant" }]);
  });

  it("checks the fixed people's details", () => {
    const bad = options({ fixedSigners: [{ roleKey: "director", fullName: " ", email: "nope", channel: "whatsapp", phone: "123" }] });
    expect(plan(bad).map((p) => p.code).sort()).toEqual(["fixed_signer_email", "fixed_signer_name", "fixed_signer_phone"]);
  });

  it("finds a template that could not be sent whoever is on the list", () => {
    const noSig = fields.filter((f) => f.key !== "dsig");
    expect(plan(options(), { fields: noSig }).map((p) => p.code)).toContain("signer_without_signature");
    const outside = fields.map((f) => (f.key === "biz" ? { ...f, page: 4 } : f));
    expect(plan(options(), { fields: outside })).toContainEqual({ code: "template_not_ready", detail: "page_out_of_range" });
  });

  it("describes the roles, and which need a person", () => {
    expect(roleInfos(roles, fields)).toEqual([
      { key: "merchant", label: "Merchant", kind: "signer", needsPerson: true },
      { key: "director", label: "Director", kind: "signer", needsPerson: true },
    ]);
  });
});

describe("buildSigners", () => {
  it("puts the person of the list on their role and the fixed person on theirs, in the template's order", () => {
    const s = buildSigners({ name: "Ali", email: "ali@example.com", phone: null }, options(), roles);
    expect(s).toEqual([
      { roleKey: "merchant", kind: "signer", fullName: "Ali", email: "ali@example.com", phone: null, channel: "email", orderNo: 1, internalUserId: null },
      { roleKey: "director", kind: "signer", fullName: "Gokula", email: "gokula@vircle.example", phone: null, channel: "email", orderNo: 2, internalUserId: null },
    ]);
  });

  it("gives the order of the template's roles whichever role the list fills", () => {
    const o = options({ personRole: "director", fixedSigners: [{ roleKey: "merchant", fullName: "Fixed", email: "f@example.com", channel: "email" }] });
    expect(buildSigners({ name: "Ali", email: "ali@example.com", phone: null }, o, roles).map((s) => [s.roleKey, s.orderNo])).toEqual([["merchant", 1], ["director", 2]]);
  });

  it("normalises the number of a fixed person reached by WhatsApp", () => {
    const o = options({ fixedSigners: [{ roleKey: "director", fullName: "G", email: "g@example.com", channel: "whatsapp", phone: "+60 12-345 6789" }] });
    expect(buildSigners({ name: "Ali", email: "ali@example.com", phone: null }, o, roles)[1].phone).toBe("+60123456789");
  });
});

describe("titles and dates", () => {
  it("names each document after the template and the person, or by the sender's pattern", () => {
    expect(titleFor(null, "Merchant Agreement", "Ali")).toBe("Merchant Agreement - Ali");
    expect(titleFor("Agreement for {name} (2026)", "Merchant Agreement", "Ali")).toBe("Agreement for Ali (2026)");
    expect(titleFor("Same for all", "Merchant Agreement", "Ali")).toBe("Same for all");
    expect(titleFor(null, "T", "x".repeat(300))).toHaveLength(200);
  });

  it("counts the expiry from the moment of sending", () => {
    expect(expiryIso(new Date("2026-10-06T08:00:00Z"), 14)).toBe("2026-10-20T08:00:00.000Z");
  });
});

describe("parseOptions", () => {
  const valid = { templateId: TEMPLATE_ID, personRole: "merchant", channel: "email", fixedSigners: [{ roleKey: "director", fullName: "G", email: "g@example.com", channel: "email" }] };

  it("reads a complete set, with every default left to the template", () => {
    const { options: o, problems } = parseOptions(valid);
    expect(problems).toEqual([]);
    expect(o).toMatchObject({ templateId: TEMPLATE_ID, personRole: "merchant", channel: "email", title: null, message: null, locale: null, expiryDays: null, codeRequired: null, signInOrder: null, reminderDays: null, categoryId: null });
  });

  it("reads the sender's choices and cleans them", () => {
    const { options: o } = parseOptions({ ...valid, title: " For {name} ", message: " Please sign. ", locale: "ms", expiryDays: 30, codeRequired: true, signInOrder: false, reminderDays: [9, 2, 2, 99], categoryId: "22222222-2222-4222-8222-222222222222" });
    expect(o).toMatchObject({ title: "For {name}", message: "Please sign.", locale: "ms", expiryDays: 30, codeRequired: true, signInOrder: false, reminderDays: [2, 9], categoryId: "22222222-2222-4222-8222-222222222222" });
  });

  it("names each thing that is wrong", () => {
    const { options: o, problems } = parseOptions({ templateId: "x", personRole: "bad role!", channel: "sms", locale: "fr", expiryDays: 0, codeRequired: "yes", message: "m".repeat(2001), fixedSigners: "nope" });
    expect(o).toBeNull();
    expect(problems.map((p) => p.detail).sort()).toEqual(["channel", "codeRequired", "expiryDays", "fixedSigners", "locale", "message", "personRole", "templateId"]);
    expect(parseOptions(null).options).toBeNull();
    expect(parseOptions([]).options).toBeNull();
  });

  it("refuses more than five fixed people", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ roleKey: `r${i}`, fullName: "A", email: "a@example.com", channel: "email" }));
    expect(parseOptions({ ...valid, fixedSigners: many }).problems).toEqual([{ code: "bad_options", detail: "fixedSigners" }]);
  });
});

describe("the result file", () => {
  it("has a header and one line per person, with the reference and the reason", () => {
    const text = resultHeaderLine() + resultLines([
      { rowNo: 1, name: "Ali", email: "ali@example.com", phone: "+60123456789", state: "sent", reference: "SGN-2026-000001", documentId: "d1", errorCode: null, errorMessage: null },
      { rowNo: 2, name: "Siti", email: "siti@example.com", phone: null, state: "failed", reference: null, documentId: null, errorCode: "sign_limit_reached", errorMessage: "This workspace has reached its monthly limit, ask support." },
    ]);
    const table = parseCsv(text);
    expect(table[0]).toEqual(["row", "name", "email", "phone", "result", "reference", "document_id", "error_code", "error_message"]);
    expect(table[1]).toEqual(["1", "Ali", "ali@example.com", "'+60123456789", "sent", "SGN-2026-000001", "d1", "", ""]);
    expect(table[2].slice(4)).toEqual(["failed", "", "", "sign_limit_reached", "This workspace has reached its monthly limit, ask support."]);
  });

  it("guards a cell a spreadsheet would run as a formula", () => {
    const text = resultLines([{ rowNo: 1, name: "=HYPERLINK(\"http://evil.example\")", email: "+cmd@example.com", phone: null, state: "skipped", reference: null, documentId: null, errorCode: "x", errorMessage: "@SUM(1)" }]);
    const [row] = parseCsv(text);
    expect(row[1]).toBe(`'=HYPERLINK("http://evil.example")`);
    expect(row[2]).toBe("'+cmd@example.com");
    expect(row[8]).toBe("'@SUM(1)");
  });

  it("names the file after the template and the day", () => {
    expect(resultFileName("Merchant Agreement (Kedai)", "2026-10-06T08:00:00Z")).toBe("bulk-send-Merchant-Agreement-Kedai-2026-10-06.csv");
    expect(resultFileName("商家协议", "2026-10-06T08:00:00Z")).toBe("bulk-send-documents-2026-10-06.csv");
  });

  it("stores a problem in a row and reads it back, with its detail", () => {
    expect(encodeProblem({ code: "merge_missing", detail: "fee" })).toBe("merge_missing:fee");
    expect(decodeProblem("merge_missing:fee")).toEqual({ code: "merge_missing", detail: "fee" });
    expect(decodeProblem("sign_limit_reached")).toEqual({ code: "sign_limit_reached" });
    expect(decodeProblem(null)).toBeNull();
    expect(problemText("email_duplicate", "4")).toContain("row 4");
  });
});
