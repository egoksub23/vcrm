import { describe, expect, it } from "vitest";

import { codeEmail, completedEmail, declinedEmail, escapeHtml, expiredEmail, fill, invitationEmail, longDate, reminderEmail, voidedEmail, wordsFor } from "./messages";
import { SIGN_LOCALES } from "./types";

const base = {
  workspace: "Vircle Sdn Bhd",
  sender: "Gokula",
  signerName: "Ali bin Ahmad",
  title: "Merchant Application Form",
  link: "https://halo.vircle.tech/s/" + "a".repeat(64),
  codeRequired: false,
};

describe("every language says everything", () => {
  it("has the same wording keys in all four", () => {
    const keys = Object.keys(wordsFor("en")).sort();
    for (const l of SIGN_LOCALES) {
      expect(Object.keys(wordsFor(l)).sort()).toEqual(keys);
      for (const k of keys) expect((wordsFor(l) as unknown as Record<string, string>)[k].length, `${l}.${k}`).toBeGreaterThan(3);
    }
  });

  it("keeps the same placeholders in every language", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const en = wordsFor("en") as unknown as Record<string, string>;
    for (const l of SIGN_LOCALES) {
      const w = wordsFor(l) as unknown as Record<string, string>;
      for (const k of Object.keys(en)) expect(placeholders(w[k]), `${l}.${k}`).toEqual(placeholders(en[k]));
    }
  });
});

describe("fill", () => {
  it("substitutes known placeholders and leaves unknown ones", () => {
    expect(fill("Hi {name}, {x}", { name: "Ali" })).toBe("Hi Ali, {x}");
  });

  it("puts values on one line so a subject cannot gain a header", () => {
    expect(fill("{title}", { title: "A\r\nBcc: evil@example.com" })).toBe("A Bcc: evil@example.com");
  });
});

describe("invitationEmail", () => {
  it("names the sender, the workspace and the document, and carries the link", () => {
    const m = invitationEmail({ ...base, locale: "en", expiresAt: new Date("2026-10-20T00:00:00Z") });
    expect(m.subject).toBe("Gokula asked you to sign: Merchant Application Form");
    expect(m.text).toContain("Hello Ali bin Ahmad, Gokula at Vircle Sdn Bhd has sent you");
    expect(m.text).toContain(base.link);
    expect(m.text).toContain("20 Oct 2026");
    expect(m.html).toContain(`href="${base.link}"`);
    expect(m.text).not.toContain("6-digit");
  });

  it("mentions the code only when one is required, and quotes the sender's message", () => {
    const m = invitationEmail({ ...base, locale: "en", codeRequired: true, message: "Please sign by Friday.\nThanks!" });
    expect(m.text).toContain("6-digit code");
    expect(m.text).toContain("Please sign by Friday.");
    expect(m.html).toContain("white-space: pre-wrap");
  });

  it("asks a filler to complete, not to sign", () => {
    const m = invitationEmail({ ...base, locale: "en", fill: true });
    expect(m.subject).toBe("Gokula asked you to complete: Merchant Application Form");
    expect(m.html).toContain("Open and complete");
  });

  it("is written in the document's language", () => {
    expect(invitationEmail({ ...base, locale: "ms" }).subject).toBe("Gokula meminta anda menandatangani: Merchant Application Form");
    expect(invitationEmail({ ...base, locale: "zh" }).subject).toBe("Gokula 请您签署：Merchant Application Form");
    expect(invitationEmail({ ...base, locale: "ko" }).subject).toBe("Gokula님이 서명을 요청했습니다: Merchant Application Form");
  });

  it("escapes everything a person typed, in the HTML", () => {
    const m = invitationEmail({ ...base, locale: "en", title: "<script>alert(1)</script>", sender: 'Ev"il <b>', signerName: "A&B", message: "<img src=x onerror=y>" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("<b>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("A&amp;B");
  });
});

describe("the other messages", () => {
  it("reminds", () => {
    const m = reminderEmail({ ...base, locale: "en" });
    expect(m.subject).toBe("Reminder: please sign Merchant Application Form");
    expect(m.text).toContain(base.link);
  });

  it("sends a code, large, with its lifetime", () => {
    const m = codeEmail({ locale: "en", workspace: "Vircle", title: "Doc", code: "042917" });
    expect(m.text).toContain("042917");
    expect(m.text).toContain("10 minutes");
    expect(m.html).toContain("042917");
  });

  it("announces completion, with the copy attached or linked", () => {
    const m = completedEmail({ locale: "en", workspace: "Vircle", name: "Ali", title: "Doc", attached: true, downloadUrl: "https://x/y" });
    expect(m.subject).toBe("Signed: Doc");
    expect(m.text).toContain("attached");
    expect(m.text).toContain("https://x/y");
    expect(completedEmail({ locale: "en", workspace: "V", name: "A", title: "D", attached: false }).text).not.toContain("attached");
  });

  it("reports a decline with its reason, an expiry and a cancellation", () => {
    expect(declinedEmail({ locale: "en", workspace: "V", name: "Ali", title: "Doc", reason: "Clause 4" }).text).toContain("Reason given: Clause 4");
    expect(declinedEmail({ locale: "en", workspace: "V", name: "Ali", title: "Doc" }).text).not.toContain("Reason");
    expect(expiredEmail({ locale: "ms", workspace: "V", title: "Doc" }).subject).toBe("Tamat tempoh: Doc");
    expect(voidedEmail({ locale: "zh", workspace: "V", title: "Doc" }).subject).toBe("已取消：Doc");
  });
});

describe("helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("writes a date in the reader's language", () => {
    const d = new Date("2026-10-06T08:00:00Z");
    expect(longDate(d, "en")).toBe("6 Oct 2026");
    expect(longDate(d, "zh")).toMatch(/2026/);
    expect(longDate(d, "en", "Not/AZone")).toMatch(/2026/);
  });
});
