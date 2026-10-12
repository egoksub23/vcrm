// ============================================================
// Compliance requests, the public forms: an amount in ringgit, a Malaysian phone number, a bank account number, an email address. Pure; browser-safe.
// ============================================================

import { normalisePhone } from "../reference";

export type AmountResult = { ok: true; value: number } | { ok: false; code: "required" | "invalid" | "too_small" | "too_many_decimals" | "too_large" };

/**
 * An amount typed by a person: "1,250.50", "RM 80", "80.5". Positive, at most two decimals, at most `max`. Anything that is not plainly a number
 * ("1e3", "-5", "12.345", "1.234,50", words) is refused rather than guessed at: the figure is money that will be paid out.
 */
export function parseAmount(input: unknown, max: number): AmountResult {
  const raw = typeof input === "number" ? String(input) : typeof input === "string" ? input : "";
  let s = raw.trim().replace(/^rm\s*/i, "").replace(/\s+/g, "");
  if (s === "") return { ok: false, code: "required" };
  // thousands separators must be where they belong: 1,250.50 / 12,345 (never 1,25 or 1.250,50)
  if (s.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return { ok: false, code: "invalid" };
    s = s.replace(/,/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, code: "invalid" };
  const decimals = s.includes(".") ? s.split(".")[1].length : 0;
  if (decimals > 2) return { ok: false, code: "too_many_decimals" };
  const value = Math.round(Number(s) * 100) / 100;
  if (!Number.isFinite(value)) return { ok: false, code: "invalid" };
  if (value <= 0) return { ok: false, code: "too_small" };
  if (value > max) return { ok: false, code: "too_large" };
  return { ok: true, value };
}

/** A Malaysian mobile or landline number in +60 form, or null. "012-3344 5566", "0123344556", "+60 12 334 4556" and "60123344556" all become +60123344556. */
export function malaysianPhone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const p = normalisePhone(input, "60");
  return p && /^\+60[1-9]\d{7,10}$/.test(p) ? p : null;
}

/** A bank account number as digits only (spaces and dashes typed for readability are dropped), or null when it is not 6 to 20 digits. */
export function bankAccountNumber(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (!/^[\d\s-]+$/.test(t)) return null;
  const digits = t.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 20 ? digits : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email address, trimmed and lower-cased, or null. */
export function cleanEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const e = input.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e) || /[\u0000-\u001f\u007f<>"',;()]/.test(e)) return null;
  return e;
}

/** A name or a short line of text: trimmed, inner whitespace collapsed, no control characters; null when empty or longer than `max`. */
export function cleanLine(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  const t = input.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t !== "" && t.length <= max ? t : null;
}

/** Free text (several lines allowed): trimmed, control characters other than line breaks dropped; null when empty or longer than `max`. */
export function cleanText(input: unknown, max: number): string | null {
  if (typeof input !== "string") return null;
  const t = input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  return t !== "" && t.length <= max ? t : null;
}

/** The address as shown back to the person who typed it: s•••••@example.com. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}${"•".repeat(Math.min(6, Math.max(2, local.length - 1)))}${email.slice(at)}`;
}
