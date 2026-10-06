// ============================================================
// Doc Sign form builder: where an answer is printed on the page. A data field is asked once and printed by any
// number of placements (a PlacedField whose `data` names it) or by none. This file counts the places, says which
// placements can print which data field, binds and unbinds a placement, makes a new bound placement for the
// "Place" action, and keeps placements in step when a data field is renamed or deleted.
// Pure: no React, no I/O.
// ============================================================

import { placementTypesFor } from "../forms/validate";
import type { DataField, FormDefinition } from "../forms/types";
import type { FieldType, PlacedField } from "../pdf/types";
import { SENDER_ROLE } from "../rules";
import type { SignRole } from "../types";
import { clampRect, createField, defaultRequired, defaultSize, keysOf, readingOrder, roleForType, type Rect } from "./layout";

// ---- counting ---------------------------------------------------------------------------------------------------------

export interface PrintedOn {
  places: number;
  /** 1-based page numbers, sorted, each once. */
  pages: number[];
  /** The placements that print it, in reading order. */
  placements: PlacedField[];
}

export function printedOn(placements: readonly PlacedField[], dataKey: string): PrintedOn {
  const mine = readingOrder(placements.filter((p) => p.data === dataKey));
  return { places: mine.length, pages: [...new Set(mine.map((p) => p.page + 1))].sort((a, b) => a - b), placements: mine };
}

/** How many places print each data field (fields printed nowhere are absent). */
export function printCounts(placements: readonly PlacedField[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of placements) if (p.data) out.set(p.data, (out.get(p.data) ?? 0) + 1);
  return out;
}

export const isBound = (p: PlacedField): boolean => !!p.data;

// ---- what can print what -------------------------------------------------------------------------------------------------

/** May a placement of `type` print this data field? */
export const canPrintIn = (field: DataField, type: FieldType): boolean => placementTypesFor(field.type).includes(type);

/** A tick box can be bound to one option of a choice or multiple choice. */
export const takesOptionValue = (field: DataField, type: FieldType): boolean => type === "checkbox" && (field.type === "choice" || field.type === "multichoice");

/** Can this placement be bound at all? Fixed text cannot; a placement for signing or the signer's own name or date cannot print an answer. */
export const bindable = (p: PlacedField): boolean => p.type !== "static_text" && ["text", "number", "date", "checkbox", "dropdown", "upload"].includes(p.type);

/** The data fields a placement may print, in the order they are asked. */
export function bindableFields(form: FormDefinition, p: PlacedField): DataField[] {
  if (!bindable(p)) return [];
  return form.fields.filter((f) => canPrintIn(f, p.type));
}

/** The placement type a new "Place" action makes for a data field; null for a field that cannot be printed (files). */
export function placementTypeFor(field: DataField): FieldType | null {
  switch (field.type) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "yesno":
    case "acknowledge":
      return "checkbox";
    case "image":
      return "upload";
    case "file":
      return null;
    default:
      return "text";
  }
}

/** How much taller than a one-line box a field's answer needs. */
const tall = (field: DataField): boolean => field.type === "multiline" || field.type === "list";

/** The size a new bound placement starts at (fractions of the page); `aspect` is page height over page width. */
export function boundSize(field: DataField, type: FieldType, aspect: number): { w: number; h: number } {
  const s = defaultSize(type, aspect);
  return tall(field) && type === "text" ? { w: s.w, h: Math.min(0.3, s.h * 4) } : s;
}

// ---- binding --------------------------------------------------------------------------------------------------------------

/** The placement printing `field` (and, for a tick box, one option). Everything about where and how it looks is kept. */
export function bindPlacement(p: PlacedField, field: DataField, dataValue?: string): PlacedField {
  const rest: PlacedField = { ...p };
  delete rest.merge;
  delete rest.dataValue;
  delete rest.label;
  const bound: PlacedField = { ...rest, data: field.key, role: SENDER_ROLE, required: false };
  if (dataValue !== undefined && takesOptionValue(field, p.type)) bound.dataValue = dataValue;
  if ((field.type === "multiline" || field.type === "list") && p.type === "text" && p.multiline === undefined) bound.multiline = true;
  return bound;
}

/** The placement as an ordinary one again, for the role that may own it. */
export function unbindPlacement(p: PlacedField, roles: readonly SignRole[], preferredRole?: string | null): PlacedField {
  const rest: PlacedField = { ...p };
  delete rest.data;
  delete rest.dataValue;
  const role = roleForType(p.type, roles, preferredRole) || (p.role === SENDER_ROLE ? "" : p.role);
  return { ...rest, role, required: defaultRequired(p.type) };
}

/** A new placement for a data field, bound, centred on `centre` (fractions of the page) and inside the page. Null for a field with no placement type. */
export function createBoundPlacement(input: { field: DataField; page: number; centre: { x: number; y: number }; aspect: number; taken: ReadonlySet<string>; dataValue?: string; random?: () => number }): PlacedField | null {
  const type = placementTypeFor(input.field);
  if (!type) return null;
  const { w, h } = boundSize(input.field, type, input.aspect);
  const rect: Rect = clampRect({ x: input.centre.x - w / 2, y: input.centre.y - h / 2, w, h });
  const base = createField({ type, page: input.page, rect, role: SENDER_ROLE, taken: input.taken, random: input.random });
  return bindPlacement(base, input.field, input.dataValue);
}

// ---- keeping placements in step ---------------------------------------------------------------------------------------

/** A change to the placements that follows from a change to the form, kept so it can be replayed on a newer version of the template. */
export type PlacementOp = { type: "remove_bound"; data: string } | { type: "rename_data"; from: string; to: string } | { type: "remove_placement"; key: string };

export function applyPlacementOps(fields: readonly PlacedField[], ops: readonly PlacementOp[]): PlacedField[] {
  let out = fields.slice();
  for (const op of ops) {
    if (op.type === "remove_bound") out = out.filter((p) => p.data !== op.data);
    else if (op.type === "remove_placement") out = out.filter((p) => p.key !== op.key);
    else out = out.map((p) => (p.data === op.from ? { ...p, data: op.to } : p));
  }
  return out;
}

/** The placements to remove when these data fields go. */
export const placementsBoundTo = (placements: readonly PlacedField[], keys: ReadonlySet<string>): PlacedField[] => placements.filter((p) => p.data !== undefined && keys.has(p.data));

/**
 * The placements bound to `field` that it can no longer print (it changed type): the placement type is not one the field prints in,
 * or a tick box still names an option though the field has no options. Used when a field changes type, so no box is left that
 * would stop the template being saved.
 */
export function incompatibleBound(field: DataField, placements: readonly PlacedField[]): PlacedField[] {
  return placements.filter((p) => p.data === field.key && (!canPrintIn(field, p.type) || (p.dataValue !== undefined && !takesOptionValue(field, p.type))));
}

/** Placement keys in use (to keep a new data field's key different from them). */
export const placementKeys = (placements: readonly PlacedField[]): Set<string> => keysOf(placements);

/**
 * Bound placements that no longer fit their data field (the field changed type, or an option went): the codes and keys, for the builder
 * to word. Mirrors validateForm for the cases a person can cause while editing, plus the option check validateForm leaves out.
 */
export function bindingProblems(form: FormDefinition, placements: readonly PlacedField[]): { code: "placement_unknown_data" | "placement_type_mismatch" | "placement_option_missing"; placement: string; field: string }[] {
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  const out: { code: "placement_unknown_data" | "placement_type_mismatch" | "placement_option_missing"; placement: string; field: string }[] = [];
  for (const p of placements) {
    if (!p.data) continue;
    const f = byKey.get(p.data);
    if (!f) out.push({ code: "placement_unknown_data", placement: p.key, field: p.data });
    else if (!canPrintIn(f, p.type)) out.push({ code: "placement_type_mismatch", placement: p.key, field: p.data });
    else if (p.dataValue !== undefined && !(f.options ?? []).some((o) => o.value === p.dataValue)) out.push({ code: "placement_option_missing", placement: p.key, field: p.data });
  }
  return out;
}
