import { describe, expect, it } from "vitest";

import { emptyForm } from "./form-edit";
import { placements, roles, sampleForm } from "./form-fixtures";
import { formForSave, planEditorSave, planFormSave, type VersionSnapshot } from "./form-save";

const version = (over: Partial<VersionSnapshot> = {}): VersionSnapshot => ({ id: "v1", fields: placements, roles, defaults: { expiry_days: 14 }, form: sampleForm(), ...over });

describe("a template with no parts is page overlay mode", () => {
  it("saves no form at all for an empty one", () => {
    expect(formForSave(emptyForm())).toBeNull();
    expect(formForSave(sampleForm())).not.toBeNull();
  });
});

describe("the form builder saving", () => {
  it("saves on top of the version it opened, changing only the form and the bindings", () => {
    const form = { ...sampleForm(), parts: sampleForm().parts.slice(0, 2) };
    const plan = planFormSave({ loaded: version(), latest: version(), form, placements: placements.slice(0, 3), ops: [] });
    expect(plan).toMatchObject({ kind: "ok", merged: false });
    if (plan.kind !== "ok") return;
    expect(plan.body.form).toBe(form);
    expect(plan.body.fields).toEqual(placements.slice(0, 3));
    expect(plan.body.roles).toBe(roles);
    expect(plan.body.defaults).toEqual({ expiry_days: 14 });
  });

  it("when the editor saved a newer version meanwhile, takes its fields, roles and defaults and replays the binding changes", () => {
    const moved = placements.map((p) => (p.key === "f_sig" ? { ...p, x: 0.5 } : p));
    const newerRoles = [...roles, { key: "director", label: "Director", kind: "signer" as const, color: 2 }];
    const latest = version({ id: "v2", fields: moved, roles: newerRoles, defaults: { expiry_days: 30 } });
    const plan = planFormSave({ loaded: version(), latest, form: sampleForm(), placements, ops: [{ type: "remove_bound", data: "legal_name" }] });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.merged).toBe(true);
    expect(plan.body.roles).toBe(newerRoles);
    expect(plan.body.defaults).toEqual({ expiry_days: 30 });
    expect(plan.body.fields.map((p) => p.key)).toEqual(["f_sig", "p_sst", "p_pct"]);
    expect(plan.body.fields.find((p) => p.key === "f_sig")!.x).toBe(0.5);
  });

  it("refuses to overwrite a form someone else changed", () => {
    const other = { ...sampleForm(), parts: sampleForm().parts.slice(1) };
    const plan = planFormSave({ loaded: version(), latest: version({ id: "v2", form: other }), form: sampleForm(), placements, ops: [] });
    expect(plan).toEqual({ kind: "conflict" });
  });

  it("sends form null when the last part was deleted, to leave page overlay mode", () => {
    const plan = planFormSave({ loaded: version(), latest: version(), form: emptyForm(), placements: [], ops: [] });
    expect(plan.kind === "ok" && plan.body.form).toBeNull();
  });

  it("works from a template that had no form", () => {
    const plan = planFormSave({ loaded: version({ form: null }), latest: version({ form: null }), form: sampleForm(), placements, ops: [] });
    expect(plan.kind === "ok" && plan.body.form).not.toBeNull();
  });
});

describe("the placement editor saving", () => {
  const edited = placements.map((p) => (p.key === "f_sig" ? { ...p, x: 0.3 } : p));

  it("carries the form over untouched", () => {
    const plan = planEditorSave({ loaded: version(), latest: version(), fields: edited, roles, defaults: { expiry_days: 14 } });
    expect(plan.kind === "ok" && plan.body.form).toEqual(sampleForm());
    expect(plan.kind === "ok" && plan.body.fields).toBe(edited);
    expect(plan).toMatchObject({ merged: false });
  });

  it("takes a newer form when the builder saved meanwhile and the layout is unchanged", () => {
    const newerForm = { ...sampleForm(), parts: sampleForm().parts.slice(0, 1), fields: sampleForm().fields.filter((f) => f.part === "company") };
    const plan = planEditorSave({ loaded: version(), latest: version({ id: "v2", form: newerForm }), fields: edited, roles, defaults: { expiry_days: 14 } });
    expect(plan).toMatchObject({ kind: "ok", merged: true });
    expect(plan.kind === "ok" && plan.body.form).toBe(newerForm);
  });

  it("refuses when the newer version changed the layout as well", () => {
    const latest = version({ id: "v2", fields: placements.slice(0, 2) });
    expect(planEditorSave({ loaded: version(), latest, fields: edited, roles, defaults: {} })).toEqual({ kind: "conflict" });
  });

  it("never turns a template with no form into one", () => {
    const plan = planEditorSave({ loaded: version({ form: null }), latest: version({ form: null }), fields: edited, roles, defaults: {} });
    expect(plan.kind === "ok" && plan.body.form).toBeNull();
  });
});
