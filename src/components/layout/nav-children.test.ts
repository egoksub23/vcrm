import { describe, expect, it } from "vitest";

import { filterByCapability } from "@/lib/auth/page-access";
import { isChildActive } from "./nav-children";
import { bottomNavItems } from "./nav-items";

const group = bottomNavItems.find((i) => i.href === "/incidents")!;
const kids = group.children!;
const activeOn = (pathname: string) => kids.filter((c) => isChildActive(c, pathname, kids)).map((c) => c.href);

describe("the Incidents group", () => {
  it("opens the Dashboard and My tasks to anyone with the Incidents menu, and Setup only to people who can configure", () => {
    const names = (caps: string[]) => filterByCapability(kids, (c) => caps.includes(c)).map((c) => c.href);
    expect(names(["menu.incidents"])).toEqual(["/incidents", "/incidents/tasks"]);
    expect(names(["menu.incidents", "incidents.configure"])).toEqual([
      "/incidents",
      "/incidents/tasks",
      "/incidents/setup",
      "/incidents/setup/roles",
      "/incidents/setup/rules",
      "/incidents/setup/form",
      "/incidents/setup/categories",
      "/incidents/setup/records",
      "/incidents/setup/steps",
      "/incidents/setup/timing",
      "/incidents/setup/channels",
      "/settings?tab=incidents",
    ]);
    // managers also see Reports (trends and registers); the setup pages need incidents.configure
    expect(names(["menu.incidents", "incidents.manage"])).toEqual(["/incidents", "/incidents/tasks", "/incidents/reports"]);
    // the nurse's return-to-play roster is a view on the dashboard, so she gets no extra menu row
    expect(names(["menu.incidents", "incidents.medical"])).toEqual(["/incidents", "/incidents/tasks"]);
    expect(names([])).toEqual([]);
  });

  it("marks exactly one child current on each page", () => {
    expect(activeOn("/incidents")).toEqual(["/incidents"]);
    expect(activeOn("/incidents/0b9c1f00-0000-4000-8000-000000000001")).toEqual(["/incidents"]);
    expect(activeOn("/incidents/tasks")).toEqual(["/incidents/tasks"]);
    expect(activeOn("/incidents/setup")).toEqual(["/incidents/setup"]);
    expect(activeOn("/incidents/setup/roles")).toEqual(["/incidents/setup/roles"]);
    expect(activeOn("/incidents/setup/rules")).toEqual(["/incidents/setup/rules"]);
    expect(activeOn("/incidents/setup/records")).toEqual(["/incidents/setup/records"]);
    expect(activeOn("/incidents/setup/form")).toEqual(["/incidents/setup/form"]);
    expect(activeOn("/incidents/setup/categories")).toEqual(["/incidents/setup/categories"]);
    expect(activeOn("/incidents/setup/steps")).toEqual(["/incidents/setup/steps"]);
    expect(activeOn("/incidents/reports")).toEqual(["/incidents/reports"]);
    expect(activeOn("/settings")).toEqual([]);
  });

  it("keeps the section's own row where it was", () => {
    expect(group).toMatchObject({ href: "/incidents", labelKey: "incidents", capability: "menu.incidents" });
  });
});
