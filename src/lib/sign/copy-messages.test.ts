import { describe, expect, it } from "vitest";

import { copyEmail, copyWordsFor, envelopeCopyEmail } from "./copy-messages";
import { deliverCopy, deliverEnvelopeCopy, type DocFacts, type EnvelopeFacts, type NotifyDeps, type Workspace } from "./notify";
import type { SignLocale } from "./types";

// The words of the message a person who receives a copy gets (migration 175), in the four languages, and how the attachments are handled.

const LOCALES: SignLocale[] = ["en", "ms", "zh", "ko"];
const VERIFY = "https://halo.test/verify/11111111-1111-4111-8111-111111111111";
const base = { workspace: "Vircle Sdn Bhd", sender: "Gokula", name: "Cara Lim", title: "Merchant Agreement" };
const noPlaceholders = (r: { subject: string; html: string; text: string }) => {
  for (const part of [r.subject, r.html, r.text]) expect(part).not.toMatch(/\{\w+\}/);
};

describe.each(LOCALES)("copyEmail in %s", (locale) => {
  it("names the document, the sender and the workspace, and says the signed copy is attached, with no link and no placeholder left", () => {
    const m = copyEmail({ ...base, locale, attached: true, verifyUrl: VERIFY });
    noPlaceholders(m);
    expect(m.subject).toContain("Merchant Agreement");
    for (const part of [m.text, m.html]) {
      expect(part).toContain("Cara Lim");
      expect(part).toContain("Gokula");
      expect(part).toContain("Vircle Sdn Bhd");
      expect(part).toContain("Merchant Agreement");
    }
    // attached: no link at all (the verify page is named only when the file could not be attached)
    expect(m.text).not.toContain("http");
    expect(m.html).not.toContain("href=");
    expect(m.text).toContain(copyWordsFor(locale).attached);
    expect(m.text).toContain(copyWordsFor(locale).nothingToDo);
  });

  it("says the file is too large to attach, tells whom to ask, and names the page that checks the document, with that one link only", () => {
    const m = copyEmail({ ...base, locale, attached: false, verifyUrl: VERIFY });
    noPlaceholders(m);
    expect(m.text).toContain(copyWordsFor(locale).tooLarge.replace("{sender}", "Gokula"));
    expect(m.text).not.toContain(copyWordsFor(locale).attached);
    expect(m.text).toContain(VERIFY);
    expect(m.html.match(/href="[^"]+"/g)).toEqual([`href="${VERIFY}"`]);
    expect([...m.text.matchAll(/https?:\/\/\S+/g)].map((x) => x[0])).toEqual([VERIFY]);
  });

  it("does not make up a link when none is given", () => {
    const m = copyEmail({ ...base, locale, attached: false });
    expect(m.text).not.toContain("http");
    expect(m.html).not.toContain("href=");
  });

  it("uses the form's words for a form without a signature: the record of what was submitted, and never 'signed'", () => {
    const sign = copyEmail({ ...base, locale, attached: true });
    const form = copyEmail({ ...base, locale, attached: true, mode: "form" });
    noPlaceholders(form);
    expect(form.subject).not.toBe(sign.subject);
    expect(form.text).toContain(copyWordsFor(locale).formAttached);
    expect(form.text).not.toContain(copyWordsFor(locale).attached);
    expect(form.subject).toBe(copyWordsFor(locale).formSubject.replace("{title}", "Merchant Agreement"));
  });
});

describe.each(LOCALES)("envelopeCopyEmail in %s", (locale) => {
  const args = { ...base, locale, title: "Onboarding pack", count: 3 };

  it("says how many documents and that every signed copy is attached when they all are", () => {
    const m = envelopeCopyEmail({ ...args, attachedCount: 3 });
    noPlaceholders(m);
    expect(m.subject).toContain("Onboarding pack");
    expect(m.subject).toContain("3");
    expect(m.text).toContain(copyWordsFor(locale).collectionAttached.replace("{count}", "3"));
    expect(m.text).not.toContain("http");
    expect(m.html).not.toContain("href=");
  });

  it("says how many were attached, whom to ask for the rest, and lists each document that did not fit with the page that checks it", () => {
    const missing = [
      { title: "Fee Schedule", verifyUrl: "https://halo.test/verify/22222222-2222-4222-8222-222222222222" },
      { title: "Data Terms", verifyUrl: "https://halo.test/verify/33333333-3333-4333-8333-333333333333" },
    ];
    const m = envelopeCopyEmail({ ...args, attachedCount: 1, notAttached: missing });
    noPlaceholders(m);
    expect(m.text).toContain(copyWordsFor(locale).collectionSomeAttached.replace("{attached}", "1").replace("{count}", "3").replace("{sender}", "Gokula"));
    for (const x of missing) {
      expect(m.text).toContain(`${x.title}: ${x.verifyUrl}`);
      expect(m.html).toContain(`href="${x.verifyUrl}"`);
    }
    expect(m.html.match(/href="[^"]+"/g)).toHaveLength(2);
  });

  it("says none could be attached when none was", () => {
    const m = envelopeCopyEmail({ ...args, attachedCount: 0, notAttached: [{ title: "A", verifyUrl: VERIFY }] });
    noPlaceholders(m);
    expect(m.text).toContain(copyWordsFor(locale).collectionNoneAttached.replace("{sender}", "Gokula"));
    expect(m.text).not.toContain(copyWordsFor(locale).collectionAttached.replace("{count}", "3"));
  });

  it("uses the form's words when every document is a form", () => {
    const sign = envelopeCopyEmail({ ...args, attachedCount: 3 });
    const form = envelopeCopyEmail({ ...args, attachedCount: 3, mode: "form" });
    noPlaceholders(form);
    expect(form.subject).not.toBe(sign.subject);
    expect(form.text).toContain(copyWordsFor(locale).collectionFormAttached.replace("{count}", "3"));
    expect(form.text).toContain(copyWordsFor(locale).collectionFormIntro.replace("{name}", "Cara Lim").replace("{sender}", "Gokula").replace("{workspace}", "Vircle Sdn Bhd").replace("{title}", "Onboarding pack").replace("{count}", "3"));
  });
});

describe("the words themselves", () => {
  it("every language has every word, every placeholder it uses is one the message fills, and the languages use the same placeholders", () => {
    const en = copyWordsFor("en") as unknown as Record<string, string>;
    const known = new Set(["name", "sender", "workspace", "title", "count", "attached"]);
    for (const locale of LOCALES) {
      const words = copyWordsFor(locale) as unknown as Record<string, string>;
      expect(Object.keys(words).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(words)) {
        expect(text.trim().length).toBeGreaterThan(5);
        const used = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(used.every((p) => known.has(p))).toBe(true);
        expect(used).toEqual([...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
      }
    }
    // an unknown language falls back to English
    expect(copyWordsFor("fr" as SignLocale)).toBe(copyWordsFor("en"));
  });

  it("escapes what a sender or a workspace typed in the HTML, and keeps a line break out of the subject", () => {
    const m = copyEmail({ locale: "en", workspace: "A & B <Co>", sender: "Mr <b>X</b>", name: "<script>alert(1)</script>", title: "Deal\r\nBcc: attacker@example.com", attached: false, verifyUrl: VERIFY });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>X</b>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("A &amp; B &lt;Co&gt;");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe("Signed copy: Deal Bcc: attacker@example.com");
  });
});

// ---- delivery: what is attached -------------------------------------------------------------------

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: string }[];
}
const sent: Sent[] = [];
const deps = (over: Partial<NotifyDeps> = {}): NotifyDeps => ({
  emailConfigured: () => true,
  sendEmail: async (a) => void sent.push({ to: a.to, subject: a.subject, text: a.text, html: a.html, attachments: a.attachments as Sent["attachments"] }) as never,
  loadIdentity: async () => ({ fromName: "Vircle" }),
  sendWhatsApp: async () => {},
  ...over,
});
const doc: DocFacts = { accountId: "a", title: "Merchant Agreement", reference: "SGN-1", locale: "en", expiresAt: null, codeRequired: false, message: null };
const env: EnvelopeFacts = { accountId: "a", title: "Onboarding pack", reference: "ENV-1", locale: "ms", expiresAt: null, codeRequired: false, message: null, documents: ["One", "Two", "Three"] };
const w: Workspace = { name: "Vircle Sdn Bhd", senderName: "Gokula", settings: null };
const to = { name: "Cara Lim", email: "cara@kedai.example" };
const file = (n: number, filename: string, extra: object = {}) => ({ bytes: new Uint8Array(n).fill(1), filename, title: filename.replace(".pdf", ""), verifyUrl: `https://halo.test/verify/${filename}`, ...extra });
const MB = 1024 * 1024;

describe("deliverCopy and deliverEnvelopeCopy", () => {
  it("attaches a file of 20 MB or less under its own name, and not one byte more", async () => {
    sent.length = 0;
    expect(await deliverCopy(deps(), doc, w, to, { bytes: new Uint8Array(20 * MB), filename: "SGN-1-signed.pdf" }, VERIFY)).toEqual({ channel: "email", status: "sent" });
    expect(sent[0].attachments).toHaveLength(1);
    expect(sent[0].attachments![0].filename).toBe("SGN-1-signed.pdf");
    expect(Buffer.from(sent[0].attachments![0].content, "base64").length).toBe(20 * MB);
    sent.length = 0;
    await deliverCopy(deps(), doc, w, to, { bytes: new Uint8Array(20 * MB + 1), filename: "SGN-1-signed.pdf" }, VERIFY);
    expect(sent[0].attachments).toBeUndefined();
    expect(sent[0].text).toContain(VERIFY);
    // no file at all (a caller that has none): the same words as too large
    sent.length = 0;
    await deliverCopy(deps(), doc, w, to, null, VERIFY);
    expect(sent[0].attachments).toBeUndefined();
  });

  it("fits a collection's files in 20 MB in all, in order; a file that does not fit is skipped and a later smaller one may still go", async () => {
    sent.length = 0;
    await deliverEnvelopeCopy(deps(), env, w, to, [file(12 * MB, "One.pdf"), file(12 * MB, "Two.pdf"), file(6 * MB, "Three.pdf")]);
    expect(sent[0].attachments!.map((a) => a.filename)).toEqual(["One.pdf", "Three.pdf"]);
    // the message says which were left out, by title and with the page that checks each
    expect(sent[0].text).toContain("Two: https://halo.test/verify/Two.pdf");
    expect(sent[0].text).not.toContain("verify/One.pdf");
    expect(sent[0].text).not.toContain("verify/Three.pdf");
    // in the language of the collection
    expect(sent[0].subject).toBe(copyWordsFor("ms").collectionSubject.replace("{title}", "Onboarding pack").replace("{count}", "3"));
  });

  it("reports a failure instead of throwing, and not_configured when there is no mail sender", async () => {
    const failing = deps({ sendEmail: async () => { throw new Error("mailbox unavailable"); } });
    expect(await deliverCopy(failing, doc, w, to, { bytes: new Uint8Array(10), filename: "x.pdf" }, VERIFY)).toEqual({ channel: "email", status: "failed", detail: "mailbox unavailable" });
    expect(await deliverEnvelopeCopy(failing, env, w, to, [file(10, "One.pdf")])).toMatchObject({ status: "failed" });
    const none = deps({ emailConfigured: () => false });
    expect(await deliverCopy(none, doc, w, to, null, VERIFY)).toMatchObject({ status: "not_configured" });
  });
});
