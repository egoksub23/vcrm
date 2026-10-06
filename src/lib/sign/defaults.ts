// ============================================================
// Which choice applies to a document: what the sender set, else the template's, else the category's,
// else the workspace's, else the product's. Plus the reminder and expiry arithmetic. Pure.
// ============================================================

import type { SignLocale, SignerStatus, TemplateDefaults } from "./types";

export const PRODUCT_DEFAULTS = {
  expiryDays: 14,
  reminderDays: [3, 7] as number[],
  signInOrder: false,
  codeRequired: false,
  locale: "en" as SignLocale,
};

export interface WorkspaceDefaults {
  default_expiry_days?: number | null;
  reminder_days?: number[] | null;
  default_language?: SignLocale | null;
}

export interface CategoryDefaults {
  expiry_days?: number | null;
  reminder_days?: number[] | null;
  code_required?: boolean | null;
  sign_in_order?: boolean | null;
}

export interface ResolvedDefaults {
  expiryDays: number;
  reminderDays: number[];
  signInOrder: boolean;
  codeRequired: boolean;
  locale: SignLocale;
}

const pick = <T>(...values: (T | null | undefined)[]): T | undefined => values.find((v) => v !== null && v !== undefined);

/** Reminder days: whole days from 1 to 60, ascending, at most 5. */
export function cleanReminderDays(days: readonly number[] | null | undefined): number[] {
  return [...new Set((days ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 60))].sort((a, b) => a - b).slice(0, 5);
}

export function resolveDefaults(args: { template?: TemplateDefaults | null; category?: CategoryDefaults | null; workspace?: WorkspaceDefaults | null }): ResolvedDefaults {
  const { template, category, workspace } = args;
  return {
    expiryDays: pick(template?.expiry_days, category?.expiry_days, workspace?.default_expiry_days) ?? PRODUCT_DEFAULTS.expiryDays,
    reminderDays: cleanReminderDays(pick(template?.reminder_days, category?.reminder_days, workspace?.reminder_days) ?? PRODUCT_DEFAULTS.reminderDays),
    signInOrder: pick(template?.sign_in_order, category?.sign_in_order) ?? PRODUCT_DEFAULTS.signInOrder,
    codeRequired: pick(template?.code_required, category?.code_required) ?? PRODUCT_DEFAULTS.codeRequired,
    locale: pick(template?.locale, workspace?.default_language) ?? PRODUCT_DEFAULTS.locale,
  };
}

/** When a document sent `now` stops accepting signatures. The chosen date wins; a past date is not accepted here. */
export function expiryFor(now: Date, defaultDays: number, chosen?: string | Date | null): Date {
  if (chosen) {
    const d = typeof chosen === "string" ? new Date(chosen) : chosen;
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(now.getTime() + defaultDays * 24 * 3600 * 1000);
}

export interface ReminderSubject {
  id: string;
  status: SignerStatus;
  invited_at: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
}

/**
 * Signers who are due a reminder: invited and not finished, with the next reminder day reached since
 * they were invited and not yet sent. A reminder is never sent twice for the same day, nor more than
 * once in 20 hours. Reminder days count from the signer's own invitation (a later step starts its own clock).
 */
export function dueReminders(signers: readonly ReminderSubject[], reminderDays: readonly number[], now: Date): ReminderSubject[] {
  const days = cleanReminderDays(reminderDays);
  return signers.filter((s) => {
    if (s.status !== "sent" && s.status !== "viewed") return false;
    if (!s.invited_at || s.reminder_count >= days.length) return false;
    const invited = new Date(s.invited_at).getTime();
    const dueAt = invited + days[s.reminder_count] * 24 * 3600 * 1000;
    if (now.getTime() < dueAt) return false;
    if (s.last_reminded_at && now.getTime() - new Date(s.last_reminded_at).getTime() < 20 * 3600 * 1000) return false;
    return true;
  });
}
