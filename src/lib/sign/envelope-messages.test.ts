import { describe, expect, it } from "vitest";

import { envelopeCompletedEmail, envelopeInvitationEmail, envelopeReminderEmail, envelopeWordsFor } from "./envelope-messages";
import { SIGN_LOCALES, type SignLocale } from "./types";

const base = { workspace: "Vircle Sdn Bhd", sender: "Gokula", signerName: "Ali", title: "Onboarding pack", documents: ["Merchant Agreement", "Fee Schedule", "Data terms"], link: "https://halo.test/s/abc", codeRequired: false } as const;

describe("the envelope's invitation", () => {
  it("is ONE message with one link, the count in the subject and every document named in order", () => {
    const m = envelopeInvitationEmail({ ...base, locale: "en", expiresAt: new Date("2026-10-20T08:00:00Z"), timeZone: "Asia/Kuala_Lumpur", message: "Please sign today." });
    expect(m.subject).toBe("Gokula asked you to sign 3 documents: Onboarding pack");
    expect(m.text).toContain("1. Merchant Agreement");
    expect(m.text).toContain("3. Data terms");
    expect(m.text.match(/https:\/\/halo\.test\/s\/abc/g)).toHaveLength(1);
    expect(m.text).toContain("Please sign today.");
    expect(m.text).toContain("20 Oct 2026");
    expect(m.html).toContain("<ol");
    expect(m.html).toContain("Merchant Agreement");
  });

  it("says complete, not sign, when the person only fills in", () => {
    const m = envelopeInvitationEmail({ ...base, locale: "en", fill: true });
    expect(m.subject).toBe("Gokula asked you to complete 3 documents: Onboarding pack");
    expect(m.text).toContain("to complete.");
  });

  it("mentions the code only when one is needed", () => {
    expect(envelopeInvitationEmail({ ...base, locale: "en", codeRequired: false }).text).not.toContain("6-digit");
    expect(envelopeInvitationEmail({ ...base, locale: "en", codeRequired: true }).text).toContain("6-digit");
  });

  it("never lets a title with a line break add a header to the subject, and escapes what goes in the page", () => {
    const m = envelopeInvitationEmail({ ...base, locale: "en", title: "Pack\r\nBcc: x@evil.example", documents: ["<script>alert(1)</script>", "B"] });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});

describe("the envelope's reminder", () => {
  it("names only what is left and tells the person the earlier link no longer works", () => {
    const m = envelopeReminderEmail({ ...base, locale: "en", documents: ["Fee Schedule"] });
    // one left: said in the singular
    expect(m.subject).toBe("Reminder: please sign Onboarding pack");
    expect(m.text).toContain("1. Fee Schedule");
    expect(m.text).not.toContain("Merchant Agreement");
    expect(m.text).toContain("no longer works");
    // several left: the count is said
    const many = envelopeReminderEmail({ ...base, locale: "en", documents: ["Fee Schedule", "Data terms"] });
    expect(many.subject).toBe("Reminder: please sign 2 documents: Onboarding pack");
    expect(many.text).toContain("the 2 documents in");
  });
});

describe("the envelope's completion message", () => {
  const args = { locale: "en", workspace: "Vircle Sdn Bhd", name: "Ali", title: "Onboarding pack", count: 3 } as const;

  it("says how many signed copies are attached, all, some or none", () => {
    expect(envelopeCompletedEmail({ ...args, attachedCount: 3 }).text).toContain("The 3 signed copies are attached");
    expect(envelopeCompletedEmail({ ...args, attachedCount: 2 }).text).toContain("2 of the 3 signed copies are attached");
    expect(envelopeCompletedEmail({ ...args, attachedCount: 0 }).text).toContain("too large to attach");
    expect(envelopeCompletedEmail({ ...args, attachedCount: 3 }).subject).toBe("Signed: Onboarding pack (3 documents)");
  });

  it("words a pack of forms as received, with records", () => {
    const m = envelopeCompletedEmail({ ...args, attachedCount: 3, mode: "form" });
    expect(m.subject).toBe("Received: Onboarding pack (3 documents)");
    expect(m.text).toContain("records of what was submitted");
  });
});

describe("every language", () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();

  it("has every sentence in all four languages with the same placeholders as the English", () => {
    const en = envelopeWordsFor("en");
    for (const locale of SIGN_LOCALES as readonly SignLocale[]) {
      const w = envelopeWordsFor(locale);
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(w[key], `${locale}.${key}`).toBeTruthy();
        expect(placeholders(w[key]), `${locale}.${key}`).toEqual(placeholders(en[key]));
        if (locale !== "en") expect(w[key], `${locale}.${key} is not the English copied`).not.toBe(en[key]);
      }
    }
  });

  it("fills every placeholder of every message in every language (no raw {key} reaches a person)", () => {
    for (const locale of SIGN_LOCALES as readonly SignLocale[]) {
      const pieces = [
        envelopeInvitationEmail({ ...base, locale, message: "Hi" }),
        envelopeInvitationEmail({ ...base, locale, fill: true, codeRequired: true, expiresAt: new Date("2026-10-20T08:00:00Z") }),
        envelopeReminderEmail({ ...base, locale }),
        envelopeCompletedEmail({ locale, workspace: "W", name: "Ali", title: "T", count: 3, attachedCount: 3 }),
        envelopeCompletedEmail({ locale, workspace: "W", name: "Ali", title: "T", count: 3, attachedCount: 1 }),
        envelopeCompletedEmail({ locale, workspace: "W", name: "Ali", title: "T", count: 3, attachedCount: 0 }),
        envelopeCompletedEmail({ locale, workspace: "W", name: "Ali", title: "T", count: 3, attachedCount: 3, mode: "form" }),
      ];
      for (const m of pieces) {
        expect(m.subject, locale).not.toMatch(/\{\w+\}/);
        expect(m.text, locale).not.toMatch(/\{\w+\}/);
        expect(m.html, locale).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
