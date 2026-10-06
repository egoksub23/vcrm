// ============================================================
// Is a form definition sound? Run by the builder as someone edits (so a problem shows at once) and by the
// server before a template version or a document is saved or sent. Codes are stable; `field`, `part` and
// `role` say where. Nothing here throws.
// ============================================================

import type { PlacedField } from "../pdf/types";
import { MAX_ITEM_LABEL, MAX_LIST_ITEMS } from "../lists/types";
import { SENDER_ROLE, type Issue } from "../rules";
import type { SignRole } from "../types";
import { listProblems, takesOptions, type ListProblemOptions } from "./lists";
import { dependencyCycle, ruleProblems } from "./rules";
import { sensitiveProblems } from "./sensitive";
import { CONTACT_FIELDS, DATA_FIELD_TYPES, FILE_KINDS, MAX_DATA_FIELDS, MAX_FILES_PER_FIELD, MAX_OPTIONS, MAX_PARTS, MAX_UPLOAD_MB, TEXT_FORMATS, type DataField, type FormDefinition, type L10n } from "./types";

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const OPTION_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,59}$/;

const l10nOk = (t: unknown, max = 300): boolean => typeof t === "object" && t !== null && typeof (t as L10n).en === "string" && (t as L10n).en.trim().length > 0 && Object.values(t as Record<string, unknown>).every((v) => typeof v === "string" && v.length <= max);

/** Placement types a data field of each type may be printed in. */
export function placementTypesFor(type: DataField["type"]): readonly PlacedField["type"][] {
  switch (type) {
    case "text":
    case "multiline":
    case "email":
    case "phone":
    case "choice":
    case "multichoice":
    case "list":
      return ["text", "dropdown", "checkbox"];
    case "number":
      return ["number", "text"];
    case "date":
      return ["date", "text"];
    case "yesno":
    case "acknowledge":
      return ["checkbox", "text"];
    case "image":
      return ["upload"];
    case "file":
      return [];
    default:
      return [];
  }
}

export function isFormDefinition(v: unknown): v is FormDefinition {
  if (typeof v !== "object" || v === null) return false;
  const f = v as FormDefinition;
  return f.version === 1 && Array.isArray(f.parts) && Array.isArray(f.fields);
}

/**
 * Problems with a form and the placements that print it. `placements` are the document's placed fields
 * (to check each `data` binding); `roles` are the template's roles. `lists` says which shared option lists exist (so a reference to
 * a missing one is a problem) and whether the form is as authored (a field then names a list or carries options, never both).
 */
export function validateForm(form: FormDefinition, roles: readonly SignRole[], placements: readonly PlacedField[] = [], lists: ListProblemOptions = {}): Issue[] {
  const issues: Issue[] = [];
  if (!isFormDefinition(form)) return [{ code: "form_shape" }];
  if (form.parts.length > MAX_PARTS) issues.push({ code: "too_many_parts", detail: String(MAX_PARTS) });
  if (form.fields.length > MAX_DATA_FIELDS) issues.push({ code: "too_many_data_fields", detail: String(MAX_DATA_FIELDS) });

  const roleKeys = new Set(roles.map((r) => r.key));
  const partKeys = new Set<string>();
  for (const p of form.parts) {
    const at = { part: p.key };
    if (!KEY_RE.test(p.key)) issues.push({ code: "bad_part_key", ...at });
    if (partKeys.has(p.key)) issues.push({ code: "duplicate_part_key", ...at });
    partKeys.add(p.key);
    if (!l10nOk(p.title, 120)) issues.push({ code: "bad_part_title", ...at });
    if (p.description !== undefined && !l10nOk(p.description, 600)) issues.push({ code: "bad_part_description", ...at });
    if (!roleKeys.has(p.role) || p.role === SENDER_ROLE) issues.push({ code: "part_unknown_role", ...at, role: p.role });
  }

  const placementKeys = new Set(placements.map((p) => p.key));
  const dataKeys = new Set<string>();
  for (const f of form.fields) {
    const at = { field: f.key };
    if (!KEY_RE.test(f.key)) issues.push({ code: "bad_data_key", ...at });
    if (dataKeys.has(f.key)) issues.push({ code: "duplicate_data_key", ...at });
    dataKeys.add(f.key);
    if (placementKeys.has(f.key)) issues.push({ code: "data_key_is_placement_key", ...at });
  }

  for (const f of form.fields) {
    const at = { field: f.key };
    if (!DATA_FIELD_TYPES.includes(f.type)) {
      issues.push({ code: "bad_data_type", ...at });
      continue;
    }
    if (!partKeys.has(f.part)) issues.push({ code: "data_unknown_part", ...at, part: f.part });
    if (!l10nOk(f.label, 200)) issues.push({ code: "bad_data_label", ...at });
    if (f.help !== undefined && !l10nOk(f.help, 600)) issues.push({ code: "bad_data_help", ...at });
    if (f.placeholder !== undefined && !l10nOk(f.placeholder, 120)) issues.push({ code: "bad_data_placeholder", ...at });

    if (takesOptions(f.type)) {
      const o = f.options ?? [];
      // a field that names a shared list gets its options from it (a form not yet resolved has none); a list
      // field without options is free text. What a list put in is as sound as an inline option, with room for a long list.
      const fromList = f.optionList !== undefined;
      const cap = fromList ? MAX_LIST_ITEMS : MAX_OPTIONS;
      const optional = fromList ? o.length === 0 : f.type === "list";
      const labelMax = fromList ? MAX_ITEM_LABEL : 120;
      if (!(optional && o.length === 0) && (o.length === 0 || o.length > cap || o.some((x) => !OPTION_RE.test(x.value) || !l10nOk(x.label, labelMax)) || new Set(o.map((x) => x.value)).size !== o.length)) {
        issues.push({ code: "bad_options", ...at });
      }
    }
    if (f.format !== undefined && !TEXT_FORMATS.includes(f.format)) issues.push({ code: "bad_format", ...at });
    if (f.itemFormat !== undefined && !TEXT_FORMATS.includes(f.itemFormat)) issues.push({ code: "bad_format", ...at });
    for (const n of [f.minLength, f.maxLength, f.itemLength, f.itemMinLength, f.maxItems, f.minItems, f.decimals]) {
      if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 5000)) issues.push({ code: "bad_limit", ...at });
    }
    if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) issues.push({ code: "bad_limit", ...at });
    if (f.itemMinLength !== undefined && f.itemLength !== undefined && f.itemMinLength > f.itemLength) issues.push({ code: "bad_limit", ...at });
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) issues.push({ code: "bad_limit", ...at });
    if (f.decimals !== undefined && f.decimals > 6) issues.push({ code: "bad_limit", ...at });
    if (f.type === "file") {
      if (!f.accept || f.accept.length === 0 || f.accept.some((k) => !FILE_KINDS.includes(k))) issues.push({ code: "bad_file_types", ...at });
      if (f.maxMb !== undefined && (!(f.maxMb > 0) || f.maxMb > MAX_UPLOAD_MB)) issues.push({ code: "bad_file_size", ...at, detail: String(MAX_UPLOAD_MB) });
      if (f.maxFiles !== undefined && (!Number.isInteger(f.maxFiles) || f.maxFiles < 1 || f.maxFiles > MAX_FILES_PER_FIELD)) issues.push({ code: "bad_limit", ...at });
      if (f.minFiles !== undefined && (!Number.isInteger(f.minFiles) || f.minFiles < 0 || f.minFiles > (f.maxFiles ?? 1))) issues.push({ code: "bad_limit", ...at });
    }
    if (f.type === "acknowledge" && !l10nOk(f.text, 8000)) issues.push({ code: "bad_acknowledge_text", ...at });
    if (f.contactField !== undefined && !(CONTACT_FIELDS as readonly string[]).includes(f.contactField) && !/^custom:[\p{L}\p{N} _.\-]{1,60}$/u.test(f.contactField)) {
      issues.push({ code: "bad_contact_field", ...at });
    }
    if (f.contactField !== undefined && (f.type === "file" || f.type === "image" || f.type === "list" || f.type === "multichoice")) issues.push({ code: "bad_contact_field", ...at });
    if (f.writeBack !== undefined && f.writeBack !== "always" && f.writeBack !== "if_empty") issues.push({ code: "bad_contact_field", ...at });
    for (const [which, rule] of [["visibleIf", f.visibleIf], ["requiredIf", f.requiredIf]] as const) {
      if (rule === undefined) continue;
      for (const c of ruleProblems(rule, dataKeys)) issues.push({ code: c, ...at, detail: which });
    }
    if (f.visibleIf && JSON.stringify(f.visibleIf).includes(`"${f.key}"`)) issues.push({ code: "rule_refers_to_itself", ...at });
  }
  for (const p of form.parts) {
    if (p.visibleIf === undefined) continue;
    for (const c of ruleProblems(p.visibleIf, dataKeys)) issues.push({ code: c, part: p.key, detail: "visibleIf" });
  }
  const cycle = dependencyCycle(form);
  if (cycle) issues.push({ code: "rule_cycle", field: cycle });
  issues.push(...listProblems(form, lists));
  issues.push(...sensitiveProblems(form));

  // the placements that print data
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  for (const p of placements) {
    if (p.data === undefined) continue;
    const at = { field: p.key };
    const target = byKey.get(p.data);
    if (!target) {
      issues.push({ code: "placement_unknown_data", ...at, detail: p.data });
      continue;
    }
    if (!placementTypesFor(target.type).includes(p.type)) issues.push({ code: "placement_type_mismatch", ...at, detail: p.data });
    if (p.merge !== undefined || p.type === "static_text") issues.push({ code: "placement_bound_and_fixed", ...at });
    if (p.dataValue !== undefined && (p.type !== "checkbox" || (target.type !== "choice" && target.type !== "multichoice"))) issues.push({ code: "placement_type_mismatch", ...at, detail: p.data });
  }
  return issues;
}

/** Problems that stop a form being sent: a part whose role has nobody to complete it. */
export function formSendProblems(form: FormDefinition, signers: readonly { role_key: string }[]): Issue[] {
  const withPeople = new Set(signers.map((s) => s.role_key));
  const issues: Issue[] = [];
  for (const p of form.parts) {
    if (!withPeople.has(p.role)) issues.push({ code: "part_without_person", part: p.key, role: p.role });
  }
  return issues;
}
