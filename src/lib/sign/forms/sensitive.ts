// ============================================================
// Sensitive answers (F-47): the pure half. Which fields may be sensitive, how a value is masked (for the sender's
// screen, and when a form asks for a masked print on the PDF) and a check that a form uses the flag soundly.
// Storage (encryption) and the staff reveal are the server's (service/sensitive.ts); this module has no I/O so the
// builder, the signer's page and the server all share one definition of "masked".
// ============================================================

import type { AnswerMap, DataField, DataFieldType, FormDefinition, FormValue, FormValueView, Rule } from "./types";

/** Types whose answer is text a person typed. A choice, a picture or a file is not a secret the form owner can mask. */
export const SENSITIVE_TYPES: readonly DataFieldType[] = ["text", "multiline", "number", "email", "phone", "date", "list"];

export const PRINT_MASKS = ["last4", "none"] as const;

export const canBeSensitive = (type: DataFieldType): boolean => SENSITIVE_TYPES.includes(type);

/** Is this field's answer to be kept encrypted and masked? */
export const isSensitive = (field: Pick<DataField, "sensitive"> | null | undefined): boolean => field?.sensitive === true;

/** The mask character on a screen. The PDF's own font may lack it, so a printed mask is `PRINT_MASK_CHAR`. */
export const MASK_CHAR = "•";
export const PRINT_MASK_CHAR = "*";

/** The most characters of a value ever shown. */
export const REVEAL_LAST = 4;
/** A value must be longer than this before its last characters are shown at all. */
export const MASK_MIN_LENGTH = 8;

/**
 * A value masked: `•••• 1234` (the last four characters) when it is longer than 8 characters, otherwise only `••••`.
 * The mask never grows with the value, so its length gives nothing away. Whitespace at the ends is ignored.
 */
export function maskText(value: string, char: string = MASK_CHAR): string {
  const t = value.trim();
  if (t === "") return "";
  const hidden = char.repeat(4);
  return t.length > MASK_MIN_LENGTH ? `${hidden} ${t.slice(-REVEAL_LAST)}` : hidden;
}

/** A stored value masked the way `maskText` does: text, and each entry of a list. Anything else is returned as it is. */
export function maskValue(value: FormValue | FormValueView, char: string = MASK_CHAR): FormValueView {
  if ("text" in value) return { text: maskText(value.text, char) };
  if ("list" in value) return { list: value.list.map((x) => maskText(x, char)) };
  return value as FormValueView;
}

/**
 * What a sender, or another role's rule, may be shown for a sensitive answer: only that there is one. Other people's
 * browsers never get the value, so a mark stands in for it (it keeps "is this empty" rules working).
 */
export function presenceOnly(value: FormValue | FormValueView): FormValueView {
  if ("list" in value) return { list: value.list.map(() => MASK_CHAR) };
  if ("text" in value) return { text: MASK_CHAR };
  return value as FormValueView;
}

/** How a sensitive answer is printed: the answer as it should be drawn, or undefined when nothing is printed. */
export function printedAnswer(field: Pick<DataField, "sensitive" | "printMasked">, answer: FormValue | undefined): FormValue | undefined {
  if (!answer || !isSensitive(field) || !field.printMasked) return answer;
  if (field.printMasked === "none") return undefined;
  return maskValue(answer, PRINT_MASK_CHAR) as FormValue;
}

// ---- soundness ------------------------------------------------------------------------------------------

/** The fields a rule tests for equality with a value (those needing the answer itself, not only whether there is one). */
function comparedFields(rule: Rule | undefined): string[] {
  if (!rule) return [];
  switch (rule.op) {
    case "eq":
    case "ne":
    case "in":
      return [rule.field];
    case "and":
    case "or":
      return rule.rules.flatMap(comparedFields);
    case "not":
      return comparedFields(rule.rule);
    default:
      return [];
  }
}

/**
 * Problems with how a form uses `sensitive` and `printMasked`, as stable codes with the field they are about:
 *   bad_sensitive             a type that cannot be sensitive, a value that is not true, or a bad `printMasked`
 *   sensitive_contact_field   cannot also fill the contact (the value would be written out in plain text)
 *   sensitive_default         cannot carry a default or fixed value (it would sit in the template in plain text)
 *   sensitive_in_rule         a rule may ask whether a sensitive field is empty, never compare its value
 */
export function sensitiveProblems(form: FormDefinition): { code: string; field: string }[] {
  const out: { code: string; field: string }[] = [];
  const sensitiveKeys = sensitiveKeysOf(form);
  for (const f of form.fields) {
    const at = { field: f.key };
    if (f.sensitive !== undefined && (f.sensitive !== true || !canBeSensitive(f.type))) out.push({ code: "bad_sensitive", ...at });
    if (f.printMasked !== undefined && (!(PRINT_MASKS as readonly string[]).includes(f.printMasked as string) || f.sensitive !== true)) out.push({ code: "bad_sensitive", ...at });
    if (f.sensitive !== true) continue;
    if (f.contactField !== undefined || f.writeBack !== undefined) out.push({ code: "sensitive_contact_field", ...at });
    if ((f.defaultValue !== undefined && f.defaultValue !== "") || f.locked === true) out.push({ code: "sensitive_default", ...at });
  }
  if (sensitiveKeys.size > 0) {
    const rules: (Rule | undefined)[] = [...form.fields.flatMap((f) => [f.visibleIf, f.requiredIf]), ...form.parts.map((p) => p.visibleIf)];
    const seen = new Set<string>();
    for (const rule of rules) {
      for (const k of comparedFields(rule)) {
        if (sensitiveKeys.has(k) && !seen.has(k)) {
          seen.add(k);
          out.push({ code: "sensitive_in_rule", field: k });
        }
      }
    }
  }
  return out;
}

/** The keys a form marks sensitive. */
export const sensitiveKeysOf = (form: FormDefinition): Set<string> => new Set(form.fields.filter((f) => f.sensitive === true).map((f) => f.key));

/** `answers` with the sensitive ones reduced to their mask (`maskText`), for a screen that only shows them. */
export function maskedAnswers(form: FormDefinition, answers: AnswerMap): Record<string, FormValueView | undefined> {
  const keys = sensitiveKeysOf(form);
  const out: Record<string, FormValueView | undefined> = {};
  for (const [k, v] of Object.entries(answers)) out[k] = v && keys.has(k) ? maskValue(v) : (v as FormValueView | undefined);
  return out;
}
