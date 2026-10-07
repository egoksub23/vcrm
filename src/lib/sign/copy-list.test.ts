import { describe, expect, it } from "vitest";

import { MAX_COPY_RECIPIENTS, checkCopyList, copiesWithoutSigners, copyProblem } from "./copy-list";

const person = (n: number) => ({ fullName: `Person ${n}`, email: `p${n}@copy.example` });

describe("copyProblem", () => {
  it("accepts a name and an address that looks like one", () => {
    expect(copyProblem({ fullName: "Siti Aminah", email: "siti@copy.example" })).toBeNull();
    expect(copyProblem({ fullName: "  Siti  ", email: "  siti@copy.example  " })).toBeNull();
  });

  it("names the first thing wrong: the name before the address", () => {
    expect(copyProblem({ fullName: "", email: "siti@copy.example" })).toBe("copy_name");
    expect(copyProblem({ fullName: "   ", email: "siti@copy.example" })).toBe("copy_name");
    expect(copyProblem({ fullName: "x".repeat(161), email: "siti@copy.example" })).toBe("copy_name");
    expect(copyProblem({ fullName: "Siti", email: "siti" })).toBe("copy_email");
    expect(copyProblem({ fullName: "Siti", email: "siti@nodot" })).toBe("copy_email");
    expect(copyProblem({ fullName: "Siti", email: `${"x".repeat(250)}@a.example` })).toBe("copy_email");
    expect(copyProblem({ fullName: "", email: "no" })).toBe("copy_name");
    expect(copyProblem({ fullName: 5, email: ["a@b.example"] })).toBe("copy_name");
    expect(copyProblem({})).toBe("copy_name");
  });
});

describe("checkCopyList", () => {
  it("takes nothing, an empty list or a good list, trimmed, in the order given", () => {
    expect(checkCopyList(undefined)).toEqual({ ok: true, list: [] });
    expect(checkCopyList(null)).toEqual({ ok: true, list: [] });
    expect(checkCopyList([])).toEqual({ ok: true, list: [] });
    expect(checkCopyList([{ fullName: "  Siti ", email: " siti@copy.example " }, person(2)])).toEqual({ ok: true, list: [{ fullName: "Siti", email: "siti@copy.example" }, person(2)] });
  });

  it("takes the snake_case name a stored row has too", () => {
    expect(checkCopyList([{ full_name: "Siti", email: "siti@copy.example" }])).toEqual({ ok: true, list: [{ fullName: "Siti", email: "siti@copy.example" }] });
  });

  it("is up to ten people, and says so beyond that", () => {
    expect(MAX_COPY_RECIPIENTS).toBe(10);
    expect(checkCopyList(Array.from({ length: 10 }, (_, i) => person(i)))).toMatchObject({ ok: true });
    expect(checkCopyList(Array.from({ length: 11 }, (_, i) => person(i)))).toEqual({ ok: false, issues: [{ code: "too_many_copies" }] });
  });

  it("lists every problem, each with the place of the person (0-based)", () => {
    const r = checkCopyList([person(1), { fullName: "", email: "a@b.example" }, { fullName: "Bala", email: "bad" }, person(4)]);
    expect(r).toEqual({ ok: false, issues: [{ code: "copy_name", index: 1 }, { code: "copy_email", index: 2 }] });
  });

  it("refuses the same address twice, case and spaces ignored, at the second place", () => {
    expect(checkCopyList([{ fullName: "A", email: "a@copy.example" }, { fullName: "B", email: " A@Copy.Example " }])).toEqual({ ok: false, issues: [{ code: "copy_duplicate", index: 1 }] });
  });

  it("refuses what is not a list, and a person that is not an object", () => {
    expect(checkCopyList("a@b.example")).toEqual({ ok: false, issues: [{ code: "bad_copy_list" }] });
    expect(checkCopyList({ fullName: "A", email: "a@b.example" })).toEqual({ ok: false, issues: [{ code: "bad_copy_list" }] });
    expect(checkCopyList(["a@b.example"])).toEqual({ ok: false, issues: [{ code: "copy_name", index: 0 }] });
    expect(checkCopyList([null])).toEqual({ ok: false, issues: [{ code: "copy_name", index: 0 }] });
  });
});

describe("copiesWithoutSigners", () => {
  const list = [
    { fullName: "Ali", email: "ALI@kedai.example" },
    { fullName: "Rahman", email: "rahman@vircle.example" },
    { fullName: "Mei", email: "mei@vircle.example" },
  ];

  it("drops the people who sign the document, case and spaces ignored, and keeps the order", () => {
    expect(copiesWithoutSigners(list, ["ali@kedai.example ", "gokula@vircle.example"])).toEqual([list[1], list[2]]);
  });

  it("changes nothing when nobody on the list signs", () => {
    expect(copiesWithoutSigners(list, ["x@y.example"])).toEqual(list);
    expect(copiesWithoutSigners(list, [])).toEqual(list);
    expect(copiesWithoutSigners([], ["x@y.example"])).toEqual([]);
  });
});
