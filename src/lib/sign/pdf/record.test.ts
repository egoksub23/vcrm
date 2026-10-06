import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";

import { appendCertificate, blankFormPage, buildSubmissionRecord, createSelfSignedP12, inspectPdf, openPdf, sealPdf, verifySealed, type CertificateData, type RecordData } from "./index";

async function textOf(bytes: Uint8Array): Promise<{ page: number; str: string }[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: { page: number; str: string }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await (await pdf.getPage(i)).getTextContent();
    for (const it of page.items) if ("str" in it && it.str.trim() !== "") out.push({ page: i, str: it.str });
  }
  return out;
}

const SHA = "ab12cd34".repeat(8);

const data = (over: Partial<RecordData> = {}): RecordData => ({
  title: "E-invoice and tax details",
  reference: "SGN-2026-000777",
  workspaceName: "Vircle Sdn Bhd",
  people: [{ name: "Ali bin Ahmad", role: "Merchant" }],
  submittedAt: new Date("2026-10-06T08:00:00Z"),
  timeZone: "Asia/Kuala_Lumpur",
  chainHead: "f".repeat(64),
  languageName: "English",
  parts: [
    {
      title: "Company",
      role: "Merchant",
      rows: [
        { label: "Legal name", text: "Kedai Runcit Ali Sdn Bhd", answered: true, sensitive: false, picture: false, files: [] },
        { label: "TIN", text: "**** 4567", answered: true, sensitive: true, picture: false, files: [] },
        { label: "Notes", text: "", answered: false, sensitive: false, picture: false, files: [] },
      ],
    },
    {
      title: "Documents",
      role: "Merchant",
      rows: [{ label: "SSM extract", text: "", answered: true, sensitive: false, picture: false, files: [{ name: "ssm-extract.pdf", size: 2048, sha256: SHA }] }],
    },
  ],
  ...over,
});

const certificate = (pageCount: number): CertificateData => ({
  title: "E-invoice and tax details",
  reference: "SGN-2026-000777",
  workspaceName: "Vircle Sdn Bhd",
  baseSha256: SHA,
  pageCount,
  signers: [{ name: "Ali bin Ahmad", email: "ali@kedai.example", role: "Merchant", status: "signed", signedAt: new Date("2026-10-06T08:00:00Z") }],
  events: [{ at: new Date("2026-10-06T08:00:00Z"), text: "Ali bin Ahmad submitted their details" }],
  chainHead: "f".repeat(64),
  verifyUrl: "https://halo.test/verify/doc",
  completedAt: new Date("2026-10-06T08:00:00Z"),
  timeZone: "Asia/Kuala_Lumpur",
});

describe("the base file of a form without a signature", () => {
  it("is one page, the same bytes every time, and something the engine opens", async () => {
    const a = await blankFormPage();
    const b = await blankFormPage();
    expect(a.sha256).toBe(b.sha256);
    expect(a.pageCount).toBe(1);
    expect((await inspectPdf(a.bytes)).pageCount).toBe(1);
    expect(a.bytes.byteLength).toBeLessThan(20_000);
    await openPdf(a.bytes);
  });
});

describe("the submission record", () => {
  it("prints who, when, every answer by part and the files with their fingerprints, and names an unanswered question", async () => {
    const { bytes, pageCount } = await buildSubmissionRecord(data());
    expect(pageCount).toBeGreaterThanOrEqual(1);
    const text = (await textOf(bytes)).map((x) => x.str).join(" ").replace(/\s+/g, " ");
    expect(text).toContain("Submission record");
    expect(text).toContain("SGN-2026-000777");
    expect(text).toContain("Ali bin Ahmad (Merchant)");
    expect(text).toContain("6 Oct 2026 16:00 UTC+8");
    expect(text).toContain("1. Company");
    expect(text).toContain("Kedai Runcit Ali Sdn Bhd");
    expect(text).toContain("Not answered");
    expect(text).toContain("ssm-extract.pdf");
    expect(text.replace(/\s/g, "")).toContain(SHA);
    expect(text.replace(/\s/g, "")).toContain("f".repeat(64));
  });

  it("shows a sensitive answer only as the mask it was given, and says so", async () => {
    const { bytes } = await buildSubmissionRecord(data());
    const text = (await textOf(bytes)).map((x) => x.str).join(" ");
    expect(text).toContain("**** 4567");
    expect(text).toContain("shown masked");
    expect(text).toContain("kept encrypted");
  });

  it("runs on to more pages when there are many answers", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ label: `Question ${i + 1}`, text: `Answer number ${i + 1} `.repeat(6), answered: true, sensitive: false, picture: false, files: [] }));
    const { bytes, pageCount } = await buildSubmissionRecord(data({ parts: [{ title: "Long", role: "Merchant", rows }] }));
    expect(pageCount).toBeGreaterThan(2);
    expect((await inspectPdf(bytes)).pageCount).toBe(pageCount);
  });

  it("takes the certificate pages and the seal like a signed document, and checks out afterwards", async () => {
    const record = await buildSubmissionRecord(data());
    const withCertificate = await appendCertificate(record.bytes, certificate(record.pageCount));
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    const sealed = await sealPdf(withCertificate.bytes, p12, "pw", { reason: "Submission record", signingTime: new Date("2026-10-06T08:01:00Z") });
    const verified = verifySealed(sealed.bytes);
    expect(verified.ok).toBe(true);
    expect(verified.sha256).toBe(sealed.sha256);
    expect((await inspectPdf(sealed.bytes)).pageCount).toBe(record.pageCount + withCertificate.pagesAdded);
    // the certificate pages came after the answers
    const pages = await textOf(sealed.bytes);
    const answers = pages.filter((x) => x.str.includes("Kedai Runcit")).map((x) => x.page);
    const cert = pages.filter((x) => x.str.includes("Certificate of Completion")).map((x) => x.page);
    expect(Math.max(...answers)).toBeLessThan(Math.min(...cert));
    // and altering the sealed file is noticed
    const tampered = new Uint8Array(sealed.bytes);
    tampered[100] = tampered[100] ^ 0xff;
    expect(verifySealed(tampered).ok).toBe(false);
  });
});
