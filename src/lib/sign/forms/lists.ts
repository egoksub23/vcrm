// ============================================================
// Option lists in a form: a data field may name a shared list (`optionList: "states_my"`) instead of carrying its own
// options. This file is the whole of what that means, pure and shared by the browser (the builder's picker and preview)
// and the server (the only place a list is ever read):
//
//   resolveFormLists   copy the lists' items into `options`, keeping `optionList` as a note of where they came from
//   stripListOptions   the opposite, for what the builder posts: the key only, so a large list is not sent back and forth
//   listProblems       is every list reference sound
//
// A form is FROZEN into a document, so resolution happens when a template version is saved, when a draft is made from
// a template and when a document is sent: from then on the document carries its own `options`, and the signer's page,
// `checkDataAnswer` and `displayValue` read only those. A later edit of the list changes nothing already made.
// ============================================================

import type { Issue } from "../rules";
import { LIST_KEY_RE, MAX_LIST_ITEMS, type ListCatalogue, type ListItem } from "../lists/types";
import type { DataField, DataFieldType, FieldOption, FormDefinition } from "./types";

/** The data field types that take options, whether typed in or from a list. */
export const OPTION_FIELD_TYPES: readonly DataFieldType[] = ["choice", "multichoice", "list"];
export const takesOptions = (type: DataFieldType): boolean => OPTION_FIELD_TYPES.includes(type);

/** The options a list gives a form: its items that are not archived, each as a value and a label (nothing else is frozen into the form). */
export function listOptions(items: readonly ListItem[]): FieldOption[] {
  return items.filter((i) => !i.archived).map((i) => ({ value: i.value, label: i.label }));
}

/** The list keys a form names, each once, in the order they are first used. */
export function referencedLists(form: FormDefinition): string[] {
  const keys: string[] = [];
  for (const f of form.fields) if (typeof f.optionList === "string" && !keys.includes(f.optionList)) keys.push(f.optionList);
  return keys;
}

export interface ListProblemOptions {
  /** The keys of the lists that exist. When given, a reference to any other is a problem. */
  known?: ReadonlySet<string>;
  /**
   * The form is what a person authored (the builder's saved state, an API body): a field then has `optionList` OR
   * `options`, never both. A resolved form (a template version, a document) legitimately has both.
   */
  authored?: boolean;
}

/** Problems with the list references of a form. Codes: bad_list_key, list_wrong_type, unknown_list, list_and_options. */
export function listProblems(form: FormDefinition, opts: ListProblemOptions = {}): Issue[] {
  const issues: Issue[] = [];
  for (const f of form.fields) {
    if (f.optionList === undefined) continue;
    const at = { field: f.key };
    if (typeof f.optionList !== "string" || !LIST_KEY_RE.test(f.optionList)) {
      issues.push({ code: "bad_list_key", ...at });
      continue;
    }
    if (!takesOptions(f.type)) issues.push({ code: "list_wrong_type", ...at });
    if (opts.known && !opts.known.has(f.optionList)) issues.push({ code: "unknown_list", ...at, detail: f.optionList });
    if (opts.authored && (f.options?.length ?? 0) > 0) issues.push({ code: "list_and_options", ...at });
  }
  return issues;
}

export interface Resolved {
  form: FormDefinition;
  problems: Issue[];
}

/**
 * Copy the items of every list a field names into its `options`. `strict` (saving a template) reports a list that is
 * missing or empty; lenient (making or sending a document from a form that already carries its options) leaves such a
 * field exactly as it is, so a list that has gone can never stop a document that was prepared with it.
 * Whatever `options` a field already had is replaced by the list's: the list is the source for a field that names one.
 */
export function resolveFormLists(form: FormDefinition, lists: ListCatalogue, opts: { strict: boolean } = { strict: true }): Resolved {
  const problems: Issue[] = [];
  let changed = false;
  const fields = form.fields.map((f): DataField => {
    if (f.optionList === undefined) return f;
    const at = { field: f.key };
    if (typeof f.optionList !== "string" || !LIST_KEY_RE.test(f.optionList)) {
      if (opts.strict) problems.push({ code: "bad_list_key", ...at });
      return f;
    }
    if (!takesOptions(f.type)) {
      if (opts.strict) problems.push({ code: "list_wrong_type", ...at });
      return f;
    }
    const list = lists.get(f.optionList);
    if (!list) {
      if (opts.strict) problems.push({ code: "unknown_list", ...at, detail: f.optionList });
      return f;
    }
    const options = listOptions(list.items);
    if (options.length === 0 || options.length > MAX_LIST_ITEMS) {
      if (opts.strict) problems.push({ code: "list_empty", ...at, detail: f.optionList });
      return f;
    }
    changed = true;
    return { ...f, options };
  });
  return { form: changed ? { ...form, fields } : form, problems };
}

/** The form with the options of every list-bound field removed (the key stays). What the builder posts. */
export function stripListOptions(form: FormDefinition): FormDefinition {
  if (!form.fields.some((f) => f.optionList !== undefined && f.options !== undefined)) return form;
  return {
    ...form,
    fields: form.fields.map((f) => {
      if (f.optionList === undefined || f.options === undefined) return f;
      const { options: _options, ...rest } = f;
      void _options;
      return rest;
    }),
  };
}

/** Do two option lists say the same thing (values, in order, and every label)? */
export function sameOptions(a: readonly FieldOption[] | undefined, b: readonly FieldOption[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
