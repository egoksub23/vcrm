import { describe, expect, it } from "vitest";

import { csvCell, exportCsv, mergeImported, parseCsv, parseListCsv } from "./csv";
import type { ListItem } from "./types";

const item = (value: string, en: string, extra: Partial<ListItem["label"]> = {}, more: Partial<ListItem> = {}): ListItem => ({ value, label: { en, ...extra }, ...more });

describe("parseCsv", () => {
  it("reads rows and cells, with CRLF, LF or CR line ends and no trailing blank row", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseCsv("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseCsv("a,b\rc,d\r")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("drops a byte order mark (what Excel writes as UTF-8)", () => {
    expect(parseCsv("﻿value,en\nmy,Malaysia")[0]).toEqual(["value", "en"]);
  });

  it("reads quoted cells: separators, doubled quotes and line breaks inside", () => {
    expect(parseCsv('code,description\n01111,"Growing of maize, beans"\n01112,"He said ""hi"""\n01113,"two\nlines"')).toEqual([
      ["code", "description"],
      ["01111", "Growing of maize, beans"],
      ["01112", 'He said "hi"'],
      ["01113", "two\nlines"],
    ]);
  });

  it("detects a semicolon or a tab as the separator (Excel in many locales), and ignores a separator in quotes when deciding", () => {
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('"a,b,c";d\n1;2')).toEqual([["a,b,c", "d"], ["1", "2"]]);
  });

  it("skips blank lines and keeps empty cells", () => {
    expect(parseCsv("a,b,c\n\n,,\n1,,3\n")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });

  it("reads an empty text as no rows", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });
});

describe("csvCell and exportCsv", () => {
  it("quotes what needs it and makes a formula harmless", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("-dash")).toBe("'-dash");
  });

  it("writes a header and a row per item, with a byte order mark", () => {
    const csv = exportCsv([item("MY", "Malaysia", { ms: "Malaysia", zh: "马来西亚" }), item("x", "Hidden", {}, { archived: true, group: "g" })]);
    expect(csv.startsWith("﻿value,en,ms,zh,ko,group,archived\r\n")).toBe(true);
    expect(csv).toContain("MY,Malaysia,Malaysia,马来西亚,,,\r\n");
    expect(csv).toContain("x,Hidden,,,,g,yes\r\n");
  });

  it("round-trips through the import, including quotes, commas, Chinese and a hidden item", () => {
    const items = [
      item("a_1", 'Acme, "the" best', { ms: "Terbaik", zh: "最好", ko: "최고" }, { group: "Top" }),
      item("b-2", "Hidden one", {}, { archived: true }),
      item("62010", "Computer programming activities", { ms: "Aktiviti pengaturcaraan komputer" }),
    ];
    const parsed = parseListCsv(exportCsv(items), "options");
    expect(parsed.problems).toEqual([]);
    expect(parsed.items).toEqual([items[0], items[1], items[2]]);
  });

  it("an exported formula comes back as it was written", () => {
    const parsed = parseListCsv(exportCsv([item("f", "=1+1")]), "options");
    expect(parsed.items[0].label.en).toBe("=1+1");
  });
});

describe("parseListCsv", () => {
  it("accepts the names an admin is likely to use for the columns", () => {
    const parsed = parseListCsv("Code,Description,Description (Malay),Division\n01111,Growing of maize,Penanaman jagung,01\n", "msic");
    expect(parsed.problems).toEqual([]);
    expect(parsed.items).toEqual([{ value: "01111", label: { en: "Growing of maize", ms: "Penanaman jagung" }, group: "01" }]);
    expect(parseListCsv("KOD;English;BM\nMY;Malaysia;Malaysia", "options").items).toEqual([{ value: "MY", label: { en: "Malaysia", ms: "Malaysia" } }]);
  });

  it("reads a file saved by Excel: a BOM, CRLF and quotes", () => {
    const parsed = parseListCsv('﻿value,en\r\nsdn_bhd,"Sdn. Bhd."\r\nbhd,Bhd.\r\n', "options");
    expect(parsed.items.map((i) => i.value)).toEqual(["sdn_bhd", "bhd"]);
    expect(parsed.items[0].label.en).toBe("Sdn. Bhd.");
  });

  it("refuses a file with no value column, no English column, no rows or nothing at all, saying which", () => {
    expect(parseListCsv("", "options").problems).toEqual([{ row: 0, code: "empty_file", level: "error" }]);
    expect(parseListCsv("name,description\nx,y", "options").problems[0]).toMatchObject({ row: 0, code: "missing_value_column" });
    expect(parseListCsv("code,ms\n1,2", "options").problems[0]).toMatchObject({ row: 0, code: "missing_en_column" });
    expect(parseListCsv("code,en\n", "options").problems[0]).toMatchObject({ row: 0, code: "no_rows" });
    expect(parseListCsv("code,en\n", "options").items).toEqual([]);
  });

  it("leaves out a bad row and says which and why, taking the rest", () => {
    const csv = ["value,en", "ok_1,One", ",No value", "bad value,Space", "ok_1,Duplicate", "ok_2,", "ok_3,Three"].join("\n");
    const parsed = parseListCsv(csv, "options");
    expect(parsed.items.map((i) => i.value)).toEqual(["ok_1", "ok_3"]);
    expect(parsed.problems).toEqual([
      { row: 2, code: "empty_value", level: "error" },
      { row: 3, code: "bad_value", level: "error", detail: "bad value" },
      { row: 4, code: "duplicate_value", level: "error", detail: "ok_1" },
      { row: 5, code: "empty_label", level: "error", detail: "ok_2" },
    ]);
  });

  it("requires five digits for an MSIC code, and puts back a leading zero a spreadsheet took away (as a warning)", () => {
    const parsed = parseListCsv("code,description\n1111,Growing of maize\n62010,Computer programming\nABCDE,Not a code\n123456,Too long", "msic");
    expect(parsed.items.map((i) => i.value)).toEqual(["01111", "62010"]);
    expect(parsed.problems).toEqual([
      { row: 1, code: "code_padded", level: "warning", detail: "1111" },
      { row: 3, code: "bad_msic_code", level: "error", detail: "ABCDE" },
      { row: 4, code: "bad_msic_code", level: "error", detail: "123456" },
    ]);
  });

  it("does not pad a four-digit value in an ordinary list", () => {
    expect(parseListCsv("value,en\n1111,Four", "options").items[0].value).toBe("1111");
  });

  it("refuses a label that is too long, and a group that is", () => {
    const parsed = parseListCsv(`value,en,group\na,${"x".repeat(301)},\nb,Fine,${"g".repeat(41)}\nc,Fine,short`, "options");
    expect(parsed.items.map((i) => i.value)).toEqual(["c"]);
    expect(parsed.problems.map((p) => p.code)).toEqual(["label_too_long", "group_too_long"]);
  });

  it("marks an item hidden only when the file has an archived column and says yes", () => {
    expect(parseListCsv("value,en,archived\na,A,yes\nb,B,\nc,C,no", "options").items.map((i) => !!i.archived)).toEqual([true, false, false]);
    expect(parseListCsv("value,en\na,A", "options").items[0].archived).toBeUndefined();
  });

  it("refuses a file with more rows than a list can hold", () => {
    const rows = Array.from({ length: 5001 }, (_, i) => `v${i},Item ${i}`).join("\n");
    expect(parseListCsv(`value,en\n${rows}`, "options").problems[0]).toMatchObject({ row: 0, code: "too_many_rows" });
  });

  it("collapses white space and trims; a label is one line, so a line break inside one becomes a space", () => {
    expect(parseListCsv("value,en\n a ,  Two   words  ", "options").items).toEqual([{ value: "a", label: { en: "Two words" } }]);
    expect(parseListCsv('value,en\na,"Line\nbreak"', "options").items[0].label.en).toBe("Line break");
  });
});

describe("mergeImported", () => {
  const existing = [item("a", "Apple", { ms: "Epal", zh: "苹果" }), item("b", "Banana"), item("c", "Cherry", {}, { archived: true })];

  it("adds what is new (last) and updates what is there, keeping a language the file does not give", () => {
    const parsed = parseListCsv("value,en,ms\na,Apple (red),Epal merah\nd,Date,Kurma\nb,Banana,", "options");
    const m = mergeImported(existing, parsed, "merge");
    expect(m.items.map((i) => i.value)).toEqual(["a", "b", "c", "d"]);
    expect(m.items[0].label).toEqual({ en: "Apple (red)", ms: "Epal merah", zh: "苹果" });
    expect(m).toMatchObject({ added: 1, updated: 1, unchanged: 1, removed: 0 });
  });

  it("changes only what the file talks about: group and archived stay unless the file has those columns", () => {
    const hidden = mergeImported(existing, parseListCsv("value,en\nc,Cherry", "options"), "merge");
    expect(hidden.items[2].archived).toBe(true);
    const shown = mergeImported(existing, parseListCsv("value,en,archived\nc,Cherry,", "options"), "merge");
    expect(shown.items[2].archived).toBeUndefined();
    expect(shown.updated).toBe(1);
  });

  it("replaces the whole list with the file, counting what goes", () => {
    const m = mergeImported(existing, parseListCsv("value,en\na,Apple\nz,Zucchini", "options"), "replace");
    expect(m.items.map((i) => i.value)).toEqual(["a", "z"]);
    expect(m).toMatchObject({ added: 1, updated: 1, unchanged: 0, removed: 2 });
  });

  it("an import that says what the list already says changes nothing", () => {
    const m = mergeImported(existing, parseListCsv(exportCsv(existing), "options"), "merge");
    expect(m).toMatchObject({ added: 0, updated: 0, unchanged: 3, removed: 0 });
    expect(m.items).toEqual(existing);
  });
});
