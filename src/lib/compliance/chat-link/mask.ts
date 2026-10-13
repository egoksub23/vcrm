// ============================================================
// Compliance requests, the personal closure form link: how the registered phone number is shown to the customer on the form. Pure; browser-safe.
// The number comes from the chat and cannot be edited on the form, so the customer only has to recognise it.
// ============================================================

/**
 * `+60123456881` -> `+6012•••••881`: the country code and the first two digits after it, the last three digits, and a dot for each digit between.
 * A shorter number keeps less (never more than half of it). Anything that is not a plausible number gives an empty string (the form then asks for it).
 */
export function maskPhone(phone: string | null | undefined): string {
  const raw = (phone ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  const plus = raw.startsWith("+") ? "+" : "";
  const keepEnd = digits.length >= 10 ? 3 : 2;
  const keepStart = digits.length >= 10 ? 4 : 2;
  const hidden = digits.length - keepStart - keepEnd;
  if (hidden < 1) return "";
  return `${plus}${digits.slice(0, keepStart)}${"•".repeat(hidden)}${digits.slice(digits.length - keepEnd)}`;
}
