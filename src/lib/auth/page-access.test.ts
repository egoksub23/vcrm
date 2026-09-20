import { describe, expect, it } from "vitest";

import { MENU_CAPABILITIES } from "./capabilities";
import {
  PAGE_ACCESS,
  capabilityForPath,
  filterByCapability,
  firstAccessiblePage,
  pageAccessForPath,
} from "./page-access";

describe("capabilityForPath", () => {
  it.each([
    ["/dashboard", "menu.dashboard"],
    ["/inbox", "menu.inbox"],
    ["/notifications", "menu.notifications"],
    ["/contacts", "menu.contacts"],
    ["/pipelines", "menu.pipelines"],
    ["/broadcasts", "menu.broadcasts"],
    ["/tickets", "menu.tickets"],
    ["/automations", "menu.automations"],
    ["/flows", "menu.flows"],
    ["/knowledge", "menu.knowledge"],
    ["/agents", "menu.agents"],
    ["/reports", "menu.reports"],
    ["/settings", "menu.settings"],
  ])("guards %s with %s", (path, cap) => {
    expect(capabilityForPath(path)).toBe(cap);
  });

  it.each([
    ["/automations/new", "menu.automations"],
    ["/automations/abc/edit", "menu.automations"],
    ["/automations/abc/logs", "menu.automations"],
    ["/broadcasts/new", "menu.broadcasts"],
    ["/broadcasts/123", "menu.broadcasts"],
    ["/flows/abc", "menu.flows"],
    ["/flows/abc/runs", "menu.flows"],
    ["/knowledge/new", "menu.knowledge"],
    ["/knowledge/9f1c", "menu.knowledge"],
    ["/inbox/", "menu.inbox"],
    ["/settings/", "menu.settings"],
    ["/settings?tab=roles", "menu.settings"],
    ["/tickets?t=42", "menu.tickets"],
  ])("guards the deep link %s with %s", (path, cap) => {
    expect(capabilityForPath(path)).toBe(cap);
  });

  it("does not confuse prefixes that merely start alike", () => {
    expect(capabilityForPath("/inbox-archive")).toBeNull();
    expect(capabilityForPath("/knowledgebase")).toBeNull();
    expect(capabilityForPath("/agentsmith")).toBeNull();
  });

  it.each(["/", "/login", "/signup", "/join/abc", "/widget-preview", "", null, undefined])(
    "leaves %s unguarded",
    (path) => {
      expect(capabilityForPath(path)).toBeNull();
    },
  );
});

describe("PAGE_ACCESS", () => {
  it("covers every menu capability exactly once", () => {
    const caps = PAGE_ACCESS.map((e) => e.cap).sort();
    expect(caps).toEqual([...MENU_CAPABILITIES].sort());
  });

  it("has unique prefixes", () => {
    const prefixes = PAGE_ACCESS.map((e) => e.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("carries the sidebar label key of each page", () => {
    expect(pageAccessForPath("/agents")?.labelKey).toBe("aiAgents");
    expect(pageAccessForPath("/settings")?.labelKey).toBe("settings");
  });
});

describe("firstAccessiblePage", () => {
  it("returns the first page in sidebar order that the caller holds", () => {
    const has = (c: string) => c === "menu.reports" || c === "menu.tickets";
    expect(firstAccessiblePage(has)?.prefix).toBe("/tickets");
  });

  it("returns null when the caller holds no menu", () => {
    expect(firstAccessiblePage(() => false)).toBeNull();
  });
});

describe("filterByCapability", () => {
  const items = [
    { id: "a", capability: "menu.inbox" },
    { id: "b", capability: "menu.reports" },
    { id: "c" },
  ];

  it("keeps items the caller holds and items without a capability", () => {
    const has = (c: string) => c === "menu.inbox";
    expect(filterByCapability(items, has).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("fails closed for an empty capability set", () => {
    expect(filterByCapability(items, () => false).map((i) => i.id)).toEqual(["c"]);
  });
});
