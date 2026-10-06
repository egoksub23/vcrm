import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { PDFDocument } from "pdf-lib";
import { zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { A4, makePdf, scribblePng } from "../pdf/fixtures";
import {
  ConvertError,
  UploadError,
  classifyUpload,
  convertWordToPdf,
  converterHealth,
  converterUrl,
  kindFromName,
  listZipEntries,
  prepareUpload,
  sniffKind,
} from "./index";

// ---- fixtures -------------------------------------------------------------

function docx(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'),
    ...extra,
  });
}

/** An OLE2-looking file whose directory names (UTF-16) are `streams`. Enough for the sniffer; not a real .doc. */
function ole(streams: string[]): Uint8Array {
  const head = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const body = Buffer.concat(streams.map((s) => Buffer.from("\0\0" + s + "\0\0", "utf16le")));
  return new Uint8Array(Buffer.concat([head, Buffer.alloc(512), body]));
}

/** Turn the declared uncompressed size of every entry into `size`, in the central directory. */
function inflateDeclaredSize(zip: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(zip);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < out.length - 4; i++) {
    if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, size, true);
  }
  return out;
}

// ---- a stand-in for Gotenberg ------------------------------------------------

interface Seen {
  method?: string;
  url?: string;
  contentType?: string;
  body: Buffer;
}

let server: Server;
let base: string;
let mode: "pdf" | "garbage" | "fail" | "busy" | "slow" | "long" = "pdf";
let seen: Seen;
let shortPdf: Uint8Array;
let longPdf: Uint8Array;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  shortPdf = await makePdf([{ ...A4 }, { ...A4 }]);
  const doc = await PDFDocument.create();
  for (let i = 0; i < 51; i++) doc.addPage([200, 200]);
  longPdf = await doc.save();
  server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(mode === "busy" ? 503 : 200).end();
      return;
    }
    seen = { method: req.method, url: req.url, contentType: req.headers["content-type"], body: await readBody(req) };
    if (mode === "fail") return void res.writeHead(400).end("bad");
    if (mode === "busy") return void res.writeHead(503).end();
    if (mode === "slow") return; // never answers
    if (mode === "garbage") return void res.writeHead(200, { "content-type": "application/pdf" }).end("not a pdf at all");
    res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.from(mode === "long" ? longPdf : shortPdf));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// ---- tests ----------------------------------------------------------------

describe("converterUrl", () => {
  it("reads and validates SIGN_CONVERTER_URL", () => {
    expect(converterUrl({ SIGN_CONVERTER_URL: "http://sign-converter:3000/" } as never)).toBe("http://sign-converter:3000");
    expect(converterUrl({ SIGN_CONVERTER_URL: "" } as never)).toBeNull();
    expect(converterUrl({} as never)).toBeNull();
    expect(converterUrl({ SIGN_CONVERTER_URL: "ftp://x" } as never)).toBeNull();
    expect(converterUrl({ SIGN_CONVERTER_URL: "http://user:pw@x:3000" } as never)).toBeNull();
    expect(converterUrl({ SIGN_CONVERTER_URL: "not a url" } as never)).toBeNull();
  });
});

describe("sniffKind and kindFromName", () => {
  it("decides from the bytes", async () => {
    expect(sniffKind(shortPdf)).toBe("pdf");
    expect(sniffKind(await scribblePng())).toBe("png");
    expect(sniffKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(sniffKind(docx())).toBe("docx");
    expect(sniffKind(ole(["WordDocument"]))).toBe("doc");
    expect(sniffKind(strToU8("hello"))).toBeNull();
  });

  it("reads the extension a name claims", () => {
    expect(kindFromName("Agreement.DOCX")).toBe("docx");
    expect(kindFromName("scan.jpg")).toBe("jpeg");
    expect(kindFromName("noext")).toBeNull();
    expect(kindFromName("sheet.xlsx")).toBeNull();
  });
});

describe("classifyUpload", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof UploadError ? e.code : "other";
    }
    return "none";
  };

  it("accepts a PDF, a docx, a legacy doc and images", async () => {
    expect(classifyUpload(shortPdf, "a.pdf")).toBe("pdf");
    expect(classifyUpload(docx(), "a.docx")).toBe("docx");
    expect(classifyUpload(ole(["WordDocument", "1Table"]), "a.doc")).toBe("doc");
    expect(classifyUpload(await scribblePng(), "sig.png")).toBe("png");
    expect(classifyUpload(shortPdf, "no-extension")).toBe("pdf");
  });

  it("refuses empty, oversize and unknown files", () => {
    expect(code(() => classifyUpload(new Uint8Array(0), "a.pdf"))).toBe("upload_empty");
    expect(code(() => classifyUpload(new Uint8Array(26 * 1024 * 1024), "a.pdf"))).toBe("upload_too_large");
    expect(code(() => classifyUpload(strToU8("plain text"), "a.txt"))).toBe("upload_unsupported");
  });

  it("refuses a file that is not what its name says", () => {
    expect(code(() => classifyUpload(shortPdf, "contract.docx"))).toBe("upload_name_mismatch");
    expect(code(() => classifyUpload(docx(), "contract.pdf"))).toBe("upload_name_mismatch");
  });

  it("refuses macros in a docx and in a legacy doc", () => {
    expect(code(() => classifyUpload(docx({ "word/vbaProject.bin": new Uint8Array(10) }), "a.docx"))).toBe("upload_macros");
    expect(code(() => classifyUpload(ole(["WordDocument", "Macros", "_VBA_PROJECT_CUR"]), "a.doc"))).toBe("upload_macros");
  });

  it("refuses a password-protected docx (an OLE file) with the right message, and an Excel file renamed .doc", () => {
    expect(code(() => classifyUpload(ole(["EncryptionInfo", "EncryptedPackage"]), "a.docx"))).toBe("upload_encrypted_word");
    expect(code(() => classifyUpload(ole(["Workbook"]), "a.doc"))).toBe("upload_unsupported");
  });

  it("refuses a zip that is not a Word file, and one that expands past the limit", () => {
    const notWord = zipSync({ "readme.txt": strToU8("hi") });
    expect(code(() => classifyUpload(notWord, "a.docx"))).toBe("upload_unsupported");
    expect(code(() => classifyUpload(inflateDeclaredSize(docx(), 300 * 1024 * 1024), "a.docx"))).toBe("upload_zip_bomb");
  });

  it("lists zip entries without unpacking", () => {
    const names = listZipEntries(docx())!.map((e) => e.name);
    expect(names).toEqual(["[Content_Types].xml", "word/document.xml"]);
    expect(listZipEntries(strToU8("nope"))).toBeNull();
  });
});

describe("convertWordToPdf (against a stand-in converter)", () => {
  it("posts the file as multipart and returns the PDF with its page count", async () => {
    mode = "pdf";
    const r = await convertWordToPdf(docx(), "Agreement.docx", { baseUrl: base });
    expect(r.pageCount).toBe(2);
    expect(Buffer.from(r.pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/forms/libreoffice/convert");
    expect(seen.contentType).toMatch(/^multipart\/form-data/);
    const body = seen.body.toString("latin1");
    expect(body).toContain('name="files"');
    // the name sent is generic: an uploaded file name never reaches the converter
    expect(body).toContain('filename="document.docx"');
    expect(body).not.toContain("Agreement");
  });

  it("says Word conversion is unavailable when the converter is not configured or not reachable", async () => {
    await expect(convertWordToPdf(docx(), "a.docx", { baseUrl: null })).rejects.toMatchObject({ code: "converter_not_configured" });
    await expect(convertWordToPdf(docx(), "a.docx", { baseUrl: "http://127.0.0.1:1" })).rejects.toMatchObject({ code: "converter_unavailable" });
    mode = "busy";
    await expect(convertWordToPdf(docx(), "a.docx", { baseUrl: base })).rejects.toMatchObject({ code: "converter_unavailable" });
  });

  it("turns a converter failure, a slow converter and a non-PDF answer into typed errors", async () => {
    mode = "fail";
    await expect(convertWordToPdf(docx(), "a.docx", { baseUrl: base })).rejects.toMatchObject({ code: "conversion_failed" });
    mode = "garbage";
    await expect(convertWordToPdf(docx(), "a.docx", { baseUrl: base })).rejects.toMatchObject({ code: "conversion_failed" });
    mode = "slow";
    const err = await convertWordToPdf(docx(), "a.docx", { baseUrl: base, timeoutMs: 150 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConvertError);
    expect(err.code).toBe("conversion_timeout");
  });

  it("refuses a result of more than 50 pages", async () => {
    mode = "long";
    await expect(convertWordToPdf(docx(), "a.docx", { baseUrl: base })).rejects.toMatchObject({ code: "conversion_too_long" });
  });
});

describe("converterHealth", () => {
  it("reports configured, up, down and not set", async () => {
    mode = "pdf";
    expect(await converterHealth({ baseUrl: base })).toMatchObject({ configured: true, ok: true });
    mode = "busy";
    expect(await converterHealth({ baseUrl: base })).toMatchObject({ configured: true, ok: false, detail: "HTTP 503" });
    expect(await converterHealth({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 })).toMatchObject({ configured: true, ok: false });
    expect(await converterHealth({ baseUrl: null })).toMatchObject({ configured: false, ok: false });
  });
});

describe("prepareUpload", () => {
  it("passes a PDF straight through", async () => {
    const r = await prepareUpload(shortPdf, "terms.pdf");
    expect(r.converted).toBe(false);
    expect(r.pdf).toBe(shortPdf);
    expect(r.info.pageCount).toBe(2);
    expect(r.original).toMatchObject({ kind: "pdf", mime: "application/pdf", name: "terms.pdf" });
    expect(r.original.sha256).toBe(r.pdfSha256);
  });

  it("turns an image into a one-page PDF, landscape when the picture is wide", async () => {
    const r = await prepareUpload(await scribblePng(), "scan.png");
    expect(r.converted).toBe(true);
    expect(r.info.pageCount).toBe(1);
    expect(r.info.pages[0].width).toBeGreaterThan(r.info.pages[0].height); // 300 x 100 picture
    expect(r.original.kind).toBe("png");
    expect(r.original.sha256).not.toBe(r.pdfSha256);
  });

  it("converts a Word file through the converter and keeps the original", async () => {
    mode = "pdf";
    const word = docx();
    const r = await prepareUpload(word, "Agreement.docx", { baseUrl: base });
    expect(r.converted).toBe(true);
    expect(r.info.pageCount).toBe(2);
    expect(r.original.bytes).toBe(word);
    expect(r.original.mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("refuses an unreadable image and a damaged PDF with stable codes", async () => {
    await expect(prepareUpload(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), "x.png")).rejects.toMatchObject({ code: "image_unreadable" });
    await expect(prepareUpload(new TextEncoder().encode("%PDF-1.4 junk"), "x.pdf")).rejects.toMatchObject({ code: "pdf_invalid" });
  });
});
