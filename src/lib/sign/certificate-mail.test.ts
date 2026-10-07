import { describe, expect, it } from "vitest";

import type { MailboxState, OutgoingEmail } from "@/lib/email/mailbox-types";
import { GMAIL_ATTACH_BYTES } from "@/lib/email/gmail-sender";
import { MS365_ATTACH_BYTES } from "@/lib/email/ms365-sender";

import { certificateMailWords, certificateSentence, certificatesSentence } from "./certificate-mail-words";
import { copyEmail, envelopeCopyEmail } from "./copy-messages";
import { envelopeCompletedEmail } from "./envelope-messages";
import { completedEmail } from "./messages";
import { deliverCompleted, deliverCopy, deliverEnvelopeCompleted, deliverEnvelopeCopy, type DocFacts, type EnvelopeFacts, type NotifyDeps, type SignedMailFile, type Workspace } from "./notify";
import type { SignLocale } from "./types";

// The signed-copy emails when the certificate is a file of its own (migration 178): the signed document(s) AND the certificate(s) go as separate
// attachments within the transport's attachment budget (2.5 MB through Microsoft 365, 17 MB through Gmail, 20 MB through the platform sender); whatever does
// not fit goes the way a file that does not fit always did, and the words say exactly what is attached.

const MB = 1024 * 1024;
const doc: DocFacts = { accountId: "acct", title: "Merchant Application", reference: "SGN-1", locale: "en", expiresAt: null, codeRequired: false, message: null };
const env: EnvelopeFacts = { accountId: "acct", title: "Onboarding pack", reference: "COL-1", locale: "en", expiresAt: null, codeRequired: false, message: null, documents: ["One", "Two", "Three"] };
const ws: Workspace = { name: "Vircle", senderName: "Gokula", settings: null };
const to = { name: "Ali", email: "ali@example.com", channel: "email" as const, locale: "en" as const };
const file = (mb: number, filename: string) => ({ bytes: new Uint8Array(Math.floor(mb * MB)).fill(1), filename });
const signed = (mb: number, certMb?: number): SignedMailFile => ({ ...file(mb, "SGN-1-signed.pdf"), ...(certMb === undefined ? {} : { certificate: file(certMb, "SGN-1-certificate.pdf") }) });

function world(attachBytes: number, provider: "microsoft365" | "gmail" | "platform" = "microsoft365") {
  const sent: OutgoingEmail[] = [];
  const state: MailboxState = provider === "platform" ? { kind: "none" } : { kind: "ready", provider, address: "support@vircle.com", attachBytes, send: async (m) => void sent.push(m) };
  const deps: NotifyDeps = {
    emailConfigured: () => provider === "platform",
    sendEmail: async (a) => void sent.push(a as unknown as OutgoingEmail),
    loadIdentity: async () => ({ fromName: "Vircle" }),
    sendWhatsApp: async () => {},
    mailbox: async () => state,
  };
  return { deps, sent };
}
const names = (m: OutgoingEmail) => (m.attachments ?? []).map((a) => a.filename);

describe("the signers' and the sender's signed copy (one document)", () => {
  it("attaches both files through each transport when both fit", async () => {
    for (const [attach, provider] of [[MS365_ATTACH_BYTES, "microsoft365"], [GMAIL_ATTACH_BYTES, "gmail"], [0, "platform"]] as const) {
      const w = world(attach, provider);
      await deliverCompleted(w.deps, doc, ws, to, signed(1, 0.2));
      expect(names(w.sent[0]), provider).toEqual(["SGN-1-signed.pdf", "SGN-1-certificate.pdf"]);
      expect(w.sent[0].text).toContain("The signed copy is attached to this message.");
      expect(w.sent[0].text).toContain("The certificate is attached to this message as a separate file.");
    }
  });

  it("through Microsoft 365 (2.5 MB in all) the certificate that no longer fits is named as not attached, the signed document that fits still goes", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverCompleted(w.deps, doc, ws, to, signed(2.4, 0.2));
    expect(names(w.sent[0])).toEqual(["SGN-1-signed.pdf"]);
    expect(w.sent[0].text).toContain("The signed copy is attached to this message.");
    expect(w.sent[0].text).toContain("The certificate is a separate file that could not be attached to this message.");
    expect(w.sent[0].text).not.toContain("The certificate is attached");
  });

  it("when the signed document is too large and the certificate is not, only the certificate goes and the message does not claim the signed copy", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverCompleted(w.deps, doc, ws, to, signed(3, 0.2));
    expect(names(w.sent[0])).toEqual(["SGN-1-certificate.pdf"]);
    expect(w.sent[0].text).not.toContain("The signed copy is attached");
    expect(w.sent[0].text).toContain("The certificate is attached to this message as a separate file.");
  });

  it("holds the budget in all, not for each file: Gmail 17 MB and the platform sender's 20 MB", async () => {
    const gmail = world(GMAIL_ATTACH_BYTES, "gmail");
    await deliverCompleted(gmail.deps, doc, ws, to, signed(16.9, 0.3));
    expect(names(gmail.sent[0])).toEqual(["SGN-1-signed.pdf"]);
    const fits = world(GMAIL_ATTACH_BYTES, "gmail");
    await deliverCompleted(fits.deps, doc, ws, to, signed(16.5, 0.3));
    expect(names(fits.sent[0])).toHaveLength(2);
    const platform = world(0, "platform");
    await deliverCompleted(platform.deps, doc, ws, to, signed(19.9, 0.2));
    expect(names(platform.sent[0])).toEqual(["SGN-1-signed.pdf"]);
    const big = world(0, "platform");
    await deliverCompleted(big.deps, doc, ws, to, signed(21, 0.2));
    expect(names(big.sent[0])).toEqual(["SGN-1-certificate.pdf"]);
  });

  it("is exactly what it was for a document whose certificate is inside the signed PDF: one attachment, no sentence about a certificate file", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverCompleted(w.deps, doc, ws, to, signed(1));
    expect(names(w.sent[0])).toEqual(["SGN-1-signed.pdf"]);
    expect(w.sent[0].text).toContain("The signed copy is attached to this message.");
    expect(w.sent[0].text).not.toMatch(/separate file/);
    const completed = completedEmail({ locale: "en", workspace: "Vircle", name: "Ali", title: "T", attached: true });
    expect(completed.text).not.toMatch(/certificate/i);
  });

  it("says 'the signed document and its certificate' where it offers a link, when the certificate is a file of its own", () => {
    const own = completedEmail({ locale: "en", workspace: "Vircle", name: "Ali", title: "T", attached: false, downloadUrl: "https://halo.test/s/x", certificate: "attached" });
    expect(own.text).toContain("You can also download the signed document and its certificate here:");
    expect(own.text).toContain("https://halo.test/s/x");
    const old = completedEmail({ locale: "en", workspace: "Vircle", name: "Ali", title: "T", attached: false, downloadUrl: "https://halo.test/s/x" });
    expect(old.text).toContain("You can also download it here:");
  });
});

describe("a copy for a person who receives one (one document)", () => {
  const verify = "https://halo.test/verify/d1";

  it("attaches both, says the copy and the certificate are attached (and no longer says the copy 'includes the certificate pages')", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverCopy(w.deps, doc, ws, { name: "Cara", email: "cara@example.com" }, signed(1, 0.2), verify);
    expect(names(w.sent[0])).toEqual(["SGN-1-signed.pdf", "SGN-1-certificate.pdf"]);
    expect(w.sent[0].text).toContain("The signed copy is attached to this message.");
    expect(w.sent[0].text).toContain("The certificate is attached to this message as a separate file.");
    expect(w.sent[0].text).not.toContain("certificate pages");
    expect(w.sent[0].text).not.toContain(verify);
  });

  it("names the page that checks the copy when it is too large, still attaches the certificate that fits, and asks the sender for what is missing; never a download link", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverCopy(w.deps, doc, ws, { name: "Cara", email: "cara@example.com" }, signed(3, 0.2), verify);
    expect(names(w.sent[0])).toEqual(["SGN-1-certificate.pdf"]);
    expect(w.sent[0].text).toContain("The signed copy is too large to attach. Ask Gokula for it.");
    expect(w.sent[0].text).toContain(verify);
    expect(w.sent[0].text).toContain("The certificate is attached to this message as a separate file.");
    const tight = world(MS365_ATTACH_BYTES);
    await deliverCopy(tight.deps, doc, ws, { name: "Cara", email: "cara@example.com" }, signed(2.45, 0.2), verify);
    expect(names(tight.sent[0])).toEqual(["SGN-1-signed.pdf"]);
    expect(tight.sent[0].text).toContain("is a separate file that could not be attached to this message: ask Gokula for it.");
  });

  it("is the old message for a document whose certificate is inside the signed PDF", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverCopy(w.deps, doc, ws, { name: "Cara", email: "cara@example.com" }, signed(1), verify);
    expect(names(w.sent[0])).toEqual(["SGN-1-signed.pdf"]);
    expect(w.sent[0].text).toContain("It includes the certificate pages that record who signed and when.");
  });
});

describe("a collection", () => {
  const pair = (n: number, mb: number, certMb: number): SignedMailFile & { title: string; verifyUrl: string } => ({
    bytes: new Uint8Array(Math.floor(mb * MB)).fill(1),
    filename: `D${n}-signed.pdf`,
    certificate: { bytes: new Uint8Array(Math.floor(certMb * MB)).fill(1), filename: `D${n}-certificate.pdf` },
    title: `Document ${n}`,
    verifyUrl: `https://halo.test/verify/d${n}`,
  });

  it("attaches each document's file, then its certificate, in order while they fit: a big document is left out, the small certificates still go", async () => {
    const w = world(GMAIL_ATTACH_BYTES, "gmail");
    await deliverEnvelopeCompleted(w.deps, env, ws, to, [pair(1, 10, 0.1), pair(2, 10, 0.1), pair(3, 5, 0.1)]);
    expect(names(w.sent[0])).toEqual(["D1-signed.pdf", "D1-certificate.pdf", "D2-certificate.pdf", "D3-signed.pdf", "D3-certificate.pdf"]);
    expect(w.sent[0].text).toContain("2 of the 3 signed copies are attached");
    expect(w.sent[0].text).toContain("The 3 certificates are attached to this message as separate files.");
  });

  it("says how many of the certificates are attached, and where the rest are to be had (the signer's own link; the sender for a person who receives a copy)", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverEnvelopeCompleted(w.deps, env, ws, to, [pair(1, 2.2, 0.2), pair(2, 0.1, 0.1), pair(3, 0.1, 0.1)]);
    // 2.2 + 0.2 = 2.4, then 0.1 more fits, nothing after
    expect(names(w.sent[0])).toEqual(["D1-signed.pdf", "D1-certificate.pdf", "D2-signed.pdf"]);
    expect(w.sent[0].text).toContain("1 of the 3 certificates are attached to this message as separate files. The others could not be attached: open your signing link to download them.");
    const copy = world(MS365_ATTACH_BYTES);
    await deliverEnvelopeCopy(copy.deps, env, ws, { name: "Cara", email: "cara@example.com" }, [pair(1, 2.2, 0.2), pair(2, 0.1, 0.1), pair(3, 0.1, 0.1)]);
    expect(copy.sent[0].text).toContain("1 of the 3 certificates are attached to this message as separate files. The others could not be attached: ask Gokula for them.");
    expect(copy.sent[0].text).toContain("2 of the 3 signed copies are attached");
    expect(copy.sent[0].text).toContain("Document 3: https://halo.test/verify/d3");
  });

  it("says the certificates are separate files that could not be attached when none fits", async () => {
    const w = world(MS365_ATTACH_BYTES);
    await deliverEnvelopeCompleted(w.deps, env, ws, to, [pair(1, 2.5, 0.1), pair(2, 1, 0.1)]);
    expect(names(w.sent[0])).toEqual(["D1-signed.pdf"]);
    expect(w.sent[0].text).toContain("The certificates are separate files and could not be attached to this message: open your signing link to download them.");
  });

  it("does not say 'the signed copies include the certificate pages' to a person who receives a copy when the certificates are files of their own; an older collection still does", async () => {
    const own = world(GMAIL_ATTACH_BYTES, "gmail");
    await deliverEnvelopeCopy(own.deps, env, ws, { name: "Cara", email: "cara@example.com" }, [pair(1, 1, 0.1), pair(2, 1, 0.1), pair(3, 1, 0.1)]);
    expect(own.sent[0].text).toContain("The 3 signed copies are attached to this message.");
    expect(own.sent[0].text).not.toContain("certificate pages");
    const old = world(GMAIL_ATTACH_BYTES, "gmail");
    await deliverEnvelopeCopy(old.deps, env, ws, { name: "Cara", email: "cara@example.com" }, [1, 2, 3].map((n) => ({ ...file(1, `D${n}-signed.pdf`), title: `Document ${n}`, verifyUrl: `https://halo.test/verify/d${n}` })));
    expect(old.sent[0].text).toContain("They include the certificate pages that record who signed and when.");
    expect(old.sent[0].text).not.toContain("separate file");
  });
});

describe("the words, in every language", () => {
  const LOCALES: SignLocale[] = ["en", "ms", "zh", "ko"];
  const unfilled = (s: string) => /\{\w+\}/.test(s);

  it("has every sentence in every language, nothing left unfilled, and different from English outside English", () => {
    for (const locale of LOCALES) {
      const words = certificateMailWords(locale);
      for (const [key, value] of Object.entries(words)) {
        expect(value, `${locale}.${key}`).toBeTruthy();
        if (locale !== "en") expect(value, `${locale}.${key}`).not.toBe((certificateMailWords("en") as unknown as Record<string, string>)[key]);
      }
      for (const state of ["attached", "missing"] as const) {
        const s = certificateSentence(locale, state, { sender: "Gokula" });
        expect(s, `${locale} ${state}`).toBeTruthy();
        expect(unfilled(s!), `${locale} ${state}`).toBe(false);
      }
      expect(certificateSentence(locale, "none")).toBeNull();
      for (const a of [{ total: 3, attached: 3 }, { total: 3, attached: 1 }, { total: 3, attached: 0 }]) {
        for (const sender of [undefined, "Gokula"]) {
          const s = certificatesSentence(locale, { ...a, sender });
          expect(s, `${locale} ${JSON.stringify(a)}`).toBeTruthy();
          expect(unfilled(s!), `${locale} ${JSON.stringify(a)}`).toBe(false);
        }
      }
      expect(certificatesSentence(locale, { total: 0, attached: 0 })).toBeNull();
    }
  });

  it("puts the sentences into the three emails, in the language of the document", () => {
    for (const locale of LOCALES) {
      const a = completedEmail({ locale, workspace: "Vircle", name: "Ali", title: "T", attached: true, certificate: "attached" });
      expect(a.text, locale).toContain(certificateSentence(locale, "attached")!);
      expect(a.html, locale).toContain(certificateSentence(locale, "attached")!.slice(0, 12));
      const c = copyEmail({ locale, workspace: "Vircle", sender: "Gokula", name: "Cara", title: "T", attached: true, verifyUrl: "https://x/verify/1", certificate: "missing" });
      expect(c.text, locale).toContain(certificateSentence(locale, "missing", { sender: "Gokula" })!);
      expect(c.text, locale).toContain(certificateMailWords(locale).signedAttached);
      const ec = envelopeCompletedEmail({ locale, workspace: "Vircle", name: "Ali", title: "T", count: 3, attachedCount: 3, certificates: { total: 3, attached: 3 } });
      expect(ec.text, locale).toContain(certificatesSentence(locale, { total: 3, attached: 3 })!);
      const cc = envelopeCopyEmail({ locale, workspace: "Vircle", sender: "Gokula", name: "Cara", title: "T", count: 3, attachedCount: 3, certificates: { total: 3, attached: 1 } });
      expect(cc.text, locale).toContain(certificatesSentence(locale, { total: 3, attached: 1, sender: "Gokula" })!);
      expect(cc.text, locale).toContain(certificateMailWords(locale).signedCopiesAttached.replace("{count}", "3"));
      for (const m of [a, c, ec, cc]) expect(unfilled(m.text) || unfilled(m.html), locale).toBe(false);
    }
  });
});
