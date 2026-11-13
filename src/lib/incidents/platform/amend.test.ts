import { describe, expect, it } from "vitest";

import { parseAmend } from "./amend";

describe("parseAmend", () => {
  it("trims the title and description, and turns an empty description into none", () => {
    expect(parseAmend({ title: "  Sprained ankle  ", description: "  Football  " }, "reported")).toEqual({ ok: true, touched: true, patch: { title: "Sprained ankle", description: "Football" } });
    expect(parseAmend({ description: "   " }, "reported")).toMatchObject({ ok: true, patch: { description: null } });
  });

  it("refuses an empty or too long title, and too long a description", () => {
    expect(parseAmend({ title: "  " }, "reported")).toMatchObject({ ok: false });
    expect(parseAmend({ title: "x".repeat(201) }, "reported")).toMatchObject({ ok: false });
    expect(parseAmend({ description: "x".repeat(10001) }, "reported")).toMatchObject({ ok: false });
    expect(parseAmend({ description: 5 }, "reported")).toMatchObject({ ok: false });
  });

  it("asks for a reason once the incident is closed, and keeps one if it is given earlier", () => {
    expect(parseAmend({ title: "New" }, "closed")).toMatchObject({ ok: false });
    expect(parseAmend({ title: "New", amend_reason: "ab" }, "closed")).toMatchObject({ ok: false });
    expect(parseAmend({ title: "New", amend_reason: " Typo in the name " }, "closed")).toMatchObject({ ok: true, patch: { title: "New", amend_reason: "Typo in the name" } });
    expect(parseAmend({ title: "New", amend_reason: "Typo" }, "investigating")).toMatchObject({ ok: true, patch: { amend_reason: "Typo" } });
  });

  it("does nothing, and needs no reason, when the request does not touch the wording", () => {
    expect(parseAmend({ severity: "p1" }, "closed")).toEqual({ ok: true, touched: false, patch: {} });
  });
});
