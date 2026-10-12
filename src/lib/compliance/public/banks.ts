// ============================================================
// Compliance requests, the public forms: the banks a parent chooses their refund account from. Pure; browser-safe.
//
// The list is the workspace's own to change (Settings > Compliance > Public forms keeps a list per form; null means this default). The form offers it as a
// choice plus "Other bank", where the parent types the name: a list is a convenience and a guard against typos, not a wall (a new bank must not stop a
// refund). Only the chosen NAME is kept, with the other bank answers, encrypted (bank_name is a sensitive field).
// ============================================================

/** Banks licensed in Malaysia that a parent is likely to hold an account with. Alphabetical. */
export const DEFAULT_BANKS: readonly string[] = [
  "Affin Bank",
  "AEON Bank",
  "Agrobank",
  "Alliance Bank",
  "Al Rajhi Bank",
  "AmBank",
  "Bank Islam",
  "Bank Muamalat",
  "Bank Rakyat",
  "Bank Simpanan Nasional (BSN)",
  "Boost Bank",
  "CIMB Bank",
  "Citibank",
  "GXBank",
  "Hong Leong Bank",
  "HSBC Bank",
  "Kuwait Finance House",
  "Maybank",
  "MBSB Bank",
  "OCBC Bank",
  "Public Bank",
  "RHB Bank",
  "Standard Chartered Bank",
  "UOB Bank",
];

/** The value the form sends when the parent chooses "Other bank" and types the name. */
export const OTHER_BANK = "__other__";

/** A list an administrator typed, one bank per line: trimmed, de-duplicated, at most 80 of at most 80 characters. Null when nothing usable was typed. */
export function parseBankList(text: string): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (name === "" || name === OTHER_BANK || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= 80) break;
  }
  return out.length > 0 ? out : null;
}

/** The list to offer: the form's own, else the default. */
export const banksFor = (own: readonly string[] | null | undefined): readonly string[] => (own && own.length > 0 ? own : DEFAULT_BANKS);

/** The bank name to keep from a submission: the one chosen from the list, or the typed name of "Other bank". Null when neither is acceptable. */
export function chosenBank(choice: unknown, other: unknown, list: readonly string[]): string | null {
  if (typeof choice !== "string") return null;
  if (choice === OTHER_BANK) {
    if (typeof other !== "string") return null;
    const name = other.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return name.length >= 2 && name.length <= 80 ? name : null;
  }
  return list.includes(choice) ? choice : null;
}
