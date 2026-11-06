// /api/incidents/setup/form — the coach report form, edited as a draft and published as a version. Requires incidents.configure.
//   GET   the draft (if any), the live version (or the built-in form), every version, and what the builder needs to offer (the template's categories).
//   PUT   { schema, note? }  save the draft. Loose on purpose (work in progress is allowed); publishing is strict.
//   POST  { action: "start" }                 begin a draft from the live form
//         { action: "publish" }               check the draft strictly, then make it the live version
//         { action: "discard" }               throw the draft away
//         { action: "restore", version }      start a draft from an older version
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { validateSchema } from "@/lib/incidents/intake/form-edit";
import { CCA_FORM, type FormSchema } from "@/lib/incidents/intake/form-schema";
import { loadActiveTemplate } from "@/lib/incidents/platform/setup-data";
import { createAdminPgDb } from "@/lib/postgres/db";

const FORM_KEY = "cca";
const MAX_BYTES = 200_000;

type Version = { id: string; version: number; status: "draft" | "published" | "archived"; schema: FormSchema; note: string | null; created_at: string; published_at: string | null };
type Ctx = Awaited<ReturnType<typeof requireCapability>>;

async function versions(ctx: Ctx): Promise<Version[]> {
  const { data } = await ctx.supabase.from("incident_form_versions").select("id, version, status, schema, note, created_at, published_at").eq("account_id", ctx.accountId).eq("form_key", FORM_KEY).order("version", { ascending: false });
  return (data ?? []) as Version[];
}

function looksLikeForm(schema: unknown): schema is FormSchema {
  if (typeof schema !== "object" || schema === null) return false;
  const s = schema as FormSchema;
  return s.version === 1 && Array.isArray(s.steps) && s.steps.length <= 12 && JSON.stringify(schema).length <= MAX_BYTES;
}

async function nextVersion(list: Version[]): Promise<number> {
  return Math.max(0, ...list.map((v) => v.version)) + 1;
}

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const [list, template] = await Promise.all([versions(ctx), loadActiveTemplate(ctx.supabase, ctx.accountId)]);
    return NextResponse.json({
      builtIn: CCA_FORM,
      draft: list.find((v) => v.status === "draft") ?? null,
      published: list.find((v) => v.status === "published") ?? null,
      versions: list.map((v) => ({ id: v.id, version: v.version, status: v.status, note: v.note, created_at: v.created_at, published_at: v.published_at })),
      allVersions: list,
      categories: (template?.categories ?? []).map((c) => ({ code: c.code, name: c.name })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as { schema?: unknown; note?: unknown } | null;
    if (!looksLikeForm(body?.schema)) return NextResponse.json({ error: "That does not look like a form, or it is too large." }, { status: 400 });
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) || null : null;

    const list = await versions(ctx);
    const draft = list.find((v) => v.status === "draft");
    if (draft) {
      const { error } = await ctx.supabase.from("incident_form_versions").update({ schema: body!.schema, note }).eq("id", draft.id).eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ error: "Could not save the draft." }, { status: 500 });
      return NextResponse.json({ version: draft.version });
    }
    const version = await nextVersion(list);
    const { error } = await ctx.supabase.from("incident_form_versions").insert({ account_id: ctx.accountId, form_key: FORM_KEY, version, status: "draft", schema: body!.schema, note, created_by: ctx.userId });
    if (error) return NextResponse.json({ error: "Could not save the draft." }, { status: 500 });
    return NextResponse.json({ version }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as { action?: unknown; version?: unknown } | null;
    const list = await versions(ctx);
    const draft = list.find((v) => v.status === "draft");
    const live = list.find((v) => v.status === "published");

    switch (body?.action) {
      case "start":
      case "restore": {
        if (draft) return NextResponse.json({ error: "There is already a draft. Publish it or discard it first." }, { status: 409 });
        const source = body.action === "restore" ? list.find((v) => v.version === body.version) : live;
        if (body.action === "restore" && !source) return NextResponse.json({ error: "That version does not exist." }, { status: 404 });
        const schema = source?.schema ?? CCA_FORM;
        const version = await nextVersion(list);
        const note = body.action === "restore" ? `Restored from version ${source!.version}` : null;
        const { error } = await ctx.supabase.from("incident_form_versions").insert({ account_id: ctx.accountId, form_key: FORM_KEY, version, status: "draft", schema, note, created_by: ctx.userId });
        if (error) return NextResponse.json({ error: "Could not start a draft." }, { status: 500 });
        return NextResponse.json({ version }, { status: 201 });
      }
      case "discard": {
        if (!draft) return NextResponse.json({ error: "There is no draft." }, { status: 404 });
        const { error } = await ctx.supabase.from("incident_form_versions").delete().eq("id", draft.id).eq("account_id", ctx.accountId).eq("status", "draft");
        if (error) return NextResponse.json({ error: "Could not discard the draft." }, { status: 500 });
        return NextResponse.json({ ok: true });
      }
      case "publish": {
        if (!draft) return NextResponse.json({ error: "There is no draft to publish." }, { status: 404 });
        const template = await loadActiveTemplate(ctx.supabase, ctx.accountId);
        if (!template) return NextResponse.json({ error: "Choose an incident template first." }, { status: 422 });
        const problems = validateSchema(draft.schema, { categoryCodes: template.categories.map((c) => c.code) });
        if (problems.length > 0) return NextResponse.json({ error: problems[0], problems }, { status: 422 });
        const { data, error } = await createAdminPgDb().rpc<boolean>("publish_incident_form", { p_account_id: ctx.accountId, p_form_key: FORM_KEY, p_version: draft.version, p_user: ctx.userId });
        if (error || data !== true) return NextResponse.json({ error: "Could not publish the form." }, { status: 500 });
        return NextResponse.json({ ok: true, version: draft.version });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
