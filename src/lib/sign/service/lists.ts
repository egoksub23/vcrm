// ============================================================
// Option lists, server side (migration 163). Two jobs:
//
//   1. For forms: copy a list's items into the form that names it (resolveFormForSave when a template version is saved,
//      refreshFormLists when a document is made from a template or is about to be sent). `forms/lists.ts` does the copying;
//      this file reads the lists. A document keeps what it was sent with, whatever happens to the list afterwards.
//   2. For Settings > Doc Sign > Lists: read, make, change, import, export and reset lists.
//
// Every read and write is scoped to ctx.accountId. A list is never deleted (archived instead); a system list's values
// never go (the database refuses too, see sign_option_lists_guard).
// ============================================================

import { listProblems, referencedLists, resolveFormLists, sameOptions, type FormDefinition } from "../forms";
import { exportCsv, mergeImported, parseListCsv } from "../lists/csv";
import { isSystemListKey, SYSTEM_LIST_KEYS } from "../lists/keys";
import { cleanItems, itemProblems, listKeyFromName, metaProblems, removedValues, resetToDefault, sameItems } from "../lists/logic";
import { catalogueOf, LIST_KEY_RE, MAX_LIST_ITEMS, summaryOf, type ImportResult, type ListCatalogue, type ListItem, type ListUse, type OptionListRow, type OptionListSummary } from "../lists/types";
import type { Issue } from "../rules";
import type { SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

/** The largest import file accepted (text of a CSV, in characters). */
export const MAX_IMPORT_CHARS = 2_000_000;

// ---- reading -------------------------------------------------------------------------------------------------------------------

/** Make sure the workspace has the shipped lists. Never throws: a failure here must not stop a screen that can still work with what exists. */
export async function ensureSystemLists(ctx: SignCtx): Promise<void> {
  try {
    const r = await ctx.admin.rpc("sign_seed_option_lists", { p_account: ctx.accountId });
    if (r.error) console.error("[sign] could not seed the option lists:", r.error.message);
  } catch (err) {
    console.error("[sign] could not seed the option lists:", err instanceof Error ? err.message : err);
  }
}

async function rowsByKeys(ctx: SignCtx, keys: readonly string[]): Promise<OptionListRow[]> {
  const { data, error } = await ctx.admin.from("sign_option_lists").select("*").eq("account_id", ctx.accountId).in("key", [...keys]);
  if (error) raiseDatabaseError(error, "load option lists");
  return (data ?? []) as OptionListRow[];
}

/** The named lists, by key. A shipped list the workspace does not have yet is copied in first. */
export async function loadCatalogue(ctx: SignCtx, keys: readonly string[]): Promise<ListCatalogue> {
  if (keys.length === 0) return new Map();
  let rows = await rowsByKeys(ctx, keys);
  if (keys.some((k) => isSystemListKey(k) && !rows.some((r) => r.key === k))) {
    await ensureSystemLists(ctx);
    rows = await rowsByKeys(ctx, keys);
  }
  return catalogueOf(rows);
}

const problemsError = (message: string, issues: Issue[]) => new SignError("invalid_layout", message, 400, issues);

/**
 * The form as it is stored with a template version: every list a field names is copied into the field's `options`. A form that names no
 * list is returned as it is. A list that is missing or empty is an error (the form cannot be saved without it).
 */
export async function resolveFormForSave(ctx: SignCtx, form: FormDefinition): Promise<FormDefinition> {
  const keys = referencedLists(form);
  if (keys.length === 0) {
    // a malformed reference is reported even though nothing can be resolved
    const bad = listProblems(form);
    if (bad.length) throw problemsError("The fields on this template are not valid.", bad);
    return form;
  }
  const { form: resolved, problems } = resolveFormLists(form, await loadCatalogue(ctx, keys), { strict: true });
  if (problems.length) throw problemsError("The fields on this template are not valid.", problems);
  return resolved;
}

/**
 * The form of a document about to be made or sent, with the lists it names read again, so a document gets today's list. A list that
 * has gone leaves its field exactly as it was: what a document was prepared with can never stop it being sent.
 */
export async function refreshFormLists(ctx: SignCtx, form: FormDefinition): Promise<FormDefinition> {
  const keys = referencedLists(form);
  if (keys.length === 0) return form;
  return resolveFormLists(form, await loadCatalogue(ctx, keys), { strict: false }).form;
}

/** Do the options of every list-bound field match the lists as they are now? (For the builder's "this form uses an older copy" hint.) */
export async function listsAreCurrent(ctx: SignCtx, form: FormDefinition): Promise<boolean> {
  const keys = referencedLists(form);
  if (keys.length === 0) return true;
  const fresh = resolveFormLists(form, await loadCatalogue(ctx, keys), { strict: false }).form;
  return form.fields.every((f, i) => f.optionList === undefined || sameOptions(f.options, fresh.fields[i].options));
}

// ---- Settings: the screen's reads -------------------------------------------------------------------------------------------

export async function listAll(ctx: SignCtx): Promise<OptionListSummary[]> {
  await ensureSystemLists(ctx);
  const { data, error } = await ctx.admin.from("sign_option_lists").select("*").eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "list option lists");
  return ((data ?? []) as OptionListRow[])
    .map((r) => ({ ...summaryOf({ ...r, items: r.items ?? [] }), itemCount: r.item_count ?? (r.items ?? []).filter((i) => !i.archived).length }))
    .sort((a, b) => Number(b.is_system) - Number(a.is_system) || SYSTEM_ORDER(a.key) - SYSTEM_ORDER(b.key) || a.name.localeCompare(b.name));
}

const SYSTEM_ORDER = (key: string): number => {
  const i = (SYSTEM_LIST_KEYS as readonly string[]).indexOf(key);
  return i < 0 ? 999 : i;
};

async function loadList(ctx: SignCtx, key: string): Promise<OptionListRow> {
  if (!LIST_KEY_RE.test(key)) throw new SignError("list_not_found", "That list was not found.", 404);
  let row = (await rowsByKeys(ctx, [key]))[0];
  if (!row && isSystemListKey(key)) {
    await ensureSystemLists(ctx);
    row = (await rowsByKeys(ctx, [key]))[0];
  }
  if (!row) throw new SignError("list_not_found", "That list was not found.", 404);
  return row;
}

/** The templates whose current version names the list. */
async function usedBy(ctx: SignCtx, key: string): Promise<ListUse[]> {
  const t = await ctx.admin.from("sign_templates").select("id, name, status, current_version_id").eq("account_id", ctx.accountId);
  if (t.error) raiseDatabaseError(t.error, "load templates");
  const templates = ((t.data ?? []) as { id: string; name: string; status: ListUse["status"]; current_version_id: string | null }[]).filter((x) => x.current_version_id);
  if (templates.length === 0) return [];
  const v = await ctx.admin.from("sign_template_versions").select("id, form").eq("account_id", ctx.accountId).in("id", templates.map((x) => x.current_version_id as string));
  if (v.error) raiseDatabaseError(v.error, "load template versions");
  const using = new Set(((v.data ?? []) as { id: string; form: FormDefinition | null }[]).filter((x) => x.form && referencedLists(x.form).includes(key)).map((x) => x.id));
  return templates.filter((x) => using.has(x.current_version_id as string)).map((x) => ({ id: x.id, name: x.name, status: x.status }));
}

export async function getList(ctx: SignCtx, key: string): Promise<{ list: OptionListRow; usedBy: ListUse[] }> {
  const list = await loadList(ctx, key);
  return { list, usedBy: await usedBy(ctx, key) };
}

// ---- Settings: writes -----------------------------------------------------------------------------------------------------------

async function write(ctx: SignCtx, row: OptionListRow, patch: Record<string, unknown>): Promise<OptionListRow> {
  const { data, error } = await ctx.admin
    .from("sign_option_lists")
    .update({ ...patch, updated_by: ctx.userId })
    .eq("id", row.id)
    .eq("account_id", ctx.accountId)
    .select("*")
    .single();
  if (error || !data) {
    if (/system_values_cannot_be_deleted/.test(error?.message ?? "")) throw new SignError("list_values_locked", "A list that comes with Doc Sign keeps every value it has.", 409);
    if (/duplicate_values/.test(error?.message ?? "")) throw new SignError("duplicate_value", "Two items have the same value.", 400);
    if (/item_is_not_valid|msic_code_is_not_valid|items_must_be_an_array/.test(error?.message ?? "")) throw new SignError("bad_items", "An item of the list is not valid.", 400);
    raiseDatabaseError(error, "update option list");
  }
  return data as OptionListRow;
}

export interface NewList {
  name: string;
  description?: string | null;
  items?: ListItem[];
}

/** A list of the workspace's own (kind `options`). Its key is made from its name and never changes. */
export async function createList(ctx: SignCtx, input: NewList): Promise<OptionListRow> {
  const issues: Issue[] = [...metaProblems({ name: input.name, description: input.description })];
  if (typeof input.name !== "string" || input.name.trim() === "") issues.push({ code: "bad_name" });
  const items = input.items ?? [];
  issues.push(...itemProblems(items, "options"));
  if (issues.length) throw new SignError("bad_list", "That list is not valid.", 400, issues);
  const taken = await ctx.admin.from("sign_option_lists").select("key").eq("account_id", ctx.accountId);
  if (taken.error) raiseDatabaseError(taken.error, "load list keys");
  const keys = new Set([...SYSTEM_LIST_KEYS, ...((taken.data ?? []) as { key: string }[]).map((r) => r.key)]);
  const key = listKeyFromName(input.name, keys);
  const { data, error } = await ctx.admin
    .from("sign_option_lists")
    .insert({
      account_id: ctx.accountId,
      key,
      name: input.name.trim(),
      description: input.description?.trim() ? input.description.trim() : null,
      kind: "options",
      items: cleanItems(items),
      is_system: false,
      updated_by: ctx.userId,
    })
    .select("*")
    .single();
  if (error || !data) raiseDatabaseError(error, "create option list");
  return data as OptionListRow;
}

export interface ListPatch {
  name?: string;
  description?: string | null;
  archived?: boolean;
  items?: ListItem[];
}

export async function updateList(ctx: SignCtx, key: string, patch: ListPatch): Promise<OptionListRow> {
  const row = await loadList(ctx, key);
  const issues: Issue[] = [...metaProblems({ name: patch.name, description: patch.description })];
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.description !== undefined) update.description = patch.description?.trim() ? patch.description.trim() : null;
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== "boolean") issues.push({ code: "bad_archived" });
    else update.archived = patch.archived;
  }
  if (patch.items !== undefined) {
    issues.push(...itemProblems(patch.items, row.kind));
    if (issues.length === 0) {
      const items = cleanItems(patch.items);
      const gone = row.is_system ? removedValues(row.items, items) : [];
      if (gone.length) throw new SignError("list_values_locked", "A list that comes with Doc Sign keeps every value it has.", 409, gone.slice(0, 20).map((v) => ({ code: "value_removed", field: v })));
      if (items.length > MAX_LIST_ITEMS) issues.push({ code: "too_many_items", detail: String(MAX_LIST_ITEMS) });
      update.items = items;
    }
  }
  if (issues.length) throw new SignError("bad_list", "That list is not valid.", 400, issues);
  if (Object.keys(update).length === 0) return row;
  return write(ctx, row, update);
}

export interface ImportInput {
  csv: string;
  mode: "merge" | "replace";
  /** Only work out what would change. */
  dryRun?: boolean;
}

/** Load a CSV into a list: new items are added, items already there are updated (merge), or the list becomes the file (replace; custom lists only). */
export async function importIntoList(ctx: SignCtx, key: string, input: ImportInput): Promise<ImportResult> {
  if (typeof input.csv !== "string") throw new SignError("bad_import", "Choose a CSV file to import.", 400);
  if (input.csv.length > MAX_IMPORT_CHARS) throw new SignError("body_too_large", "That file is too large to import.", 413);
  if (input.mode !== "merge" && input.mode !== "replace") throw new SignError("bad_import", "Choose how to import the file.", 400);
  const row = await loadList(ctx, key);
  if (row.is_system && input.mode === "replace") throw new SignError("system_list_merge_only", "A list that comes with Doc Sign can only be added to or updated, never replaced.", 409);

  const parsed = parseListCsv(input.csv, row.kind);
  if (parsed.items.length === 0) {
    throw new SignError("import_failed", "Nothing in this file could be imported.", 400, parsed.problems.map((p) => ({ code: p.code, field: String(p.row), ...(p.detail ? { detail: p.detail } : {}) })));
  }
  const merged = mergeImported(row.items, parsed, input.mode);
  if (merged.items.length > MAX_LIST_ITEMS) throw new SignError("too_many_items", `A list holds up to ${MAX_LIST_ITEMS} items.`, 400);
  const result: ImportResult = { dryRun: !!input.dryRun, added: merged.added, updated: merged.updated, unchanged: merged.unchanged, removed: merged.removed, problems: parsed.problems };
  if (input.dryRun || sameItems(merged.items, row.items)) return result;
  result.list = await write(ctx, row, { items: cleanItems(merged.items) });
  return result;
}

export async function exportList(ctx: SignCtx, key: string): Promise<{ filename: string; csv: string }> {
  const row = await loadList(ctx, key);
  return { filename: `${row.key}.csv`, csv: exportCsv(row.items) };
}

/** Put a list that comes with Doc Sign back to the wording it shipped with. What the workspace added is kept after it. */
export async function resetList(ctx: SignCtx, key: string): Promise<OptionListRow> {
  const row = await loadList(ctx, key);
  if (!row.is_system) throw new SignError("not_a_system_list", "Only a list that comes with Doc Sign can be reset.", 409);
  // loaded here, not at the top of the file: the shipped content is large and only this one call needs it
  const { SYSTEM_LISTS } = await import("../lists/system-lists");
  const shipped = SYSTEM_LISTS.find((l) => l.key === key);
  if (!shipped) throw new SignError("not_a_system_list", "Only a list that comes with Doc Sign can be reset.", 409);
  const items = resetToDefault(row.items, shipped.items);
  if (sameItems(items, row.items)) return row;
  return write(ctx, row, { items });
}
