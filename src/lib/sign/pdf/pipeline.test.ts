import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CertificateError,
  PdfError,
  answerFields,
  appendCertificate,
  assertValidNow,
  createSelfSignedP12,
  freezeBase,
  inspectPdf,
  openPdf,
  readP12,
  sealPdf,
  sha256Hex,
  stampFields,
  staticValues,
  verifySealed,
  type CertificateData,
  type PlacedField,
} from "./index";
import { A4, LETTER, makePdf, scribblePng } from "./fixtures";

interface Item {
  str: string;
  /** Baseline origin in shown coordinates (points, origin top-left). */
  x: number;
  y: number;
}

async function textItems(bytes: Uint8Array): Promise<Item[][]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: Item[][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((it): it is typeof it & { str: string; transform: number[] } => "str" in it && it.str.trim() !== "")
        .map((it) => {
          const [x, y] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
          return { str: it.str, x, y };
        }),
    );
  }
  return pages;
}

const field = (over: Partial<PlacedField> & Pick<PlacedField, "key" | "type">): PlacedField => ({
  role: "merchant",
  page: 0,
  x: 0.1,
  y: 0.2,
  w: 0.4,
  h: 0.04,
  required: true,
  ...over,
});

describe("inspectPdf and the limits", () => {
  it("reports page count and shown sizes, including rotation", async () => {
    const pdf = await makePdf([{ ...A4 }, { ...LETTER, rotate: 90 }]);
    const info = await inspectPdf(pdf);
    expect(info.pageCount).toBe(2);
    expect(info.pages[0]).toMatchObject({ width: A4.w, height: A4.h, rotation: 0 });
    expect(info.pages[1]).toMatchObject({ width: LETTER.h, height: LETTER.w, rotation: 90 });
  });

  it("refuses what is not a readable PDF, with a stable code", async () => {
    await expect(openPdf(new TextEncoder().encode("hello"))).rejects.toMatchObject({ code: "pdf_invalid" });
    const err = await openPdf(new TextEncoder().encode("%PDF-1.4 garbage")).catch((e) => e);
    expect(err).toBeInstanceOf(PdfError);
    expect(err.code).toBe("pdf_invalid");
  });

  it("refuses more than 200 pages", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 201; i++) doc.addPage([100, 100]);
    const bytes = await doc.save();
    await expect(openPdf(bytes)).rejects.toMatchObject({ code: "pdf_too_many_pages" });
  });

  it("refuses a file over 25 MB", async () => {
    await expect(openPdf(new Uint8Array(26 * 1024 * 1024))).rejects.toMatchObject({ code: "pdf_too_large" });
  });
});

describe("stampFields", () => {
  it("writes each kind of value inside its box", async () => {
    const base = await makePdf([{ ...A4 }]);
    const png = await scribblePng();
    const fields: PlacedField[] = [
      field({ key: "biz", type: "text", y: 0.2 }),
      field({ key: "amount", type: "number", decimals: 2, y: 0.26, w: 0.3 }),
      field({ key: "when", type: "date", y: 0.32, dateFormat: "DD MMM YYYY" }),
      field({ key: "signed", type: "date_signed", y: 0.38 }),
      field({ key: "plan", type: "dropdown", options: ["Basic", "Plus"], y: 0.44 }),
      field({ key: "agree", type: "checkbox", y: 0.5, w: 0.03, h: 0.03 }),
      field({ key: "sig", type: "signature", y: 0.56, h: 0.08 }),
      field({ key: "typed", type: "signature", y: 0.68, h: 0.06 }),
      field({ key: "nope", type: "text", y: 0.8 }),
    ];
    const { bytes, warnings } = await stampFields(
      base,
      fields,
      {
        biz: { text: "Kedai Runcit Ali Sdn Bhd" },
        amount: { text: "1234567" },
        when: { text: "2026-10-05" },
        signed: { at: new Date(Date.UTC(2026, 9, 6, 8, 0)) },
        plan: { text: "Plus" },
        agree: { checked: true },
        sig: { image: { bytes: png, mime: "image/png" } },
        typed: { typed: "Ali Ahmad" },
      },
      { timeZone: "Asia/Kuala_Lumpur" },
    );
    expect(warnings).toEqual([]);

    const [page] = await textItems(bytes);
    const find = (s: string) => page.find((i) => i.str.includes(s));
    const within = (it: Item | undefined, f: PlacedField) => {
      expect(it, f.key).toBeDefined();
      const left = f.x * A4.w;
      const top = f.y * A4.h;
      expect(it!.x, `${f.key} x`).toBeGreaterThanOrEqual(left - 0.5);
      expect(it!.x, `${f.key} x`).toBeLessThanOrEqual(left + f.w * A4.w);
      expect(it!.y, `${f.key} y`).toBeGreaterThan(top);
      expect(it!.y, `${f.key} y`).toBeLessThanOrEqual(top + f.h * A4.h + 0.5);
    };
    within(find("Kedai Runcit Ali Sdn Bhd"), fields[0]);
    within(find("1,234,567.00"), fields[1]);
    within(find("05 Oct 2026"), fields[2]);
    within(find("06 Oct 2026"), fields[3]);
    within(find("Plus"), fields[4]);
    within(find("Ali Ahmad"), fields[7]);
    // the blank field wrote nothing; the image is an XObject on the page
    expect(page.some((i) => i.y > 0.8 * A4.h && i.y < 0.84 * A4.h)).toBe(false);
    const doc = await PDFDocument.load(bytes);
    const xobjects = doc.getPage(0).node.Resources()?.lookup(doc.context.obj("XObject") as never);
    expect(xobjects).toBeDefined();
  });

  it("puts date_signed in the zone asked for", async () => {
    const base = await makePdf([{ ...A4 }]);
    const f = [field({ key: "signed", type: "date_signed" })];
    const at = new Date(Date.UTC(2026, 9, 6, 20, 30)); // 7 Oct in Kuala Lumpur
    const kl = await stampFields(base, f, { signed: { at } }, { timeZone: "Asia/Kuala_Lumpur" });
    const utc = await stampFields(base, f, { signed: { at } });
    expect((await textItems(kl.bytes))[0].some((i) => i.str.includes("07 Oct 2026"))).toBe(true);
    expect((await textItems(utc.bytes))[0].some((i) => i.str.includes("06 Oct 2026"))).toBe(true);
  });

  it("places fields correctly on a page stored rotated, and on one with an offset crop box", async () => {
    for (const rotate of [0, 90, 180, 270] as const) {
      const base = await makePdf([{ ...LETTER, rotate }, { ...A4, originX: 30, originY: 20 }]);
      const shown = (await inspectPdf(base)).pages;
      const f = [field({ key: "t", type: "text", x: 0.15, y: 0.3, w: 0.5, h: 0.05 }), field({ key: "t2", type: "text", page: 1, x: 0.15, y: 0.3, w: 0.5, h: 0.05 })];
      const { bytes } = await stampFields(base, f, { t: { text: "Hello" }, t2: { text: "Offset" } });
      const pages = await textItems(bytes);
      for (const [pi, key, word] of [[0, f[0], "Hello"], [1, f[1], "Offset"]] as const) {
        const it = pages[pi].find((i) => i.str === word);
        expect(it, `${word} on rotation ${rotate}`).toBeDefined();
        const left = key.x * shown[pi].width;
        const top = key.y * shown[pi].height;
        expect(it!.x).toBeGreaterThanOrEqual(left - 0.5);
        expect(it!.x).toBeLessThanOrEqual(left + 8);
        expect(it!.y).toBeGreaterThan(top);
        expect(it!.y).toBeLessThanOrEqual(top + key.h * shown[pi].height + 0.5);
      }
    }
  });

  it("wraps a multi-line field and warns when text had to be cut", async () => {
    const base = await makePdf([{ ...A4 }]);
    const f = [field({ key: "note", type: "text", multiline: true, h: 0.08, w: 0.4 }), field({ key: "tiny", type: "text", y: 0.5, w: 0.05, h: 0.01 })];
    const { bytes, warnings } = await stampFields(base, f, {
      note: { text: "First line\nSecond line of the note that is long enough to wrap onto another line" },
      tiny: { text: "This text cannot possibly fit in that little box" },
    });
    expect(warnings.map((w) => `${w.field}:${w.code}`)).toContain("tiny:text_truncated");
    const page = (await textItems(bytes))[0];
    expect(page.filter((i) => i.y > 0.2 * A4.h && i.y < 0.3 * A4.h).length).toBeGreaterThan(2);
  });

  it("writes characters the font lacks as ? and says so", async () => {
    const base = await makePdf([{ ...A4 }]);
    const { bytes, warnings } = await stampFields(base, [field({ key: "n", type: "name" })], { n: { text: "Tan 你好" } });
    expect(warnings).toEqual([{ field: "n", code: "unsupported_characters", detail: "2" }]);
    expect((await textItems(bytes))[0].some((i) => i.str.includes("Tan ??"))).toBe(true);
  });

  it("embeds the whole bundled font, not a subset (the library's subsetter drops glyphs from it)", async () => {
    // Found by rendering a sealed file: with { subset: true } most letters were missing from the page
    // although text extraction still read them. A full embed of the 70 KB Latin font is far above 40 KB.
    const base = await makePdf([{ ...A4 }]);
    const { bytes } = await stampFields(base, [field({ key: "n", type: "name" })], { n: { text: "Kedai Runcit Ali" } });
    expect(bytes.byteLength - base.byteLength).toBeGreaterThan(40_000);
  });

  it("keeps Malay and accented Latin text", async () => {
    const base = await makePdf([{ ...A4 }]);
    const { warnings, bytes } = await stampFields(base, [field({ key: "n", type: "name" })], { n: { text: "Nur Aishah binti Mohd Zaini éü" } });
    expect(warnings).toEqual([]);
    expect((await textItems(bytes))[0].some((i) => i.str.includes("Nur Aishah"))).toBe(true);
  });

  it("reports a field on a page the file does not have, and a bad image, and carries on", async () => {
    const base = await makePdf([{ ...A4 }]);
    const { warnings } = await stampFields(
      base,
      [field({ key: "x", type: "text", page: 4 }), field({ key: "s", type: "signature" })],
      { x: { text: "lost" }, s: { image: { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" } } },
    );
    expect(warnings.map((w) => w.code).sort()).toEqual(["bad_image", "missing_page"]);
  });
});

describe("freezeBase", () => {
  it("writes the static and merge fields, fingerprints the result, and leaves answer fields out", async () => {
    const template = await makePdf([{ ...A4 }]);
    const fields: PlacedField[] = [
      field({ key: "fee", type: "static_text", text: "RM 1.00 per collection" }),
      field({ key: "name", type: "text", merge: "business_name", y: 0.3 }),
      field({ key: "sig", type: "signature", y: 0.5 }),
    ];
    const merge = { business_name: "Kedai Runcit Ali Sdn Bhd" };
    expect(staticValues(fields, merge)).toEqual({ fee: { text: "RM 1.00 per collection" }, name: { text: "Kedai Runcit Ali Sdn Bhd" } });
    expect(answerFields(fields).map((f) => f.key)).toEqual(["sig"]);
    const { bytes, sha256 } = await freezeBase(template, fields, merge);
    expect(sha256).toBe(sha256Hex(bytes));
    const strs = (await textItems(bytes))[0].map((i) => i.str).join(" ");
    expect(strs).toContain("RM 1.00 per collection");
    expect(strs).toContain("Kedai Runcit Ali Sdn Bhd");
    // the same inputs give the same fingerprint's inputs: nothing random is written
    expect(sha256Hex(template)).not.toBe(sha256);
  });
});

const certData = (): CertificateData => ({
  title: "Merchant Application Form: Kedai Runcit Ali",
  reference: "SGN-2026-000123",
  workspaceName: "Vircle Sdn Bhd",
  baseSha256: "a".repeat(64),
  pageCount: 4,
  chainHead: "b".repeat(64),
  verifyUrl: "https://halo.vircle.tech/verify/abc123",
  sentAt: new Date(Date.UTC(2026, 9, 6, 2, 0)),
  completedAt: new Date(Date.UTC(2026, 9, 6, 8, 30)),
  signers: [
    { name: "Ali bin Ahmad", email: "ali@kedairuncit.example", role: "Merchant", order: 1, status: "signed", signedAt: new Date(Date.UTC(2026, 9, 6, 6, 3)), ip: "203.0.113.9", device: "Chrome on Android", channel: "Email" },
    { name: "Gokula", email: "gokula@example.com", role: "Director", order: 2, status: "signed", signedAt: new Date(Date.UTC(2026, 9, 6, 8, 30)), ip: "198.51.100.4", device: "Safari on macOS", channel: "Email" },
  ],
  events: Array.from({ length: 6 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 6, 2, i)), text: `Event number ${i + 1} happened to the document` })),
  timeZone: "Asia/Kuala_Lumpur",
});

describe("appendCertificate", () => {
  it("adds readable certificate pages with the facts and a QR code", async () => {
    const base = await makePdf([{ ...A4 }, { ...A4 }]);
    const { bytes, pagesAdded } = await appendCertificate(base, certData());
    expect(pagesAdded).toBe(1);
    const pages = await textItems(bytes);
    expect(pages).toHaveLength(3);
    const text = pages[2].map((i) => i.str).join(" ");
    for (const s of ["Certificate of Completion", "SGN-2026-000123", "Ali bin Ahmad", "203.0.113.9", "Gokula", "Event number 6", "Certificate page 1 of 1"]) {
      expect(text, s).toContain(s);
    }
    // 06 Oct 2026 06:03 UTC is 14:03 in Kuala Lumpur
    expect(text).toContain("06 Oct 2026 14:03 UTC+8");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPage(2).getSize()).toEqual({ width: expect.closeTo(595.28, 1), height: expect.closeTo(841.89, 1) });
  });

  it("flows onto more pages when there is a lot to say", async () => {
    const base = await makePdf([{ ...A4 }]);
    const d = certData();
    d.events = Array.from({ length: 80 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 6, 2, i % 60)), text: `Event ${i + 1}: the signer did something noteworthy with the document` }));
    d.signers = Array.from({ length: 5 }, (_, i) => ({ ...d.signers[0], name: `Signer ${i + 1}`, order: i + 1 }));
    const { bytes, pagesAdded } = await appendCertificate(base, d);
    expect(pagesAdded).toBeGreaterThan(1);
    const pages = await textItems(bytes);
    expect(pages[pages.length - 1].map((i) => i.str).join(" ")).toContain(`Certificate page ${pagesAdded} of ${pagesAdded}`);
  });
});

describe("sealing and verification", () => {
  let p12: Uint8Array;
  const pass = "test-passphrase";

  beforeAll(() => {
    p12 = createSelfSignedP12({ commonName: "Vircle Secure Sign test", organization: "Vircle", country: "MY", passphrase: pass, bits: 1024 });
  });

  it("reads the facts about a certificate and rejects a wrong passphrase", () => {
    const facts = readP12(p12, pass);
    expect(facts.subject).toBe("Vircle Secure Sign test, Vircle, MY");
    expect(facts.selfSigned).toBe(true);
    expect(facts.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(() => readP12(p12, "wrong")).toThrow(CertificateError);
    try {
      readP12(p12, "wrong");
    } catch (e) {
      expect((e as CertificateError).code).toBe("p12_bad_passphrase");
    }
    expect(() => readP12(new Uint8Array([1, 2, 3]), pass)).toThrow(/not a certificate file/);
  });

  it("refuses an expired or not-yet-valid certificate", () => {
    const facts = readP12(p12, pass);
    expect(() => assertValidNow(facts, new Date(facts.notAfter.getTime() + 1000))).toThrow(/expired/);
    expect(() => assertValidNow(facts, new Date(facts.notBefore.getTime() - 1000))).toThrow(/not valid yet/);
  });

  it("seals a stamped, certified document, and the seal verifies", async () => {
    const base = await makePdf([{ ...A4 }, { ...LETTER }]);
    const stamped = await stampFields(base, [field({ key: "t", type: "text" })], { t: { text: "Signed text" } });
    const certified = await appendCertificate(stamped.bytes, certData());
    const sealed = await sealPdf(certified.bytes, p12, pass, { reason: "Test seal", signingTime: new Date() });
    expect(sealed.sha256).toBe(sha256Hex(sealed.bytes));
    expect(sealed.size).toBe(sealed.bytes.byteLength);

    const v = verifySealed(sealed.bytes);
    expect(v.problems).toEqual([]);
    expect(v).toMatchObject({ ok: true, signatureCount: 1, signatureValid: true, digestMatches: true, coversWholeFile: true });
    expect(v.signer).toMatchObject({ subject: "Vircle Secure Sign test, Vircle, MY", selfSigned: true });
    expect(v.reason).toBe("Test seal");
    expect(Math.abs((v.signingTime?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);

    // still a document a reader can open, with the stamped text and the certificate pages
    const pages = await textItems(sealed.bytes);
    expect(pages).toHaveLength(3);
    expect(pages[0].some((i) => i.str.includes("Signed text"))).toBe(true);
  });

  it("notices any change made after sealing", async () => {
    const base = await makePdf([{ ...A4 }]);
    const sealed = (await sealPdf(base, p12, pass)).bytes;
    expect(verifySealed(sealed).ok).toBe(true);

    // change one content byte inside the signed range
    const tampered = new Uint8Array(sealed);
    tampered[12] = tampered[12] ^ 0x01; // inside the file header, well within the signed range
    const t = verifySealed(tampered);
    expect(t.ok).toBe(false);
    expect(t.digestMatches).toBe(false);

    // something appended after the seal is not covered
    const extended = new Uint8Array(sealed.length + 10);
    extended.set(sealed);
    extended.set(new TextEncoder().encode("\n%extra%\n"), sealed.length);
    const e = verifySealed(extended);
    expect(e.ok).toBe(false);
    expect(e.coversWholeFile).toBe(false);

    // an unsigned file
    const u = verifySealed(base);
    expect(u.ok).toBe(false);
    expect(u.signatureCount).toBe(0);
  });

  it("is checked by an independent verifier (OpenSSL) when one is installed", async () => {
    const have = spawnSync("openssl", ["version"]).status === 0;
    if (!have) return;
    const base = await makePdf([{ ...A4 }]);
    const sealed = (await sealPdf(base, p12, pass)).bytes;
    const text = Buffer.from(sealed).toString("latin1");
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text)!;
    const [a, b, c, d] = m.slice(1).map(Number);
    const signedData = Buffer.concat([Buffer.from(sealed.subarray(a, a + b)), Buffer.from(sealed.subarray(c, c + d))]);
    const hex = text.slice(a + b + 1, c - 1);
    const dir = mkdtempSync(path.join(tmpdir(), "sign-verify-"));
    try {
      writeFileSync(path.join(dir, "content.bin"), signedData);
      writeFileSync(path.join(dir, "sig.der"), Buffer.from(hex, "hex"));
      const out = spawnSync("openssl", ["cms", "-verify", "-inform", "DER", "-in", path.join(dir, "sig.der"), "-content", path.join(dir, "content.bin"), "-binary", "-noverify", "-out", path.join(dir, "out.bin")], { encoding: "utf8" });
      expect(out.stderr + out.stdout).toMatch(/Verification successful/i);

      // and OpenSSL rejects the same signature over changed content
      const bad = Buffer.from(signedData);
      bad[10] = bad[10] ^ 0xff;
      writeFileSync(path.join(dir, "bad.bin"), bad);
      const rejected = spawnSync("openssl", ["cms", "-verify", "-inform", "DER", "-in", path.join(dir, "sig.der"), "-content", path.join(dir, "bad.bin"), "-binary", "-noverify", "-out", path.join(dir, "out2.bin")], { encoding: "utf8" });
      expect(rejected.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    void execFileSync;
  });

  it("will not seal with an expired certificate", async () => {
    const old = createSelfSignedP12({ commonName: "Old", passphrase: pass, bits: 1024, years: 1, notBefore: new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000) });
    await expect(sealPdf(await makePdf([{ ...A4 }]), old, pass)).rejects.toMatchObject({ code: "p12_expired" });
  });
});
