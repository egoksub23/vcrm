import { describe, expect, it } from "vitest";

import { BASE_STATUSES, MAX_LABEL, makeKey, mergeOptions, optionFor, parseLabel, statusText, type StatusOptionRow } from "./statuses";

const row = (over: Partial<StatusOptionRow>): StatusOptionRow => ({ key: "s_waiting", label: "Waiting for parents", base_status: "investigating", position: 0, is_builtin: false, is_active: true, ...over });
const own = (b: string) => `own:${b}`;

describe("mergeOptions", () => {
  it("is the six base statuses, in order, when the school has changed nothing", () => {
    const o = mergeOptions([]);
    expect(o.map((x) => x.key)).toEqual([...BASE_STATUSES]);
    expect(o.every((x) => x.builtin && x.label === null && x.active)).toBe(true);
  });

  it("puts a renamed base status and the extras under their base status", () => {
    const o = mergeOptions([row({ key: "triaged", label: "Assessed", base_status: "triaged", is_builtin: true }), row({}), row({ key: "s_b", label: "Awaiting nurse", base_status: "triaged", position: 1 })]);
    expect(o.map((x) => x.key)).toEqual(["reported", "triaged", "s_b", "contained", "investigating", "s_waiting", "recovered", "closed"]);
    expect(o.find((x) => x.key === "triaged")?.label).toBe("Assessed");
  });

  it("ignores an extra that points at no base status", () => {
    expect(mergeOptions([row({ base_status: "nonsense" })])).toHaveLength(6);
  });
});

describe("what an incident's status reads as", () => {
  const options = mergeOptions([row({}), row({ key: "closed", label: "Done", base_status: "closed", is_builtin: true })]);
  it("uses the school's wording for its own choice", () => {
    expect(statusText(options, "investigating", "s_waiting", own)).toBe("Waiting for parents");
  });
  it("falls back to the base status when the choice is gone, and to the app's own name when the school has not renamed it", () => {
    expect(optionFor(options, "investigating", "s_deleted")?.key).toBe("investigating");
    expect(statusText(options, "investigating", "s_deleted", own)).toBe("own:investigating");
    expect(statusText(options, "reported", null, own)).toBe("own:reported");
  });
  it("uses a renamed base status's new name", () => {
    expect(statusText(options, "closed", null, own)).toBe("Done");
  });
});

describe("makeKey and parseLabel", () => {
  it("makes a readable key and never repeats one", () => {
    expect(makeKey("Waiting for parents", new Set())).toBe("s_waiting_for_parents");
    expect(makeKey("Waiting for parents", new Set(["s_waiting_for_parents"]))).toBe("s_waiting_for_parents_2");
    expect(makeKey("???", new Set())).toBe("s_status");
  });
  it("asks for a name of a sensible length", () => {
    expect(parseLabel("  ")).toEqual({ ok: false, error: "Give the status a name." });
    expect(parseLabel("x".repeat(MAX_LABEL + 1)).ok).toBe(false);
    expect(parseLabel(" Assessed ")).toEqual({ ok: true, value: "Assessed" });
  });
});
