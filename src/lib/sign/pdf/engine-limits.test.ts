// WP25 review: two findings of the sealing benchmark (docs/doc-sign-load-notes.md), proved on the real engine.
//  1. A signer's long answer in a small box was measured to the end at every font size: 50 answers of 2000 characters held the whole Node
//     process for 135 seconds. The work now follows the size of the box, not the length of the answer.
//  2. A document of 199 or 200 pages was accepted and then could never be sealed (the certificate pages made it too long to re-open).

import { beforeAll, describe, expect, it } from "vitest";

import { A4, makePdf } from "./fixtures";
import { appendCertificate, createSelfSignedP12, sealPdf, stampFields, verifySealed, type CertificateData, type PlacedField } from "./index";
import { fitText, wrapText } from "./format";

// a measure that counts how much work it is asked for, and charges by the length it is given (the shape of a real shaper)
function metered() {
  const calls = { n: 0, chars: 0 };
  const at = (size: number) => (s: string) => {
    calls.n++;
    calls.chars += s.length;
    return s.length * size * 0.5;
  };
  return { calls, at };
}

describe("fitting a long answer into a small box", () => {
  const box = { w: 120, h: 30 };
  const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

  it("costs the same whatever the length of the answer, once it cannot fit", () => {
    const short = metered();
    const huge = metered();
    fitText(long(60), box, short.at, { multiline: true });
    const out = fitText(long(400), box, huge.at, { multiline: true });
    expect(out.truncated).toBe(true);
    // a hundred times the text, not a hundred times the work: bounded by the box, with a little room for the longer words
    expect(huge.calls.chars).toBeLessThan(short.calls.chars * 4);
    expect(huge.calls.chars).toBeLessThan(20_000);
  });

  it("costs the same for one long word with no spaces, which is split by character", () => {
    const some = metered();
    const m = metered();
    fitText("x".repeat(300), box, some.at, { multiline: true });
    const out = fitText("x".repeat(2000), box, m.at, { multiline: true });
    expect(out.truncated).toBe(true);
    // seven times the characters, the same number of measurements: it stops at the box, not at the end of the answer (the word itself is
    // measured once per size to see whether it fits on a line, which is linear in its length and nothing more)
    expect(m.calls.n).toBe(some.calls.n);
    expect(m.calls.chars).toBeLessThan(200_000);
  });

  it("does not measure a single line again for every character it drops", () => {
    const m = metered();
    const out = fitText("y".repeat(2000), { w: 100, h: 14 }, m.at, {});
    expect(out.truncated).toBe(true);
    // halving: a few dozen measurements, not two thousand
    expect(m.calls.n).toBeLessThan(80);
    expect(out.lines[0].endsWith("…")).toBe(true);
    // and it is still the longest start that fits
    const size = out.fontSize;
    const fits = (s: string) => s.length * size * 0.5 <= 100 - 4;
    expect(fits(out.lines[0])).toBe(true);
    expect(fits(`${out.lines[0].slice(0, -1)}y…`)).toBe(false);
  });

  it("gives exactly the same lines as before when the answer fits, and the first lines of the same wrapping when it is cut", () => {
    const measure = (s: string) => s.length * 2;
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const all = wrapText(text, 40, measure);
    expect(wrapText(text, 40, measure, 3)).toEqual(all.slice(0, 3));
    expect(wrapText(text, 40, measure, 1)).toEqual(all.slice(0, 1));
    expect(wrapText(text, 40, measure, 1000)).toEqual(all);
    // a paragraph break and a word wider than a line
    const mixed = "alpha\n\nabcdefghijklmnopqrstuvwxyz0123456789\nomega";
    const full = wrapText(mixed, 20, measure);
    for (let k = 1; k <= full.length; k++) expect(wrapText(mixed, 20, measure, k), `k=${k}`).toEqual(full.slice(0, k));
    const fit = fitText(text, { w: 90, h: 40 }, (size) => (s: string) => s.length * size * 0.5, { multiline: true });
    expect(fit.lines.join(" ").replace(/…$/, "").trim().length).toBeGreaterThan(0);
  });
});

describe("a document at the page limit", () => {
  const pass = "limit-test";
  let p12: Uint8Array;
  beforeAll(() => {
    p12 = createSelfSignedP12({ commonName: "Halo Doc Sign test", organization: "Vircle", country: "MY", passphrase: pass, bits: 1024 });
  });
  const cert: CertificateData = {
    title: "Long agreement",
    reference: "SGN-2026-000200",
    workspaceName: "Vircle Sdn Bhd",
    baseSha256: "a".repeat(64),
    pageCount: 200,
    chainHead: "b".repeat(64),
    verifyUrl: "https://halo.vircle.tech/verify/x",
    sentAt: new Date(Date.UTC(2026, 9, 6, 2, 0)),
    completedAt: new Date(Date.UTC(2026, 9, 6, 8, 30)),
    signers: [{ name: "Ali", email: "ali@example.com", role: "Merchant", order: 1, status: "signed", signedAt: new Date(Date.UTC(2026, 9, 6, 6, 3)), ip: "203.0.113.9", device: "Chrome", channel: "Email" }],
    events: [{ at: new Date(Date.UTC(2026, 9, 6, 2, 0)), text: "Sent" }],
    timeZone: "UTC",
  };
  const field: PlacedField = { key: "t", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.2, w: 0.4, h: 0.04, required: true };

  it("is sealed at 200 pages, with the certificate pages after them, and the seal verifies", async () => {
    const base = await makePdf(Array.from({ length: 200 }, () => ({ ...A4 })));
    const stamped = await stampFields(base, [field], { t: { text: "x" } });
    const certified = await appendCertificate(stamped.bytes, cert);
    expect(certified.pagesAdded).toBeGreaterThan(0);
    const sealed = await sealPdf(certified.bytes, p12, pass, { signingTime: new Date() });
    expect(verifySealed(sealed.bytes)).toMatchObject({ ok: true, signatureValid: true });
  }, 120_000);

  it("still refuses a file that is far past the limit when it is sealed", async () => {
    const base = await makePdf(Array.from({ length: 260 }, () => ({ ...A4 })));
    await expect(sealPdf(base, p12, pass)).rejects.toMatchObject({ code: "pdf_too_many_pages" });
  }, 120_000);
});
