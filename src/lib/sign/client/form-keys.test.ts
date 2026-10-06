import { describe, expect, it } from "vitest";

import { cleanDataKey, DATA_KEY_RE, keyFromLabel, OPTION_VALUE_RE, optionValueFromLabel, slugify, takenDataKeys, uniqueKey } from "./form-keys";
import { placements, sampleForm } from "./form-fixtures";

describe("slugify", () => {
  it("makes lower-case words joined by underscores and drops accents", () => {
    expect(slugify("Tax percentage")).toBe("tax_percentage");
    expect(slugify("  Sdn. Bhd.  ")).toBe("sdn_bhd");
    expect(slugify("Café & Bar — 2")).toBe("cafe_bar_2");
    expect(slugify("公司名称")).toBe("");
  });
});

describe("keyFromLabel", () => {
  it("makes a valid, unique key from an English label", () => {
    const taken = new Set<string>();
    const a = keyFromLabel("Tax percentage", taken);
    expect(a).toBe("tax_percentage");
    taken.add(a);
    expect(keyFromLabel("Tax percentage", taken)).toBe("tax_percentage_2");
    taken.add("tax_percentage_2");
    expect(keyFromLabel("Tax percentage", taken)).toBe("tax_percentage_3");
  });

  it("always answers a key validateForm accepts", () => {
    for (const label of ["", "123 numbers first", "公司", "A".repeat(200), "  ", "Name / Nama (BM)", "_leading"]) {
      const key = keyFromLabel(label, new Set());
      expect(key).toMatch(DATA_KEY_RE);
    }
  });

  it("keeps a long label within 40 characters even when it needs a suffix", () => {
    const base = "x".repeat(60);
    const first = keyFromLabel(base, new Set());
    expect(first.length).toBe(40);
    const second = keyFromLabel(base, new Set([first]));
    expect(second.length).toBeLessThanOrEqual(40);
    expect(second).not.toBe(first);
    expect(second).toMatch(DATA_KEY_RE);
  });

  it("avoids the keys of the form and of the placements", () => {
    const taken = takenDataKeys(sampleForm(), placements);
    expect(taken.has("legal_name")).toBe(true);
    expect(taken.has("f_sig")).toBe(true);
    expect(keyFromLabel("Legal name", taken)).toBe("legal_name_2");
    expect(keyFromLabel("F sig", taken)).toBe("f_sig_2");
  });
});

describe("optionValueFromLabel", () => {
  it("makes a stored value from the label and keeps values unique", () => {
    const taken = new Set<string>();
    const a = optionValueFromLabel("Sdn. Bhd.", taken);
    expect(a).toBe("sdn_bhd");
    taken.add(a);
    expect(optionValueFromLabel("sdn bhd", taken)).toBe("sdn_bhd_2");
    expect(optionValueFromLabel("2 years", new Set())).toMatch(OPTION_VALUE_RE);
    expect(optionValueFromLabel("", new Set())).toBe("option");
    expect(optionValueFromLabel("é".repeat(80) + "z".repeat(80), new Set()).length).toBeLessThanOrEqual(60);
  });
});

describe("uniqueKey and cleanDataKey", () => {
  it("counts up from 2", () => {
    expect(uniqueKey("a", new Set(["a", "a_2"]))).toBe("a_3");
  });
  it("strips what a key cannot hold", () => {
    expect(cleanDataKey("1st Tax-ID!")).toBe("stTaxID");
    expect(cleanDataKey("_x")).toBe("x");
    expect(cleanDataKey("a".repeat(80)).length).toBe(40);
  });
});
