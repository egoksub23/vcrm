import { describe, expect, it } from "vitest";

import { boundValues } from "../forms/printing";
import { validateForm } from "../forms/validate";
import type { PlacedField } from "../pdf/types";
import { SENDER_ROLE, validateFields } from "../rules";
import { fieldOf } from "./form-edit";
import { placement, placements, roles, sampleForm } from "./form-fixtures";
import { applyPlacementOps, bindableFields, bindPlacement, bindingProblems, boundSize, canPrintIn, createBoundPlacement, incompatibleBound, placementsBoundTo, placementTypeFor, printCounts, printedOn, takesOptionValue, unbindPlacement } from "./form-printing";
import { boundSample, sampleValue } from "./editor-preview";

const form = sampleForm();
const field = (k: string) => fieldOf(form, k)!;

describe("printed on the form", () => {
  it("counts the places and pages a data field prints on, in reading order", () => {
    const p = printedOn(placements, "legal_name");
    expect(p.places).toBe(2);
    expect(p.pages).toEqual([1, 2]);
    expect(p.placements.map((x) => x.key)).toEqual(["p_name", "p_name2"]);
    expect(printedOn(placements, "msic")).toEqual({ places: 0, pages: [], placements: [] });
    expect(printCounts(placements)).toEqual(new Map([["legal_name", 2], ["tax_type", 1], ["tax_pct", 1]]));
  });
});

describe("what can be printed where", () => {
  it("follows placementTypesFor", () => {
    expect(canPrintIn(field("legal_name"), "text")).toBe(true);
    expect(canPrintIn(field("legal_name"), "signature")).toBe(false);
    expect(canPrintIn(field("tax_pct"), "number")).toBe(true);
    expect(canPrintIn(field("form9"), "text")).toBe(false);
    expect(takesOptionValue(field("tax_type"), "checkbox")).toBe(true);
    expect(takesOptionValue(field("tax_type"), "text")).toBe(false);
    expect(takesOptionValue(field("legal_name"), "checkbox")).toBe(false);
  });

  it("offers a placement only the data fields it can print", () => {
    const names = (p: PlacedField) => bindableFields(form, p).map((f) => f.key);
    expect(names(placement({ key: "a", type: "number" }))).toEqual(["tax_pct"]);
    expect(names(placement({ key: "a", type: "text" }))).toEqual(["legal_name", "biz_type", "tax_type", "tax_pct", "msic", "account_no"]);
    expect(names(placement({ key: "a", type: "checkbox" }))).toEqual(["legal_name", "biz_type", "tax_type", "msic", "account_no"]);
    expect(names(placement({ key: "a", type: "signature" }))).toEqual([]);
    expect(names(placement({ key: "a", type: "static_text", text: "x" }))).toEqual([]);
  });

  it("chooses the placement a data field gets from the Place action", () => {
    expect(placementTypeFor(field("legal_name"))).toBe("text");
    expect(placementTypeFor(field("tax_pct"))).toBe("number");
    expect(placementTypeFor({ ...field("legal_name"), type: "date" })).toBe("date");
    expect(placementTypeFor({ ...field("legal_name"), type: "yesno" })).toBe("checkbox");
    expect(placementTypeFor({ ...field("legal_name"), type: "image" })).toBe("upload");
    expect(placementTypeFor(field("form9"))).toBeNull();
  });
});

describe("binding", () => {
  it("binds a placement to the sender and drops what no longer applies", () => {
    const p = placement({ key: "x", type: "text", role: "merchant", required: true, merge: "company", label: "Company", fontSize: 10 });
    const b = bindPlacement(p, field("legal_name"));
    expect(b).toMatchObject({ key: "x", data: "legal_name", role: SENDER_ROLE, required: false, fontSize: 10 });
    expect(b.merge).toBeUndefined();
    expect(b.label).toBeUndefined();
    expect(validateFields([b], roles, 1)).toEqual([]);
    expect(validateForm(form, roles, [b])).toEqual([]);
  });

  it("binds a tick box to one option, and ignores an option for any other pairing", () => {
    const tick = placement({ key: "t", type: "checkbox", role: "merchant" });
    expect(bindPlacement(tick, field("tax_type"), "sst").dataValue).toBe("sst");
    expect(bindPlacement(tick, field("legal_name"), "x").dataValue).toBeUndefined();
    expect(bindPlacement(placement({ key: "u", type: "text" }), field("tax_type"), "sst").dataValue).toBeUndefined();
    expect(validateForm(form, roles, [bindPlacement(tick, field("tax_type"), "sst")])).toEqual([]);
  });

  it("makes a multi-line answer print in a multi-line box", () => {
    expect(bindPlacement(placement({ key: "m", type: "text" }), field("msic")).multiline).toBe(true);
    expect(bindPlacement(placement({ key: "m", type: "text" }), field("legal_name")).multiline).toBeUndefined();
  });

  it("unbinding hands the placement back to a role that may own it", () => {
    const b = bindPlacement(placement({ key: "x", type: "text" }), field("legal_name"));
    const u = unbindPlacement(b, roles, "finance");
    expect(u.data).toBeUndefined();
    expect(u).toMatchObject({ role: "finance", required: true });
    const tick = unbindPlacement(bindPlacement(placement({ key: "t", type: "checkbox" }), field("tax_type"), "sst"), roles, null);
    expect(tick.dataValue).toBeUndefined();
    expect(tick.role).toBe("merchant");
  });

  it("creates a bound placement at a point, the right type and size, inside the page", () => {
    const p = createBoundPlacement({ field: field("tax_pct"), page: 1, centre: { x: 0.5, y: 0.5 }, aspect: 1.4142, taken: new Set(["f_a"]) })!;
    expect(p).toMatchObject({ type: "number", page: 1, data: "tax_pct", role: SENDER_ROLE, required: false });
    expect(p.x).toBeCloseTo(0.5 - p.w / 2, 4);
    expect(validateFields([p], roles, 2)).toEqual([]);
    // at the page corner it is pushed inside
    const corner = createBoundPlacement({ field: field("legal_name"), page: 0, centre: { x: 1, y: 1 }, aspect: 1.4142, taken: new Set() })!;
    expect(corner.x + corner.w).toBeLessThanOrEqual(1);
    expect(corner.y + corner.h).toBeLessThanOrEqual(1);
    // a file cannot be printed
    expect(createBoundPlacement({ field: field("form9"), page: 0, centre: { x: 0.5, y: 0.5 }, aspect: 1.4, taken: new Set() })).toBeNull();
    // a multi-line field is taller than a one-line one
    expect(boundSize(field("msic"), "text", 1.4142).h).toBeGreaterThan(boundSize(field("legal_name"), "text", 1.4142).h);
    // never a key a data field uses
    const keyed = createBoundPlacement({ field: field("legal_name"), page: 0, centre: { x: 0.5, y: 0.5 }, aspect: 1.4, taken: new Set(["f_aaaa"]), random: () => 0 })!;
    expect(keyed.key).not.toBe("f_aaaa");
  });
});

describe("keeping placements in step", () => {
  it("removes the placements of deleted data fields and follows a renamed key", () => {
    expect(placementsBoundTo(placements, new Set(["legal_name"])).map((p) => p.key)).toEqual(["p_name", "p_name2"]);
    const out = applyPlacementOps(placements, [{ type: "remove_bound", data: "legal_name" }, { type: "rename_data", from: "tax_pct", to: "vat" }]);
    expect(out.map((p) => p.key)).toEqual(["f_sig", "p_sst", "p_pct"]);
    expect(out.find((p) => p.key === "p_pct")!.data).toBe("vat");
    expect(applyPlacementOps(placements, [])).toEqual(placements);
    // one box by its key
    expect(applyPlacementOps(placements, [{ type: "remove_placement", key: "p_sst" }]).map((p) => p.key)).toEqual(["f_sig", "p_name", "p_name2", "p_pct"]);
  });

  it("finds the boxes a field can no longer print after it changes type, so none is left to block a save", () => {
    const retyped = (type: "text" | "image" | "number" | "yesno") => ({ ...field("tax_type"), type, options: undefined });
    // a tick box tied to an option cannot stay once the field has no options; a text box cannot print a picture
    expect(incompatibleBound(retyped("text"), placements).map((p) => p.key)).toEqual(["p_sst"]);
    expect(incompatibleBound(retyped("image"), placements).map((p) => p.key)).toEqual(["p_sst"]);
    expect(incompatibleBound(field("tax_type"), placements)).toEqual([]);
    expect(incompatibleBound({ ...field("legal_name"), type: "image" }, placements).map((p) => p.key)).toEqual(["p_name", "p_name2"]);
    // what remains is sound
    const changed = { ...form, fields: form.fields.map((f) => (f.key === "legal_name" ? { ...f, type: "image" as const } : f)) };
    const gone = incompatibleBound(changed.fields.find((f) => f.key === "legal_name")!, placements).map((p) => ({ type: "remove_placement" as const, key: p.key }));
    expect(validateForm(changed, roles, applyPlacementOps(placements, gone)).filter((i) => i.code.startsWith("placement_"))).toEqual([]);
  });

  it("names the bindings that no longer fit", () => {
    const f = sampleForm();
    const retyped = { ...f, fields: f.fields.filter((x) => x.key !== "tax_pct").map((x) => (x.key === "tax_type" ? { ...x, type: "image" as const, options: undefined } : x)) };
    expect(bindingProblems(retyped, placements)).toEqual([
      { code: "placement_type_mismatch", placement: "p_sst", field: "tax_type" },
      { code: "placement_unknown_data", placement: "p_pct", field: "tax_pct" },
    ]);
    expect(bindingProblems(f, placements)).toEqual([]);
    const noOption = { ...f, fields: f.fields.map((x) => (x.key === "tax_type" ? { ...x, options: [{ value: "na", label: { en: "NA" } }] } : x)) };
    expect(bindingProblems(noOption, placements)).toEqual([{ code: "placement_option_missing", placement: "p_sst", field: "tax_type" }]);
  });
});

describe("what the editor shows for a bound placement", () => {
  const ctx = { now: new Date(2026, 9, 5), locale: "en", signerName: "Ali", textPlaceholder: "Sample text", form, sampleItem: (n: number) => `Item ${n}` };

  it("shows a sample of the data field's answer", () => {
    const at = (type: PlacedField["type"], data: string, over: Partial<PlacedField> = {}) => sampleValue(placement({ key: "k", type, data, ...over }), ctx);
    expect(at("text", "legal_name")).toEqual({ kind: "text", text: "Sample text" });
    expect(at("text", "biz_type")).toEqual({ kind: "text", text: "Sdn. Bhd." });
    expect(at("text", "msic", { multiline: true })).toEqual({ kind: "text", text: "Item 1\nItem 2" });
    expect(at("text", "msic")).toEqual({ kind: "text", text: "Item 1, Item 2" });
    expect(at("number", "tax_pct", { decimals: 2 })).toEqual({ kind: "text", text: "1,234.57" });
    expect(at("checkbox", "tax_type", { dataValue: "sst" }).kind).toBe("check");
    expect(at("text", "ghost")).toEqual({ kind: "text", text: "{{ghost}}", missing: true });
    expect(boundSample(placement({ key: "k", data: "x" }), undefined, ctx).missing).toBe(true);
  });

  it("uses the language of the reader for option labels", () => {
    const ms = { ...form, fields: form.fields.map((f) => (f.key === "biz_type" ? { ...f, options: [{ value: "sdn_bhd", label: { en: "Sdn. Bhd.", ms: "Syarikat" } }] } : f)) };
    expect(sampleValue(placement({ key: "k", data: "biz_type" }), { ...ctx, form: ms, locale: "ms" })).toEqual({ kind: "text", text: "Syarikat" });
  });
});

describe("agreement with the engine's printing", () => {
  it("a bound placement the builder makes gets a value from the engine for a matching answer", () => {
    const b = bindPlacement(placement({ key: "x", type: "text" }), field("legal_name"));
    const tick = bindPlacement(placement({ key: "t", type: "checkbox" }), field("tax_type"), "sst");
    const values = boundValues([b, tick], form, { legal_name: { text: "Kedai Runcit" }, tax_type: { text: "sst" } }, "en");
    expect(values.x).toEqual({ text: "Kedai Runcit" });
    expect(values.t).toEqual({ checked: true });
  });
});
