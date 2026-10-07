import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { beforeAll, describe, expect, it } from "vitest";

import { collectionSummaryLabels } from "../collection-summary-words";
import { certificateLabels } from "../certificate-words";
import { appendCertificate, buildCertificate, buildCollectionSummary } from "./certificate";
import { A4, makePdf } from "./fixtures";
import { idFooterText } from "./idfooter";
import { createSelfSignedP12 } from "./p12";
import { sealPdf } from "./seal";
import type { CertificateData, CollectionSummaryData } from "./types";
import { verifySealed } from "./verify";
import { sha256Hex } from "./load";

// The certificate as a PDF of its own (migration 178), the same pages as the embedded certificate with the signed file it covers named by its
// fingerprint; the ID line on the embedded pages; and the small summary that opens a collection's zip.

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    out.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " "));
  }
  return out;
}
const squash = (s: string) => s.replace(/\s/g, "");

const DOC_ID = "7b2e9c1a-4d3f-4e8a-9b6c-1f2a3b4c5d6e";
const SIGNED_SHA = "c".repeat(64);

const certData = (over: Partial<CertificateData> = {}): CertificateData => ({
  title: "Merchant Application Form: Kedai Runcit Ali",
  reference: "SGN-2026-000123",
  documentId: DOC_ID,
  workspaceName: "Vircle Sdn Bhd",
  baseSha256: "a".repeat(64),
  pageCount: 4,
  chainHead: "b".repeat(64),
  verifyUrl: `https://halo.vircle.tech/verify/${DOC_ID}`,
  sentAt: new Date(Date.UTC(2026, 9, 6, 2, 0)),
  completedAt: new Date(Date.UTC(2026, 9, 6, 8, 30)),
  signers: [
    { name: "Ali bin Ahmad", email: "ali@kedairuncit.example", role: "Merchant", order: 1, status: "signed", signedAt: new Date(Date.UTC(2026, 9, 6, 6, 3)), ip: "203.0.113.9", device: "Chrome on Android", channel: "Email" },
    { name: "Gokula", email: "gokula@example.com", role: "Director", order: 2, status: "signed", signedAt: new Date(Date.UTC(2026, 9, 6, 8, 30)), ip: "198.51.100.4", device: "Safari on macOS", channel: "Email" },
  ],
  events: Array.from({ length: 6 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 6, 2, i)), text: `Event number ${i + 1} happened to the document` })),
  timeZone: "Asia/Kuala_Lumpur",
  ...over,
});

const covers = { fileName: "SGN-2026-000123-signed.pdf", sha256: SIGNED_SHA };

describe("buildCertificate: the standalone certificate", () => {
  let p12: Uint8Array;
  beforeAll(() => {
    p12 = createSelfSignedP12({ commonName: "Vircle Secure Sign test", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
  });

  it("is a PDF of its own with the certificate pages only, the reference and ID, the signed file it covers by name and SHA-256, who signed and when, and the timeline", async () => {
    const { bytes, pageCount } = await buildCertificate(certData({ covers }));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(pageCount);
    const text = (await pageTexts(bytes)).join(" ");
    for (const s of ["Certificate of Completion", "SGN-2026-000123", "Document ID", DOC_ID, "Signed document", "SGN-2026-000123-signed.pdf", "Ali bin Ahmad", "203.0.113.9", "Gokula", "Event number 6", "Certificate page 1 of 1"]) {
      expect(text, s).toContain(s);
    }
    // the fingerprint of the signed file it covers, and (as before) of the file as it was sent
    expect(squash(text)).toContain(SIGNED_SHA);
    expect(squash(text)).toContain("a".repeat(64));
    expect(text).toContain("SHA-256 of the signed document");
    // 06 Oct 2026 06:03 UTC is 14:03 in Kuala Lumpur
    expect(text).toContain("06 Oct 2026 14:03 UTC+8");
    // it says it is a file of its own, and that it is sealed
    expect(text).toContain("This certificate is a separate file");
    expect(text).toContain("This certificate is sealed with a digital signature");
    // no pages of the document are in it: A4 certificate pages only
    expect(doc.getPage(0).getSize()).toEqual({ width: expect.closeTo(595.28, 1), height: expect.closeTo(841.89, 1) });
  });

  it("can be sealed with the same certificate as the signed file, and the seal verifies", async () => {
    const { bytes } = await buildCertificate(certData({ covers }));
    const sealed = await sealPdf(bytes, p12, "pw", { signingTime: new Date("2026-10-06T08:30:00Z"), reason: "Certificate of completion through Vircle Secure Sign: SGN-2026-000123" });
    const verified = verifySealed(sealed.bytes);
    expect(verified.ok, verified.problems.join("; ")).toBe(true);
    expect(verified.sha256).toBe(sha256Hex(sealed.bytes));
    expect(verified.signer?.subject).toContain("Vircle Secure Sign test");
    // it is still the same text after sealing
    expect((await pageTexts(sealed.bytes)).join(" ")).toContain("SGN-2026-000123-signed.pdf");
  });

  it("for a document of a collection, names the collection, its size and each document with its fingerprint as sent", async () => {
    const envelope = {
      heading: "Part of document collection COL-2026-000004 (document 2 of 3)",
      note: "These 3 documents were signed together.",
      referenceLabel: "Reference",
      sha256Label: "SHA-256 as sent",
      hereLabel: "this document",
      documents: [
        { number: 1, title: "Agreement", reference: "SGN-2026-000121", sha256: "1".repeat(64), current: false },
        { number: 2, title: "Fee schedule", reference: "SGN-2026-000123", sha256: "2".repeat(64), current: true },
        { number: 3, title: "Data terms", reference: "SGN-2026-000124", sha256: "3".repeat(64), current: false },
      ],
    };
    const { bytes } = await buildCertificate(certData({ covers, envelope }));
    const text = (await pageTexts(bytes)).join(" ");
    // (a section heading is drawn in capitals)
    expect(text.toUpperCase()).toContain("PART OF DOCUMENT COLLECTION COL-2026-000004 (DOCUMENT 2 OF 3)");
    for (const s of ["1. Agreement", "2. Fee schedule (this document)", "3. Data terms", "SGN-2026-000121"]) expect(text, s).toContain(s);
    expect(squash(text)).toContain("2".repeat(64));
  });

  it("says a form's record, not a signed document, for a form without a signature, in every language", async () => {
    for (const locale of ["en", "ms", "zh", "ko"] as const) {
      const labels = certificateLabels(locale, "form");
      const signLabels = certificateLabels(locale, "sign");
      expect(labels.signedFile, locale).not.toBe(signLabels.signedFile);
      expect(labels.standaloneNote.length, locale).toBeGreaterThan(40);
      // every label is words in the language: none is empty, and the new ones differ from English outside English
      for (const key of ["documentId", "signedFile", "signedFingerprint", "standaloneNote"] as const) expect(labels[key], `${locale}.${key}`).toBeTruthy();
      if (locale !== "en") expect(signLabels.signedFile).not.toBe(certificateLabels("en", "sign").signedFile);
    }
    const { bytes } = await buildCertificate(certData({ covers: { fileName: "SGN-1-record.pdf", sha256: SIGNED_SHA }, labels: certificateLabels("en", "form") }));
    const text = (await pageTexts(bytes)).join(" ");
    expect(text).toContain("Certificate of Submission");
    expect(text).toContain("Sealed record");
    expect(text).toContain("SGN-1-record.pdf");
  });

  it("flows onto more pages when there is a lot to say, each page numbered", async () => {
    const d = certData({ covers });
    d.events = Array.from({ length: 80 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 6, 2, i % 60)), text: `Event ${i + 1}: the signer did something noteworthy with the document` }));
    const { bytes, pageCount } = await buildCertificate(d);
    expect(pageCount).toBeGreaterThan(1);
    const texts = await pageTexts(bytes);
    expect(texts).toHaveLength(pageCount);
    expect(texts[pageCount - 1]).toContain(`Certificate page ${pageCount} of ${pageCount}`);
  });
});

describe("the embedded certificate", () => {
  it("is unchanged without `covers`: pages after the document, the old note, and now the document's ID", async () => {
    const base = await makePdf([{ ...A4 }, { ...A4 }]);
    const { bytes, pagesAdded } = await appendCertificate(base, certData());
    expect(pagesAdded).toBe(1);
    const text = (await pageTexts(bytes))[2];
    expect(text).toContain("Certificate of Completion");
    expect(text).toContain(DOC_ID);
    expect(text).toContain("The signing events above are kept in an audit trail");
    expect(text).not.toContain("This certificate is a separate file");
    expect(text).not.toContain("SHA-256 of the signed document");
  });

  it("carries the ID line on its own pages when asked, below the page's footer, and still seals and verifies", async () => {
    const base = await makePdf([{ ...A4 }]);
    const line = idFooterText({ documentId: DOC_ID, collectionReference: "COL-2026-000004" });
    const d = certData();
    d.events = Array.from({ length: 80 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 6, 2, i % 60)), text: `Event ${i + 1}: the signer did something noteworthy with the document` }));
    const { bytes, pagesAdded } = await appendCertificate(base, d, { idFooter: line });
    expect(pagesAdded).toBeGreaterThan(1);
    const texts = await pageTexts(bytes);
    // the document's own page is left alone here (the answers' stamp puts the line on it); every certificate page has the line
    expect(texts[0]).not.toContain("Vircle Secure Sign ·");
    for (const t of texts.slice(1)) expect(t).toContain(line);
    const p12 = createSelfSignedP12({ commonName: "Test seal", passphrase: "pw", bits: 1024, notBefore: new Date("2026-10-01T00:00:00Z") });
    expect(verifySealed((await sealPdf(bytes, p12, "pw")).bytes).ok).toBe(true);
  });
});

describe("buildCollectionSummary", () => {
  const data = (over: Partial<CollectionSummaryData> = {}): CollectionSummaryData => ({
    reference: "COL-2026-000004",
    title: "Onboarding pack",
    workspaceName: "Vircle Sdn Bhd",
    preparedAt: new Date(Date.UTC(2026, 9, 7, 3, 0)),
    timeZone: "Asia/Kuala_Lumpur",
    labels: collectionSummaryLabels("en"),
    documents: [
      {
        number: 1,
        title: "Merchant Agreement",
        reference: "SGN-2026-000121",
        fileName: "SGN-2026-000121 - Merchant Agreement.pdf",
        sha256: "1".repeat(64),
        certificateFileName: "SGN-2026-000121 - Merchant Agreement - certificate.pdf",
        certificateSha256: "9".repeat(64),
        signers: [
          { name: "Ali bin Ahmad", signedAt: new Date(Date.UTC(2026, 9, 6, 6, 3)) },
          { name: "Gokula", signedAt: new Date(Date.UTC(2026, 9, 6, 8, 30)) },
        ],
      },
      { number: 2, title: "Fee schedule", reference: "SGN-2026-000122", fileName: "SGN-2026-000122 - Fee schedule.pdf", sha256: "2".repeat(64), signers: [] },
    ],
    ...over,
  });

  it("lists the collection, and each document with its file, fingerprint, certificate and who signed when", async () => {
    const { bytes, pageCount } = await buildCollectionSummary(data());
    expect(pageCount).toBe(1);
    const text = (await pageTexts(bytes)).join(" ");
    for (const s of ["Collection summary", "COL-2026-000004", "Onboarding pack", "Documents 2", "1. Merchant Agreement", "SGN-2026-000121", "SGN-2026-000121 - Merchant Agreement.pdf", "2. Fee schedule", "Ali bin Ahmad", "Gokula", "No signatures are listed"]) {
      expect(text, s).toContain(s);
    }
    expect(squash(text)).toContain("1".repeat(64));
    expect(squash(text)).toContain("9".repeat(64));
    expect(squash(text)).toContain("2".repeat(64));
    // a document whose certificate is inside its signed file says so
    expect(text).toContain("The certificate pages are inside the signed document");
    // 06 Oct 2026 06:03 UTC is 14:03 in Kuala Lumpur
    expect(text).toContain("06 Oct 2026 14:03 UTC+8");
    // it is an index, and says it is not sealed itself
    expect(text).toContain("It is not sealed");
  });

  it("flows onto more pages for a long collection and numbers them", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, title: `Document ${i + 1}`, reference: `SGN-2026-0001${i}`, fileName: `File ${i + 1}.pdf`, sha256: String(i % 10).repeat(64), signers: [{ name: `Person ${i + 1}`, signedAt: new Date(Date.UTC(2026, 9, 6, 6, i)) }] }));
    const { bytes, pageCount } = await buildCollectionSummary(data({ documents: many }));
    expect(pageCount).toBeGreaterThan(1);
    expect((await pageTexts(bytes)).at(-1)).toContain(`Page ${pageCount} of ${pageCount}`);
  });

  it("has words in every language, and says record and submitted for a collection of forms", async () => {
    for (const locale of ["en", "ms", "zh", "ko"] as const) {
      const sign = collectionSummaryLabels(locale);
      const form = collectionSummaryLabels(locale, "form");
      for (const [key, value] of Object.entries(sign)) expect(value, `${locale}.${key}`).toBeTruthy();
      expect(form.signedBy, locale).not.toBe(sign.signedBy);
      expect(form.file, locale).not.toBe(sign.file);
      if (locale !== "en") expect(sign.heading, locale).not.toBe(collectionSummaryLabels("en").heading);
      const { bytes } = await buildCollectionSummary(data({ labels: sign }), { locale });
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    }
    const { bytes } = await buildCollectionSummary(data({ labels: collectionSummaryLabels("en", "form") }));
    const text = (await pageTexts(bytes)).join(" ");
    expect(text).toContain("Submitted by");
    expect(text).toContain("Record file");
  });
});
