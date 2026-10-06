// ============================================================
// Registration forms, the admin side (Settings > Doc Sign > Registration forms, migration 164): list, create,
// change, switch on and off, regenerate the address, and read what came of the submissions.
//
// The routes pass a context whose client is the signed-in person's own (RLS scoped), not the service role: the
// database then checks sign.settings itself and its audit trigger records WHO changed a form. Every read and
// write is still scoped to the workspace explicitly, as everywhere in Doc Sign.
//
// A form that is switched on must be able to work: when it sends a document, the template must be active with
// a saved version, the applicant's role must exist, and every other role that has something to complete needs
// a person (`formReadiness`, which reuses the rules a sender meets at "Send"). A form that cannot work is saved
// switched off, never silently broken.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Issue } from "../rules";
import { formSendProblems } from "../forms";
import { sendProblems, type SignerDraft } from "../rules";
import { makeSlug, regenerateSlug } from "../registration/slug";
import { DEFAULT_ASKED, DEFAULT_DAILY_CAP, type OtherSigner, type RegistrationCounts, type RegistrationEntry, type RegistrationFormRow, type RegistrationMode } from "../registration/types";
import { parseFormInput, type FormInput } from "../registration/validate";
import { isFormMode, type SignRole, type SignTemplateVersionRow } from "../types";
import type { SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

/** The same context with the signed-in person's own client, so the database checks the capability and records who changed a form. */
export const withUserClient = (ctx: SignCtx, supabase: SupabaseClient): SignCtx => ({ ...ctx, admin: supabase });

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNT_WINDOW_DAYS = 30;
const FORM_LIMIT = 100;

// ---- readiness -----------------------------------------------------------------------------------------

export interface TemplateState {
  name: string;
  status: string;
  version: SignTemplateVersionRow | null;
}

/** A person standing in for the applicant when the form is checked for readiness. */
const SAMPLE_APPLICANT = { full_name: "Applicant", email: "applicant@registration.invalid" };

/**
 * What stands between a form and a page that works. Empty means ready. A form that sends no document needs
 * nothing. The codes are the ones the send screen already words (`role_without_person`, `part_without_person`,
 * `signer_without_signature`, ...), plus the ones about the form itself.
 */
export function formReadiness(
  form: Pick<RegistrationFormRow, "send_document" | "template_id" | "applicant_role_key" | "signers_other"> & { mode?: RegistrationMode },
  template: TemplateState | null,
): Issue[] {
  if (!form.send_document) return [];
  if (!form.template_id || !template) return [{ code: "no_template" }];
  if (template.status !== "active") return [{ code: "template_not_active" }];
  const version = template.version;
  if (!version) return [{ code: "template_has_no_version" }];
  // a form that sends a form without a signature needs a template of that kind (and the other way round)
  if ((form.mode === "form") !== isFormMode(version)) return [{ code: "template_mode_mismatch" }];
  if (!form.applicant_role_key) return [{ code: "no_applicant_role" }];
  const roles = version.roles as SignRole[];
  const applicantRole = roles.find((r) => r.key === form.applicant_role_key);
  if (!applicantRole) return [{ code: "applicant_role_unknown", role: form.applicant_role_key }];

  const issues: Issue[] = [];
  const signers: SignerDraft[] = [{ role_key: applicantRole.key, kind: applicantRole.kind, ...SAMPLE_APPLICANT, phone: null, channel: "email", order_no: 1 }];
  form.signers_other.forEach((s, i) => {
    const role = roles.find((r) => r.key === s.role_key);
    if (!role || role.key === applicantRole.key) {
      issues.push({ code: "signer_role", field: "signersOther", detail: String(i), role: s.role_key });
      return;
    }
    signers.push({ role_key: role.key, kind: role.kind, full_name: s.name, email: s.email, phone: s.phone ?? null, channel: s.channel, order_no: i + 2 });
  });
  issues.push(...sendProblems({ fields: version.fields, roles, signers, signInOrder: version.defaults.sign_in_order ?? false, pageCount: version.page_count, hasBaseFile: true, mode: version.mode }));
  if (version.form) issues.push(...formSendProblems(version.form, signers));
  return issues;
}

export async function loadTemplateStates(ctx: SignCtx, templateIds: string[]): Promise<Map<string, TemplateState>> {
  const out = new Map<string, TemplateState>();
  const ids = [...new Set(templateIds)];
  if (ids.length === 0) return out;
  const t = await ctx.admin.from("sign_templates").select("*").eq("account_id", ctx.accountId).in("id", ids);
  if (t.error) raiseDatabaseError(t.error, "load templates");
  const templates = (t.data ?? []) as { id: string; name: string; status: string; current_version_id: string | null }[];
  const versionIds = templates.map((x) => x.current_version_id).filter((x): x is string => !!x);
  const versions = new Map<string, SignTemplateVersionRow>();
  if (versionIds.length > 0) {
    const v = await ctx.admin.from("sign_template_versions").select("*").eq("account_id", ctx.accountId).in("id", versionIds);
    if (v.error) raiseDatabaseError(v.error, "load template versions");
    for (const row of (v.data ?? []) as SignTemplateVersionRow[]) versions.set(row.id, row);
  }
  for (const x of templates) out.set(x.id, { name: x.name, status: x.status, version: x.current_version_id ? (versions.get(x.current_version_id) ?? null) : null });
  return out;
}

/** The readiness of a form, loading its template. */
export async function readinessOf(ctx: SignCtx, form: RegistrationFormRow): Promise<Issue[]> {
  if (!form.send_document) return [];
  const states = await loadTemplateStates(ctx, form.template_id ? [form.template_id] : []);
  return formReadiness(form, form.template_id ? (states.get(form.template_id) ?? null) : null);
}

// ---- reading -------------------------------------------------------------------------------------------

export interface FormListItem {
  form: RegistrationFormRow;
  counts: RegistrationCounts;
  /** Why the form cannot work (empty when it can). */
  issues: Issue[];
  url: string;
}

const emptyCounts = (): RegistrationCounts => ({ accepted: 0, rejected_spam: 0, rejected_cap: 0, failed: 0, today: 0 });

export const publicUrl = (origin: string, slug: string): string => `${origin.replace(/\/+$/, "")}/r/${slug}`;

async function loadCounts(ctx: SignCtx, formIds: string[]): Promise<Map<string, RegistrationCounts>> {
  const out = new Map<string, RegistrationCounts>(formIds.map((id) => [id, emptyCounts()]));
  if (formIds.length === 0) return out;
  const now = ctx.now().getTime();
  // counted in the database: the API returns at most a thousand rows, which a busy form passes in a day
  const r = await ctx.admin.rpc("sign_registration_counts", {
    p_account: ctx.accountId,
    p_since: new Date(now - COUNT_WINDOW_DAYS * DAY_MS).toISOString(),
    p_today: new Date(now - DAY_MS).toISOString(),
  });
  if (r.error) raiseDatabaseError(r.error, "count registrations");
  for (const row of (r.data ?? []) as { form_id: string; accepted: number | string; rejected_spam: number | string; rejected_cap: number | string; failed: number | string; today: number | string }[]) {
    const c = out.get(row.form_id);
    if (!c) continue;
    // bigint columns come back as numbers or as text, depending on the size
    c.accepted = Number(row.accepted) || 0;
    c.rejected_spam = Number(row.rejected_spam) || 0;
    c.rejected_cap = Number(row.rejected_cap) || 0;
    c.failed = Number(row.failed) || 0;
    c.today = Number(row.today) || 0;
  }
  return out;
}

export async function listForms(ctx: SignCtx): Promise<FormListItem[]> {
  const r = await ctx.admin.from("sign_registration_forms").select("*").eq("account_id", ctx.accountId).order("created_at", { ascending: false }).limit(FORM_LIMIT);
  if (r.error) raiseDatabaseError(r.error, "list registration forms");
  const forms = (r.data ?? []) as RegistrationFormRow[];
  const [counts, states] = await Promise.all([loadCounts(ctx, forms.map((f) => f.id)), loadTemplateStates(ctx, forms.filter((f) => f.send_document && f.template_id).map((f) => f.template_id as string))]);
  return forms.map((form) => ({
    form,
    counts: counts.get(form.id) ?? emptyCounts(),
    issues: formReadiness(form, form.template_id ? (states.get(form.template_id) ?? null) : null),
    url: publicUrl(ctx.origin, form.slug),
  }));
}

export async function loadForm(ctx: SignCtx, id: string): Promise<RegistrationFormRow> {
  const r = await ctx.admin.from("sign_registration_forms").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
  if (r.error) raiseDatabaseError(r.error, "load registration form");
  if (!r.data) throw new SignError("form_not_found", "That registration form was not found.", 404);
  return r.data as RegistrationFormRow;
}

/** The newest submissions of a form: what happened and when, never an address or an email. */
export async function listEntries(ctx: SignCtx, formId: string, limit = 50): Promise<RegistrationEntry[]> {
  const r = await ctx.admin.from("sign_registrations").select("*").eq("account_id", ctx.accountId).eq("form_id", formId).order("created_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 200));
  if (r.error) raiseDatabaseError(r.error, "list registrations");
  return ((r.data ?? []) as RegistrationEntry[]).map((e) => ({ id: e.id, status: e.status, reason: e.reason, contact_id: e.contact_id, document_id: e.document_id, locale: e.locale, created_at: e.created_at }));
}

export async function formView(ctx: SignCtx, id: string): Promise<FormListItem & { entries: RegistrationEntry[] }> {
  const form = await loadForm(ctx, id);
  const [counts, issues, entries] = await Promise.all([loadCounts(ctx, [form.id]), readinessOf(ctx, form), listEntries(ctx, form.id)]);
  return { form, counts: counts.get(form.id) ?? emptyCounts(), issues, url: publicUrl(ctx.origin, form.slug), entries };
}

// ---- the choices the screen offers ---------------------------------------------------------------------

export interface FormOptions {
  templates: { id: string; name: string; roles: { key: string; label: string; kind: "signer" | "filler" }[]; hasForm: boolean; mode: RegistrationMode }[];
  tags: { id: string; name: string; color: string }[];
}

export async function formOptions(ctx: SignCtx): Promise<FormOptions> {
  const t = await ctx.admin.from("sign_templates").select("*").eq("account_id", ctx.accountId).eq("status", "active").order("name", { ascending: true }).limit(200);
  if (t.error) raiseDatabaseError(t.error, "list templates");
  const templates = ((t.data ?? []) as { id: string; name: string; current_version_id: string | null }[]).filter((x) => !!x.current_version_id);
  const versions = new Map<string, SignTemplateVersionRow>();
  if (templates.length > 0) {
    const v = await ctx.admin.from("sign_template_versions").select("*").eq("account_id", ctx.accountId).in("id", templates.map((x) => x.current_version_id as string));
    if (v.error) raiseDatabaseError(v.error, "list template versions");
    for (const row of (v.data ?? []) as SignTemplateVersionRow[]) versions.set(row.id, row);
  }
  const g = await ctx.admin.from("tags").select("id, name, color, for_contacts").eq("account_id", ctx.accountId).eq("approval_status", "approved").is("deleted_at", null).order("name", { ascending: true }).limit(500);
  if (g.error) raiseDatabaseError(g.error, "list tags");
  return {
    templates: templates.flatMap((x) => {
      const version = versions.get(x.current_version_id as string);
      return version ? [{ id: x.id, name: x.name, roles: version.roles.map((r) => ({ key: r.key, label: r.label, kind: r.kind })), hasForm: !!version.form, mode: isFormMode(version) ? ("form" as const) : ("sign" as const) }] : [];
    }),
    tags: ((g.data ?? []) as { id: string; name: string; color: string; for_contacts?: boolean | null }[]).filter((x) => x.for_contacts !== false).map((x) => ({ id: x.id, name: x.name, color: x.color })),
  };
}

// ---- writing -------------------------------------------------------------------------------------------

/** The mode of the chosen template (a form follows it unless the admin chose one), or null when no template was given. */
async function assertTemplate(ctx: SignCtx, templateId: string | null | undefined): Promise<RegistrationMode | null> {
  if (!templateId) return null;
  const r = await ctx.admin.from("sign_templates").select("id, mode").eq("id", templateId).eq("account_id", ctx.accountId).maybeSingle();
  if (r.error) raiseDatabaseError(r.error, "load template");
  if (!r.data) throw new SignError("template_not_found", "That template was not found.", 400);
  return isFormMode(r.data as { mode?: string | null }) ? "form" : "sign";
}

async function assertTag(ctx: SignCtx, tagId: string | null | undefined): Promise<void> {
  if (!tagId) return;
  const r = await ctx.admin.from("tags").select("id, for_contacts").eq("id", tagId).eq("account_id", ctx.accountId).eq("approval_status", "approved").is("deleted_at", null).maybeSingle();
  if (r.error) raiseDatabaseError(r.error, "load tag");
  const row = r.data as { for_contacts?: boolean | null } | null;
  if (!row || row.for_contacts === false) throw new SignError("tag_not_found", "That tag was not found. Choose a contact tag.", 400);
}

function rowFrom(input: FormInput): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.active !== undefined) row.active = input.active;
  if (input.sendDocument !== undefined) row.send_document = input.sendDocument;
  if (input.mode !== undefined) row.mode = input.mode;
  if (input.templateId !== undefined) row.template_id = input.templateId;
  if (input.applicantRoleKey !== undefined) row.applicant_role_key = input.applicantRoleKey;
  if (input.signersOther !== undefined) row.signers_other = input.signersOther;
  if (input.contactTagId !== undefined) row.contact_tag_id = input.contactTagId;
  if (input.fields !== undefined) row.fields = input.fields;
  if (input.consentText !== undefined) row.consent_text = input.consentText;
  if (input.successMessage !== undefined) row.success_message = input.successMessage;
  if (input.defaultLocale !== undefined) row.default_locale = input.defaultLocale;
  if (input.dailyCap !== undefined) row.daily_cap = input.dailyCap;
  return row;
}

function checkedInput(body: unknown): FormInput {
  const parsed = parseFormInput(body);
  if (!parsed.ok) throw new SignError("invalid_form", "The registration form is not valid.", 400, parsed.issues);
  return parsed.value;
}

/** A form that is switched on must be able to work. */
async function assertReady(ctx: SignCtx, form: Pick<RegistrationFormRow, "active" | "send_document" | "template_id" | "applicant_role_key" | "signers_other"> & { mode?: RegistrationMode }): Promise<void> {
  if (!form.active || !form.send_document) return;
  const states = await loadTemplateStates(ctx, form.template_id ? [form.template_id] : []);
  const issues = formReadiness(form, form.template_id ? (states.get(form.template_id) ?? null) : null);
  if (issues.length > 0) throw new SignError("form_not_ready", "This form cannot be switched on yet.", 409, issues);
}

const isUniqueViolation = (e: { code?: string } | null | undefined): boolean => e?.code === "23505";

export async function createForm(ctx: SignCtx, body: unknown): Promise<RegistrationFormRow> {
  const input = checkedInput(body);
  if (!input.name) throw new SignError("invalid_form", "Give the form a name.", 400, [{ code: "bad_name", field: "name" }]);
  const [templateMode] = await Promise.all([assertTemplate(ctx, input.templateId), assertTag(ctx, input.contactTagId)]);
  const row: Record<string, unknown> = {
    fields: DEFAULT_ASKED,
    daily_cap: DEFAULT_DAILY_CAP,
    send_document: true,
    active: false,
    signers_other: [] as OtherSigner[],
    ...rowFrom(input),
    account_id: ctx.accountId,
    created_by: ctx.userId,
  };
  // what the form sends follows its template unless the admin said otherwise (a mismatch is then a readiness problem, said in words)
  if (input.mode === undefined && templateMode && templateMode !== "sign") row.mode = templateMode;
  await assertReady(ctx, { mode: (row.mode as RegistrationMode | undefined) ?? "sign", active: !!row.active, send_document: !!row.send_document, template_id: (row.template_id as string | null | undefined) ?? null, applicant_role_key: (row.applicant_role_key as string | null | undefined) ?? null, signers_other: row.signers_other as OtherSigner[] });
  // the address ends in a random suffix; a clash (rare) draws another
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await ctx.admin.from("sign_registration_forms").insert({ ...row, slug: makeSlug(input.name) }).select("*").single();
    if (!error && data) return data as RegistrationFormRow;
    if (!isUniqueViolation(error)) raiseDatabaseError(error, "create registration form");
  }
  throw new SignError("slug_unavailable", "Could not make an address for this form. Try again.", 500);
}

export async function updateForm(ctx: SignCtx, id: string, body: unknown): Promise<RegistrationFormRow> {
  const input = checkedInput(body);
  const current = await loadForm(ctx, id);
  const row = rowFrom(input);
  if (Object.keys(row).length === 0) return current;
  const [templateMode] = await Promise.all([input.templateId !== undefined ? assertTemplate(ctx, input.templateId) : null, input.contactTagId !== undefined ? assertTag(ctx, input.contactTagId) : null]);
  // choosing another template changes what the form sends, unless the admin chose the mode too
  if (input.mode === undefined && templateMode) row.mode = templateMode;
  // only a change that can make a working form stop working is held to the readiness rules (a rename never is)
  if (row.active === true || ["send_document", "template_id", "applicant_role_key", "signers_other", "mode"].some((k) => k in row)) {
    await assertReady(ctx, { ...current, ...(row as Partial<RegistrationFormRow>) });
  }
  const { data, error } = await ctx.admin.from("sign_registration_forms").update(row).eq("id", id).eq("account_id", ctx.accountId).select("*").maybeSingle();
  if (error) raiseDatabaseError(error, "update registration form");
  if (!data) throw new SignError("form_not_found", "That registration form was not found.", 404);
  return data as RegistrationFormRow;
}

/** A new address for a form: the old one stops working at once (for a link that was shared where it should not be). */
export async function regenerateFormSlug(ctx: SignCtx, id: string): Promise<RegistrationFormRow> {
  const current = await loadForm(ctx, id);
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, error } = await ctx.admin.from("sign_registration_forms").update({ slug: regenerateSlug(current.slug) }).eq("id", id).eq("account_id", ctx.accountId).select("*").maybeSingle();
    if (!error && data) return data as RegistrationFormRow;
    if (error && !isUniqueViolation(error)) raiseDatabaseError(error, "regenerate registration slug");
    if (!error && !data) throw new SignError("form_not_found", "That registration form was not found.", 404);
  }
  throw new SignError("slug_unavailable", "Could not make an address for this form. Try again.", 500);
}
