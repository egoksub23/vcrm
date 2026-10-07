// ============================================================
// Doc Sign, browser side: a draft's options (title, category, contact, language, message, expiry, reminders,
// code, signing order) as the sender edits them, and the patch that saves only what changed and only what the
// server would accept. Pure and tested.
// ============================================================

import { cleanReminderDays } from "../defaults";
import type { SignDocumentRow, SignLocale } from "../types";
import { SIGN_LOCALES } from "../types";

export interface DraftOptions {
  title: string;
  categoryId: string | null;
  contactId: string | null;
  /** F-51: the ticket and the deal this document is attached to (absent: none). */
  ticketId?: string | null;
  dealId?: string | null;
  locale: SignLocale;
  message: string;
  /** `YYYY-MM-DD` in the sender's own calendar, or "" to use the default. */
  expiryDate: string;
  /** Days as typed, for example "3, 7". */
  reminderText: string;
  codeRequired: boolean;
  signInOrder: boolean;
  /** Forwarding (F-95): the people on the document may hand their turn, or a part of the form, to someone else. */
  allowForwarding: boolean;
  /** Migration 176: private to whoever uploaded it, the workspace's admins and the Halo users named on it. Chosen while a draft. Absent: not private. */
  isPrivate?: boolean;
}

/** What `PATCH /api/sign/documents/:id` takes (a subset of DraftPatch). */
export interface OptionsPatch {
  title?: string;
  categoryId?: string | null;
  contactId?: string | null;
  ticketId?: string | null;
  dealId?: string | null;
  locale?: string;
  message?: string | null;
  expiresAt?: string | null;
  signInOrder?: boolean;
  codeRequired?: boolean;
  allowForwarding?: boolean;
  isPrivate?: boolean;
  reminderDays?: number[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar date of a stored time, in the browser's time zone. */
export function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The last moment of a chosen calendar day, in the browser's time zone, as an ISO time. Null for "" or a bad date. */
export function fromDateInput(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0, 0);
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d.toISOString();
}

export function parseReminderDays(text: string): number[] {
  return cleanReminderDays(
    text
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((x) => Number(x)),
  );
}

export const reminderText = (days: readonly number[] | null | undefined): string => (days ?? []).join(", ");

export function optionsFromDocument(doc: SignDocumentRow): DraftOptions {
  return {
    title: doc.title,
    categoryId: doc.category_id,
    contactId: doc.contact_id,
    ticketId: doc.ticket_id ?? null,
    dealId: doc.deal_id ?? null,
    locale: SIGN_LOCALES.includes(doc.locale) ? doc.locale : "en",
    message: doc.message ?? "",
    expiryDate: toDateInput(doc.expires_at),
    reminderText: reminderText(doc.reminder_days),
    codeRequired: doc.code_required,
    signInOrder: doc.sign_in_order,
    allowForwarding: !!doc.allow_forwarding,
    isPrivate: doc.is_private === true,
  };
}

export interface OptionsFlags {
  title: boolean;
  message: boolean;
  /** The chosen date is today or earlier (or not a date). */
  expiryPast: boolean;
  /** Something typed in the reminders box that is not a whole number of days from 1 to 60. */
  reminders: boolean;
}

/** What is wrong with the options as typed. `now` is passed in (the clock is not read here). */
export function optionsFlags(o: DraftOptions, now: Date): OptionsFlags {
  const title = o.title.trim();
  const expiry = o.expiryDate ? fromDateInput(o.expiryDate) : null;
  const typed = o.reminderText.split(/[\s,;]+/).filter(Boolean);
  return {
    title: title.length < 1 || title.length > 200,
    message: o.message.length > 2000,
    // today is too soon to be useful: the chosen day must come after today
    expiryPast: o.expiryDate !== "" && (expiry === null || o.expiryDate <= toDateInput(now.toISOString())),
    reminders: typed.length !== parseReminderDays(o.reminderText).length,
  };
}

/**
 * The fields that differ between what is saved (`saved`) and what is typed (`next`), leaving out any that the
 * server would refuse (an empty title, a date in the past, an over-long message): those wait until fixed.
 */
export function optionsPatch(saved: DraftOptions, next: DraftOptions, now: Date): OptionsPatch {
  const flags = optionsFlags(next, now);
  const patch: OptionsPatch = {};
  if (!flags.title && next.title.trim() !== saved.title.trim()) patch.title = next.title.trim();
  if (next.categoryId !== saved.categoryId) patch.categoryId = next.categoryId;
  if (next.contactId !== saved.contactId) patch.contactId = next.contactId;
  if ((next.ticketId ?? null) !== (saved.ticketId ?? null)) patch.ticketId = next.ticketId ?? null;
  if ((next.dealId ?? null) !== (saved.dealId ?? null)) patch.dealId = next.dealId ?? null;
  if (next.locale !== saved.locale) patch.locale = next.locale;
  if (!flags.message && next.message.trim() !== saved.message.trim()) patch.message = next.message.trim() === "" ? null : next.message.trim();
  if (next.expiryDate !== saved.expiryDate) {
    if (next.expiryDate === "") patch.expiresAt = null;
    else if (!flags.expiryPast) patch.expiresAt = fromDateInput(next.expiryDate);
  }
  if (!flags.reminders) {
    const days = parseReminderDays(next.reminderText);
    if (days.join(",") !== parseReminderDays(saved.reminderText).join(",")) patch.reminderDays = days;
  }
  if (next.codeRequired !== saved.codeRequired) patch.codeRequired = next.codeRequired;
  if (next.signInOrder !== saved.signInOrder) patch.signInOrder = next.signInOrder;
  if (next.allowForwarding !== saved.allowForwarding) patch.allowForwarding = next.allowForwarding;
  if ((next.isPrivate ?? false) !== (saved.isPrivate ?? false)) patch.isPrivate = next.isPrivate ?? false;
  return patch;
}

export const isEmptyPatch = (p: OptionsPatch): boolean => Object.keys(p).length === 0;

/** The date a document sent `now` would expire on by default, as `YYYY-MM-DD`. */
export function defaultExpiryDate(now: Date, expiryDays: number): string {
  const d = new Date(now.getTime() + expiryDays * 24 * 3600 * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
