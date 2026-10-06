// ============================================================
// Doc Sign form builder: problems with a form, in a form the screen can word and act on. validateForm gives
// stable codes; this maps each code to a message key, says what a code is about (so a click can select the
// field, the part or the placement), and adds the soft warnings validateForm does not raise (a rule that
// compares with a value the field does not offer, a part with nothing in it).
// Pure: no React, no I/O.
// ============================================================

import { pick } from "../forms/text";
import type { FormDefinition, Rule } from "../forms/types";
import type { PlacedField } from "../pdf/types";
import type { SignLocale, SignRole } from "../types";
import { bindingProblems } from "./form-printing";
import { isBlankCondition, isLeaf, valueChoices, type LeafRule } from "./form-rules";

/**
 * Every code validateForm (and its rule checks) can report, plus the soft warnings below. Each has a message under
 * `issues.<code>` in the builder's translations.
 */
export const FORM_ISSUE_CODES = [
  "form_shape",
  "too_many_parts",
  "too_many_data_fields",
  "bad_part_key",
  "duplicate_part_key",
  "bad_part_title",
  "bad_part_description",
  "part_unknown_role",
  "bad_data_key",
  "duplicate_data_key",
  "data_key_is_placement_key",
  "bad_data_type",
  "data_unknown_part",
  "bad_data_label",
  "bad_data_help",
  "bad_data_placeholder",
  "bad_options",
  "bad_format",
  "bad_limit",
  "bad_file_types",
  "bad_file_size",
  "bad_acknowledge_text",
  "bad_contact_field",
  "rule_shape",
  "rule_too_deep",
  "rule_unknown_field",
  "rule_value",
  "rule_too_big",
  "rule_refers_to_itself",
  "rule_cycle",
  "placement_unknown_data",
  "placement_type_mismatch",
  "placement_bound_and_fixed",
  "part_without_person",
] as const;

/** The soft warnings: the form is valid but probably not what was meant. Messages are under `warnings.<code>`. */
export const FORM_WARNING_CODES = ["part_empty", "rule_value_not_option", "rule_blank_value", "default_not_option", "placement_option_missing", "role_signer_no_signature", "static_text_does_not_fit"] as const;

export type FormWarningCode = (typeof FORM_WARNING_CODES)[number];

export function formIssueMessageKey(code: string): string {
  return (FORM_ISSUE_CODES as readonly string[]).includes(code) ? `issues.${code}` : "issues.unknown";
}

export function formWarningMessageKey(code: string): string {
  return (FORM_WARNING_CODES as readonly string[]).includes(code) ? `warnings.${code}` : "warnings.unknown";
}

/** Codes of a failed call the builder words under `errors.<code>`; any other gets `errors.generic`. */
export const BUILDER_ERROR_CODES = ["network", "signed_out", "forbidden", "rate_limited", "invalid_layout", "bad_layout", "bad_form", "template_not_found", "template_has_no_version", "changed_elsewhere", "fix_problems", "request_failed"] as const;

export function builderErrorKey(code: string): string {
  return (BUILDER_ERROR_CODES as readonly string[]).includes(code) ? `errors.${code}` : "errors.generic";
}

export type IssueTarget = { kind: "field"; field: string } | { kind: "part"; part: string } | { kind: "placement"; placement: string } | { kind: "role"; role: string } | { kind: "form" };

/** What an issue is about. A `placement_*` issue carries a placement key in `field`; any other `field` is a data field. */
export function issueTarget(issue: { code: string; field?: string; part?: string; role?: string }): IssueTarget {
  if (issue.code.startsWith("placement_") && issue.field) return { kind: "placement", placement: issue.field };
  if (issue.field) return { kind: "field", field: issue.field };
  if (issue.part) return { kind: "part", part: issue.part };
  if (issue.role) return { kind: "role", role: issue.role };
  return { kind: "form" };
}

export interface IssueContext {
  form: FormDefinition;
  roles: readonly SignRole[];
  placements: readonly PlacedField[];
  locale: SignLocale;
}

/** The names a message can use: the data field's label, the part's title, the role's label, the page of a placement. */
export function issueParams(issue: { field?: string; part?: string; role?: string; detail?: string; code: string }, ctx: IssueContext): { field: string; part: string; role: string; detail: string; page: number | ""; subject: string } {
  const target = issueTarget(issue);
  const placement = target.kind === "placement" ? ctx.placements.find((p) => p.key === target.placement) : undefined;
  const dataField = target.kind === "field" ? ctx.form.fields.find((f) => f.key === target.field) : undefined;
  const part = issue.part ? ctx.form.parts.find((p) => p.key === issue.part) : dataField ? ctx.form.parts.find((p) => p.key === dataField.part) : undefined;
  const bound = placement?.data ? ctx.form.fields.find((f) => f.key === placement.data) : undefined;
  const field = dataField ? pick(dataField.label, ctx.locale) || dataField.key : bound ? pick(bound.label, ctx.locale) || bound.key : (placement?.label ?? issue.field ?? "");
  const partTitle = part ? pick(part.title, ctx.locale) || part.key : (issue.part ?? "");
  return {
    field,
    part: partTitle,
    role: ctx.roles.find((r) => r.key === issue.role)?.label ?? issue.role ?? "",
    detail: issue.detail ?? "",
    page: placement ? placement.page + 1 : "",
    // what the problem is about, for a message that fits a field or a part
    subject: target.kind === "field" || target.kind === "placement" ? field : partTitle,
  };
}

export interface FormWarning {
  /** One of FORM_WARNING_CODES (any other code is worded generically). */
  code: string;
  field?: string;
  part?: string;
  placement?: string;
  role?: string;
  detail?: string;
}

function leaves(rule: Rule | undefined): LeafRule[] {
  if (!rule) return [];
  if (rule.op === "and" || rule.op === "or") return rule.rules.flatMap(leaves);
  if (rule.op === "not") return leaves(rule.rule);
  return isLeaf(rule) ? [rule] : [];
}

/** Things that are allowed but probably a slip. */
export function formWarnings(form: FormDefinition, placements: readonly PlacedField[]): FormWarning[] {
  const out: FormWarning[] = [];
  for (const p of form.parts) {
    if (!form.fields.some((f) => f.part === p.key)) out.push({ code: "part_empty", part: p.key });
  }
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  const checkRule = (rule: Rule | undefined, owner: { field?: string; part?: string }) => {
    for (const leaf of leaves(rule)) {
      if (isBlankCondition(leaf)) {
        out.push({ code: "rule_blank_value", ...owner });
        continue;
      }
      const choices = valueChoices(byKey.get(leaf.field));
      if (!choices) continue;
      const values = leaf.op === "eq" || leaf.op === "ne" ? [leaf.value] : leaf.op === "in" ? leaf.values : [];
      const stale = values.find((v) => !choices.some((c) => c.value === v));
      if (stale !== undefined) out.push({ code: "rule_value_not_option", ...owner, detail: stale });
    }
  };
  for (const f of form.fields) {
    checkRule(f.visibleIf, { field: f.key });
    checkRule(f.requiredIf, { field: f.key });
    if (f.type === "choice" && f.defaultValue && !(f.options ?? []).some((o) => o.value === f.defaultValue)) out.push({ code: "default_not_option", field: f.key, detail: f.defaultValue });
  }
  for (const p of form.parts) checkRule(p.visibleIf, { part: p.key });
  for (const b of bindingProblems(form, placements)) {
    if (b.code === "placement_option_missing") out.push({ code: "placement_option_missing", placement: b.placement, field: b.field });
  }
  return out;
}

/** Soft warnings that concern roles: a signer who holds parts but has nothing to sign. Fillers never sign, so they are never named. */
export function roleWarnings(form: FormDefinition, roles: readonly SignRole[], placements: readonly PlacedField[]): { code: "role_signer_no_signature"; role: string }[] {
  const out: { code: "role_signer_no_signature"; role: string }[] = [];
  for (const r of roles) {
    if (r.kind !== "signer") continue;
    if (!form.parts.some((p) => p.role === r.key)) continue;
    if (!placements.some((p) => p.role === r.key && (p.type === "signature" || p.type === "initials"))) out.push({ code: "role_signer_no_signature", role: r.key });
  }
  return out;
}
