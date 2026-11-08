// /api/incidents/setup/categories — the school's incident categories. Requires incidents.configure.
//   GET   the active template, its severity levels, and each category with what uses it (incidents, notification rules, the report form)
//   POST  { action: "copy" }  make the school's own copy of the active template, and switch to it. Incidents already raised keep the template they were raised under.
//         { action: "add", name, description?, default_severity?, default_flags? }  add a category to the school's own copy
// Categories can only be changed on the school's own copy: the built-in templates are shared by every school.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { MAX_CATEGORIES, copyName, copySlug, makeCode, parseCategory } from "@/lib/incidents/platform/categories";
import { loadCategoriesView } from "@/lib/incidents/platform/categories-data";
import { loadActiveTemplate } from "@/lib/incidents/platform/setup-data";
import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";

/** The rows of one standard, ready to be inserted under another: a new id is made by the database, and they point at the new standard. */
const reparent = (rows: Record<string, unknown>[] | null, standardId: string) =>
  (rows ?? []).map((row) => {
    const copy: Record<string, unknown> = { ...row, standard_id: standardId };
    delete copy.id;
    return copy;
  });

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const view = await loadCategoriesView(createAdminPgDb(), ctx.accountId);
    if (!view) return NextResponse.json({ error: "This school has no incident template yet. Pick one in Settings > Incidents." }, { status: 404 });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Copy the template's categories, severity levels and steps into a new standard owned by the school, and make it the school's template. */
async function makeCopy(db: PgDb, accountId: string, userId: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { data: own } = await db.from("incident_standards").select("id").eq("account_id", accountId).eq("kind", "template").maybeSingle();
  let ownId = (own as { id: string } | null)?.id ?? null;

  if (!ownId) {
    const active = await loadActiveTemplate(db, accountId);
    if (!active) return { ok: false, error: "This school has no incident template yet. Pick one in Settings > Incidents.", status: 404 };
    const { data: src } = await db.from("incident_standards").select("name, regulatory_body, sector, description").eq("id", active.standardId).maybeSingle();
    const from = src as { name: string; regulatory_body: string | null; sector: string | null; description: string | null } | null;
    if (!from) return { ok: false, error: "Could not read the template.", status: 500 };

    const created = await db
      .from("incident_standards")
      .insert({ slug: copySlug(accountId), name: copyName(from.name), regulatory_body: from.regulatory_body, sector: from.sector, description: from.description, kind: "template", is_system: false, account_id: accountId, copied_from: active.standardId })
      .select("id")
      .single();
    ownId = (created.data as { id: string } | null)?.id ?? null;
    if (created.error || !ownId) {
      console.error("[categories copy] standard:", created.error);
      return { ok: false, error: "Could not make the copy.", status: 500 };
    }

    try {
      const [cats, sevs, steps] = await Promise.all([
        db.from("incident_type_catalogue").select("*").eq("standard_id", active.standardId).order("position"),
        db.from("incident_severity_levels").select("*").eq("standard_id", active.standardId).order("position"),
        db.from("incident_obligation_rules").select("*").eq("standard_id", active.standardId).order("position"),
      ]);
      const inserts = [
        { table: "incident_type_catalogue", rows: reparent(cats.data as Record<string, unknown>[] | null, ownId) },
        { table: "incident_severity_levels", rows: reparent(sevs.data as Record<string, unknown>[] | null, ownId) },
        { table: "incident_obligation_rules", rows: reparent(steps.data as Record<string, unknown>[] | null, ownId) },
      ];
      for (const { table, rows } of inserts) {
        if (rows.length === 0) continue;
        const res = await db.from(table).insert(rows);
        if (res.error) throw new Error(`${table}: ${res.error.message}`);
      }
    } catch (err) {
      // A half-made copy is worse than none: remove it (its rows go with it) and leave the school on its template.
      console.error("[categories copy] rows:", err);
      await db.from("incident_standards").delete().eq("id", ownId);
      return { ok: false, error: "Could not make the copy.", status: 500 };
    }
  }

  // Switching to it: migration 206's trigger switches the old template off.
  const switched = await db.from("account_incident_standards").upsert({ account_id: accountId, standard_id: ownId, is_active: true, activated_at: new Date().toISOString() }, { onConflict: "account_id,standard_id" });
  if (switched.error) {
    console.error("[categories copy] switch:", switched.error, userId);
    return { ok: false, error: "Made the copy, but could not switch to it.", status: 500 };
  }
  return { ok: true };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const db = createAdminPgDb();

    if (body?.action === "copy") {
      const done = await makeCopy(db, ctx.accountId, ctx.userId);
      if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
      return NextResponse.json(await loadCategoriesView(db, ctx.accountId), { status: 201 });
    }

    if (body?.action === "add") {
      const view = await loadCategoriesView(db, ctx.accountId);
      if (!view) return NextResponse.json({ error: "This school has no incident template yet." }, { status: 404 });
      if (!view.template.ownCopy) return NextResponse.json({ error: "Make your school's own copy of the template first. The built-in template is shared and cannot be changed." }, { status: 409 });
      if (view.categories.length >= MAX_CATEGORIES) return NextResponse.json({ error: `A school can have ${MAX_CATEGORIES} categories at most. Hide one you do not use.` }, { status: 409 });

      const parsed = parseCategory(body, { severities: view.severities.map((s) => s.slug), isNew: true });
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      const v = parsed.value;
      if (view.categories.some((c) => c.name.toLowerCase() === (v.name ?? "").toLowerCase())) return NextResponse.json({ error: "There is already a category with that name." }, { status: 409 });

      // New categories start at the second-lowest level unless told otherwise, as the raise form does.
      const slugs = view.severities.map((s) => s.slug);
      const row = {
        standard_id: view.template.id,
        code: makeCode(v.name as string, view.categories.map((c) => c.code)),
        name: v.name,
        description: v.description ?? null,
        default_severity: v.defaultSeverity ?? slugs[Math.max(0, slugs.length - 2)] ?? null,
        default_flags: v.defaultFlags ?? [],
        notifiable: false,
        position: Math.max(0, ...view.categories.map((c) => c.position)) + 1,
      };
      const { error } = await db.from("incident_type_catalogue").insert(row);
      if (error) {
        console.error("[categories add]", error);
        return NextResponse.json({ error: "Could not add the category." }, { status: 500 });
      }
      return NextResponse.json(await loadCategoriesView(db, ctx.accountId), { status: 201 });
    }

    return NextResponse.json({ error: "Say what to do: copy or add." }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
