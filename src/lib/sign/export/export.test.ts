import { unzipSync, strFromU8 } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/csv";

import type { NotifyDeps } from "../notify";
import type { SignCtx } from "../service/context";
import { FakeDb } from "../service/fake-db";
import { documentsCsvStream, planZip, zipStream } from "../service/export";
import {
  EXPORT_HEADER,
  applyExportFilters,
  createdRange,
  exportFileName,
  exportHeaderLine,
  exportLines,
  exportQuery,
  nextDay,
  parseExportFilters,
  startOfDayIso,
  type ExportDocRow,
  type ExportFilters,
} from "./documents";
import { ZIP_MAX_BYTES, ZIP_MAX_DOCUMENTS, ZIP_SKIPPED_NOTE, classifyForZip, cleanIds, skippedNote, zipEntryName, zipFileName } from "./zip";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CAT = "33333333-3333-4333-8333-333333333333";
const CONTACT = "44444444-4444-4444-8444-444444444444";

const none: ExportFilters = { group: "all", category: "all", search: "", from: null, to: null, contactId: null };
const isId = (v: string) => /^[0-9a-f-]{36}$/.test(v);

describe("the export's filters", () => {
  it("reads the list's own filters and the date range from the query string", () => {
    const f = parseExportFilters(new URLSearchParams(`status=completed&category=${CAT}&q=Kedai%20Runcit&from=2026-10-01&to=2026-10-31&contact=${CONTACT}`));
    expect(f).toEqual({ group: "completed", category: CAT, search: "Kedai Runcit", from: "2026-10-01", to: "2026-10-31", contactId: CONTACT });
  });

  it("leaves out anything it does not understand rather than guessing", () => {
    const f = parseExportFilters(new URLSearchParams("status=everything&category=drop%20table&q=a%2C(b)%25&from=2026-02-31&to=yesterday&contact=nope"));
    expect(f).toEqual({ group: "all", category: "all", search: "a b", from: null, to: null, contactId: null });
    expect(parseExportFilters(new URLSearchParams("category=none")).category).toBe("none");
    expect(parseExportFilters(new URLSearchParams()).group).toBe("all");
  });

  it("makes the query string the list's Export button sends, leaving defaults out", () => {
    expect(exportQuery({})).toBe("");
    expect(exportQuery({ group: "all", category: "all", search: "  " })).toBe("");
    const q = exportQuery({ group: "waiting", category: "none", search: "ali, bin", from: "2026-10-01", contactId: CONTACT });
    expect(parseExportFilters(new URLSearchParams(q))).toEqual({ group: "waiting", category: "none", search: "ali bin", from: "2026-10-01", to: null, contactId: CONTACT });
  });

  it("starts a day where the workspace's day starts", () => {
    expect(startOfDayIso("2026-10-06", "Asia/Kuala_Lumpur")).toBe("2026-10-05T16:00:00.000Z");
    expect(startOfDayIso("2026-10-06", "UTC")).toBe("2026-10-06T00:00:00.000Z");
    // clocks change on 8 March 2026 in New York: midnight is still UTC-5 on the 8th, UTC-4 on the 9th
    expect(startOfDayIso("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(startOfDayIso("2026-03-09", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    expect(startOfDayIso("2026-10-06", "Not/AZone")).toBe("2026-10-06T00:00:00.000Z");
    expect(startOfDayIso("2026-13-40", "UTC")).toBeNull();
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("covers the whole of the last day of a range", () => {
    expect(createdRange({ from: "2026-10-01", to: "2026-10-31" }, "Asia/Kuala_Lumpur")).toEqual({ gte: "2026-09-30T16:00:00.000Z", lt: "2026-10-31T16:00:00.000Z" });
    expect(createdRange({ from: null, to: null }, "UTC")).toEqual({ gte: null, lt: null });
  });

  it("asks the database for exactly the filters given", () => {
    const calls: string[] = [];
    const builder: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["in", "is", "eq", "or", "gte", "lt"]) builder[m] = (...a) => (calls.push(`${m}(${a.map((x) => JSON.stringify(x)).join(",")})`), builder);
    applyExportFilters(builder, { group: "stopped", category: "none", search: "x", from: "2026-10-01", to: "2026-10-02", contactId: CONTACT }, "title.ilike.%x%", { gte: "A", lt: "B" });
    expect(calls).toEqual([
      'in("status",["declined","expired","voided","failed"])',
      'is("category_id",null)',
      `eq("contact_id","${CONTACT}")`,
      'gte("created_at","A")',
      'lt("created_at","B")',
      'or("title.ilike.%x%")',
    ]);
    calls.length = 0;
    applyExportFilters(builder, { ...none, category: CAT }, null, { gte: null, lt: null });
    expect(calls).toEqual([`eq("category_id","${CAT}")`]);
  });
});

describe("the export's lines", () => {
  const doc = (over: Partial<ExportDocRow> = {}): ExportDocRow => ({
    reference: "SGN-2026-000001",
    title: "Merchant Agreement - Ali",
    status: "completed",
    category_id: CAT,
    created_at: "2026-10-01T08:00:00+00:00",
    sent_at: "2026-10-01T08:05:00.123+00:00",
    completed_at: "2026-10-02T09:00:00+00:00",
    expires_at: "2026-10-15T08:05:00+00:00",
    contacts: { name: "Kedai Runcit Ali" },
    sign_signers: [
      { full_name: "Gokula", order_no: 2 },
      { full_name: "Ali bin Ahmad", order_no: 1 },
    ],
    ...over,
  });
  const names = new Map([[CAT, "Merchant agreements"]]);

  it("has the columns the owner asked for, in order", () => {
    expect([...EXPORT_HEADER]).toEqual(["reference", "title", "category", "status", "contact", "signers", "created", "sent", "completed", "expires", "mode", "cancelled", "cancelled_at"]);
    expect(parseCsv(exportHeaderLine())[0]).toEqual([...EXPORT_HEADER]);
  });

  it("writes a document as one line: names joined in signing order, dates as ISO times", () => {
    const [row] = parseCsv(exportLines([doc()], names));
    expect(row).toEqual(["SGN-2026-000001", "Merchant Agreement - Ali", "Merchant agreements", "completed", "Kedai Runcit Ali", "Ali bin Ahmad; Gokula", "2026-10-01T08:00:00.000Z", "2026-10-01T08:05:00.123Z", "2026-10-02T09:00:00.000Z", "2026-10-15T08:05:00.000Z", "sign", "no", ""]);
  });

  it("marks a form without a signature as a form, and anything else as an agreement", () => {
    expect(parseCsv(exportLines([doc({ mode: "form" })], names))[0][10]).toBe("form");
    expect(parseCsv(exportLines([doc({ mode: "sign" })], names))[0][10]).toBe("sign");
    expect(parseCsv(exportLines([doc({ mode: null })], names))[0][10]).toBe("sign");
  });

  it("leaves the cells of a draft empty", () => {
    const [row] = parseCsv(exportLines([doc({ reference: null, status: "draft", category_id: null, sent_at: null, completed_at: null, expires_at: null, contacts: null, sign_signers: null })], names));
    expect(row.slice(0, 2)).toEqual(["", "Merchant Agreement - Ali"]);
    expect(row.slice(2)).toEqual(["", "draft", "", "", "2026-10-01T08:00:00.000Z", "", "", "", "sign", "no", ""]);
  });

  it("says a completed document was cancelled afterwards in two columns of its own, while its status stays completed (migration 181)", () => {
    const [row] = parseCsv(exportLines([doc({ cancelled_at: "2026-10-08T02:00:00+00:00" })], names));
    expect(row.slice(3, 4)).toEqual(["completed"]);
    expect(row.slice(10)).toEqual(["sign", "yes", "2026-10-08T02:00:00.000Z"]);
    // the person's own free-text reason is not in the file
    expect(row.join("|")).not.toMatch(/reason/i);
    // a stamp on anything that is not completed is not a cancellation
    expect(parseCsv(exportLines([doc({ status: "sent", cancelled_at: "2026-10-08T02:00:00+00:00" })], names))[0].slice(11)).toEqual(["no", ""]);
  });

  it("guards every cell a spreadsheet could run as a formula, and quotes what needs it", () => {
    const [row] = parseCsv(
      exportLines([doc({ title: '=HYPERLINK("http://evil.example","click")', contacts: { name: "+cmd|' /C calc'!A0" }, sign_signers: [{ full_name: "@SUM(A1)", order_no: 1 }, { full_name: "Lim, Ah Seng", order_no: 2 }] })], names),
    );
    expect(row[1]).toBe(`'=HYPERLINK("http://evil.example","click")`);
    expect(row[4]).toBe("'+cmd|' /C calc'!A0");
    expect(row[5]).toBe("'@SUM(A1); Lim, Ah Seng");
  });

  it("names the file after the day", () => {
    expect(exportFileName(new Date("2026-10-06T23:00:00Z"))).toBe("signing-documents-2026-10-06.csv");
  });
});

// ---- the streamed file ----------------------------------------------------------------------------------

const deps: NotifyDeps = { emailConfigured: () => false, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "x" }), sendWhatsApp: async () => {} };

function setup() {
  const db = new FakeDb();
  const ctx: SignCtx = { admin: db.client(), accountId: ACCT, userId: USER, origin: "https://halo.test", deps, now: () => new Date("2026-10-06T08:00:00Z") };
  db.seed("accounts", [{ id: ACCT, name: "Vircle", brand_name: null, timezone: "Asia/Kuala_Lumpur" }]);
  db.seed("sign_categories", [{ id: CAT, account_id: ACCT, name: "Merchant agreements" }]);
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  return { db, ctx };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

const read = (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe("documentsCsvStream", () => {
  const seedDocs = (n: number, over: Record<string, unknown> = {}) =>
    t.db.seed(
      "sign_documents",
      Array.from({ length: n }, (_, i) => ({
        id: `d${String(i).padStart(3, "0")}`,
        account_id: ACCT,
        reference: `SGN-2026-${String(i + 1).padStart(6, "0")}`,
        title: `Doc ${i + 1}`,
        status: "sent",
        category_id: CAT,
        created_at: `2026-10-0${(i % 9) + 1}T01:00:00Z`,
        sent_at: null,
        completed_at: null,
        expires_at: null,
        contacts: null,
        sign_signers: [{ full_name: `Person ${i + 1}`, order_no: 1 }],
        ...over,
      })),
    );

  it("streams the header and every document, a page at a time", async () => {
    seedDocs(5);
    t.db.seed("sign_documents", [{ id: "other", account_id: "someone-else", reference: "X", title: "Not ours", status: "sent", created_at: "2026-10-01T00:00:00Z" }]);
    const bytes = new Uint8Array(await new Response(documentsCsvStream(t.ctx, none, { pageSize: 2 })).arrayBuffer());
    // a byte order mark, so Excel reads names that are not Latin as UTF-8 (a text decoder drops it, so the bytes are checked)
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    const table = parseCsv(text);
    expect(table[0]).toEqual([...EXPORT_HEADER]);
    expect(table).toHaveLength(6);
    expect(table.slice(1).map((r) => r[1]).sort()).toEqual(["Doc 1", "Doc 2", "Doc 3", "Doc 4", "Doc 5"]);
    expect(table[1][2]).toBe("Merchant agreements");
    // never another workspace's document
    expect(text).not.toContain("Not ours");
  });

  it("stops at the most it is allowed to hold", async () => {
    seedDocs(7);
    const table = parseCsv(await read(documentsCsvStream(t.ctx, none, { pageSize: 2, maxRows: 3 })));
    expect(table).toHaveLength(4);
  });

  it("applies the status group, category, contact and the day range in the workspace's time zone", async () => {
    seedDocs(1, { id: "a1", title: "Completed in range", status: "completed", contact_id: CONTACT, created_at: "2026-09-30T17:00:00Z" });
    seedDocs(1, { id: "a2", title: "Wrong status", status: "draft", contact_id: CONTACT, created_at: "2026-09-30T17:00:00Z" });
    seedDocs(1, { id: "a3", title: "Before the range", status: "completed", contact_id: CONTACT, created_at: "2026-09-30T15:59:00Z" });
    seedDocs(1, { id: "a4", title: "Wrong contact", status: "completed", contact_id: "someone", created_at: "2026-09-30T17:00:00Z" });
    seedDocs(1, { id: "a5", title: "After the range", status: "completed", contact_id: CONTACT, created_at: "2026-10-31T16:00:00Z" });
    const text = await read(documentsCsvStream(t.ctx, { ...none, group: "completed", category: CAT, contactId: CONTACT, from: "2026-10-01", to: "2026-10-31" }));
    expect(parseCsv(text).slice(1).map((r) => r[1])).toEqual(["Completed in range"]);
  });

  it("lists the cancelled documents apart: Completed leaves them out, Cancelled is only them, All has both (migration 181)", async () => {
    seedDocs(1, { id: "k1", title: "Still in force", status: "completed", completed_at: "2026-10-02T09:00:00Z" });
    seedDocs(1, { id: "k2", title: "Cancelled afterwards", status: "completed", completed_at: "2026-10-02T09:00:00Z", cancelled_at: "2026-10-08T02:00:00Z" });
    seedDocs(1, { id: "k3", title: "Still open", status: "sent" });
    const titles = async (group: ExportFilters["group"]) => parseCsv(await read(documentsCsvStream(t.ctx, { ...none, group }))).slice(1).map((r) => r[1] + ":" + r[3] + ":" + r[11]).sort();
    expect(await titles("completed")).toEqual(["Still in force:completed:no"]);
    expect(await titles("cancelled")).toEqual(["Cancelled afterwards:completed:yes"]);
    expect(await titles("all")).toEqual(["Cancelled afterwards:completed:yes", "Still in force:completed:no", "Still open:sent:no"]);
    expect(await titles("waiting")).toEqual(["Still open:sent:no"]);
    // the list's own Cancelled group travels through the export button's query string
    expect(parseExportFilters(new URLSearchParams(exportQuery({ group: "cancelled" }))).group).toBe("cancelled");
  });

  it("answers an empty list with the header alone", async () => {
    expect(parseCsv(await read(documentsCsvStream(t.ctx, none)))).toEqual([[...EXPORT_HEADER]]);
  });

  it("fails the stream when the database refuses a page, so a cut-off file is never taken for a whole one", async () => {
    const chain: unknown = new Proxy({}, { get: (_t, p) => (p === "range" ? () => Promise.resolve({ data: null, error: { message: "boom" } }) : p === "then" ? undefined : () => chain) });
    const real = t.ctx.admin;
    const admin = { from: (table: string) => (table === "sign_documents" ? chain : real.from(table)), rpc: real.rpc.bind(real) } as unknown as SignCtx["admin"];
    await expect(read(documentsCsvStream({ ...t.ctx, admin }, none))).rejects.toBeDefined();
  });
});

// ---- the zip ----------------------------------------------------------------------------------------------

describe("which documents go in the zip", () => {
  const cand = (id: string, over: Partial<Parameters<typeof classifyForZip>[1][number]> = {}) => ({ id, reference: `SGN-${id}`, title: `Title ${id}`, status: "completed", final_path: `account-${ACCT}/${id}/final/x.pdf`, ...over });

  it("takes the completed ones that have a signed file and reports every other with its reason", () => {
    const { included, skipped } = classifyForZip(["a", "b", "c", "d", "e"], [cand("a"), cand("b", { status: "in_progress", final_path: null }), cand("c", { final_path: null }), cand("d", { status: "voided" })]);
    expect(included.map((d) => d.id)).toEqual(["a"]);
    expect(skipped).toEqual([
      { id: "b", reference: "SGN-b", reason: "not_completed" },
      { id: "c", reference: "SGN-c", reason: "no_signed_file" },
      { id: "d", reference: "SGN-d", reason: "not_completed" },
      { id: "e", reference: null, reason: "not_found" },
    ]);
  });

  it("keeps the order the documents were chosen in", () => {
    expect(classifyForZip(["c", "a", "b"], [cand("a"), cand("b"), cand("c")]).included.map((d) => d.id)).toEqual(["c", "a", "b"]);
  });

  it("takes the ids as sent: well formed ones, each once, between 1 and 50", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    expect(cleanIds([id(1), id(1), "nope", 5, id(2)], isId)).toEqual([id(1), id(2)]);
    expect(cleanIds([], isId)).toBeNull();
    expect(cleanIds("x", isId)).toBeNull();
    expect(cleanIds(["nope"], isId)).toBeNull();
    expect(cleanIds(Array.from({ length: ZIP_MAX_DOCUMENTS }, (_, i) => id(i)), isId)).toHaveLength(ZIP_MAX_DOCUMENTS);
    expect(cleanIds(Array.from({ length: ZIP_MAX_DOCUMENTS + 1 }, (_, i) => id(i)), isId)).toBeNull();
  });

  it("names files by reference and title, safe for any system, and never twice", () => {
    const used = new Set<string>();
    expect(zipEntryName({ id: "x", reference: "SGN-2026-000001", title: "Merchant Agreement: Kedai/Runcit" }, used)).toBe("SGN-2026-000001 - Merchant Agreement Kedai-Runcit.pdf");
    expect(zipEntryName({ id: "x", reference: "SGN-2026-000001", title: "Merchant Agreement: Kedai/Runcit" }, used)).toBe("SGN-2026-000001 - Merchant Agreement Kedai-Runcit-2.pdf");
    expect(zipEntryName({ id: "x", reference: "sgn-2026-000001", title: "merchant agreement: kedai/runcit" }, used)).toBe("sgn-2026-000001 - merchant agreement kedai-runcit-3.pdf");
    expect(zipEntryName({ id: "12345678-aaaa", reference: null, title: "???" }, used)).toBe("12345678.pdf");
    const sneaky = zipEntryName({ id: "x", reference: null, title: "../../etc/passwd" }, new Set());
    expect(sneaky).not.toMatch(/[/\\]/);
    expect(sneaky.endsWith(".pdf")).toBe(true);
    expect(sneaky).not.toContain("..");
    expect(zipEntryName({ id: "x", reference: "R", title: "a".repeat(300) }, new Set()).length).toBeLessThanOrEqual(104);
  });

  it("writes a note of what was left out, and nothing when nothing was", () => {
    expect(skippedNote([])).toBe("");
    const note = skippedNote([{ id: "a", reference: "SGN-1", reason: "not_completed" }, { id: "b", reference: null, reason: "not_found" }]);
    expect(note).toContain("SGN-1: not completed yet");
    expect(note).toContain("b: not found in this workspace");
    expect(zipFileName(new Date("2026-10-06T08:00:00Z"))).toBe("signed-documents-2026-10-06.zip");
  });
});

describe("planZip and zipStream", () => {
  const pdf = (n: number) => new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 251));
  const addDoc = (id: string, over: Record<string, unknown> = {}, bytes = pdf(id.charCodeAt(0))) => {
    const path = `account-${ACCT}/${id}/final/${id}.pdf`;
    t.db.seed("sign_documents", [{ id, account_id: ACCT, reference: `SGN-2026-${id}`, title: `Agreement ${id}`, status: "completed", final_path: path, ...over }]);
    if (over.final_path !== null) t.db.files.set(path, bytes);
    return { path, bytes };
  };

  it("zips the signed files, names them by reference, records a download for each, and notes what was left out", async () => {
    const a = addDoc("a");
    const b = addDoc("b");
    addDoc("c", { status: "in_progress", final_path: null });
    t.db.seed("sign_documents", [{ id: "x", account_id: "someone-else", reference: "OTHER", title: "Not ours", status: "completed", final_path: `account-someone-else/x/final/x.pdf` }]);
    const plan = await planZip(t.ctx, ["a", "b", "c", "x", "gone"]);
    expect(plan.included.map((d) => d.id)).toEqual(["a", "b"]);
    expect(plan.skipped.map((s) => [s.id, s.reason])).toEqual([["c", "not_completed"], ["x", "not_found"], ["gone", "not_found"]]);

    const zip = unzipSync(new Uint8Array(await new Response(zipStream(t.ctx, plan)).arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual([ZIP_SKIPPED_NOTE, "SGN-2026-a - Agreement a.pdf", "SGN-2026-b - Agreement b.pdf"]);
    expect(zip["SGN-2026-a - Agreement a.pdf"]).toEqual(a.bytes);
    expect(zip["SGN-2026-b - Agreement b.pdf"]).toEqual(b.bytes);
    expect(strFromU8(zip[ZIP_SKIPPED_NOTE])).toContain("SGN-2026-c: not completed yet");
    // one downloaded event for each file that went in, none for the others
    const events = t.db.rpcCalls.filter((c) => c.name === "sign_log" && c.args.p_type === "downloaded");
    expect(events.map((e) => e.args.p_document).sort()).toEqual(["a", "b"]);
    expect(events[0].args).toMatchObject({ p_actor_type: "user", p_user: USER, p_detail: { kind: "final", source: "zip" } });
  });

  it("has no note when everything went in", async () => {
    addDoc("a");
    const plan = await planZip(t.ctx, ["a"]);
    const zip = unzipSync(new Uint8Array(await new Response(zipStream(t.ctx, plan)).arrayBuffer()));
    expect(Object.keys(zip)).toEqual(["SGN-2026-a - Agreement a.pdf"]);
  });

  it("refuses when none of the chosen documents has a signed file", async () => {
    addDoc("c", { status: "sent", final_path: null });
    const err = await planZip(t.ctx, ["c", "gone"]).catch((e) => e);
    expect(err).toMatchObject({ code: "nothing_to_download", status: 409 });
    expect(err.issues).toEqual([{ code: "not_completed", detail: "SGN-2026-c" }, { code: "not_found", detail: "gone" }]);
  });

  it("leaves out a file that cannot be read and still sends the others", async () => {
    addDoc("a");
    const lost = addDoc("b");
    t.db.files.delete(lost.path);
    const plan = await planZip(t.ctx, ["a", "b"]);
    const zip = unzipSync(new Uint8Array(await new Response(zipStream(t.ctx, plan)).arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual([ZIP_SKIPPED_NOTE, "SGN-2026-a - Agreement a.pdf"]);
    expect(strFromU8(zip[ZIP_SKIPPED_NOTE])).toContain("SGN-2026-b: the signed file could not be read");
    expect(t.db.rpcCalls.filter((c) => c.args.p_type === "downloaded").map((c) => c.args.p_document)).toEqual(["a"]);
  });

  it("holds the size limit: the known sizes decide up front, the bytes read decide at the end", async () => {
    addDoc("a");
    addDoc("b");
    addDoc("c");
    const half = Math.floor(ZIP_MAX_BYTES * 0.6);
    t.db.seed("sign_document_files", [
      { account_id: ACCT, document_id: "a", kind: "signed", size_bytes: half },
      { account_id: ACCT, document_id: "b", kind: "signed", size_bytes: half },
      { account_id: ACCT, document_id: "c", kind: "signed", size_bytes: 10 },
    ]);
    const plan = await planZip(t.ctx, ["a", "b", "c"]);
    expect(plan.included.map((d) => d.id)).toEqual(["a", "c"]);
    expect(plan.skipped).toEqual([{ id: "b", reference: "SGN-2026-b", reason: "too_large" }]);
  });

  describe("with certificates that are files of their own (migration 178)", () => {
    const certificateOf = (id: string, bytes = pdf(id.charCodeAt(0) + 100)) => {
      const path = `account-${ACCT}/${id}/certificate/${id}.pdf`;
      const row = t.db.rows("sign_documents").find((d) => d.id === id)!;
      row.certificate_path = path;
      row.certificate_sha256 = "d".repeat(64);
      t.db.files.set(path, bytes);
      return { path, bytes };
    };

    it("puts each document's certificate in the zip beside its signed file, named after it; a document with its certificate inside the signed PDF adds nothing", async () => {
      const a = addDoc("a");
      const b = addDoc("b");
      const ca = certificateOf("a");
      const plan = await planZip(t.ctx, ["a", "b"]);
      expect(plan.names?.get("a")).toEqual({ signed: "SGN-2026-a - Agreement a.pdf", certificate: "SGN-2026-a - Agreement a - certificate.pdf" });
      expect(plan.names?.get("b")).toEqual({ signed: "SGN-2026-b - Agreement b.pdf", certificate: null });
      const zip = unzipSync(new Uint8Array(await new Response(zipStream(t.ctx, plan)).arrayBuffer()));
      expect(Object.keys(zip).sort()).toEqual(["SGN-2026-a - Agreement a - certificate.pdf", "SGN-2026-a - Agreement a.pdf", "SGN-2026-b - Agreement b.pdf"]);
      expect(zip["SGN-2026-a - Agreement a.pdf"]).toEqual(a.bytes);
      expect(zip["SGN-2026-a - Agreement a - certificate.pdf"]).toEqual(ca.bytes);
      expect(zip["SGN-2026-b - Agreement b.pdf"]).toEqual(b.bytes);
      // one download recorded for each document, not for each file
      expect(t.db.rpcCalls.filter((c) => c.args.p_type === "downloaded").map((c) => c.args.p_document)).toEqual(["a", "b"]);
    });

    it("counts the certificate in the size of a document, and names a certificate that cannot be read while the signed file still comes", async () => {
      addDoc("a");
      addDoc("b");
      certificateOf("a");
      const lost = certificateOf("b");
      t.db.files.delete(lost.path);
      const half = Math.floor(ZIP_MAX_BYTES * 0.5);
      t.db.seed("sign_document_files", [
        { account_id: ACCT, document_id: "a", kind: "signed", size_bytes: half },
        { account_id: ACCT, document_id: "a", kind: "certificate", size_bytes: Math.floor(half * 0.6) },
        { account_id: ACCT, document_id: "b", kind: "signed", size_bytes: 10 },
        { account_id: ACCT, document_id: "b", kind: "certificate", size_bytes: 10 },
      ]);
      // a's signed file and certificate together are 80% of the limit: b still fits (and is the one with the unreadable certificate)
      const plan = await planZip(t.ctx, ["a", "b"]);
      expect(plan.included.map((d) => d.id)).toEqual(["a", "b"]);
      const zip = unzipSync(new Uint8Array(await new Response(zipStream(t.ctx, plan)).arrayBuffer()));
      expect(Object.keys(zip).sort()).toEqual([ZIP_SKIPPED_NOTE, "SGN-2026-a - Agreement a - certificate.pdf", "SGN-2026-a - Agreement a.pdf", "SGN-2026-b - Agreement b.pdf"]);
      expect(strFromU8(zip[ZIP_SKIPPED_NOTE])).toContain("SGN-2026-b: the signed file is in this zip, but its certificate could not be read");
      // and the limit is held with the certificate in it
      t.db.tables["sign_document_files"] = [];
      t.db.seed("sign_document_files", [
        { account_id: ACCT, document_id: "a", kind: "signed", size_bytes: Math.floor(ZIP_MAX_BYTES * 0.5) },
        { account_id: ACCT, document_id: "a", kind: "certificate", size_bytes: Math.floor(ZIP_MAX_BYTES * 0.3) },
        { account_id: ACCT, document_id: "b", kind: "signed", size_bytes: Math.floor(ZIP_MAX_BYTES * 0.19) },
        { account_id: ACCT, document_id: "b", kind: "certificate", size_bytes: Math.floor(ZIP_MAX_BYTES * 0.05) },
      ]);
      const over = await planZip(t.ctx, ["a", "b"]);
      expect(over.included.map((d) => d.id)).toEqual(["a"]);
      expect(over.skipped).toEqual([{ id: "b", reference: "SGN-2026-b", reason: "too_large" }]);
    });

    it("names a certificate like its signed file with ' - certificate' before the extension, and never twice the same", () => {
      const used = new Set<string>();
      const doc = { id: "x", reference: "SGN-2026-000001", title: "Merchant Agreement" };
      expect(zipEntryName(doc, used)).toBe("SGN-2026-000001 - Merchant Agreement.pdf");
      expect(zipEntryName(doc, used, "certificate")).toBe("SGN-2026-000001 - Merchant Agreement - certificate.pdf");
      expect(zipEntryName(doc, used, "certificate")).toBe("SGN-2026-000001 - Merchant Agreement - certificate-2.pdf");
    });
  });

  it("always takes the first document even when it alone is over the limit", async () => {
    addDoc("a");
    t.db.seed("sign_document_files", [{ account_id: ACCT, document_id: "a", kind: "signed", size_bytes: ZIP_MAX_BYTES + 1 }]);
    expect((await planZip(t.ctx, ["a"])).included).toHaveLength(1);
  });
});
