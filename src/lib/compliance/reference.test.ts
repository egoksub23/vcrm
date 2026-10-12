import { describe, expect, it } from "vitest";

import { formatReference, isReference, normalisePhone, searchKind } from "./reference";

describe("reference", () => {
  it("formats CMP-YYYY-NNNNNN", () => {
    expect(formatReference(2026, 1)).toBe("CMP-2026-000001");
    expect(formatReference(2026, 123456)).toBe("CMP-2026-123456");
    expect(formatReference(2027, 1234567)).toBe("CMP-2027-1234567");
  });
  it("recognises a reference in any case and with spaces around it", () => {
    expect(isReference("CMP-2026-000001")).toBe(true);
    expect(isReference(" cmp-2026-000123 ")).toBe(true);
    expect(isReference("CMP-26-000001")).toBe(false);
    expect(isReference("SGN-2026-000001")).toBe(false);
    expect(isReference("CMP-2026-1")).toBe(false);
  });
});

describe("normalisePhone", () => {
  it("keeps an international number and drops the punctuation", () => {
    expect(normalisePhone("+60 12-345 6789")).toBe("+60123456789");
    expect(normalisePhone("+60 (12) 345.6789")).toBe("+60123456789");
    expect(normalisePhone("+65 9123 4567")).toBe("+6591234567");
  });
  it("reads a leading 0 as Malaysia and 00 as a plus", () => {
    expect(normalisePhone("012-345 6789")).toBe("+60123456789");
    expect(normalisePhone("0123456789")).toBe("+60123456789");
    expect(normalisePhone("0065 91234567")).toBe("+6591234567");
  });
  it("reads 60... without a plus as Malaysia, but not a short or foreign-looking bare number", () => {
    expect(normalisePhone("60123456789")).toBe("+60123456789");
    expect(normalisePhone("9123456")).toBeNull();
    expect(normalisePhone("12345")).toBeNull();
  });
  it("refuses empty input, letters, too few or too many digits and a leading 0 after the plus", () => {
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone("call me")).toBeNull();
    expect(normalisePhone("+60 12")).toBeNull();
    expect(normalisePhone("+6012345678901234")).toBeNull();
    expect(normalisePhone("+0123456789")).toBeNull();
    expect(normalisePhone("+60123456789x")).toBeNull();
  });
  it("what it returns always fits the database check (+ then 7 to 15 digits)", () => {
    for (const v of ["012 3456789", "+44 20 7946 0958", "0065 6123 4567", "60 12 345 6789"]) {
      const n = normalisePhone(v);
      expect(n, v).toMatch(/^\+[0-9]{7,15}$/);
    }
  });
  it("tells what a search box holds", () => {
    expect(searchKind("CMP-2026-000001")).toBe("reference");
    expect(searchKind("+6012 345 6789")).toBe("phone");
    expect(searchKind("0123456789")).toBe("phone");
    expect(searchKind("Aisyah")).toBe("text");
    expect(searchKind("a@b.my")).toBe("text");
  });
});
