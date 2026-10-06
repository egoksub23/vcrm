import { describe, expect, it } from "vitest";

import { PRODUCT_DEFAULTS, cleanReminderDays, dueReminders, expiryFor, resolveDefaults } from "./defaults";

describe("resolveDefaults", () => {
  it("falls back to the product's choices", () => {
    expect(resolveDefaults({})).toEqual({ expiryDays: 14, reminderDays: [3, 7], signInOrder: false, codeRequired: false, locale: "en" });
  });

  it("prefers the template, then the category, then the workspace", () => {
    const workspace = { default_expiry_days: 30, reminder_days: [5], default_language: "ms" as const };
    const category = { expiry_days: 21, code_required: true, sign_in_order: true };
    const template = { expiry_days: 7, sign_in_order: false, locale: "zh" as const };
    expect(resolveDefaults({ workspace })).toMatchObject({ expiryDays: 30, reminderDays: [5], locale: "ms" });
    expect(resolveDefaults({ workspace, category })).toMatchObject({ expiryDays: 21, reminderDays: [5], codeRequired: true, signInOrder: true });
    expect(resolveDefaults({ workspace, category, template })).toMatchObject({ expiryDays: 7, signInOrder: false, codeRequired: true, locale: "zh" });
  });

  it("treats null as 'not set', so a category can fall through to the workspace", () => {
    expect(resolveDefaults({ category: { expiry_days: null, code_required: null }, workspace: { default_expiry_days: 10 } })).toMatchObject({ expiryDays: 10, codeRequired: false });
  });

  it("keeps signing order off unless something asks for it", () => {
    expect(PRODUCT_DEFAULTS.signInOrder).toBe(false);
    expect(resolveDefaults({ template: {}, category: {}, workspace: {} }).signInOrder).toBe(false);
  });
});

describe("cleanReminderDays", () => {
  it("keeps whole days from 1 to 60, sorted, unique, at most five", () => {
    expect(cleanReminderDays([7, 3, 3, 0, 61, 2.5, 1, 14, 21, 30, 45])).toEqual([1, 3, 7, 14, 21]);
    expect(cleanReminderDays(null)).toEqual([]);
  });
});

describe("expiryFor", () => {
  const now = new Date("2026-10-06T08:00:00Z");
  it("adds the default days, or takes the chosen date", () => {
    expect(expiryFor(now, 14).toISOString()).toBe("2026-10-20T08:00:00.000Z");
    expect(expiryFor(now, 14, "2026-11-01T00:00:00Z").toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(expiryFor(now, 14, "garbage").toISOString()).toBe("2026-10-20T08:00:00.000Z");
  });
});

describe("dueReminders", () => {
  const now = new Date("2026-10-10T09:00:00Z");
  const s = (over: Partial<{ id: string; status: "sent" | "viewed" | "pending" | "signed"; invited_at: string | null; last_reminded_at: string | null; reminder_count: number }> = {}) => ({
    id: "a",
    status: "sent" as const,
    invited_at: "2026-10-06T08:00:00Z",
    last_reminded_at: null,
    reminder_count: 0,
    ...over,
  });

  it("is due once the next reminder day has passed since the invitation", () => {
    expect(dueReminders([s()], [3, 7], now)).toHaveLength(1); // 4 days since invitation, first reminder at day 3
    expect(dueReminders([s({ invited_at: "2026-10-08T08:00:00Z" })], [3, 7], now)).toHaveLength(0);
  });

  it("goes through the reminder days in turn and stops after the last", () => {
    expect(dueReminders([s({ reminder_count: 1, last_reminded_at: "2026-10-09T08:00:00Z" })], [3, 7], now)).toHaveLength(0); // day 7 not reached
    expect(dueReminders([s({ reminder_count: 1, last_reminded_at: "2026-10-09T08:00:00Z", invited_at: "2026-10-02T08:00:00Z" })], [3, 7], now)).toHaveLength(1);
    expect(dueReminders([s({ reminder_count: 2, invited_at: "2026-09-01T08:00:00Z" })], [3, 7], now)).toHaveLength(0);
  });

  it("never reminds twice within 20 hours", () => {
    expect(dueReminders([s({ last_reminded_at: "2026-10-10T00:00:00Z" })], [3, 7], now)).toHaveLength(0);
  });

  it("ignores people who are not waiting", () => {
    expect(dueReminders([s({ status: "signed" }), s({ status: "pending" }), s({ invited_at: null })], [3, 7], now)).toHaveLength(0);
    expect(dueReminders([s({ status: "viewed" })], [3, 7], now)).toHaveLength(1);
  });
});
