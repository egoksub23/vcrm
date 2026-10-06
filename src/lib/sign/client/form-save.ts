// ============================================================
// Doc Sign form builder: saving a template version without losing anyone's work. The placement editor and the
// form builder are two views of ONE template version (fields, roles, defaults, form). Each loads the latest
// version before it saves, changes only what it owns, and carries the rest over unchanged. When a newer version
// was saved in the meantime by the other view, the change is merged if the two did not touch the same thing,
// and refused (so nothing is silently overwritten) if they did.
// Pure: no React, no I/O.
// ============================================================

import type { FormDefinition } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import type { SignRole, TemplateDefaults } from "../types";
import { applyPlacementOps, type PlacementOp } from "./form-printing";

/** The body of POST /api/sign/templates/[id]/versions. `form: null` removes the form. */
export interface VersionBody {
  fields: PlacedField[];
  roles: SignRole[];
  defaults: TemplateDefaults;
  form: FormDefinition | null;
}

/** What a screen needs of a version row. */
export interface VersionSnapshot {
  id: string;
  fields: PlacedField[];
  roles: SignRole[];
  defaults: TemplateDefaults;
  form: FormDefinition | null;
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A form with no parts and no fields is no form: the template goes back to placing fields on the page. */
export const formForSave = (form: FormDefinition): FormDefinition | null => (form.parts.length === 0 && form.fields.length === 0 ? null : form);

export type SavePlan = { kind: "ok"; body: VersionBody; merged: boolean } | { kind: "conflict" };

/**
 * The form builder saving. `loaded` is the version it was opened on, `latest` what the server has now. The builder owns the form and
 * the placements' bindings; it never changes roles or defaults, so those come from `latest`.
 */
export function planFormSave(input: { loaded: VersionSnapshot; latest: VersionSnapshot; form: FormDefinition; placements: readonly PlacedField[]; ops: readonly PlacementOp[] }): SavePlan {
  const { loaded, latest } = input;
  if (latest.id === loaded.id) {
    return { kind: "ok", merged: false, body: { fields: [...input.placements], roles: latest.roles, defaults: latest.defaults, form: formForSave(input.form) } };
  }
  // someone saved since: only safe when they did not touch the form this screen is editing
  if (!same(latest.form, loaded.form)) return { kind: "conflict" };
  return { kind: "ok", merged: true, body: { fields: applyPlacementOps(latest.fields, input.ops), roles: latest.roles, defaults: latest.defaults, form: formForSave(input.form) } };
}

/**
 * The placement editor saving. It owns the fields, roles and defaults; the form is carried over from `latest` untouched. A newer version
 * is only merged over when it changed nothing the editor owns (a form-only save in the other view), otherwise the editor refuses.
 */
export function planEditorSave(input: { loaded: VersionSnapshot; latest: VersionSnapshot; fields: PlacedField[]; roles: SignRole[]; defaults: TemplateDefaults }): SavePlan {
  const { loaded, latest } = input;
  if (latest.id !== loaded.id && !(same(latest.fields, loaded.fields) && same(latest.roles, loaded.roles) && same(latest.defaults, loaded.defaults))) return { kind: "conflict" };
  return { kind: "ok", merged: latest.id !== loaded.id, body: { fields: input.fields, roles: input.roles, defaults: input.defaults, form: latest.form } };
}

export const sameForm = (a: FormDefinition | null | undefined, b: FormDefinition | null | undefined): boolean => same(a, b);
