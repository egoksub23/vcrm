import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  currencySymbol,
  formatCurrency,
  formatCurrencyShort,
  resolveAccountCurrencies,
  serializeCurrencies,
  validateCurrencyEntry,
  withCurrencyIncluded,
} from "./currency";

describe("formatCurrency", () => {
  it("formats whole amounts with no minor units", () => {
    // Use a non-breaking-space-tolerant check: Intl may insert NBSP.
    const out = formatCurrency(1234, "USD");
    expect(out).toContain("1,234");
    expect(out).not.toContain(".00");
  });

  it("defaults to USD when no currency is given", () => {
    expect(formatCurrency(10)).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("treats an empty-string currency as the default", () => {
    expect(formatCurrency(10, "")).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("coerces non-finite values to 0", () => {
    expect(formatCurrency(Number.NaN, "USD")).toContain("0");
  });

  it("renders a well-formed but unknown ISO code without throwing", () => {
    // Intl is lenient here — it uses the code as the symbol.
    const out = formatCurrency(1234, "ZZZ");
    expect(out).toContain("ZZZ");
    expect(out).toContain("1,234");
  });

  it("never throws on a structurally invalid code (no DB CHECK on deals.currency)", () => {
    for (const bad of ["United States", "US", "USDD", "12", "u$d"]) {
      expect(() => formatCurrency(1234, bad)).not.toThrow();
      expect(formatCurrency(1234, bad)).toContain("1,234");
    }
  });

  it("formats every offered currency without throwing", () => {
    for (const c of CURRENCIES) {
      expect(() => formatCurrency(1000, c.code)).not.toThrow();
    }
  });
});

describe("formatCurrencyShort", () => {
  it("abbreviates millions and thousands with the currency symbol", () => {
    expect(formatCurrencyShort(2_500_000, "USD")).toBe("$2.5M");
    expect(formatCurrencyShort(3_400, "USD")).toBe("$3.4k");
    expect(formatCurrencyShort(900, "USD")).toBe("$900");
  });

  it("uses the matching symbol for non-USD currencies", () => {
    expect(formatCurrencyShort(1_000, "EUR")).toBe("€1.0k");
    expect(formatCurrencyShort(1_000, "INR")).toBe("₹1.0k");
  });

  it("falls back to the code prefix for unknown currencies (no throw)", () => {
    expect(formatCurrencyShort(1_000, "ZZZ")).toBe("ZZZ 1.0k");
  });
});

describe("built-in list", () => {
  it("offers Malaysian Ringgit", () => {
    expect(CURRENCIES.find((c) => c.code === "MYR")).toMatchObject({ label: "Malaysian Ringgit", symbol: "RM" });
    expect(formatCurrencyShort(1_500, "MYR")).toBe("RM1.5k");
  });

  it("has unique codes", () => {
    expect(new Set(CURRENCIES.map((c) => c.code)).size).toBe(CURRENCIES.length);
  });
});

describe("currencySymbol", () => {
  it("derives a symbol for codes outside the built-in list", () => {
    expect(currencySymbol("SEK")).not.toBeNull();
  });
  it("returns null when there is no symbol", () => {
    expect(currencySymbol("ZZZ")).toBeNull();
  });
});

describe("resolveAccountCurrencies", () => {
  it("falls back to the built-ins for null, non-arrays and empty/garbage arrays", () => {
    expect(resolveAccountCurrencies(null)).toBe(CURRENCIES);
    expect(resolveAccountCurrencies("USD")).toBe(CURRENCIES);
    expect(resolveAccountCurrencies([])).toBe(CURRENCIES);
    expect(resolveAccountCurrencies([{ code: "x" }, 5, null])).toBe(CURRENCIES);
  });

  it("keeps valid entries, upper-cases codes, defaults a blank name, drops duplicates", () => {
    expect(
      resolveAccountCurrencies([
        { code: "myr", label: "Malaysian Ringgit" },
        { code: "USD", label: "" },
        { code: "MYR", label: "dupe" },
        { code: "bad!", label: "no" },
      ]),
    ).toEqual([
      { code: "MYR", label: "Malaysian Ringgit" },
      { code: "USD", label: "USD" },
    ]);
  });

  it("round-trips through serializeCurrencies", () => {
    const list = [{ code: "MYR", label: "Malaysian Ringgit", symbol: "RM" }];
    expect(resolveAccountCurrencies(serializeCurrencies(list))).toEqual([{ code: "MYR", label: "Malaysian Ringgit" }]);
  });
});

describe("validateCurrencyEntry", () => {
  const existing = [{ code: "USD", label: "US Dollar" }];
  it("accepts a new well-formed entry (case-insensitive code)", () => {
    expect(validateCurrencyEntry({ code: "myr", label: "Malaysian Ringgit" }, existing)).toBeNull();
  });
  it("rejects bad codes, blank/long names and duplicates", () => {
    expect(validateCurrencyEntry({ code: "RM", label: "x" }, existing)).toBe("code_invalid");
    expect(validateCurrencyEntry({ code: "MYR", label: "  " }, existing)).toBe("name_required");
    expect(validateCurrencyEntry({ code: "MYR", label: "x".repeat(41) }, existing)).toBe("name_too_long");
    expect(validateCurrencyEntry({ code: "usd", label: "Dollar" }, existing)).toBe("duplicate");
  });
});

describe("withCurrencyIncluded", () => {
  const list = [{ code: "USD", label: "US Dollar" }];
  it("adds a code that was removed from the account list", () => {
    expect(withCurrencyIncluded(list, "MYR")).toEqual([...list, { code: "MYR", label: "MYR" }]);
  });
  it("returns the same list when the code is present or empty", () => {
    expect(withCurrencyIncluded(list, "USD")).toBe(list);
    expect(withCurrencyIncluded(list, "")).toBe(list);
    expect(withCurrencyIncluded(list, null)).toBe(list);
  });
});
