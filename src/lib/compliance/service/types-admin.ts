// ============================================================
// Compliance requests: the request type definitions and their settings (compliance.manage). Server only.
//
// What can be changed: the labels, the clocks (applied to NEW cases only; a case keeps the clock it was made with), the identity check switch, the
// dues block, the pause switch, the checklist template (copied onto new cases), active, and the position. The FIELDS of a system type (closure,
// withdrawal, phone_change) are fixed (the public form and the staff form are built on them); a custom type's fields are editable through this API.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { ComplianceError, complianceError, fromDatabase } from "../errors";
import { validateChecklist, validateFieldDefs } from "../fields";
import type { RequestTypeRow } from "../types";
import { loadTypes, TYPE_COLUMNS, typeFromRow, type ComplianceCaller, type TypeDbRow } from "./rows";

export interface TypePatch {
  label?: string;
  labelL10n?: Record<string, string>;
  /** null: no target. */
  targetDays?: number | null;
  hardStopDays?: number | null;
  requiresIdentityCheck?: boolean;
  checkDues?: boolean;
  allowPause?: boolean;
  active?: boolean;
  position?: number;
  checklist?: unknown;
  fields?: unknown;
}

const days = (v: unknown, max: number, field: string): number | null => {
  if (v === null) return null;
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ComplianceError("validation_failed", "Enter a whole number of days.", 400, [{ field, code: "invalid" }]);
  return n;
};

function dbPatch(p: TypePatch, current: RequestTypeRow | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.label !== undefined) {
    const t = p.label.trim();
    if (t === "" || t.length > 120) throw new ComplianceError("validation_failed", "Enter a name.", 400, [{ field: "label", code: t === "" ? "required" : "too_long" }]);
    out.label = t;
  }
  if (p.labelL10n !== undefined) {
    const o: Record<string, string> = {};
    for (const l of ["ms", "zh", "ko"] as const) {
      const v = typeof p.labelL10n[l] === "string" ? p.labelL10n[l].trim().slice(0, 120) : "";
      if (v !== "") o[l] = v;
    }
    out.label_l10n = o;
  }
  const target = p.targetDays !== undefined ? days(p.targetDays, 365, "target_days") : (current?.targetDays ?? null);
  const stop = p.hardStopDays !== undefined ? days(p.hardStopDays, 730, "hard_stop_days") : (current?.hardStopDays ?? null);
  if (p.targetDays !== undefined) out.target_days = target;
  if (p.hardStopDays !== undefined) out.hard_stop_days = stop;
  if (target !== null && stop !== null && stop < target) throw new ComplianceError("validation_failed", "The hard stop cannot be before the target.", 400, [{ field: "hard_stop_days", code: "before_target" }]);
  for (const [k, col] of [["requiresIdentityCheck", "requires_identity_check"], ["checkDues", "check_dues"], ["allowPause", "allow_pause"], ["active", "active"]] as const) {
    const v = p[k];
    if (v !== undefined) {
      if (typeof v !== "boolean") throw complianceError("invalid_request");
      out[col] = v;
    }
  }
  if (p.position !== undefined) {
    if (!Number.isInteger(p.position) || p.position < 0 || p.position > 1000) throw complianceError("invalid_request");
    out.position = p.position;
  }
  if (p.checklist !== undefined) {
    const c = validateChecklist(p.checklist);
    if (!c.ok) throw new ComplianceError("validation_failed", "The checklist is not valid.", 400, c.issues);
    out.checklist = c.items;
  }
  if (p.fields !== undefined) {
    if (current?.isSystem) throw new ComplianceError("invalid_request", "The fields of a standard request type cannot be changed.", 400);
    const f = validateFieldDefs(p.fields);
    if (!f.ok) throw new ComplianceError("validation_failed", "The fields are not valid.", 400, f.issues);
    out.fields = f.fields;
  }
  return out;
}

export async function updateType(admin: SupabaseClient, caller: ComplianceCaller, key: string, patch: TypePatch): Promise<RequestTypeRow> {
  if (!caller.viewer.canManage) throw complianceError("forbidden");
  const current = (await loadTypes(admin, caller.accountId)).find((t) => t.key === key) ?? null;
  if (!current) throw complianceError("not_found");
  const set = dbPatch(patch, current);
  if (Object.keys(set).length === 0) return current;
  const { data, error } = await admin.from("compliance_request_types").update(set).eq("account_id", caller.accountId).eq("key", key).select(TYPE_COLUMNS).single();
  if (error || !data) throw fromDatabase(error);
  return typeFromRow(data as unknown as TypeDbRow);
}

export interface NewType extends TypePatch {
  key: string;
  label: string;
  fields: unknown;
}

export async function createType(admin: SupabaseClient, caller: ComplianceCaller, input: NewType): Promise<RequestTypeRow> {
  if (!caller.viewer.canManage) throw complianceError("forbidden");
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(input.key)) throw new ComplianceError("validation_failed", "The key is not valid.", 400, [{ field: "key", code: "invalid" }]);
  const existing = await loadTypes(admin, caller.accountId);
  if (existing.some((t) => t.key === input.key)) throw new ComplianceError("validation_failed", "That key is already used.", 400, [{ field: "key", code: "duplicate" }]);
  const set = dbPatch({ ...input, fields: input.fields }, null);
  const { data, error } = await admin
    .from("compliance_request_types")
    .insert({ account_id: caller.accountId, key: input.key, is_system: false, position: existing.length + 1, ...set })
    .select(TYPE_COLUMNS)
    .single();
  if (error || !data) throw fromDatabase(error);
  return typeFromRow(data as unknown as TypeDbRow);
}

