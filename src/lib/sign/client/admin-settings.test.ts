import { describe, expect, it } from "vitest";

import { certificateState, formatReminderDays, isCategoryKey, keyFromName, parseCategoryForm, parseReminderDays, parseWholeNumber, reorderPositions, withConsentText, type CategoryFormInput } from "./admin-settings";

describe("keyFromName", () => {
  it("makes a lower case key from the name", () => {
    expect(keyFromName("Merchant agreements", [])).toBe("merchant_agreements");
    expect(keyFromName("  NDA (mutual)  ", [])).toBe("nda_mutual");
    expect(keyFromName("Café & Bar", [])).toBe("cafe_bar");
  });

  it("is unique among the keys taken, archived ones included", () => {
    expect(keyFromName("Sales", ["sales"])).toBe("sales_2");
    expect(keyFromName("Sales", ["sales", "sales_2", "sales_3"])).toBe("sales_4");
  });

  it("starts with a letter and has a usable length, whatever the name", () => {
    expect(keyFromName("2026 deals", [])).toBe("c_2026_deals");
    expect(keyFromName("合作", [])).toBe("category");
    expect(keyFromName("合作", ["category"])).toBe("category_2");
    expect(keyFromName("A", [])).toBe("category");
    expect(keyFromName("x".repeat(200), []).length).toBeLessThanOrEqual(36);
  });

  it("always satisfies the database's key rule", () => {
    for (const name of ["Merchant agreements", "2026", "合作 Partner", "a-b-c", "!!!", "Ünïcödé", "x".repeat(100), "Sales"]) {
      const first = keyFromName(name, []);
      expect(isCategoryKey(first), name).toBe(true);
      expect(isCategoryKey(keyFromName(name, [first])), name).toBe(true);
    }
  });
});

describe("parseReminderDays", () => {
  it("reads days separated by commas or spaces", () => {
    expect(parseReminderDays("3, 7")).toEqual({ days: [3, 7] });
    expect(parseReminderDays("7 3 3")).toEqual({ days: [3, 7] });
    expect(parseReminderDays("")).toEqual({ days: [] });
  });

  it("refuses what the server would", () => {
    expect(parseReminderDays("three")).toEqual({ problem: "not_a_number" });
    expect(parseReminderDays("1.5")).toEqual({ problem: "not_a_number" });
    expect(parseReminderDays("0")).toEqual({ problem: "out_of_range" });
    expect(parseReminderDays("61")).toEqual({ problem: "out_of_range" });
    expect(parseReminderDays("1,2,3,4,5,6")).toEqual({ problem: "too_many" });
  });

  it("formats days back", () => {
    expect(formatReminderDays([3, 7])).toBe("3, 7");
    expect(formatReminderDays(null)).toBe("");
  });
});

describe("parseWholeNumber", () => {
  it("accepts only whole numbers in range", () => {
    expect(parseWholeNumber("14", 1, 365)).toBe(14);
    expect(parseWholeNumber(" 7 ", 1, 365)).toBe(7);
    expect(parseWholeNumber("", 1, 365)).toBeNull();
    expect(parseWholeNumber("0", 1, 365)).toBeNull();
    expect(parseWholeNumber("366", 1, 365)).toBeNull();
    expect(parseWholeNumber("1e3", 1, 365)).toBeNull();
    expect(parseWholeNumber("-3", 1, 365)).toBeNull();
  });
});

describe("certificateState", () => {
  const now = new Date("2026-10-06T00:00:00Z");

  it("is valid well before the end", () => {
    expect(certificateState("2028-10-06T00:00:00Z", now).state).toBe("valid");
  });

  it("warns 60 days before the end", () => {
    expect(certificateState("2026-12-05T00:00:00Z", now)).toEqual({ state: "expiring", daysLeft: 60 });
    expect(certificateState("2026-12-06T00:00:00Z", now).state).toBe("valid");
  });

  it("is expired at and after the end", () => {
    expect(certificateState("2026-10-06T00:00:00Z", now).state).toBe("expired");
    expect(certificateState("2026-01-01T00:00:00Z", now).state).toBe("expired");
  });

  it("copes with no date or a bad one", () => {
    expect(certificateState(null, now)).toEqual({ state: "unknown", daysLeft: null });
    expect(certificateState("not a date", now).state).toBe("unknown");
  });
});

describe("withConsentText", () => {
  it("sets one language and keeps the others", () => {
    expect(withConsentText({ ms: "Saya setuju" }, "en", "  I agree  ")).toEqual({ ms: "Saya setuju", en: "I agree" });
  });

  it("a blank text takes the language back to the default", () => {
    expect(withConsentText({ ms: "Saya setuju", en: "x" }, "en", "   ")).toEqual({ ms: "Saya setuju" });
    expect(withConsentText(null, "en", "")).toEqual({});
  });
});

describe("parseCategoryForm", () => {
  const blank: CategoryFormInput = { name: "Sales", description: "", expiry: "", reminders: "", codeRequired: false, signInOrder: false, retention: "", consent: {} };

  it("a blank preset means the workspace setting", () => {
    const r = parseCategoryForm(blank);
    expect(r).toEqual({ ok: true, values: { name: "Sales", description: null, expiry_days: null, reminder_days: null, code_required: false, sign_in_order: false, retention_years: null, consent_text: null } });
  });

  it("reads the presets and the own wording", () => {
    const r = parseCategoryForm({ ...blank, name: " NDA ", description: " Mutual ", expiry: "30", reminders: "7, 3", codeRequired: true, signInOrder: true, retention: "10", consent: { en: " I agree ", ms: "  " } });
    expect(r).toEqual({ ok: true, values: { name: "NDA", description: "Mutual", expiry_days: 30, reminder_days: [3, 7], code_required: true, sign_in_order: true, retention_years: 10, consent_text: { en: "I agree" } } });
  });

  it("says what is wrong, field by field", () => {
    const r = parseCategoryForm({ ...blank, name: " ", expiry: "0", reminders: "x", retention: "51" });
    expect(r).toEqual({ ok: false, errors: { name: "name_required", expiry: "expiry_invalid", reminders: "reminders_not_a_number", retention: "retention_invalid" } });
    expect(parseCategoryForm({ ...blank, name: "x".repeat(81) })).toMatchObject({ ok: false, errors: { name: "name_too_long" } });
  });
});

describe("reorderPositions", () => {
  const rows = [
    { id: "a", position: 1 },
    { id: "b", position: 2 },
    { id: "c", position: 3 },
  ];

  it("swaps with the neighbour and changes only the two rows", () => {
    expect(reorderPositions(rows, "b", -1)).toEqual([
      { id: "b", position: 1 },
      { id: "a", position: 2 },
    ]);
    expect(reorderPositions(rows, "b", 1)).toEqual([
      { id: "c", position: 2 },
      { id: "b", position: 3 },
    ]);
  });

  it("does nothing at the ends or for an unknown row", () => {
    expect(reorderPositions(rows, "a", -1)).toEqual([]);
    expect(reorderPositions(rows, "c", 1)).toEqual([]);
    expect(reorderPositions(rows, "zzz", 1)).toEqual([]);
  });

  it("renumbers rows that share a position so the move really happens", () => {
    const tied = [
      { id: "a", position: 0 },
      { id: "b", position: 0 },
      { id: "c", position: 0 },
    ];
    expect(reorderPositions(tied, "c", -1)).toEqual([
      { id: "a", position: 1 },
      { id: "c", position: 2 },
      { id: "b", position: 3 },
    ]);
  });
});
