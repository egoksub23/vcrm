import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PAGE_ACCESS, filterByCapability } from "@/lib/auth/page-access";
import { bottomNavItems, navItems } from "./nav-items";

// The sidebar's rows (the User Guide has no capability, so it is always there). KYC review sits directly below Incidents and Secure Sign (the e-signing module) directly below KYC review; each keeps its own capability gate.

const hrefs = (items: readonly { href: string }[]) => items.map((i) => i.href);

describe("the sidebar rows", () => {
  it("puts KYC review directly below Incidents, then Compliance, then Secure Sign", () => {
    const bottom = hrefs(bottomNavItems);
    const at = bottom.indexOf("/incidents");
    expect(at).toBeGreaterThan(-1);
    expect(bottom[at + 1]).toBe("/kyc");
    expect(bottom[at + 2]).toBe("/compliance");
    expect(bottom[at + 3]).toBe("/sign");
    expect(hrefs(navItems)).not.toContain("/kyc");
    expect([...hrefs(navItems), ...bottom].filter((h) => h === "/kyc")).toHaveLength(1);
    expect(hrefs(navItems)).not.toContain("/sign");
    expect(hrefs(navItems)).not.toContain("/sign");
    // one row for it, not two
    expect([...hrefs(navItems), ...bottom].filter((h) => h === "/sign")).toHaveLength(1);
  });

  it("keeps the capability that shows the row, and the label key the translations name", () => {
    const row = bottomNavItems.find((i) => i.href === "/sign");
    expect(row).toMatchObject({ labelKey: "sign", capability: "menu.sign" });
  });

  it("shows the KYC row only to a person who holds menu.kyc (the feature flag removes the capability, so the row goes with it)", () => {
    const names = (caps: string[]) => hrefs(filterByCapability(bottomNavItems, (c) => caps.includes(c)));
    expect(bottomNavItems.find((i) => i.href === "/kyc")).toMatchObject({ labelKey: "kyc", capability: "menu.kyc" });
    expect(names(["menu.incidents", "menu.kyc", "menu.sign"])).toEqual(["/help", "/incidents", "/kyc", "/sign"]);
    expect(names(["menu.kyc", "menu.compliance"])).toEqual(["/help", "/kyc", "/compliance"]);
    expect(names(["menu.incidents", "menu.sign"])).toEqual(["/help", "/incidents", "/sign"]);
    expect(names(["menu.kyc"])).toEqual(["/help", "/kyc"]);
    // kyc.view and kyc.reveal alone never show the row
    expect(names(["kyc.view", "kyc.reveal"])).toEqual(["/help"]);
  });

  it("shows the Secure Sign row only to a person who holds menu.sign", () => {
    const names = (caps: string[]) => hrefs(filterByCapability(bottomNavItems, (c) => caps.includes(c)));
    expect(names(["menu.incidents", "menu.sign"])).toEqual(["/help", "/incidents", "/sign"]);
    expect(names(["menu.incidents"])).toEqual(["/help", "/incidents"]);
    expect(names(["menu.sign"])).toEqual(["/help", "/sign"]);
  });

  it("leaves every other row where it was", () => {
    expect(hrefs(navItems)).toEqual(["/dashboard", "/inbox", "/notifications", "/contacts", "/pipelines", "/broadcasts", "/tickets", "/automations", "/flows", "/knowledge", "/agents", "/reports"]);
    expect(hrefs(bottomNavItems)).toEqual(["/help", "/settings", "/sembang", "/incidents", "/kyc", "/compliance", "/sign"]);
  });

  it("matches the order the page-access list keeps (first accessible page walks it): KYC review right after Incidents, then Compliance, then Secure Sign", () => {
    const order = PAGE_ACCESS.map((e) => e.prefix);
    expect(order[order.indexOf("/incidents") + 1]).toBe("/kyc");
    expect(order[order.indexOf("/kyc") + 1]).toBe("/compliance");
    expect(order[order.indexOf("/compliance") + 1]).toBe("/sign");
    expect(PAGE_ACCESS.find((e) => e.prefix === "/compliance")).toMatchObject({ cap: "menu.compliance", labelKey: "compliance" });
    expect(PAGE_ACCESS.find((e) => e.prefix === "/kyc")).toMatchObject({ cap: "menu.kyc", labelKey: "kyc" });
  });

  it("shows the Compliance row only to a person who holds menu.compliance (the flag removes the capability, so the row goes with it); the area's other permissions alone never show it", () => {
    const names = (caps: string[]) => hrefs(filterByCapability(bottomNavItems, (c) => caps.includes(c)));
    expect(bottomNavItems.find((i) => i.href === "/compliance")).toMatchObject({ labelKey: "compliance", capability: "menu.compliance" });
    expect(names(["menu.compliance"])).toEqual(["/help", "/compliance"]);
    expect(names(["compliance.review", "compliance.approve", "compliance.reveal", "compliance.execute", "compliance.manage"])).toEqual(["/help"]);
    expect(hrefs(navItems)).not.toContain("/compliance");
    expect([...hrefs(navItems), ...hrefs(bottomNavItems)].filter((h) => h === "/compliance")).toHaveLength(1);
  });

  it("is called KYC review in the sidebar and the page header, in every language (the key is added by the KYC i18n fragment)", () => {
    for (const locale of ["en", "ms", "zh", "ko"]) {
      const m = JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sidebar: { kyc: string }; Header: { kyc: string } };
      expect(m.Sidebar.kyc.length).toBeGreaterThan(0);
      expect(m.Header.kyc.length).toBeGreaterThan(0);
    }
  });

  it("is called Secure Sign in the sidebar, the page header and the settings group, in every language", () => {
    for (const locale of ["en", "ms", "zh", "ko"]) {
      const m = JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sidebar: { sign: string }; Header: { sign: string } };
      expect(m.Sidebar.sign).toBe("Secure Sign");
      expect(m.Header.sign).toBe("Secure Sign");
    }
  });
});
