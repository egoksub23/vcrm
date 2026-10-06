import { describe, expect, it } from "vitest";

import { BRN_TYPES, EINVOICE_PHASES, MALAYSIAN_STATES, TAX_TYPES } from "../addons/merchant/form";
import { SYSTEM_LIST_KEYS, isSystemListKey } from "./keys";
import { MSIC_CLASSES, MSIC_DIVISIONS, MSIC_SECTIONS, MSIC_SOURCE, msicItems } from "./msic";
import { SYSTEM_LISTS } from "./system-lists";
import { LIST_KEY_RE, LIST_VALUE_RE, MAX_ITEM_LABEL, MSIC_CODE_RE, type ListItem } from "./types";

const list = (key: string) => SYSTEM_LISTS.find((l) => l.key === key)!;

describe("the lists every workspace starts with", () => {
  it("are the seven named, with keys the database and the code agree on", () => {
    expect(SYSTEM_LISTS.map((l) => l.key)).toEqual([...SYSTEM_LIST_KEYS]);
    expect(isSystemListKey("states_my")).toBe(true);
    expect(isSystemListKey("suppliers")).toBe(false);
    for (const l of SYSTEM_LISTS) {
      expect(l.key).toMatch(LIST_KEY_RE);
      expect(l.name.length).toBeGreaterThan(2);
      expect(l.description.length).toBeLessThanOrEqual(500);
      expect(l.version).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(SYSTEM_LISTS.map((l) => l.position)).size).toBe(SYSTEM_LISTS.length);
  });

  it("have sound items: a stable value, an English label, no duplicates, no label too long", () => {
    for (const l of SYSTEM_LISTS) {
      const seen = new Set<string>();
      for (const i of l.items) {
        expect(i.value, `${l.key} ${i.value}`).toMatch(l.kind === "msic" ? MSIC_CODE_RE : LIST_VALUE_RE);
        expect(seen.has(i.value), `${l.key} repeats ${i.value}`).toBe(false);
        seen.add(i.value);
        expect(i.label.en.trim(), `${l.key} ${i.value}`).not.toBe("");
        for (const text of Object.values(i.label)) expect(text.length).toBeLessThanOrEqual(MAX_ITEM_LABEL);
      }
    }
  });

  it("keep the stored values the Merchant Registration add-on has used, so a form switched to a list loses no answer", () => {
    const values = (items: readonly { value: string }[]) => items.map((i) => i.value);
    expect(values(list("states_my").items)).toEqual(values(MALAYSIAN_STATES));
    expect(values(list("company_id_types").items)).toEqual(values(BRN_TYPES));
    expect(values(list("einvoice_phases").items)).toEqual(values(EINVOICE_PHASES));
    const tax = values(list("tax_types").items);
    for (const v of values(TAX_TYPES)) expect(tax).toContain(v);
    // the wording is the add-on's too, in every language it had
    const label = (key: string, value: string) => list(key).items.find((i) => i.value === value)!.label;
    for (const s of MALAYSIAN_STATES) expect(label("states_my", s.value)).toEqual(s.label);
    for (const s of EINVOICE_PHASES) expect(label("einvoice_phases", s.value)).toEqual(s.label);
  });
});

describe("states_my", () => {
  it("holds the 13 states and the 3 federal territories", () => {
    const items = list("states_my").items;
    expect(items).toHaveLength(16);
    expect(items.filter((i) => i.value.startsWith("wp_"))).toHaveLength(3);
    expect(items.map((i) => i.value)).toContain("pulau_pinang");
  });
});

describe("countries", () => {
  const items = list("countries").items;

  it("are the 249 entries of ISO 3166-1, Malaysia first, each by its two-letter code", () => {
    expect(items).toHaveLength(249);
    expect(items[0].value).toBe("MY");
    for (const i of items) expect(i.value).toMatch(/^[A-Z]{2}$/);
    expect(new Set(items.map((i) => i.value)).size).toBe(249);
  });

  it("have Bahasa Melayu names, and Chinese and Korean ones for the countries Malaysian businesses deal with", () => {
    const by = new Map(items.map((i) => [i.value, i.label]));
    expect(by.get("SG")).toMatchObject({ en: "Singapore", ms: "Singapura", zh: "新加坡", ko: "싱가포르" });
    expect(by.get("US")).toMatchObject({ en: "United States", ms: "Amerika Syarikat" });
    expect(by.get("DE")).toMatchObject({ en: "Germany", ms: "Jerman" });
    for (const i of items) expect(i.label.ms, i.value).toBeTruthy();
  });

  it("include well-known codes", () => {
    const codes = new Set(items.map((i) => i.value));
    for (const c of ["MY", "SG", "BN", "ID", "TH", "CN", "JP", "KR", "IN", "AU", "GB", "US", "FR", "DE", "AE", "SA", "ZA", "NZ", "CA", "BR"]) expect(codes.has(c), c).toBe(true);
  });
});

describe("banks and tax types", () => {
  it("end the bank list with Other, and name the principal banks", () => {
    const banks = list("banks_my").items;
    expect(banks[banks.length - 1].value).toBe("other");
    expect(banks.map((b) => b.value)).toEqual(expect.arrayContaining(["maybank", "cimb", "public_bank", "rhb", "hong_leong", "ambank", "bank_islam"]));
  });

  it("offer SST, service tax, sales tax and not applicable", () => {
    expect(list("tax_types").items.map((i) => i.value)).toEqual(expect.arrayContaining(["sst", "service_tax", "sales_tax", "na"]));
  });
});

describe("MSIC 2008 (DOSM)", () => {
  const items = list("msic").items;

  it("says where it came from, and when", () => {
    expect(MSIC_SOURCE.url).toBe("https://open.dosm.gov.my/data-catalogue/msic");
    expect(MSIC_SOURCE.licence).toBe("CC BY 4.0");
    expect(MSIC_SOURCE.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is the full classification: 21 sections, 88 divisions, 1,174 five-digit classes", () => {
    expect(MSIC_SECTIONS.map((s) => s.code).join("")).toBe("ABCDEFGHIJKLMNOPQRSTU");
    expect(MSIC_DIVISIONS).toHaveLength(88);
    expect(MSIC_CLASSES).toHaveLength(1174);
    expect(items).toHaveLength(1174);
  });

  it("has every code as five digits, once, in order, under a division of its own section", () => {
    const codes = items.map((i) => i.value);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    const sections = new Set(MSIC_SECTIONS.map((s) => s.code));
    const divisions = new Map(MSIC_DIVISIONS.map((d) => [d.code, d]));
    for (const d of MSIC_DIVISIONS) expect(sections.has(d.section), d.code).toBe(true);
    for (const c of MSIC_CLASSES) {
      expect(c.code).toMatch(MSIC_CODE_RE);
      expect(c.code.startsWith(c.division), c.code).toBe(true);
      expect(divisions.get(c.division)?.section, c.code).toBe(c.section);
    }
    // every division has at least one class, and the division order follows the code order
    for (const d of MSIC_DIVISIONS) expect(MSIC_CLASSES.some((c) => c.division === d.code), d.code).toBe(true);
    expect(MSIC_DIVISIONS.map((d) => d.code)).toEqual([...MSIC_DIVISIONS.map((d) => d.code)].sort());
  });

  it("holds the well-known codes with DOSM's wording (checked against the source on retrieval)", () => {
    const by = new Map(MSIC_CLASSES.map((c) => [c.code, c]));
    expect(by.get("01111")).toMatchObject({ en: "Growing of maize", ms: "Penanaman jagung", section: "A" });
    expect(by.get("47111")).toMatchObject({ en: "Provision stores", ms: "Kedai runcit", section: "G" });
    expect(by.get("62010")).toMatchObject({ en: "Computer programming activities", ms: "Aktiviti pengaturcaraan komputer", section: "J" });
    expect(by.get("62021")).toMatchObject({ en: "Computer consultancy", ms: "Perundingan komputer" });
    expect(by.get("96091")).toMatchObject({ en: "Activities of sauna, steam baths, massage salons", section: "S" });
    expect(by.get("56101")).toMatchObject({ en: "Restaurants and restaurant cum night clubs", section: "I" });
    expect(by.get("99000")).toMatchObject({ en: "Activities of extraterritorial organizations and bodies", section: "U" });
  });

  it("keeps the source's own wording, without the footnote markers and the spreadsheet artefact it was published with", () => {
    for (const c of MSIC_CLASSES) {
      expect(`${c.en} ${c.ms}`, c.code).not.toMatch(/_x000D_/);
      expect(c.ms, c.code).not.toMatch(/\(\d+\)?\s*$/);
      expect(c.ms, c.code).not.toMatch(/\($/);
      expect(c.ms, c.code).not.toMatch(/\s{2,}/);
    }
    // an odd wording in the source stays odd: it was not "corrected"
    expect(MSIC_CLASSES.find((c) => c.code === "20131")).toMatchObject({ en: "Manufacture of plastic in primary forms" });
    expect(MSIC_CLASSES.find((c) => c.code === "64924")?.ms).toBe("Kedai pajak gadai dan tukang pajak termasuk Ar-Rahnu");
  });

  it("is given to the list as an item per class, grouped by division, with English and Malay", () => {
    const first: ListItem = items[0];
    expect(first).toEqual({ value: "01111", label: { en: "Growing of maize", ms: "Penanaman jagung" }, group: "01" });
    expect(msicItems()).toEqual(items);
    for (const i of items) {
      expect(i.group).toBe(i.value.slice(0, 2));
      expect(i.label.ms).toBeTruthy();
    }
  });
});
