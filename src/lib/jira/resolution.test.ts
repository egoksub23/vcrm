import { describe, expect, it } from "vitest";

import { mapJiraResolution, normalizeResolutionName } from "./resolution";

const CATALOGUE = [
  { id: "fixed", name: "Fixed", is_active: true },
  { id: "answered", name: "Answered / information given", is_active: true },
  { id: "dup", name: "Duplicate", is_active: true },
  { id: "cnr", name: "Cannot reproduce", is_active: true },
  { id: "wontfix", name: "Won't fix", is_active: true },
  { id: "custom", name: "Declined by policy", is_active: true },
  { id: "archived", name: "Workaround", is_active: false },
];

describe("normalizeResolutionName", () => {
  it("ignores case, spacing and apostrophe style", () => {
    expect(normalizeResolutionName("  Won\u2019t   FIX ")).toBe("won't fix");
    expect(normalizeResolutionName(null)).toBe("");
  });
});

describe("mapJiraResolution", () => {
  it("matches by name, ignoring case and spacing", () => {
    expect(mapJiraResolution("Fixed", CATALOGUE)).toBe("fixed");
    expect(mapJiraResolution("  duplicate ", CATALOGUE)).toBe("dup");
    expect(mapJiraResolution("Declined by  Policy", CATALOGUE)).toBe("custom");
  });
  it("understands the Jira wordings of the default entries", () => {
    expect(mapJiraResolution("Won't Do", CATALOGUE)).toBe("wontfix");
    expect(mapJiraResolution("Won\u2019t Do", CATALOGUE)).toBe("wontfix");
    expect(mapJiraResolution("Cannot Reproduce", CATALOGUE)).toBe("cnr");
    expect(mapJiraResolution("Answered", CATALOGUE)).toBe("answered");
  });
  it("an exact catalogue name wins over an alias", () => {
    const cat = [...CATALOGUE, { id: "wd", name: "Won't Do", is_active: true }];
    expect(mapJiraResolution("Won't Do", cat)).toBe("wd");
  });
  it("never maps Jira's generic Done and friends", () => {
    for (const generic of ["Done", "done", "Resolved", "Complete", "Closed"]) {
      expect(mapJiraResolution(generic, [...CATALOGUE, { id: "d", name: generic, is_active: true }])).toBeNull();
    }
  });
  it("returns null with no name, no match, or only an archived match", () => {
    expect(mapJiraResolution(null, CATALOGUE)).toBeNull();
    expect(mapJiraResolution("", CATALOGUE)).toBeNull();
    expect(mapJiraResolution("Something else", CATALOGUE)).toBeNull();
    expect(mapJiraResolution("Workaround", CATALOGUE)).toBeNull();
  });
  it("an alias whose default entry was renamed or archived does not match", () => {
    const cat = CATALOGUE.map((c) => (c.id === "wontfix" ? { ...c, is_active: false } : c));
    expect(mapJiraResolution("Won't Do", cat)).toBeNull();
  });
});
