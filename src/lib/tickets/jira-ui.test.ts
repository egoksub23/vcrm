import { describe, expect, it } from "vitest";

import {
  CATEGORY_TONE,
  bannersFor,
  categoryTone,
  errorKeyOf,
  extractIssueKey,
  fieldHasValue,
  issueUrlOf,
  normalizeCategory,
  retrySeconds,
  safeHttpUrl,
  splitLabels,
  visibleChips,
} from "./jira-ui";

describe("status category colours", () => {
  it("maps each category to its own tone, with a dark-mode variant", () => {
    expect(categoryTone("new")).toBe(CATEGORY_TONE.new);
    expect(categoryTone("indeterminate")).toContain("blue");
    expect(categoryTone("done")).toContain("emerald");
    for (const tone of Object.values(CATEGORY_TONE)) {
      expect(tone.includes("dark:") || tone.includes("text-muted-foreground")).toBe(true);
    }
  });
  it("treats anything else as undefined", () => {
    expect(normalizeCategory("weird")).toBe("undefined");
    expect(normalizeCategory(null)).toBe("undefined");
    expect(categoryTone(undefined)).toBe(CATEGORY_TONE.undefined);
  });
});

describe("safe URLs", () => {
  it("only lets http(s) through", () => {
    expect(safeHttpUrl("https://acme.atlassian.net/browse/ENG-1")).toBe("https://acme.atlassian.net/browse/ENG-1");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
  it("builds the issue address from the site when the row has none", () => {
    expect(issueUrlOf({ issue_url: null, issue_key: "ENG-1" }, "https://acme.atlassian.net/")).toBe("https://acme.atlassian.net/browse/ENG-1");
    expect(issueUrlOf({ issue_url: "javascript:x", issue_key: "ENG-1" }, null)).toBeNull();
    expect(issueUrlOf({ issue_url: "https://a.test/b", issue_key: "ENG-1" }, "https://other.test")).toBe("https://a.test/b");
  });
});

describe("banners", () => {
  const base = { sync_state: "ok" as const, sync_error: null, last_push: null }
  it("a healthy link has none", () => {
    expect(bannersFor(base, { needsReconnect: false })).toEqual([]);
  });
  it("broken says deleted or no access", () => {
    expect(bannersFor({ ...base, sync_state: "broken", sync_error: "not_found" }, { needsReconnect: false })).toEqual(["not_found"]);
    expect(bannersFor({ ...base, sync_state: "broken", sync_error: "no_access" }, { needsReconnect: false })).toEqual(["no_access"]);
    expect(bannersFor({ ...base, sync_state: "broken", sync_error: null }, { needsReconnect: true })).toEqual(["not_found"]);
  });
  it("paused says reconnect when the connection needs it", () => {
    expect(bannersFor({ ...base, sync_state: "paused" }, { needsReconnect: true })).toEqual(["reconnect"]);
    expect(bannersFor({ ...base, sync_state: "paused" }, { needsReconnect: false })).toEqual(["paused"]);
    expect(bannersFor(base, { needsReconnect: true })).toEqual(["reconnect"]);
  });
  it("only three failed-push reasons are worth a banner", () => {
    const push = (reason: string, ok = false) => bannersFor({ ...base, last_push: { ok, reason, at: "" } }, { needsReconnect: false });
    expect(push("no_transition")).toEqual(["no_transition"]);
    expect(push("screen_fields")).toEqual(["screen_fields"]);
    expect(push("permission")).toEqual(["permission"]);
    expect(push("not_mapped")).toEqual([]);
    expect(push("already")).toEqual([]);
    expect(push("no_transition", true)).toEqual([]);
  });
  it("a broken link does not also complain about a push", () => {
    expect(bannersFor({ sync_state: "broken", sync_error: "not_found", last_push: { ok: false, reason: "no_transition", at: "" } }, { needsReconnect: false })).toEqual(["not_found"]);
  });
});

describe("error codes", () => {
  it("known codes keep their own sentence, unknown ones fall back", () => {
    expect(errorKeyOf("jira_rejected")).toBe("jira_rejected");
    expect(errorKeyOf("link_limit")).toBe("link_limit");
    expect(errorKeyOf("something_new")).toBe("generic");
    expect(errorKeyOf(undefined)).toBe("generic");
  });
  it("retry seconds are a positive whole number", () => {
    expect(retrySeconds(12.2)).toBe(13);
    expect(retrySeconds(0)).toBe(1);
    expect(retrySeconds(undefined)).toBe(30);
  });
});

describe("pasted references", () => {
  it("finds a key in a key, a browse URL or a board URL", () => {
    expect(extractIssueKey("eng-482")).toBe("ENG-482");
    expect(extractIssueKey("  ENG-482  ")).toBe("ENG-482");
    expect(extractIssueKey("https://acme.atlassian.net/browse/ENG-482")).toBe("ENG-482");
    expect(extractIssueKey("https://acme.atlassian.net/jira/software/projects/ENG/boards/1?selectedIssue=ENG-9")).toBe("ENG-9");
  });
  it("leaves search text and non-web schemes alone", () => {
    expect(extractIssueKey("checkout fails")).toBeNull();
    expect(extractIssueKey("ENG")).toBeNull();
    expect(extractIssueKey("javascript:ENG-1")).toBeNull();
    expect(extractIssueKey("")).toBeNull();
  });
});

describe("chips and form helpers", () => {
  it("shows two chips and counts the rest", () => {
    expect(visibleChips([1, 2, 3, 4])).toEqual({ shown: [1, 2], extra: 2 });
    expect(visibleChips([1])).toEqual({ shown: [1], extra: 0 });
    expect(visibleChips([])).toEqual({ shown: [], extra: 0 });
  });
  it("knows when a required field has a value", () => {
    expect(fieldHasValue("text", "  ")).toBe(false);
    expect(fieldHasValue("text", "x")).toBe(true);
    expect(fieldHasValue("multiselect", [])).toBe(false);
    expect(fieldHasValue("multiselect", ["a"])).toBe(true);
    expect(fieldHasValue("number", "abc")).toBe(false);
    expect(fieldHasValue("number", "0")).toBe(true);
    expect(fieldHasValue("select", undefined)).toBe(false);
  });
  it("splits labels on spaces and commas", () => {
    expect(splitLabels("a, b  c,,d")).toEqual(["a", "b", "c", "d"]);
    expect(splitLabels("")).toEqual([]);
  });
});
