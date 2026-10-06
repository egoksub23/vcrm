import { describe, expect, it } from "vitest";

import type { SignDocumentRow } from "../types";
import { defaultExpiryDate, fromDateInput, isEmptyPatch, optionsFlags, optionsFromDocument, optionsPatch, parseReminderDays, toDateInput, type DraftOptions } from "./draft-options";

const NOW = new Date(2026, 9, 6, 10, 0, 0); // 6 Oct 2026, local time

const doc = {
  title: "Merchant Agreement",
  category_id: null,
  contact_id: null,
  locale: "en",
  message: null,
  expires_at: null,
  reminder_days: [3, 7],
  code_required: false,
  sign_in_order: false,
} as unknown as SignDocumentRow;

const base = optionsFromDocument(doc);

describe("dates", () => {
  it("round-trips a calendar day through the end of that day", () => {
    const iso = fromDateInput("2026-10-20");
    expect(iso).not.toBeNull();
    expect(toDateInput(iso)).toBe("2026-10-20");
    expect(new Date(iso as string).getHours()).toBe(23);
  });

  it("refuses what is not a date", () => {
    expect(fromDateInput("")).toBeNull();
    expect(fromDateInput("20/10/2026")).toBeNull();
    expect(fromDateInput("2026-02-31")).toBeNull();
    expect(toDateInput(null)).toBe("");
    expect(toDateInput("not a date")).toBe("");
  });

  it("works out the default expiry day", () => {
    expect(defaultExpiryDate(NOW, 14)).toBe("2026-10-20");
    expect(defaultExpiryDate(NOW, 1)).toBe("2026-10-07");
  });
});

describe("reminders", () => {
  it("reads whole days from 1 to 60, sorted, without repeats, at most five", () => {
    expect(parseReminderDays("7, 3 3")).toEqual([3, 7]);
    expect(parseReminderDays("0, 61, 2.5, abc, 10")).toEqual([10]);
    expect(parseReminderDays("1 2 3 4 5 6 7")).toEqual([1, 2, 3, 4, 5]);
    expect(parseReminderDays("")).toEqual([]);
  });
});

describe("flags", () => {
  it("accepts the starting options", () => {
    expect(optionsFlags(base, NOW)).toEqual({ title: false, message: false, expiryPast: false, reminders: false });
  });

  it("flags an empty title, a long message, a past date and reminders that do not read", () => {
    const f = optionsFlags({ ...base, title: "  ", message: "x".repeat(2001), expiryDate: "2026-10-06", reminderText: "3, banana" }, NOW);
    expect(f).toEqual({ title: true, message: true, expiryPast: true, reminders: true });
  });

  it("accepts tomorrow", () => {
    expect(optionsFlags({ ...base, expiryDate: "2026-10-07" }, NOW).expiryPast).toBe(false);
  });
});

describe("the patch", () => {
  it("is empty when nothing changed, even if the reminders are typed differently", () => {
    expect(isEmptyPatch(optionsPatch(base, base, NOW))).toBe(true);
    expect(isEmptyPatch(optionsPatch(base, { ...base, reminderText: "3,7" }, NOW))).toBe(true);
  });

  it("holds only what changed", () => {
    const patch = optionsPatch(base, { ...base, title: "  New title ", locale: "ms", codeRequired: true, signInOrder: true, message: " Hello " }, NOW);
    expect(patch).toEqual({ title: "New title", locale: "ms", codeRequired: true, signInOrder: true, message: "Hello" });
  });

  it("clears the message and the expiry with null", () => {
    const saved = { ...base, message: "Hi", expiryDate: "2026-10-20" };
    expect(optionsPatch(saved, { ...saved, message: "", expiryDate: "" }, NOW)).toEqual({ message: null, expiresAt: null });
  });

  it("sends a chosen expiry as the end of that day and a category or contact as an id or null", () => {
    const patch = optionsPatch(base, { ...base, expiryDate: "2026-10-20", categoryId: "cat-1", contactId: "con-1" }, NOW);
    expect(toDateInput(patch.expiresAt as string)).toBe("2026-10-20");
    expect(patch).toMatchObject({ categoryId: "cat-1", contactId: "con-1" });
    expect(optionsPatch({ ...base, categoryId: "cat-1" }, { ...base, categoryId: null }, NOW)).toEqual({ categoryId: null });
  });

  it("leaves out what the server would refuse until it is fixed", () => {
    const next: DraftOptions = { ...base, title: "", message: "x".repeat(2001), expiryDate: "2026-10-01", reminderText: "99" };
    expect(isEmptyPatch(optionsPatch(base, next, NOW))).toBe(true);
  });

  it("sends reminders as numbers", () => {
    expect(optionsPatch(base, { ...base, reminderText: "5, 1" }, NOW)).toEqual({ reminderDays: [1, 5] });
    expect(optionsPatch(base, { ...base, reminderText: "" }, NOW)).toEqual({ reminderDays: [] });
  });
});
