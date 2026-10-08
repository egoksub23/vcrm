import { describe, expect, it } from "vitest";

import { cancelEmail, cancelWordsFor } from "./cancel-messages";
import { SIGN_LOCALES } from "./types";

const when = new Date("2026-10-06T08:00:00Z");
const base = { workspace: "Vircle Sdn Bhd", title: "Merchant Agreement", reference: "SGN-2026-000012", cancelledAt: when, reason: "Signed with the wrong price list.", timeZone: "Asia/Kuala_Lumpur" };

describe("the message that tells people a completed document was cancelled", () => {
  it("says which document, who cancelled it, when, why, and what the copy they hold now is (English)", () => {
    const m = cancelEmail({ ...base, locale: "en" });
    expect(m.subject).toBe("Cancelled: Merchant Agreement");
    expect(m.text).toContain("“Merchant Agreement” (SGN-2026-000012) was cancelled by Vircle Sdn Bhd on 6 Oct 2026.");
    expect(m.text).toContain("Reason: Signed with the wrong price list.");
    expect(m.text).toContain("The signed copy you already have remains a record of what was signed; it is no longer in force.");
    expect(m.html).toContain("Reason: Signed with the wrong price list.");
  });

  it("has a version in every language that fills every placeholder and leaves no brace", () => {
    for (const locale of SIGN_LOCALES) {
      const m = cancelEmail({ ...base, locale });
      for (const part of [m.subject, m.text, m.html]) {
        expect(part, locale).not.toMatch(/\{\w+\}/);
        expect(part, locale).toContain("Merchant Agreement");
      }
      expect(m.text, locale).toContain("SGN-2026-000012");
      expect(m.text, locale).toContain("Signed with the wrong price list.");
      expect(m.text, locale).toContain("Vircle Sdn Bhd");
      expect(m.text, locale).toMatch(/2026/);
    }
    expect(cancelEmail({ ...base, locale: "ms" }).subject).toBe("Dibatalkan: Merchant Agreement");
    expect(cancelEmail({ ...base, locale: "zh" }).subject).toBe("已取消：Merchant Agreement");
    expect(cancelEmail({ ...base, locale: "ko" }).subject).toBe("취소됨: Merchant Agreement");
    // every language has every sentence
    const keys = Object.keys(cancelWordsFor("en")).sort();
    for (const locale of SIGN_LOCALES) expect(Object.keys(cancelWordsFor(locale)).sort(), locale).toEqual(keys);
  });

  it("names a collection with its count, and a form as a record of what was submitted", () => {
    const pack = cancelEmail({ ...base, locale: "en", title: "Merchant onboarding", count: 3 });
    expect(pack.subject).toBe("Cancelled: Merchant onboarding (3 documents)");
    expect(pack.text).toContain("a collection of 3 documents, was cancelled by Vircle Sdn Bhd on 6 Oct 2026");
    expect(pack.text).toContain("The signed copies you already have remain a record of what was signed; they are no longer in force.");
    const form = cancelEmail({ ...base, locale: "en", mode: "form" });
    expect(form.text).toContain("The record you already have remains a record of what was submitted; it is no longer in force.");
    expect(form.text).not.toContain("signed copy");
  });

  it("leaves out the reference when there is none", () => {
    expect(cancelEmail({ ...base, locale: "en", reference: null }).text).toContain("“Merchant Agreement” was cancelled by Vircle Sdn Bhd on 6 Oct 2026.");
  });

  it("carries no link, no button and no file, and escapes what the person typed", () => {
    const m = cancelEmail({ ...base, locale: "en", title: "<b>Deal</b>", reason: "Line one\n<script>alert(1)</script> & \"quotes\"" });
    expect(m.html).not.toMatch(/href=|<a |<button|<img|<script/);
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("&lt;b&gt;Deal&lt;/b&gt;");
    expect(m.text).not.toMatch(/https?:/);
    // a title or reason with a line break can never add a header to the subject
    expect(cancelEmail({ ...base, locale: "en", title: "Deal\r\nBcc: x@y.example" }).subject).not.toMatch(/[\r\n]/);
  });
});
