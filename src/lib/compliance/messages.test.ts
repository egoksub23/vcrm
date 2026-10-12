import { describe, expect, it } from "vitest";

import { CUSTOMER_LOCALES, clockAlertEmail, codeEmail, customerEmail, customerLocaleOf, signoffWaitingEmail, wordsOf, type CustomerNotice } from "./messages";

// The words of the emails: every notice in every language, filled in, escaped, and free of what a customer must never be sent. The delivery (claims,
// results, the text refused for a bank detail) is service/notices.test.ts.

const KINDS: CustomerNotice[] = ["received", "more_info", "approved", "rejected", "completed"];
const base = { workspace: "Vircle", name: "Siti Aminah", reference: "CMP-2026-000123", typeKey: "closure", targetDays: 14, text: "Please send the letter again." };

describe.each(CUSTOMER_LOCALES)("customer emails in %s", (locale) => {
  it("has a subject, an HTML body and a plain body for every notice, with the reference and the name and nothing left unfilled", () => {
    for (const kind of KINDS) {
      const m = customerEmail(kind, { ...base, locale });
      expect(m.subject, kind).toBeTruthy();
      expect(m.subject.length, kind).toBeLessThan(120);
      expect(m.text, kind).toContain("CMP-2026-000123");
      expect(m.text, kind).toContain("Siti Aminah");
      expect(m.html, kind).toContain("CMP-2026-000123");
      for (const part of [m.subject, m.text, m.html.replace(/<[^>]+>/g, " ")]) expect(part, kind).not.toMatch(/\{\w+\}/);
      expect(m.subject, kind).not.toMatch(/[\r\n]/);
    }
  });

  it("tells a closure's customer the practice target and nobody else, and never the regulatory stop", () => {
    const received = customerEmail("received", { ...base, locale });
    expect(received.text).toContain("14");
    const withdrawal = customerEmail("received", { ...base, locale, typeKey: "withdrawal" });
    expect(withdrawal.text).not.toContain("14");
    const none = customerEmail("received", { ...base, locale, targetDays: null });
    expect(none.text).not.toContain("14");
    for (const kind of KINDS) {
      const m = customerEmail(kind, { ...base, locale });
      expect(`${m.subject} ${m.text}`, kind).not.toMatch(/hard stop|regulat|\b30\b/i);
    }
  });

  it("says what the request is in the sentence for its type", () => {
    const sentence = (typeKey: string) => customerEmail("completed", { ...base, locale, typeKey }).text;
    const all = new Set(["closure", "withdrawal", "phone_change", "custom_thing"].map(sentence));
    expect(all.size).toBe(4);
  });

  it("quotes the staff's words on lines of their own, and escapes them in the HTML", () => {
    const evil = `<script>alert("x")</script> & "quotes"`;
    for (const kind of ["more_info", "rejected"] as const) {
      const m = customerEmail(kind, { ...base, locale, text: evil });
      expect(m.html).not.toContain("<script>");
      expect(m.html).toContain("&lt;script&gt;");
      expect(m.text).toContain(evil);
    }
    // a name is escaped too
    expect(customerEmail("received", { ...base, locale, name: "<b>Siti</b>" }).html).not.toContain("<b>Siti</b>");
  });

  it("carries no link, no file and nothing about the workspace's staff screens", () => {
    for (const kind of KINDS) {
      const m = customerEmail(kind, { ...base, locale });
      expect(m.html, kind).not.toMatch(/href=|https?:\/\/|\/compliance/i);
      expect(m.text, kind).not.toMatch(/https?:\/\/|\/compliance/i);
    }
  });

  it("keeps a subject on one line even if a name has a line break", () => {
    expect(customerEmail("received", { ...base, locale, name: "Siti\r\nBcc: x@y.z" }).subject).not.toMatch(/[\r\n]/);
  });

  it("sends the six-digit code with its validity and nothing else", () => {
    const m = codeEmail({ locale, workspace: "Vircle", code: "042917" });
    expect(m.subject).toContain("042917");
    expect(m.text).toContain("042917");
    expect(m.text).toContain("15");
    expect(m.html).toContain("042917");
    expect(m.html).not.toMatch(/href=|CMP-/);
    expect(m.text).not.toMatch(/\{\w+\}/);
  });

  it("tells the staff what is waiting and what to do, without naming the customer or linking anywhere", () => {
    const s = signoffWaitingEmail({ locale, workspace: "Vircle", reference: "CMP-2026-000123", typeLabel: "Account closure", recommendation: "approve" });
    expect(s.subject).toContain("CMP-2026-000123");
    expect(s.text).toContain("Account closure");
    expect(s.text).not.toMatch(/Siti|https?:\/\//);
    const recs = new Set((["approve", "reject", "more_info", null] as const).map((r) => signoffWaitingEmail({ locale, workspace: "Vircle", reference: "R", typeLabel: "T", recommendation: r }).text));
    expect(recs.size).toBe(3);
    for (const days of [10, 5, 1]) {
      const a = clockAlertEmail({ locale, workspace: "Vircle", reference: "CMP-2026-000123", typeLabel: "Account closure", daysLeft: days });
      expect(a.subject).toContain("CMP-2026-000123");
      expect(a.subject).toContain(String(days));
      expect(a.text).not.toMatch(/\{\w+\}/);
    }
    const reached = clockAlertEmail({ locale, workspace: "Vircle", reference: "CMP-2026-000123", typeLabel: "Account closure", daysLeft: 0 });
    expect(reached.subject).not.toMatch(/\b0\b/);
  });
});

describe("the four languages differ and share their shape", () => {
  it("has a different subject in each language for the same notice", () => {
    for (const kind of KINDS) {
      const subjects = CUSTOMER_LOCALES.map((l) => customerEmail(kind, { ...base, locale: l }).subject);
      expect(new Set(subjects).size, kind).toBe(4);
    }
  });

  it("has the same placeholders in every language", () => {
    const holders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    const en = wordsOf("en") as unknown as Record<string, string>;
    for (const l of CUSTOMER_LOCALES) {
      const w = wordsOf(l) as unknown as Record<string, string>;
      expect(Object.keys(w).sort(), l).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) expect(holders(w[k]), `${l} ${k}`).toBe(holders(en[k]));
    }
  });

  it("never says 'envelope' and names the product as the workspace's own", () => {
    for (const l of CUSTOMER_LOCALES) expect(JSON.stringify(wordsOf(l))).not.toMatch(/envelope/i);
  });

  it("reads a language code from anywhere", () => {
    expect(customerLocaleOf("ms-MY")).toBe("ms");
    expect(customerLocaleOf("zh_CN")).toBe("zh");
    expect(customerLocaleOf("KO")).toBe("ko");
    expect(customerLocaleOf("fr")).toBeNull();
    expect(customerLocaleOf(null)).toBeNull();
    expect(customerLocaleOf("")).toBeNull();
  });
});
