// ============================================================
// Templates: a document prepared once (its file, fields, roles and defaults) and used many times. A
// version is immutable; saving the editor adds a new one and makes it current, so a document already
// sent from an older version keeps exactly what its signers were shown. A different set of terms (a
// merchant group, say) is simply another template: "Duplicate" makes it in one step.
// ============================================================

import { randomUUID } from "node:crypto";

import type { ConvertOptions } from "../convert";
import { cleanReminderDays } from "../defaults";
import type { PlacedField } from "../pdf/types";
import { validateFields, validateRoles, type Issue } from "../rules";
import { copyFile, getFile, putFile, removeFiles, safeFileName, templatePath } from "../storage";
import type { SignDocumentRow, SignRole, SignTemplateVersionRow, TemplateDefaults } from "../types";
import { SIGN_LOCALES } from "../types";
import { loadDocument, type SignCtx } from "./context";
import { prepareOrThrow } from "./drafts";
import { SignError, raiseDatabaseError } from "./errors";

export interface TemplateRow {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  status: "draft" | "active" | "archived";
  current_version_id: string | null;
  tags: string[];
  addon_key: string | null;
  addon_version: string | null;
  customised: boolean;
}

const stripExt = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();

/** Defaults a template may carry, cleaned. */
export function cleanDefaults(d: TemplateDefaults | undefined): TemplateDefaults {
  const out: TemplateDefaults = {};
  if (!d) return out;
  if (Number.isInteger(d.expiry_days) && d.expiry_days! >= 1 && d.expiry_days! <= 365) out.expiry_days = d.expiry_days;
  if (d.reminder_days) out.reminder_days = cleanReminderDays(d.reminder_days);
  if (typeof d.sign_in_order === "boolean") out.sign_in_order = d.sign_in_order;
  if (typeof d.code_required === "boolean") out.code_required = d.code_required;
  if (d.locale && SIGN_LOCALES.includes(d.locale)) out.locale = d.locale;
  if (typeof d.subject === "string" && d.subject.trim()) out.subject = d.subject.trim().slice(0, 200);
  if (typeof d.message === "string" && d.message.trim()) out.message = d.message.trim().slice(0, 2000);
  return out;
}

async function loadTemplate(ctx: SignCtx, id: string): Promise<TemplateRow> {
  const { data, error } = await ctx.admin.from("sign_templates").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
  if (error) raiseDatabaseError(error, "load template");
  if (!data) throw new SignError("template_not_found", "That template was not found.", 404);
  return data as TemplateRow;
}

async function loadVersion(ctx: SignCtx, id: string | null): Promise<SignTemplateVersionRow> {
  if (!id) throw new SignError("template_has_no_version", "This template has no saved version yet.", 409);
  const { data, error } = await ctx.admin.from("sign_template_versions").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
  if (error || !data) raiseDatabaseError(error, "load template version");
  return data as SignTemplateVersionRow;
}

async function assertCategoryId(ctx: SignCtx, categoryId: string | null | undefined): Promise<string | null> {
  if (!categoryId) return null;
  const { data, error } = await ctx.admin.from("sign_categories").select("id").eq("id", categoryId).eq("account_id", ctx.accountId).eq("archived", false).maybeSingle();
  if (error) raiseDatabaseError(error, "load category");
  if (!data) throw new SignError("category_not_found", "That category was not found.", 400);
  return categoryId;
}

function checkName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 160) throw new SignError("bad_name", "Give the template a name of up to 160 characters.", 400);
  return n;
}

function checkLayout(fields: PlacedField[], roles: SignRole[], pageCount: number): void {
  const issues: Issue[] = [...validateRoles(roles), ...validateFields(fields, roles, pageCount)];
  if (issues.length) throw new SignError("invalid_layout", "The fields on this template are not valid.", 400, issues);
}

async function insertTemplateWithVersion(
  ctx: SignCtx,
  args: { id: string; name: string; description?: string | null; categoryId: string | null; tags?: string[]; sourcePath: string; sourceSha: string; originalPath: string | null; originalType: string | null; pageCount: number; fields: PlacedField[]; roles: SignRole[]; defaults: TemplateDefaults; addon?: { key: string; version: string } },
  paths: string[],
): Promise<{ template: TemplateRow; version: SignTemplateVersionRow }> {
  const t = await ctx.admin
    .from("sign_templates")
    .insert({
      id: args.id,
      account_id: ctx.accountId,
      name: args.name,
      description: args.description ?? null,
      category_id: args.categoryId,
      status: "draft",
      tags: args.tags ?? [],
      addon_key: args.addon?.key ?? null,
      addon_version: args.addon?.version ?? null,
      created_by: ctx.userId,
    })
    .select("*")
    .single();
  if (t.error || !t.data) {
    await removeFiles(ctx.admin, paths);
    raiseDatabaseError(t.error, "insert template");
  }
  const v = await ctx.admin
    .from("sign_template_versions")
    .insert({
      account_id: ctx.accountId,
      template_id: args.id,
      version_no: 1,
      source_path: args.sourcePath,
      source_sha256: args.sourceSha,
      original_path: args.originalPath,
      original_type: args.originalType,
      page_count: args.pageCount,
      fields: args.fields,
      roles: args.roles,
      defaults: args.defaults,
      created_by: ctx.userId,
    })
    .select("*")
    .single();
  if (v.error || !v.data) {
    await ctx.admin.from("sign_templates").delete().eq("id", args.id).eq("account_id", ctx.accountId);
    await removeFiles(ctx.admin, paths);
    raiseDatabaseError(v.error, "insert template version");
  }
  const version = v.data as SignTemplateVersionRow;
  const u = await ctx.admin.from("sign_templates").update({ current_version_id: version.id }).eq("id", args.id).eq("account_id", ctx.accountId).select("*").single();
  if (u.error || !u.data) raiseDatabaseError(u.error, "set current version");
  return { template: u.data as TemplateRow, version };
}

/** A new template from an uploaded file (PDF, Word or image), with no fields yet. */
export async function createTemplateFromUpload(
  ctx: SignCtx,
  args: { bytes: Uint8Array; filename: string; name?: string; categoryId?: string | null; converter?: ConvertOptions },
): Promise<{ template: TemplateRow; version: SignTemplateVersionRow; converted: boolean }> {
  const prepared = await prepareOrThrow(args.bytes, args.filename, args.converter);
  const categoryId = await assertCategoryId(ctx, args.categoryId);
  const id = randomUUID();
  const sourcePath = templatePath(ctx.accountId, id, `v1-${prepared.pdfSha256}.pdf`);
  const paths = [sourcePath];
  await putFile(ctx.admin, sourcePath, prepared.pdf, "application/pdf");
  let originalPath: string | null = null;
  if (prepared.converted) {
    originalPath = templatePath(ctx.accountId, id, `original-${prepared.original.sha256.slice(0, 16)}-${safeFileName(args.filename, "document")}`);
    paths.push(originalPath);
    await putFile(ctx.admin, originalPath, prepared.original.bytes, prepared.original.mime);
  }
  const { template, version } = await insertTemplateWithVersion(
    ctx,
    {
      id,
      name: checkName(args.name?.trim() || stripExt(safeFileName(args.filename, "Template")) || "Template"),
      categoryId,
      sourcePath,
      sourceSha: prepared.pdfSha256,
      originalPath,
      originalType: prepared.converted ? prepared.original.mime : null,
      pageCount: prepared.info.pageCount,
      fields: [],
      roles: [],
      defaults: {},
    },
    paths,
  );
  return { template, version, converted: prepared.converted };
}

/** "Save as template": copy a prepared draft's file, fields, roles and choices into a new template. */
export async function createTemplateFromDocument(ctx: SignCtx, documentId: string, args: { name: string; categoryId?: string | null }): Promise<{ template: TemplateRow; version: SignTemplateVersionRow }> {
  const doc: SignDocumentRow = await loadDocument(ctx, documentId);
  if (!doc.base_path || !doc.base_sha256 || !doc.page_count) throw new SignError("document_has_no_file", "This document has no file to save.", 409);
  const categoryId = await assertCategoryId(ctx, args.categoryId ?? doc.category_id);
  const id = randomUUID();
  const sourcePath = templatePath(ctx.accountId, id, `v1-${doc.base_sha256}.pdf`);
  await copyFile(ctx.admin, doc.base_path, sourcePath, ctx.accountId);
  return insertTemplateWithVersion(
    ctx,
    {
      id,
      name: checkName(args.name),
      categoryId,
      sourcePath,
      sourceSha: doc.base_sha256,
      originalPath: null,
      originalType: null,
      pageCount: doc.page_count,
      fields: doc.fields_snapshot,
      roles: doc.roles_snapshot,
      defaults: cleanDefaults({ sign_in_order: doc.sign_in_order, code_required: doc.code_required, locale: doc.locale, reminder_days: doc.reminder_days ?? undefined, message: doc.message ?? undefined }),
    },
    [sourcePath],
  );
}

export interface VersionInput {
  fields: PlacedField[];
  roles: SignRole[];
  defaults?: TemplateDefaults;
}

/** Save the editor: a new immutable version, made current. */
export async function saveTemplateVersion(ctx: SignCtx, templateId: string, input: VersionInput): Promise<SignTemplateVersionRow> {
  const template = await loadTemplate(ctx, templateId);
  const current = await loadVersion(ctx, template.current_version_id);
  checkLayout(input.fields, input.roles, current.page_count);
  const { data, error } = await ctx.admin
    .from("sign_template_versions")
    .insert({
      account_id: ctx.accountId,
      template_id: templateId,
      version_no: current.version_no + 1,
      source_path: current.source_path,
      source_sha256: current.source_sha256,
      original_path: current.original_path,
      original_type: current.original_type,
      page_count: current.page_count,
      fields: input.fields,
      roles: input.roles,
      defaults: cleanDefaults(input.defaults ?? current.defaults),
      created_by: ctx.userId,
    })
    .select("*")
    .single();
  if (error || !data) raiseDatabaseError(error, "save template version");
  const version = data as SignTemplateVersionRow;
  const patch: Record<string, unknown> = { current_version_id: version.id };
  // an add-on's template that someone edited is no longer overwritten by the add-on's updates
  if (template.addon_key) patch.customised = true;
  const u = await ctx.admin.from("sign_templates").update(patch).eq("id", templateId).eq("account_id", ctx.accountId);
  if (u.error) raiseDatabaseError(u.error, "set current version");
  return version;
}

export interface TemplatePatch {
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  status?: "draft" | "active" | "archived";
  tags?: string[];
}

export async function updateTemplate(ctx: SignCtx, templateId: string, patch: TemplatePatch): Promise<TemplateRow> {
  const template = await loadTemplate(ctx, templateId);
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = checkName(patch.name);
  if (patch.description !== undefined) update.description = patch.description?.trim() ? patch.description.trim().slice(0, 1000) : null;
  if (patch.categoryId !== undefined) update.category_id = await assertCategoryId(ctx, patch.categoryId);
  if (patch.tags !== undefined) update.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 20).map((t) => t.slice(0, 40));
  if (patch.status !== undefined) {
    if (!["draft", "active", "archived"].includes(patch.status)) throw new SignError("bad_status", "That status is not valid.", 400);
    if (patch.status === "active") {
      const v = await loadVersion(ctx, template.current_version_id);
      checkLayout(v.fields, v.roles, v.page_count);
      if (v.roles.length === 0 || v.fields.length === 0) throw new SignError("template_not_ready", "Add roles and fields before making the template active.", 409);
    }
    update.status = patch.status;
  }
  if (template.addon_key && Object.keys(update).length) update.customised = true;
  if (Object.keys(update).length === 0) return template;
  const { data, error } = await ctx.admin.from("sign_templates").update(update).eq("id", templateId).eq("account_id", ctx.accountId).select("*").single();
  if (error || !data) raiseDatabaseError(error, "update template");
  return data as TemplateRow;
}

/** A copy of a template, as a new draft template: for another set of terms or another merchant group. */
export async function duplicateTemplate(ctx: SignCtx, templateId: string, name?: string): Promise<{ template: TemplateRow; version: SignTemplateVersionRow }> {
  const source = await loadTemplate(ctx, templateId);
  const v = await loadVersion(ctx, source.current_version_id);
  const id = randomUUID();
  const sourcePath = templatePath(ctx.accountId, id, `v1-${v.source_sha256}.pdf`);
  const paths = [sourcePath];
  await copyFile(ctx.admin, v.source_path, sourcePath, ctx.accountId);
  let originalPath: string | null = null;
  if (v.original_path) {
    originalPath = templatePath(ctx.accountId, id, `original-${safeFileName(v.original_path.split("/").pop() ?? "original")}`);
    paths.push(originalPath);
    await copyFile(ctx.admin, v.original_path, originalPath, ctx.accountId);
  }
  return insertTemplateWithVersion(
    ctx,
    {
      id,
      name: checkName(name?.trim() || `${source.name} (copy)`),
      description: source.description,
      categoryId: source.category_id,
      tags: source.tags,
      sourcePath,
      sourceSha: v.source_sha256,
      originalPath,
      originalType: v.original_type,
      pageCount: v.page_count,
      fields: v.fields,
      roles: v.roles,
      defaults: v.defaults,
    },
    paths,
  );
}

/** Delete a template and its files. Documents sent from it keep their own snapshot and file. */
export async function deleteTemplate(ctx: SignCtx, templateId: string): Promise<void> {
  const template = await loadTemplate(ctx, templateId);
  const versions = await ctx.admin.from("sign_template_versions").select("source_path, original_path").eq("template_id", templateId).eq("account_id", ctx.accountId);
  const mine = `account-${ctx.accountId}/templates/${templateId}/`;
  const paths = new Set<string>();
  for (const v of (versions.data ?? []) as { source_path: string; original_path: string | null }[]) {
    for (const p of [v.source_path, v.original_path]) if (p && p.startsWith(mine)) paths.add(p);
  }
  const { error } = await ctx.admin.from("sign_templates").delete().eq("id", template.id).eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "delete template");
  await removeFiles(ctx.admin, [...paths]);
}

/** The template's current PDF, for the editor. */
export async function templateFile(ctx: SignCtx, templateId: string): Promise<{ bytes: Uint8Array; version: SignTemplateVersionRow }> {
  const template = await loadTemplate(ctx, templateId);
  const version = await loadVersion(ctx, template.current_version_id);
  return { bytes: await getFile(ctx.admin, version.source_path, ctx.accountId), version };
}
