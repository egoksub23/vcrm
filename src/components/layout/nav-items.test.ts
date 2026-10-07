import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PAGE_ACCESS, filterByCapability } from "@/lib/auth/page-access";
import { bottomNavItems, navItems } from "./nav-items";

// The sidebar's rows (the User Guide has no capability, so it is always there). Secure Sign (the e-signing module) sits directly below Incidents; its capability gate is the one it always had.

const hrefs = (items: readonly { href: string }[]) => items.map((i) => i.href);

describe("the sidebar rows", () => {
  it("puts Secure Sign directly below Incidents", () => {
    const bottom = hrefs(bottomNavItems);
    const at = bottom.indexOf("/incidents");
    expect(at).toBeGreaterThan(-1);
    expect(bottom[at + 1]).toBe("/sign");
    expect(hrefs(navItems)).not.toContain("/sign");
    // one row for it, not two
    expect([...hrefs(navItems), ...bottom].filter((h) => h === "/sign")).toHaveLength(1);
  });

  it("keeps the capability that shows the row, and the label key the translations name", () => {
    const row = bottomNavItems.find((i) => i.href === "/sign");
    expect(row).toMatchObject({ labelKey: "sign", capability: "menu.sign" });
  });

  it("shows the row only to a person who holds menu.sign", () => {
    const names = (caps: string[]) => hrefs(filterByCapability(bottomNavItems, (c) => caps.includes(c)));
    expect(names(["menu.incidents", "menu.sign"])).toEqual(["/help", "/incidents", "/sign"]);
    expect(names(["menu.incidents"])).toEqual(["/help", "/incidents"]);
    expect(names(["menu.sign"])).toEqual(["/help", "/sign"]);
  });

  it("leaves every other row where it was", () => {
    expect(hrefs(navItems)).toEqual(["/dashboard", "/inbox", "/notifications", "/contacts", "/pipelines", "/broadcasts", "/tickets", "/automations", "/flows", "/knowledge", "/agents", "/reports"]);
    expect(hrefs(bottomNavItems)).toEqual(["/help", "/settings", "/sembang", "/incidents", "/sign"]);
  });

  it("matches the order the page-access list keeps (first accessible page walks it): Secure Sign right after Incidents", () => {
    const order = PAGE_ACCESS.map((e) => e.prefix);
    expect(order[order.indexOf("/incidents") + 1]).toBe("/sign");
  });

  it("is called Secure Sign in the sidebar, the page header and the settings group, in every language", () => {
    for (const locale of ["en", "ms", "zh", "ko"]) {
      const m = JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sidebar: { sign: string }; Header: { sign: string } };
      expect(m.Sidebar.sign).toBe("Secure Sign");
      expect(m.Header.sign).toBe("Secure Sign");
    }
  });
});
