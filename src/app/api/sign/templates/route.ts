// ============================================================
// POST /api/sign/templates   (sign.templates)
//
// A new template from an uploaded file (multipart: `file`, optional name and categoryId). PDF, Word and
// image files are accepted; Word and images are converted to the PDF that is edited and signed. The
// template starts as a draft with no fields. Reading templates is done by the screens through row level
// security (menu.sign).
//
// A new template for a form WITHOUT a signature (migration 169): JSON `{ mode: "form", name, categoryId? }`. No file is
// needed; the template starts with one role that fills in, and the form builder adds the parts.
// ============================================================
import { NextResponse } from "next/server";
import { json, optionalId, readJson, readUpload, staff } from "@/lib/sign/http";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { SignError } from "@/lib/sign/service/errors";
import { createFormTemplate, createTemplateFromUpload } from "@/lib/sign/service/templates";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const library = searchParams.get("library") === "true";

    if (library) {
      const TEMPLATE_COLUMNS = "id, name, description, category_id, status, tags, addon_key, addon_version, customised, updated_at, mode";
      const [templatesRes, categoriesRes] = await Promise.all([
        ctx.supabase.from("sign_templates").select(TEMPLATE_COLUMNS).order("name"),
        ctx.supabase.from("sign_categories").select("*").eq("account_id", ctx.accountId).order("position"),
      ]);
      if (templatesRes.error) return NextResponse.json({ error: templatesRes.error.message }, { status: 500 });
      const templateIds = (templatesRes.data ?? []).map((t: { id: string }) => t.id);
      const versionCounts: Record<string, number> = {};
      if (templateIds.length) {
        const { data: vRows } = await ctx.supabase
          .from("sign_template_versions")
          .select("template_id")
          .in("template_id", templateIds);
        for (const row of (vRows ?? []) as { template_id: string }[]) {
          versionCounts[row.template_id] = (versionCounts[row.template_id] ?? 0) + 1;
        }
      }
      return NextResponse.json({
        templates: (templatesRes.data ?? []).map((t: Record<string, unknown>) => ({ ...t, version_count: versionCounts[t.id as string] ?? 0 })),
        categories: categoriesRes.data ?? [],
      });
    }

    const { data: templates, error } = await ctx.supabase
      .from("sign_templates")
      .select("id, name, description, category_id, current_version_id, mode")
      .eq("status", "active")
      .order("name", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const list = (
      (templates as { id: string; name: string; description: string | null; category_id: string | null; current_version_id: string | null; mode?: string | null }[] | null) ?? []
    ).filter((x) => x.current_version_id);

    const versionIds = list.map((x) => x.current_version_id as string);
    const info = new Map<string, { pages: number; roles: number }>();
    if (versionIds.length) {
      const { data: versions } = await ctx.supabase
        .from("sign_template_versions")
        .select("id, page_count, roles")
        .in("id", versionIds);
      for (const row of (versions as { id: string; page_count: number; roles: unknown }[] | null) ?? []) {
        info.set(row.id, { pages: row.page_count, roles: Array.isArray(row.roles) ? row.roles.length : 0 });
      }
    }

    return NextResponse.json({
      templates: list.map((x) => ({
        id: x.id,
        name: x.name,
        description: x.description,
        category_id: x.category_id,
        pages: info.get(x.current_version_id as string)?.pages ?? 0,
        roles: info.get(x.current_version_id as string)?.roles ?? 0,
        mode: x.mode === "form" ? "form" : "sign",
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  return staff(
    "sign.templates",
    request,
    async ({ ctx }) => {
      if ((request.headers.get("content-type") ?? "").includes("application/json")) {
        const body = await readJson<{ mode?: unknown; name?: unknown; categoryId?: unknown }>(request);
        if (body.mode !== "form") throw new SignError("bad_mode", "Choose a template from a file, or a form without a signature.", 400);
        const made = await createFormTemplate(ctx, { name: typeof body.name === "string" ? body.name : "", categoryId: optionalId(body.categoryId) });
        return json({ template: made.template, version: { id: made.version.id, version_no: made.version.version_no, page_count: made.version.page_count }, converted: false }, 201);
      }
      const { file, fields } = await readUpload(request);
      if (!file) throw new SignError("no_file", "Choose a file to upload.", 400);
      const { template, version, converted } = await createTemplateFromUpload(ctx, {
        bytes: file.bytes,
        filename: file.name,
        name: fields.name,
        categoryId: optionalId(fields.categoryId),
      });
      return json({ template, version: { id: version.id, version_no: version.version_no, page_count: version.page_count }, converted }, 201);
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
