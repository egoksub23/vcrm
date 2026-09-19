/**
 * Currency — single source of truth for deal-value formatting and
 * the currency picker options.
 *
 * Before this module, ~6 components each defined their own
 * `Intl.NumberFormat(..., { currency: "USD" })` helper with USD
 * baked in. The default currency is now configurable per account
 * (accounts.default_currency, migration 021), so every formatter
 * takes a currency and falls back to DEFAULT_CURRENCY only when
 * nothing is known.
 */

/** App-wide fallback when no account/deal currency is available. */
export const DEFAULT_CURRENCY = "USD";

export interface CurrencyOption {
  /** ISO-4217 code, e.g. "USD". Stored verbatim in the DB. */
  code: string;
  /** Human label for the dropdown, e.g. "US Dollar". */
  label: string;
  /** Symbol for compact display, e.g. "$". Optional — derived from Intl when absent. */
  symbol?: string;
}

/**
 * The built-in currency list: what an account offers until an admin
 * customises it (Settings → Deals & currency), and the suggestions in
 * that screen's "add" picker. Codes must be valid ISO-4217 so
 * `Intl.NumberFormat` renders the right symbol/grouping.
 */
export const CURRENCIES: CurrencyOption[] = [
  { code: "USD", label: "US Dollar", symbol: "$" },
  { code: "EUR", label: "Euro", symbol: "€" },
  { code: "GBP", label: "British Pound", symbol: "£" },
  { code: "INR", label: "Indian Rupee", symbol: "₹" },
  { code: "AUD", label: "Australian Dollar", symbol: "A$" },
  { code: "CAD", label: "Canadian Dollar", symbol: "C$" },
  { code: "BRL", label: "Brazilian Real", symbol: "R$" },
  { code: "JPY", label: "Japanese Yen", symbol: "¥" },
  { code: "CNY", label: "Chinese Yuan", symbol: "¥" },
  { code: "AED", label: "UAE Dirham", symbol: "د.إ" },
  { code: "ZAR", label: "South African Rand", symbol: "R" },
  { code: "NGN", label: "Nigerian Naira", symbol: "₦" },
  { code: "SGD", label: "Singapore Dollar", symbol: "S$" },
  { code: "MXN", label: "Mexican Peso", symbol: "$" },
  { code: "COP", label: "Colombian Peso", symbol: "$" },
  { code: "MYR", label: "Malaysian Ringgit", symbol: "RM" },
  { code: "IDR", label: "Indonesian Rupiah", symbol: "Rp" },
  { code: "THB", label: "Thai Baht", symbol: "฿" },
  { code: "PHP", label: "Philippine Peso", symbol: "₱" },
  { code: "VND", label: "Vietnamese Dong", symbol: "₫" },
  { code: "KRW", label: "South Korean Won", symbol: "₩" },
  { code: "HKD", label: "Hong Kong Dollar", symbol: "HK$" },
  { code: "TWD", label: "New Taiwan Dollar", symbol: "NT$" },
  { code: "NZD", label: "New Zealand Dollar", symbol: "NZ$" },
  { code: "CHF", label: "Swiss Franc", symbol: "CHF" },
  { code: "SAR", label: "Saudi Riyal", symbol: "﷼" },
];

/** Most currencies one account can carry — a sanity bound, not a product limit. */
export const MAX_ACCOUNT_CURRENCIES = 60;
export const CURRENCY_LABEL_MAX = 40;

/**
 * Read `accounts.currencies` (migration 068). NULL / malformed / empty
 * means "not customised" and yields the built-in list, so a bad value can
 * never leave the pickers empty. Entries are validated individually and
 * de-duplicated by code.
 */
export function resolveAccountCurrencies(stored: unknown): CurrencyOption[] {
  if (!Array.isArray(stored)) return CURRENCIES;
  const seen = new Set<string>();
  const out: CurrencyOption[] = [];
  for (const item of stored) {
    if (!item || typeof item !== "object") continue;
    const code = String((item as { code?: unknown }).code ?? "").trim().toUpperCase();
    const label = String((item as { label?: unknown }).label ?? "").trim();
    if (!/^[A-Z]{3}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, label: label || code });
  }
  return out.length > 0 ? out : CURRENCIES;
}

/** The JSON shape stored in `accounts.currencies`. */
export function serializeCurrencies(list: CurrencyOption[]): { code: string; label: string }[] {
  return list.map(({ code, label }) => ({ code, label }));
}

export type CurrencyEntryError = "code_invalid" | "name_required" | "name_too_long" | "duplicate" | "limit";

/** Validate a code + name about to be added to `existing`; null when fine. */
export function validateCurrencyEntry(
  entry: { code: string; label: string },
  existing: CurrencyOption[],
): CurrencyEntryError | null {
  const code = entry.code.trim().toUpperCase();
  const label = entry.label.trim();
  if (!/^[A-Z]{3}$/.test(code)) return "code_invalid";
  if (!label) return "name_required";
  if (label.length > CURRENCY_LABEL_MAX) return "name_too_long";
  if (existing.some((c) => c.code === code)) return "duplicate";
  if (existing.length >= MAX_ACCOUNT_CURRENCIES) return "limit";
  return null;
}

/**
 * `list` plus `code` when it isn't in it — a deal saved in a currency
 * that was later removed from the account must still show (and keep) its
 * own currency in the edit form's picker.
 */
export function withCurrencyIncluded(list: CurrencyOption[], code: string | null | undefined): CurrencyOption[] {
  const c = (code ?? "").trim();
  if (!c || list.some((o) => o.code === c)) return list;
  return [...list, { code: c, label: c }];
}

/** Symbol for a code: a listed one wins, else Intl's narrow symbol, else null. */
export function currencySymbol(code: string): string | null {
  const listed = CURRENCIES.find((c) => c.code === code)?.symbol;
  if (listed) return listed;
  try {
    const part = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((p) => p.type === "currency")?.value;
    // Intl echoes the code back when it has no symbol for it.
    return part && part !== code ? part : null;
  } catch {
    return null;
  }
}

/**
 * Format a deal value as a currency string. Whole-number output
 * (no minor units) — deal values are tracked to the dollar across
 * the app. `currency` defaults to USD so callers with nothing better
 * stay safe, but pass the account/deal currency wherever known.
 *
 * Total by design: `Intl.NumberFormat` throws a RangeError on a
 * structurally invalid currency code, and `deals.currency` carries
 * NO DB CHECK (only `accounts.default_currency` does), so legacy
 * rows, imports, or hand-edited data can hold malformed values like
 * "United States". We never let that crash a render — on a bad code
 * we fall back to "CODE 1,234".
 */
export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = (currency || DEFAULT_CURRENCY).trim();
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Invalid ISO code — show the raw code + grouped number so the
    // value is still legible instead of throwing.
    return `${code} ${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(amount)}`;
  }
}

/**
 * Compact currency for tight spaces (donut center, legend rows):
 * "$1.2M" / "€34.5k" / "₹900". Uses the currency's symbol from
 * the built-in list or Intl, falling back to the code when neither has one.
 */
export function formatCurrencyShort(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = currency || DEFAULT_CURRENCY;
  const symbol = currencySymbol(code) ?? `${code} `;
  return `${symbol}${formatCompactNumber(value)}`;
}

/**
 * Compact number for tight spaces (chart tiles, legends): 1_234 → "1.2k",
 * 1_200_000 → "1.2M", 900 → "900". The unit-less core shared with
 * {@link formatCurrencyShort}.
 */
export function formatCompactNumber(value: number): string {
  const v = Number(value || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}
