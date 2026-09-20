import { describe, expect, it } from "vitest";

import {
  applySettingsPatch,
  changedSections,
  mapJiraStatusToTicket,
  normalizeSettings,
  pickTransition,
  transitionFields,
  wantedJiraTarget,
  type JiraTransition,
} from "./settings";
import { DEFAULT_JIRA_SETTINGS } from "./types";

describe("normalizeSettings", () => {
  it("gives the documented defaults for nothing", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_JIRA_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_JIRA_SETTINGS);
    expect(normalizeSettings("garbage")).toEqual(DEFAULT_JIRA_SETTINGS);
    const d = normalizeSettings(null);
    expect(d.privacy).toEqual({ include_customer: false, preview_before_send: true });
    expect(d.direction.status_to_jira).toBe(false); // opt-in
    expect(d.direction.status_from_jira).toBe(true);
    expect(d.done_behaviour).toBe("note");
  });

  it("drops unknown keys, forces types and caps sizes", () => {
    const s = normalizeSettings({
      evil: true,
      projects: { allowed: ["eng", "ENG", "web", "bad key!", 5, "x".repeat(40)], default_project: "web", default_issue_type: "  Task  " },
      mapping: {
        priority: { urgent: "Highest", high: "", nope: "x", low: 7 },
        status_from_jira: { " In Review ": "in_progress", Bogus: "exploded", Done: "resolved" },
        status_to_jira: { resolved: "Done", pending: "Waiting", open: "" },
        category_label: "yes",
      },
      direction: { status_to_jira: true, assignee: "yes" },
      privacy: { include_customer: true },
      done_behaviour: "resolve",
      resolution: "  Fixed ",
    });
    expect(s.projects.allowed).toEqual(["ENG", "WEB"]);
    expect(s.projects.default_project).toBe("WEB");
    expect(s.projects.default_issue_type).toBe("Task");
    expect(s.mapping.priority).toEqual({ urgent: "Highest" });
    expect(s.mapping.status_from_jira).toEqual({ "in review": "in_progress", done: "resolved" });
    expect(s.mapping.status_to_jira).toEqual({ resolved: "Done", pending: "Waiting" });
    expect(s.mapping.category_label).toBe(true); // a non-boolean falls back to the default
    expect(s.direction.status_to_jira).toBe(true);
    expect(s.direction.assignee).toBe(false);
    expect(s.privacy.include_customer).toBe(true);
    expect(s.done_behaviour).toBe("resolve");
    expect(s.resolution).toBe("Fixed");
    expect(s).not.toHaveProperty("evil");
  });

  it("clears a default project that is not among the allowed projects", () => {
    expect(normalizeSettings({ projects: { allowed: ["ENG"], default_project: "WEB" } }).projects.default_project).toBeNull();
    expect(normalizeSettings({ projects: { allowed: ["ENG"], default_project: "eng" } }).projects.default_project).toBe("ENG");
    expect(normalizeSettings({ projects: { allowed: [], default_project: "WEB" } }).projects.default_project).toBe("WEB");
  });

  it("merges a patch section by section and reports which sections changed (names only)", () => {
    const before = normalizeSettings({});
    const after = applySettingsPatch(before, { direction: { status_to_jira: true }, privacy: { include_customer: true }, bogus: 1 });
    expect(after.direction.status_to_jira).toBe(true);
    expect(after.direction.comments_to_jira).toBe(true); // untouched siblings survive
    expect(changedSections(before, after)).toEqual(["direction", "privacy"]);
    expect(changedSections(before, before)).toEqual([]);
    expect(applySettingsPatch(before, "nope")).toBe(before);
  });
});

describe("status mapping", () => {
  const defaults = normalizeSettings({});

  it("maps by Jira status category: To do -> open, In progress -> in_progress, Done -> resolved", () => {
    expect(mapJiraStatusToTicket(defaults, { name: "Backlog", category: "new" })).toEqual({ status: "open", explicit: false });
    expect(mapJiraStatusToTicket(defaults, { name: "In Review", category: "indeterminate" })).toEqual({ status: "in_progress", explicit: false });
    expect(mapJiraStatusToTicket(defaults, { name: "Shipped", category: "done" })).toEqual({ status: "resolved", explicit: false });
    expect(mapJiraStatusToTicket(defaults, { name: "?", category: "undefined" })).toBeNull();
    expect(mapJiraStatusToTicket(defaults, { name: "?", category: "weird" })).toBeNull();
  });

  it("an override per Jira status NAME beats the category and is case-insensitive", () => {
    const s = normalizeSettings({ mapping: { status_from_jira: { "waiting for customer": "pending" } } });
    expect(mapJiraStatusToTicket(s, { name: "Waiting For Customer", category: "indeterminate" })).toEqual({ status: "pending", explicit: true });
    expect(mapJiraStatusToTicket(s, { name: "In Review", category: "indeterminate" })?.status).toBe("in_progress");
  });

  it("Vircle to Jira is the same table reversed; pending and closed have no twin by default", () => {
    expect(wantedJiraTarget(defaults, "open")).toEqual({ category: "new" });
    expect(wantedJiraTarget(defaults, "in_progress")).toEqual({ category: "indeterminate" });
    expect(wantedJiraTarget(defaults, "resolved")).toEqual({ category: "done" });
    expect(wantedJiraTarget(defaults, "pending")).toBeNull();
    expect(wantedJiraTarget(defaults, "closed")).toBeNull();
    const s = normalizeSettings({ mapping: { status_to_jira: { pending: "Waiting", resolved: "Closed" } } });
    expect(wantedJiraTarget(s, "pending")).toEqual({ name: "Waiting" });
    expect(wantedJiraTarget(s, "resolved")).toEqual({ name: "Closed" });
  });
});

describe("transition selection (never a chain, never a guess)", () => {
  const t = (id: string, to: string, category: string, extra: Partial<JiraTransition> = {}): JiraTransition => ({
    id,
    name: `Go to ${to}`,
    to: { id: `s${id}`, name: to, statusCategory: { key: category } },
    isAvailable: true,
    ...extra,
  });
  const list = [t("11", "In Progress", "indeterminate"), t("21", "In Review", "indeterminate", { hasScreen: true }), t("31", "Done", "done", { hasScreen: true }), t("41", "Blocked", "indeterminate", { isAvailable: false })];

  it("lands on the wanted category with the simplest transition (no screen, not conditional)", () => {
    const c = pickTransition(list, { category: "indeterminate" }, { name: "To Do", category: "new" });
    expect(c).toEqual({ kind: "transition", transition: expect.objectContaining({ id: "11" }) });
  });

  it("an admin override lands on that exact status name", () => {
    const c = pickTransition(list, { name: "in review" }, { name: "To Do", category: "new" });
    expect(c).toEqual({ kind: "transition", transition: expect.objectContaining({ id: "21" }) });
  });

  it("says none when the issue cannot get there in ONE step, and never picks an unavailable transition", () => {
    expect(pickTransition(list, { category: "new" }, { name: "In Progress", category: "indeterminate" })).toEqual({ kind: "none" });
    expect(pickTransition(list, { name: "Blocked" }, { name: "To Do", category: "new" })).toEqual({ kind: "none" });
    expect(pickTransition([], { category: "done" }, { name: "To Do", category: "new" })).toEqual({ kind: "none" });
  });

  it("does nothing when the issue is already there", () => {
    expect(pickTransition(list, { category: "done" }, { name: "Closed", category: "done" })).toEqual({ kind: "already" });
    expect(pickTransition(list, { name: "Done" }, { name: "done", category: "done" })).toEqual({ kind: "already" });
  });

  it("supplies a required resolution from the settings, and refuses fields it cannot invent", () => {
    const withResolution: JiraTransition = t("31", "Done", "done", {
      hasScreen: true,
      fields: { resolution: { required: true, name: "Resolution", allowedValues: [{ name: "Fixed" }, { name: "Done" }] } },
    });
    expect(transitionFields(withResolution, "Done")).toEqual({ ok: true, fields: { resolution: { name: "Done" } } });
    expect(transitionFields(withResolution, "Won't do")).toEqual({ ok: true, fields: { resolution: { name: "Fixed" } } }); // the site has no such value
    const needsMore: JiraTransition = t("31", "Done", "done", {
      fields: { resolution: { required: true, allowedValues: [{ name: "Done" }] }, customfield_10100: { required: true, name: "Root cause" } },
    });
    expect(transitionFields(needsMore, "Done")).toEqual({ ok: false, missing: ["Root cause"] });
    expect(transitionFields(t("11", "In Progress", "indeterminate"), "Done")).toEqual({ ok: true, fields: {} });
    // a required field with a default is fine
    const defaulted: JiraTransition = t("5", "X", "done", { fields: { customfield_1: { required: true, hasDefaultValue: true, name: "x" } } });
    expect(transitionFields(defaulted, "Done")).toEqual({ ok: true, fields: {} });
  });
});
