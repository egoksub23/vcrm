import { describe, expect, it } from "vitest";

import { cleanDefaults } from "../service/templates";
import { formatDaysList, parseDaysList, parseExpiryDays, patchDefaults, sameDefaults } from "./template-defaults";

describe("template defaults from form controls", () => {
  it("reads a list of reminder days like the server does", () => {
    expect(parseDaysList("3, 7")).toEqual([3, 7]);
    expect(parseDaysList("14 3 3 7")).toEqual([3, 7, 14]);
    expect(parseDaysList("0, 61, 5")).toEqual([5]);
    expect(parseDaysList("1,2,3,4,5,6,7")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDaysList("")).toEqual([]);
    expect(parseDaysList("abc")).toEqual([]);
    expect(formatDaysList([3, 7])).toBe("3, 7");
    expect(formatDaysList(undefined)).toBe("");
  });
  it("reads the expiry in days, 1 to 365", () => {
    expect(parseExpiryDays("14")).toBe(14);
    expect(parseExpiryDays(" 365 ")).toBe(365);
    expect(parseExpiryDays("0")).toBeUndefined();
    expect(parseExpiryDays("366")).toBeUndefined();
    expect(parseExpiryDays("")).toBeUndefined();
    expect(parseExpiryDays("1.5")).toBeUndefined();
    expect(parseExpiryDays("-3")).toBeUndefined();
  });
  it("sets and clears a default", () => {
    const a = patchDefaults({}, { expiry_days: 10, sign_in_order: false, subject: "Hello" });
    expect(a).toEqual({ expiry_days: 10, sign_in_order: false, subject: "Hello" });
    const b = patchDefaults(a, { expiry_days: undefined, subject: "", reminder_days: [] });
    expect(b).toEqual({ sign_in_order: false });
    expect(patchDefaults(b, { locale: "ms", message: null })).toEqual({ sign_in_order: false, locale: "ms" });
  });
  it("compares defaults regardless of blanks and key order", () => {
    expect(sameDefaults({ expiry_days: 7, code_required: true }, { code_required: true, expiry_days: 7, subject: "" })).toBe(true);
    expect(sameDefaults({ expiry_days: 7 }, { expiry_days: 8 })).toBe(false);
    expect(sameDefaults({}, { reminder_days: [] })).toBe(true);
  });
  it("produces defaults the server keeps as they are", () => {
    const d = patchDefaults({}, { expiry_days: 30, reminder_days: parseDaysList("3, 7"), sign_in_order: true, code_required: true, locale: "ko", subject: "Subject", message: "Please sign" });
    expect(cleanDefaults(d)).toEqual(d);
  });
});
