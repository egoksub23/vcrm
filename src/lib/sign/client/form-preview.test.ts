import { describe, expect, it } from "vitest";

import { boundValues } from "../forms/printing";
import { fieldOf } from "./form-edit";
import { placement, sampleForm } from "./form-fixtures";
import { bindPlacement } from "./form-printing";
import { addTestFile, applyInput, previewPercent, previewView, printedRows, removeTestFile, type TestAnswers } from "./form-preview";

const form = sampleForm();

describe("test answers", () => {
  it("runs a typed answer through the real check and keeps the answers when it is refused", () => {
    const ok = applyInput(form, {}, "legal_name", { text: "  Kedai Runcit " });
    expect(ok.answers).toEqual({ legal_name: { text: "Kedai Runcit" } });
    expect(ok.error).toBeUndefined();
    const bad = applyInput(form, ok.answers, "account_no", { text: "12ab" });
    expect(bad.error).toEqual({ code: "format_digits", detail: undefined });
    expect(bad.answers).toBe(ok.answers);
    const cleared = applyInput(form, ok.answers, "legal_name", { text: "" });
    expect(cleared.answers).toEqual({});
    expect(applyInput(form, {}, "ghost", { text: "x" }).answers).toEqual({});
  });

  it("adds and removes a test file and respects the file count", () => {
    const field = fieldOf(form, "form9")!;
    const one = addTestFile({}, field, { name: "form9.pdf", size: 1200, type: "application/pdf" }, "id1");
    expect(one.answers.form9).toMatchObject({ files: [{ id: "id1", name: "form9.pdf" }] });
    const two = addTestFile(one.answers, field, { name: "b.pdf", size: 5, type: "application/pdf" }, "id2");
    expect(two.error).toEqual({ code: "too_many_files", detail: "1" });
    expect(removeTestFile(one.answers, "form9", "id1")).toEqual({});
  });
});

describe("the view a signer would be given", () => {
  it("lists the role's parts and progress, and never the path of a file", () => {
    const withFile = addTestFile({}, fieldOf(form, "form9")!, { name: "f.pdf", size: 1, type: "application/pdf" }, "i").answers;
    const view = previewView(form, "finance", withFile);
    expect(view.partKeys).toEqual(["bank"]);
    expect(view.answers.form9).toEqual({ files: [{ id: "i", name: "f.pdf", mime: "application/pdf", size: 1, sha256: "preview" }] });
    expect(view.unconfirmed).toEqual([]);
    expect(view.definition).toBe(form);
    expect(view.progress.map((p) => p.key)).toEqual(["bank"]);
  });

  it("opens the sign step only when every required field of the role's parts is answered, and rules change what is required", () => {
    let answers: TestAnswers = {};
    expect(previewView(form, "merchant", answers).ready).toBe(false);
    answers = applyInput(form, answers, "legal_name", { text: "Kedai" }).answers;
    answers = applyInput(form, answers, "biz_type", { text: "sole" }).answers;
    answers = applyInput(form, answers, "msic", { list: ["47111"] }).answers;
    expect(previewView(form, "merchant", answers).ready).toBe(true);
    // choosing SST makes the tax percentage appear and be required
    answers = applyInput(form, answers, "tax_type", { text: "sst" }).answers;
    const view = previewView(form, "merchant", answers);
    expect(view.ready).toBe(false);
    expect(view.progress.find((p) => p.key === "tax")).toMatchObject({ state: "in_progress", total: 2, done: 1 });
    answers = applyInput(form, answers, "tax_pct", { text: "8" }).answers;
    expect(previewView(form, "merchant", answers).ready).toBe(true);
    expect(previewPercent(form, "merchant", answers)).toBe(100);
  });

  it("a role with no parts has no part keys", () => {
    expect(previewView(form, "nobody", {}).partKeys).toEqual([]);
  });
});

describe("what the answers print", () => {
  it("lists the text and ticks the bound placements would print, matching the engine", () => {
    const placements = [
      bindPlacement(placement({ key: "n1", type: "text", page: 0 }), fieldOf(form, "legal_name")!),
      bindPlacement(placement({ key: "t1", type: "checkbox", page: 1 }), fieldOf(form, "tax_type")!, "sst"),
      bindPlacement(placement({ key: "t2", type: "checkbox", page: 1 }), fieldOf(form, "tax_type")!, "na"),
      bindPlacement(placement({ key: "m1", type: "text", page: 1, multiline: true }), fieldOf(form, "msic")!),
      bindPlacement(placement({ key: "p1", type: "number", page: 1 }), fieldOf(form, "tax_pct")!),
    ];
    const answers: TestAnswers = { legal_name: { text: "Kedai Runcit" }, tax_type: { text: "sst" }, msic: { list: ["47111", "47211"] }, tax_pct: { text: "8" } };
    const rows = printedRows(form, placements, answers, "en");
    expect(rows).toEqual([
      { placement: "n1", page: 1, field: "legal_name", text: "Kedai Runcit" },
      { placement: "t1", page: 2, field: "tax_type", checked: true },
      { placement: "m1", page: 2, field: "msic", text: "47111\n47211" },
      { placement: "p1", page: 2, field: "tax_pct", text: "8" },
    ]);
    // the engine prints the same
    const engine = boundValues(placements, form, answers, "en");
    expect(Object.keys(engine).sort()).toEqual(rows.map((r) => r.placement).sort());
    expect(engine.n1).toEqual({ text: "Kedai Runcit" });
    expect(engine.m1).toEqual({ text: "47111\n47211" });
    expect(engine.t1).toEqual({ checked: true });
    // a hidden field prints nothing
    expect(printedRows(form, placements, { tax_pct: { text: "8" } }, "en")).toEqual([]);
  });
});
