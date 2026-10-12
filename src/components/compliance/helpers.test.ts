import { describe, expect, it } from "vitest";

import { DAY_MS, computeClock } from "@/lib/compliance/clock";
import type { FieldDef, RequestEvent } from "@/lib/compliance/types";

import { codeOf, listQuery } from "./api";
import {
  EMPTY_FILTERS,
  HEADER_CHIPS,
  REVEAL_MS,
  answersFromForm,
  chipActive,
  clockLine,
  collapseViews,
  emptyForm,
  errorKey,
  eventLine,
  fieldLabel,
  formatDay,
  formatWhen,
  hasFilters,
  localInputToIso,
  missingRequired,
  revealExpired,
  revealSecondsLeft,
  toggleChip,
  typeLabel,
} from "./helpers";
import { clocksValid, parseDays } from "./settings";

const T0 = Date.parse("2026-10-01T09:00:00Z");
const closure = (days: number, over: Record<string, unknown> = {}) =>
  computeClock(
    { status: "officer_review", receivedAt: new Date(T0).toISOString(), targetDays: 14, hardStopDays: 30, targetDueAt: new Date(T0 + 14 * DAY_MS).toISOString(), hardStopAt: new Date(T0 + 30 * DAY_MS).toISOString(), pausedAt: null, ...over },
    T0 + days * DAY_MS,
  );

describe("clockLine: what the clock says in one line", () => {
  it("'Day 9 of 14 target' with '21 days to stop'", () => {
    expect(clockLine(closure(8.2))).toEqual({ key: "dayOf", values: { day: 9, target: 14 }, stop: { key: "toStop", count: 22 } });
    expect(clockLine(closure(9))).toMatchObject({ values: { day: 10, target: 14 }, stop: { key: "toStop", count: 21 } });
  });
  it("past the stop it counts the days over, and on the day it says so", () => {
    expect(clockLine(closure(33.5)).stop).toEqual({ key: "overStop", count: 3 });
    expect(clockLine(closure(30)).stop).toEqual({ key: "stopToday", count: 0 });
  });
  it("paused, finished and no-clock cases each have their own line", () => {
    expect(clockLine(closure(40, { pausedAt: new Date(T0 + 12 * DAY_MS).toISOString() }))).toMatchObject({ key: "paused", values: { day: 13 } });
    expect(clockLine(closure(40, { status: "closed", closedAt: new Date(T0 + 9 * DAY_MS).toISOString() }))).toEqual({ key: "done", values: { days: 10 }, stop: null });
    expect(clockLine(closure(3, { targetDays: null, hardStopDays: null, targetDueAt: null, hardStopAt: null }))).toEqual({ key: "none", values: { day: 4 }, stop: null });
  });
  it("a stop with no target reads 'Day N' and the days to stop", () => {
    expect(clockLine(closure(3, { targetDays: null, targetDueAt: null }))).toMatchObject({ key: "stopOnly", values: { day: 4 }, stop: { key: "toStop" } });
  });
});

describe("the header chips", () => {
  it("each applies its own filter and clicking it again clears it", () => {
    const chip = HEADER_CHIPS.find((c) => c.key === "nearStop")!;
    const on = toggleChip(chip, { ...EMPTY_FILTERS, q: "siti", page: 3 });
    expect(on).toMatchObject({ due: "near_stop", status: "", q: "siti", page: 1 });
    expect(chipActive(chip, on)).toBe(true);
    expect(toggleChip(chip, on)).toMatchObject({ due: "all", status: "", page: 1 });
    const stage = HEADER_CHIPS.find((c) => c.key === "needsIdentityCheck")!;
    expect(toggleChip(stage, EMPTY_FILTERS)).toMatchObject({ status: "received,identity_check", due: "all" });
    expect(chipActive(stage, toggleChip(chip, EMPTY_FILTERS))).toBe(false);
  });
  it("covers the seven counts in order", () => {
    expect(HEADER_CHIPS.map((c) => c.key)).toEqual(["needsIdentityCheck", "inReview", "awaitingSignoff", "executing", "pastTarget", "nearStop", "breached"]);
  });
  it("knows whether any filter is set", () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    for (const patch of [{ type: "closure" }, { status: "received" }, { due: "breached" }, { assignee: "none" }, { mine: true }, { q: " x " }, { from: "2026-10-01" }, { to: "2026-10-02" }]) expect(hasFilters({ ...EMPTY_FILTERS, ...patch })).toBe(true);
    expect(hasFilters({ ...EMPTY_FILTERS, q: "   ", page: 4 })).toBe(false);
  });
});

describe("the list query", () => {
  it("sends only what is set, and turns local days into exact instants", () => {
    expect(listQuery({})).toBe("");
    const q = new URLSearchParams(listQuery({ type: "closure", status: "received,identity_check", due: "breached", assignee: "none", mine: true, q: " siti ", from: "2026-10-01", to: "2026-10-02", page: 3 }));
    expect(q.get("type")).toBe("closure");
    expect(q.get("status")).toBe("received,identity_check");
    expect(q.get("due")).toBe("breached");
    expect(q.get("assignee")).toBe("none");
    expect(q.get("mine")).toBe("1");
    expect(q.get("q")).toBe("siti");
    expect(q.get("page")).toBe("3");
    expect(Date.parse(q.get("to")!) - Date.parse(q.get("from")!)).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(new URLSearchParams(listQuery({ due: "all", page: 1, from: "garbage" })).toString()).toBe("");
  });
  it("reads an error code from the body, else from the status", () => {
    expect(codeOf(409, { code: "maker_checker" })).toBe("maker_checker");
    expect(codeOf(429, null)).toBe("rate_limited");
    expect(codeOf(403, "x")).toBe("forbidden");
    expect(codeOf(404, {})).toBe("not_found");
    expect(codeOf(500, {})).toBe("server_error");
  });
  it("words an unknown error code as the generic one", () => {
    expect(errorKey("maker_checker")).toBe("maker_checker");
    expect(errorKey("network")).toBe("network");
    expect(errorKey("<script>")).toBe("server_error");
  });
});

describe("the reveal timer", () => {
  it("lasts two minutes and runs out exactly then", () => {
    expect(REVEAL_MS).toBe(120_000);
    expect(revealExpired(null, 5)).toBe(false);
    expect(revealExpired(1000, 999)).toBe(false);
    expect(revealExpired(1000, 1000)).toBe(true);
    expect(revealSecondsLeft(61_000, 1_000)).toBe(60);
    expect(revealSecondsLeft(1_001, 1_000)).toBe(1);
    expect(revealSecondsLeft(500, 1_000)).toBe(0);
    expect(revealSecondsLeft(null, 1_000)).toBe(0);
  });
});

const field = (over: Partial<FieldDef>): FieldDef => ({ key: "k", type: "text", label: { en: "K", ms: "Kunci" }, required: false, sensitive: false, ...over });

describe("labels", () => {
  it("uses the locale's text, then English, then the key", () => {
    expect(fieldLabel(field({}), "ms")).toBe("Kunci");
    expect(fieldLabel(field({}), "zh")).toBe("K");
    expect(typeLabel({ typeLabel: "Account closure", typeLabelL10n: { ms: "Penutupan akaun" } }, "ms")).toBe("Penutupan akaun");
    expect(typeLabel({ typeLabel: "Account closure", typeLabelL10n: { ms: "Penutupan akaun" } }, "ko")).toBe("Account closure");
  });
  it("formats dates and survives garbage", () => {
    expect(formatWhen("2026-10-12T12:00:00Z", "en")).toMatch(/2026/);
    expect(formatWhen("nonsense", "en")).toBe("");
    expect(formatWhen(null, "en")).toBe("");
    expect(formatDay("2026-10-12T12:00:00Z", "en")).toMatch(/Oct/);
    expect(formatDay(undefined, "en")).toBe("");
  });
  it("turns a datetime-local value into an instant, or nothing", () => {
    expect(localInputToIso("")).toBe("");
    expect(localInputToIso("not a date")).toBe("");
    expect(localInputToIso("2026-10-12T09:30")).toMatch(/^2026-10-12T\d\d:\d\d:00\.000Z$/);
  });
});

describe("the form", () => {
  const fields = [
    field({ key: "ack", type: "acknowledge", required: true }),
    field({ key: "reason", type: "multiline" }),
    field({ key: "bank", type: "text", required: true, sensitive: true }),
    field({ key: "letter", type: "file", required: true }),
  ];
  it("starts empty (ticks off, no file value) and lists what is missing, files aside", () => {
    expect(emptyForm(fields)).toEqual({ ack: false, reason: "", bank: "" });
    expect(missingRequired(fields, emptyForm(fields))).toEqual(["ack", "bank"]);
    expect(missingRequired(fields, { ack: true, reason: "", bank: " 1234 " })).toEqual([]);
    expect(missingRequired(fields, { ack: true, reason: "", bank: "   " })).toEqual(["bank"]);
  });
  it("sends what was typed (trimmed), the ticks as booleans, and no empty answers", () => {
    expect(answersFromForm(fields, { ack: true, reason: "", bank: " 1234 " })).toEqual({ ack: true, bank: "1234" });
    expect(answersFromForm(fields, { ack: false, reason: " x ", bank: "" })).toEqual({ ack: false, reason: "x" });
  });
});

describe("eventLine", () => {
  const e = (kind: RequestEvent["kind"], detail: Record<string, unknown> = {}) => eventLine({ kind, detail });
  it("reads each kind's detail into a key, values and the typed note", () => {
    expect(e("status", { from: "received", to: "officer_review", note: "Called" })).toEqual({ key: "status", values: { from: "received", to: "officer_review" }, text: "Called" });
    expect(e("note", { text: "Hello" })).toMatchObject({ key: "note", text: "Hello" });
    expect(e("signoff", { decision: "approved", override: true }).key).toBe("signoff_override");
    expect(e("execute_step", { done: false }).key).toBe("step_undone");
    expect(e("reveal", { allowed: false }).key).toBe("reveal_refused");
    expect(e("reveal", { allowed: true }).key).toBe("reveal");
    expect(e("view", { file: "f1", name: "a.pdf" })).toMatchObject({ key: "view_file", values: { name: "a.pdf" } });
    expect(e("created", { backdated: true, source: "staff" }).key).toBe("created_backdated");
    expect(e("clock_alert", { threshold: 5 })).toMatchObject({ key: "clock_alert", values: { threshold: 5 } });
    expect(e("edited", { fields: ["received_at", "data"] }).values.fields).toBe("received_at, data");
    expect(e("standing", { dues_outstanding: true }).key).toBe("standing_dues");
    expect(e("assigned", { to: null }).key).toBe("unassigned");
  });
  it("never throws on a detail it does not expect", () => {
    expect(eventLine({ kind: "status", detail: undefined as unknown as Record<string, unknown> }).key).toBe("status");
    expect(eventLine({ kind: "nonsense" as RequestEvent["kind"], detail: {} }).key).toBe("other");
    expect(e("edited", { fields: "oops" }).values.fields).toBe("");
  });
});

describe("collapseViews", () => {
  const ev = (id: string, kind: RequestEvent["kind"], at: string, actor = "u1", detail: Record<string, unknown> = {}): RequestEvent => ({ id, kind, at, actor: { id: actor, name: actor }, detail });
  it("folds one person's opens within ten minutes into one entry, keeps other people's and other kinds", () => {
    const out = collapseViews([
      ev("5", "view", "2026-10-12T10:08:00Z"),
      ev("4", "view", "2026-10-12T10:05:00Z"),
      ev("3", "view", "2026-10-12T10:00:00Z", "u2"),
      ev("2", "note", "2026-10-12T09:59:00Z"),
      ev("1", "view", "2026-10-12T09:00:00Z"),
    ]);
    expect(out.map((x) => [x.id, x.count])).toEqual([["5", 2], ["3", 1], ["2", 1], ["1", 1]]);
  });
  it("does not fold a file being opened, or opens far apart", () => {
    const out = collapseViews([ev("3", "view", "2026-10-12T10:08:00Z", "u1", { file: "f1" }), ev("2", "view", "2026-10-12T10:07:00Z", "u1", { file: "f1" }), ev("1", "view", "2026-10-12T08:00:00Z")]);
    expect(out.map((x) => x.count)).toEqual([1, 1, 1]);
  });
  it("does not change the events it is given", () => {
    const input = [ev("2", "view", "2026-10-12T10:08:00Z"), ev("1", "view", "2026-10-12T10:07:00Z")];
    collapseViews(input);
    expect(input.every((x) => !("count" in x))).toBe(true);
  });
});

describe("the settings form's clocks", () => {
  it("reads whole days, empty as no limit, and refuses the rest", () => {
    expect(parseDays("")).toBeNull();
    expect(parseDays(" 14 ")).toBe(14);
    expect(parseDays("0")).toBeUndefined();
    expect(parseDays("2.5")).toBeUndefined();
    expect(parseDays("abc")).toBeUndefined();
    expect(parseDays("1000")).toBeUndefined();
  });
  it("accepts a stop on or after the target, either empty, and refuses a stop before the target", () => {
    expect(clocksValid("14", "30")).toBe(true);
    expect(clocksValid("14", "14")).toBe(true);
    expect(clocksValid("", "30")).toBe(true);
    expect(clocksValid("14", "")).toBe(true);
    expect(clocksValid("", "")).toBe(true);
    expect(clocksValid("30", "14")).toBe(false);
    expect(clocksValid("x", "14")).toBe(false);
  });
});
