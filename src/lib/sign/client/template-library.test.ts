import { describe, expect, it } from "vitest";

import { countVersions, filterTemplates, isLibraryFiltered, newDocumentFromTemplateHref, templateEditorHref, templateStatusKey, type LibraryTemplate } from "./template-library";

const row = (over: Partial<LibraryTemplate> & { id: string }): LibraryTemplate => ({
  name: over.id,
  description: null,
  category_id: null,
  status: "active",
  tags: [],
  addon_key: null,
  addon_version: null,
  customised: false,
  updated_at: "2026-10-01T00:00:00Z",
  versionCount: 1,
  ...over,
});

const rows = [
  row({ id: "a", name: "Merchant Agreement", category_id: "c1", updated_at: "2026-10-02T00:00:00Z", tags: ["bm"] }),
  row({ id: "b", name: "NDA", category_id: "c2", status: "draft", updated_at: "2026-10-05T00:00:00Z" }),
  row({ id: "c", name: "Old terms", category_id: "c1", status: "archived", updated_at: "2026-10-06T00:00:00Z" }),
  row({ id: "d", name: "Loose", category_id: null, updated_at: "2026-09-01T00:00:00Z", description: "No category yet" }),
];

describe("filterTemplates", () => {
  it("lists everything with archived last and the newest first", () => {
    expect(filterTemplates(rows, { category: "all", status: "all", search: "" }).map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("filters by category, including no category", () => {
    expect(filterTemplates(rows, { category: "c1", status: "all", search: "" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterTemplates(rows, { category: "none", status: "all", search: "" }).map((r) => r.id)).toEqual(["d"]);
  });

  it("filters by status", () => {
    expect(filterTemplates(rows, { category: "all", status: "draft", search: "" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterTemplates(rows, { category: "all", status: "archived", search: "" }).map((r) => r.id)).toEqual(["c"]);
  });

  it("searches name, description and tags, ignoring case and spaces around", () => {
    expect(filterTemplates(rows, { category: "all", status: "all", search: "  merchant " }).map((r) => r.id)).toEqual(["a"]);
    expect(filterTemplates(rows, { category: "all", status: "all", search: "BM" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterTemplates(rows, { category: "all", status: "all", search: "category yet" }).map((r) => r.id)).toEqual(["d"]);
  });

  it("combines the filters", () => {
    expect(filterTemplates(rows, { category: "c1", status: "active", search: "agree" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterTemplates(rows, { category: "c2", status: "active", search: "" })).toEqual([]);
  });

  it("does not change the list it was given", () => {
    const copy = [...rows];
    filterTemplates(rows, { category: "all", status: "all", search: "" });
    expect(rows).toEqual(copy);
  });
});

describe("the rest", () => {
  it("knows when anything narrows the list", () => {
    expect(isLibraryFiltered({ category: "all", status: "all", search: "  " })).toBe(false);
    expect(isLibraryFiltered({ category: "none", status: "all", search: "" })).toBe(true);
    expect(isLibraryFiltered({ category: "all", status: "draft", search: "" })).toBe(true);
    expect(isLibraryFiltered({ category: "all", status: "all", search: "x" })).toBe(true);
  });

  it("counts versions per template", () => {
    const m = countVersions([{ template_id: "a" }, { template_id: "a" }, { template_id: "b" }]);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(1);
    expect(m.get("zzz")).toBeUndefined();
  });

  it("words a status, with a fallback", () => {
    expect(templateStatusKey("active")).toBe("statusValue.active");
    expect(templateStatusKey("weird")).toBe("statusValue.unknown");
  });

  it("links to the editor and to a new document", () => {
    expect(templateEditorHref("t1")).toBe("/sign/templates/t1");
    expect(newDocumentFromTemplateHref("t1")).toBe("/sign/new?templateId=t1");
  });
});
