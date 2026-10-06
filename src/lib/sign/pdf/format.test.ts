import { describe, expect, it } from "vitest";

import { fitText, formatDate, formatDateTime, formatIsoDate, formatNumber, wrapText } from "./format";

describe("formatDate", () => {
  const d = new Date(Date.UTC(2026, 9, 6, 20, 30)); // 6 Oct 2026 20:30 UTC = 7 Oct 04:30 in Kuala Lumpur

  it("uses the default format and the zone's calendar day", () => {
    expect(formatDate(d)).toBe("06 Oct 2026");
    expect(formatDate(d, undefined, "en", "Asia/Kuala_Lumpur")).toBe("07 Oct 2026");
  });

  it("supports the tokens and keeps other characters", () => {
    expect(formatDate(d, "D/M/YY")).toBe("6/10/26");
    expect(formatDate(d, "DD-MM-YYYY")).toBe("06-10-2026");
    expect(formatDate(d, "MMMM D, YYYY")).toBe("October 6, 2026");
  });

  it("writes month names in the document's language", () => {
    expect(formatDate(d, "D MMMM YYYY", "ms")).toBe("6 Oktober 2026");
    expect(formatDate(new Date(Date.UTC(2026, 4, 3)), "D MMM YYYY", "ms")).toBe("3 Mei 2026");
    expect(formatDate(d, "YYYY MMM D", "zh")).toBe("2026 10月 6");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(formatDate(d, "DD MMM YYYY", "en", "Nowhere/Land")).toBe("06 Oct 2026");
  });
});

describe("formatDateTime", () => {
  it("shows date, 24-hour time and the zone", () => {
    const d = new Date(Date.UTC(2026, 9, 6, 6, 3));
    expect(formatDateTime(d)).toBe("06 Oct 2026 06:03 UTC");
    expect(formatDateTime(d, "Asia/Kuala_Lumpur")).toBe("06 Oct 2026 14:03 UTC+8");
  });
});

describe("formatIsoDate", () => {
  it("formats a picked date and returns anything else untouched", () => {
    expect(formatIsoDate("2026-10-06", "DD MMM YYYY")).toBe("06 Oct 2026");
    expect(formatIsoDate("2026-02-30")).toBe("2026-02-30");
    expect(formatIsoDate("next Tuesday")).toBe("next Tuesday");
  });
});

describe("formatNumber", () => {
  it("adds thousands separators and fixed decimals", () => {
    expect(formatNumber("1234567", 2)).toBe("1,234,567.00");
    expect(formatNumber("1,234.5", 0)).toBe("1,235");
    expect(formatNumber("-12.345", 1)).toBe("-12.3");
    expect(formatNumber("42")).toBe("42");
  });

  it("returns what is not a number as it was", () => {
    expect(formatNumber("12 abc")).toBe("12 abc");
    expect(formatNumber("")).toBe("");
  });
});

const mono = (size: number) => (s: string) => s.length * size * 0.5;

describe("wrapText", () => {
  it("wraps on words and keeps newlines", () => {
    expect(wrapText("one two three four", 20, (s) => s.length * 2)).toEqual(["one two", "three four"]);
    expect(wrapText("a\n\nb", 100, (s) => s.length)).toEqual(["a", "", "b"]);
  });

  it("splits a word that is wider than the line", () => {
    expect(wrapText("abcdefghij", 8, (s) => s.length * 2)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("fitText", () => {
  it("takes the largest size that fits on one line", () => {
    const fit = fitText("Kedai Runcit Ali Sdn Bhd", { w: 200, h: 24 }, mono);
    expect(fit.truncated).toBe(false);
    expect(fit.lines).toEqual(["Kedai Runcit Ali Sdn Bhd"]);
    expect(fit.fontSize).toBeLessThanOrEqual(14);
    expect(mono(fit.fontSize)(fit.lines[0])).toBeLessThanOrEqual(196.01);
  });

  it("shrinks to fit and then cuts with an ellipsis", () => {
    const fit = fitText("x".repeat(400), { w: 100, h: 20 }, mono);
    expect(fit.truncated).toBe(true);
    expect(fit.fontSize).toBe(5);
    expect(fit.lines[0].endsWith("…")).toBe(true);
  });

  it("honours a fixed size", () => {
    const fit = fitText("short", { w: 200, h: 40 }, mono, { fixedSize: 9 });
    expect(fit.fontSize).toBe(9);
  });

  it("wraps a multi-line field and cuts what does not fit the height", () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const fit = fitText(text, { w: 120, h: 30 }, mono, { multiline: true });
    expect(fit.lines.length).toBeGreaterThan(1);
    expect(fit.lines.length * fit.lineHeight).toBeLessThanOrEqual(30);
    const ok = fitText("a short note", { w: 200, h: 60 }, mono, { multiline: true });
    expect(ok.truncated).toBe(false);
  });
});
