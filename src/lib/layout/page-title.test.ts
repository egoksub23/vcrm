import { describe, expect, it } from "vitest";
import { getPageTitleKey, PAGE_TITLE_KEYS } from "./page-title";
import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";

type Messages = { Header: Record<string, string> };

describe("getPageTitleKey", () => {
  it.each([
    ["/dashboard", "dashboard"],
    ["/inbox", "inbox"],
    ["/notifications", "notifications"],
    ["/contacts", "contacts"],
    ["/pipelines", "pipelines"],
    ["/broadcasts", "broadcasts"],
    ["/tickets", "tickets"],
    ["/automations", "automations"],
    ["/flows", "flows"],
    ["/knowledge", "knowledge"],
    ["/agents", "aiAgents"],
    ["/reports", "reports"],
    ["/settings", "settings"],
    ["/help", "userGuide"],
  ])("%s -> %s", (path, key) => {
    expect(getPageTitleKey(path)).toBe(key);
  });

  it("keeps the section title on nested routes", () => {
    expect(getPageTitleKey("/knowledge/new")).toBe("knowledge");
    expect(getPageTitleKey("/knowledge/abc-123")).toBe("knowledge");
    expect(getPageTitleKey("/tickets/42")).toBe("tickets");
    expect(getPageTitleKey("/flows/9/edit")).toBe("flows");
    expect(getPageTitleKey("/automations/new")).toBe("automations");
    expect(getPageTitleKey("/help/inbox/reply-to-customers")).toBe("userGuide");
  });

  it("ignores query strings, hashes and trailing slashes", () => {
    expect(getPageTitleKey("/reports?tab=sla")).toBe("reports");
    expect(getPageTitleKey("/tickets/")).toBe("tickets");
    expect(getPageTitleKey("/settings#profile")).toBe("settings");
  });

  it("does not match on a partial segment", () => {
    expect(getPageTitleKey("/helpful")).toBe("dashboard");
    expect(getPageTitleKey("/ticketsX")).toBe("dashboard");
  });

  it("falls back to dashboard for unknown or empty paths", () => {
    expect(getPageTitleKey("/nope")).toBe("dashboard");
    expect(getPageTitleKey("")).toBe("dashboard");
    expect(getPageTitleKey(null)).toBe("dashboard");
  });

  it("every title key exists in the Header namespace in en and ko", () => {
    for (const key of Object.values(PAGE_TITLE_KEYS)) {
      expect((en as Messages).Header[key], `en ${key}`).toBeTruthy();
      expect((ko as Messages).Header[key], `ko ${key}`).toBeTruthy();
    }
  });
});
