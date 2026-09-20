import { describe, expect, it } from "vitest";

import {
  SECTION_META,
  SETTINGS_SECTIONS,
  canSeeSection,
  resolveSection,
  resolveTeamView,
  visibleSections,
} from "./settings-sections";

const holds = (...caps: string[]) => (c: string) => caps.includes(c);

describe("settings sections and capabilities", () => {
  it("registers Roles & permissions in the workspace group after Team", () => {
    expect(SECTION_META.roles.group).toBe("workspace");
    expect(SECTION_META.roles.label).toBe("Roles & permissions");
    const order = [...SETTINGS_SECTIONS];
    expect(order.indexOf("roles")).toBeGreaterThan(order.indexOf("team"));
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

  it("registers Approvals in the workspace group behind approvals.review", () => {
    expect(SECTION_META.approvals.group).toBe("workspace");
    expect(SECTION_META.approvals.capability).toBe("approvals.review");
    expect(resolveSection("approvals")).toBe("approvals");
    expect(canSeeSection("approvals", holds())).toBe(false);
    expect(canSeeSection("approvals", holds("approvals.review"))).toBe(true);
    const order = [...SETTINGS_SECTIONS];
    expect(order.indexOf("approvals")).toBeGreaterThan(order.indexOf("roles"));
  });

  it("registers Integrations in the workspace group behind jira.connect", () => {
    expect(SECTION_META.integrations.group).toBe("workspace");
    expect(SECTION_META.integrations.capability).toBe("jira.connect");
    expect(resolveSection("integrations")).toBe("integrations");
    expect(canSeeSection("integrations", holds())).toBe(false);
    expect(canSeeSection("integrations", holds("jira.connect"))).toBe(true);
    // Agents hold jira.link but not jira.connect, so they never see the section.
    expect(canSeeSection("integrations", holds("jira.link"))).toBe(false);
  });

  it("hides roles without roles.manage and api without api.manage", () => {
    expect(canSeeSection("roles", holds())).toBe(false);
    expect(canSeeSection("api", holds())).toBe(false);
    expect(canSeeSection("roles", holds("roles.manage"))).toBe(true);
    expect(canSeeSection("api", holds("api.manage"))).toBe(true);
  });

  it("keeps every other section visible to anyone who can open Settings", () => {
    const rest = SETTINGS_SECTIONS.filter(
      (s) => s !== "roles" && s !== "api" && s !== "audit" && s !== "approvals" && s !== "integrations",
    );
    for (const s of rest) expect(canSeeSection(s, holds())).toBe(true);
    expect(visibleSections(holds())).toEqual(rest);
  });

  it("shows everything to someone who holds all the gating capabilities", () => {
    expect(
      visibleSections(holds("roles.manage", "api.manage", "audit.view", "approvals.review", "jira.connect")),
    ).toEqual([
      ...SETTINGS_SECTIONS,
    ]);
  });
});

describe("the merged Team section", () => {
  it("is one section in the workspace group, visible to everyone in Settings", () => {
    expect(SETTINGS_SECTIONS).toContain("team");
    expect(SETTINGS_SECTIONS).not.toContain("members");
    expect(SETTINGS_SECTIONS).not.toContain("teams");
    expect(SECTION_META.team.group).toBe("workspace");
    expect(SECTION_META.team.capability).toBeUndefined();
    expect(canSeeSection("team", holds())).toBe(true);
  });

  it("keeps the old ?tab=members and ?tab=teams links landing on it", () => {
    expect(resolveSection("team")).toBe("team");
    expect(resolveSection("members")).toBe("team");
    expect(resolveSection("teams")).toBe("team");
  });

  it("opens the view the link asked for, ?view= first", () => {
    expect(resolveTeamView("team", "teams")).toBe("teams");
    expect(resolveTeamView("team", "members")).toBe("members");
    expect(resolveTeamView("teams", null)).toBe("teams");
    expect(resolveTeamView("members", null)).toBe("members");
    expect(resolveTeamView("team", null)).toBe("members");
    expect(resolveTeamView("teams", "members")).toBe("members");
  });

  it("ignores a ?view= meant for another section", () => {
    expect(resolveTeamView("team", "templates")).toBe("members");
    expect(resolveTeamView("teams", "templates")).toBe("teams");
    expect(resolveTeamView(null, null)).toBe("members");
  });
});

