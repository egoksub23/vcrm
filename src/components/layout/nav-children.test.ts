import { describe, expect, it } from "vitest";

import { filterByCapability } from "@/lib/auth/page-access";
import { isChildActive } from "./nav-children";
import { bottomNavItems } from "./nav-items";

const group = bottomNavItems.find((i) => i.href === "/incidents")!;
const kids = group.children!;
const activeOn = (pathname: string) => kids.filter((c) => isChildActive(c, pathname, kids)).map((c) => c.href);

describe("the Incidents group", () => {
  it("opens Overview, All incidents and My tasks to anyone with the Incidents menu, and Setup only to people who can configure", () => {
    const names = (caps: string[]) => filterByCapability(kids, (c) => caps.includes(c)).map((c) => c.href);
    expect(names(["menu.incidents"])).toEqual(["/incidents/overview", "/incidents", "/incidents/tasks"]);
    expect(names(["menu.incidents", "incidents.configure"])).toEqual([
      "/incidents/overview",
      "/incidents",
      "/incidents/tasks",
      "/incidents/setup",
      "/incidents/setup/roles",
      "/incidents/setup/rules",
      "/incidents/setup/portal",
      "/settings?tab=incidents",
    ]);
    // the nurse sees Return to play without being able to configure anything
    expect(names(["menu.incidents", "incidents.medical"])).toEqual(["/incidents/overview", "/incidents", "/incidents/tasks", "/incidents/clearances"]);
    expect(names([])).toEqual([]);
  });

  it("marks exactly one child current on each page", () => {
    expect(activeOn("/incidents")).toEqual(["/incidents"]);
    expect(activeOn("/incidents/0b9c1f00-0000-4000-8000-000000000001")).toEqual(["/incidents"]);
    expect(activeOn("/incidents/overview")).toEqual(["/incidents/overview"]);
    expect(activeOn("/incidents/tasks")).toEqual(["/incidents/tasks"]);
    expect(activeOn("/incidents/setup")).toEqual(["/incidents/setup"]);
    expect(activeOn("/incidents/setup/roles")).toEqual(["/incidents/setup/roles"]);
    expect(activeOn("/incidents/setup/rules")).toEqual(["/incidents/setup/rules"]);
    expect(activeOn("/incidents/setup/portal")).toEqual(["/incidents/setup/portal"]);
    expect(activeOn("/incidents/clearances")).toEqual(["/incidents/clearances"]);
    expect(activeOn("/settings")).toEqual([]);
  });

  it("keeps the section's own row where it was", () => {
    expect(group).toMatchObject({ href: "/incidents", labelKey: "incidents", capability: "menu.incidents" });
  });
});
