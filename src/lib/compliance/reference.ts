// ============================================================
// Compliance requests: the reference (CMP-2026-000123) and phone numbers. Pure; browser-safe.
// The database makes the reference (a counter per workspace per year); these helpers only read and format it.
// ============================================================

export const REFERENCE_RE = /^CMP-\d{4}-\d{6,}$/;

export function formatReference(year: number, seq: number): string {
  return `CMP-${String(year).padStart(4, "0")}-${String(seq).padStart(6, "0")}`;
}

export function isReference(v: string): boolean {
  return REFERENCE_RE.test(v.trim().toUpperCase());
}

/**
 * A phone number in international form (+60123456789) or null when it is not one. A leading 0 is read as Malaysia (0123456789 -> +60123456789),
 * `00` as `+`, `60...` with no plus as Malaysia, spaces, dashes, dots and brackets are dropped. 7 to 15 digits after the plus, as the database checks.
 */
export function normalisePhone(input: string | null | undefined, defaultCountry = "60"): string | null {
  const raw = (input ?? "").trim();
  if (raw === "") return null;
  if (/[^\d\s+().-]/.test(raw)) return null;
  const hasPlus = raw.startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (digits === "") return null;
  if (hasPlus) {
    // already international
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = defaultCountry + digits.slice(1);
  } else if (digits.startsWith(defaultCountry) && digits.length >= defaultCountry.length + 8) {
    // 60123456789 typed without the plus
  } else {
    return null;
  }
  if (digits.length < 7 || digits.length > 15 || digits.startsWith("0")) return null;
  return `+${digits}`;
}

/** The search box: a reference (any case, with or without leading zeros trimmed), or a phone, or text. */
export function searchKind(q: string): "reference" | "phone" | "text" {
  const t = q.trim();
  if (isReference(t)) return "reference";
  if (/^[+\d][\d\s().-]{5,}$/.test(t)) return "phone";
  return "text";
}
