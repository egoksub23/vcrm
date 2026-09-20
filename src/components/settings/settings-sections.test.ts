import { describe, expect, it } from "vitest";

import {
  SECTION_META,
  SETTINGS_SECTIONS,
  canSeeSection,
  resolveSection,
  visibleSections,
} from "./settings-sections";

const holds = (...caps: string[]) => (c: string) => caps.includes(c);

describe("settings sections and capabilities", () => {
  it("registers Roles & permissions in the workspace group after Teams", () => {
    expect(SECTION_META.roles.group).toBe("workspace");
    expect(SECTION_META.roles.label).toBe("Roles & permissions");
    const order = [...SETTINGS_SECTIONS];
    expect(order.indexOf("roles")).toBeGreaterThan(order.indexOf("teams"));
  });

  it("resolves ?tab=roles to the roles section", () => {
    expect(resolveSection("roles")).toBe("roles");
  });

  it("registers the Audit log in the workspace group behind audit.view", () => {
    expect(SECTION_META.audit.group).toBe("workspace");
    expect(SECTION_META.audit.capability).toBe("audit.view");
    expect(resolveSection("audit")).toBe("audit");
    expect(canSeeSection("audit", holds())).toBe(false);
    expect(canSeeSection("audit", holds("audit.view"))).toBe(true);
  });

  it("hides roles without roles.manage and api without api.manage", () => {
    expect(canSeeSection("roles", holds())).toBe(false);
    expect(canSeeSection("api", holds())).toBe(false);
    expect(canSeeSection("roles", holds("roles.manage"))).toBe(true);
    expect(canSeeSection("api", holds("api.manage"))).toBe(true);
  });

  it("keeps every other section visible to anyone who can open Settings", () => {
    const rest = SETTINGS_SECTIONS.filter(
      (s) => s !== "roles" && s !== "api" && s !== "audit",
    );
    for (const s of rest) expect(canSeeSection(s, holds())).toBe(true);
    expect(visibleSections(holds())).toEqual(rest);
  });

  it("shows everything to someone who holds all the gating capabilities", () => {
    expect(visibleSections(holds("roles.manage", "api.manage", "audit.view"))).toEqual([
      ...SETTINGS_SECTIONS,
    ]);
  });
});
