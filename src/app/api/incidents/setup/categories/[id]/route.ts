// PATCH /api/incidents/setup/categories/[id] — rename a category, change its description, the severity it starts at, what it involves, or hide it. The code never
// changes, so renaming does not break the rules and forms that point at the category.
// DELETE removes a category only when nothing uses it (no incident, no notification rule, not the report form); otherwise it can only be hidden.
// Only on the school's own copy of the template. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseCategory, whyNotDeletable } from "@/lib/incidents/platform/categories";
import { loadCategoriesView } from "@/lib/incidents/platform/categories-data";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const db = createAdminPgDb();
    const view = await loadCategoriesView(db, ctx.accountId);
    if (!view) return NextResponse.json({ error: "This school has no incident template yet." }, { status: 404 });
    if (!view.template.ownCopy) return NextResponse.json({ error: "Make your school's own copy of the template first." }, { status: 409 });
    const current = view.categories.find((c) => c.id === id);
    if (!current) return NextResponse.json({ error: "Category not found." }, { status: 404 });

    const parsed = parseCategory(await request.json().catch(() => null), { severities: view.severities.map((s) => s.slug), isNew: false });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const v = parsed.value;
    if (v.name !== undefined && view.categories.some((c) => c.id !== id && c.name.toLowerCase() === v.name?.toLowerCase())) {
      return NextResponse.json({ error: "There is already a category with that name." }, { status: 409 });
    }
    // The last visible category cannot be hidden, or nobody could raise an incident.
    if (v.hidden === true && view.categories.filter((c) => !c.is_hidden && c.id !== id).length === 0) {
      return NextResponse.json({ error: "Keep at least one category visible, or nobody can raise an incident." }, { status: 409 });
    }

    const patch: Record<string, unknown> = {};
    if (v.name !== undefined) patch.name = v.name;
    if (v.description !== undefined) patch.description = v.description;
    if (v.defaultSeverity !== undefined) patch.default_severity = v.defaultSeverity;
    if (v.defaultFlags !== undefined) patch.default_flags = v.defaultFlags;
    if (v.hidden !== undefined) patch.is_hidden = v.hidden;

    const { error } = await db.from("incident_type_catalogue").update(patch).eq("id", id).eq("standard_id", view.template.id);
    if (error) return NextResponse.json({ error: "Could not save the changes." }, { status: 500 });
    return NextResponse.json(await loadCategoriesView(db, ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const db = createAdminPgDb();
    const view = await loadCategoriesView(db, ctx.accountId);
    if (!view) return NextResponse.json({ error: "This school has no incident template yet." }, { status: 404 });
    if (!view.template.ownCopy) return NextResponse.json({ error: "Make your school's own copy of the template first." }, { status: 409 });
    const current = view.categories.find((c) => c.id === id);
    if (!current) return NextResponse.json({ error: "Category not found." }, { status: 404 });

    const why = whyNotDeletable(current.usage);
    if (why) return NextResponse.json({ error: why }, { status: 409 });
    if (view.categories.filter((c) => !c.is_hidden && c.id !== id).length === 0) {
      return NextResponse.json({ error: "Keep at least one category visible, or nobody can raise an incident." }, { status: 409 });
    }

    const { error } = await db.from("incident_type_catalogue").delete().eq("id", id).eq("standard_id", view.template.id);
    if (error) return NextResponse.json({ error: "Could not delete the category." }, { status: 500 });
    return NextResponse.json(await loadCategoriesView(db, ctx.accountId));
  } catch (err) {
    return toErrorResponse(err);
  }
}
