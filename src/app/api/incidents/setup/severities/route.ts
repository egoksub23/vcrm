// /api/incidents/setup/severities — the school's severity levels. Requires incidents.configure.
//   GET   the active template's severity levels and whether this is the school's own copy
//   POST  { action: "rename", id, label }     rename a level (slug is never changed)
//         { action: "patch",  id, color? }    update the color
//         { action: "reorder", order: string[] }  new position order (array of IDs)
// Writes are only allowed on the school's own copy.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadActiveTemplate } from "@/lib/incidents/platform/setup-data";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const db = createAdminPgDb();
    const tpl = await loadActiveTemplate(db, ctx.accountId);
    if (!tpl) return NextResponse.json({ error: "This school has no incident template yet." }, { status: 404 });
    const { data: std } = await db.from("incident_standards").select("account_id").eq("id", tpl.standardId).maybeSingle();
    const ownCopy = (std as { account_id: string | null } | null)?.account_id === ctx.accountId;
    return NextResponse.json({ template: { id: tpl.standardId, name: tpl.name, ownCopy }, severities: tpl.severities }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const db = createAdminPgDb();

    async function fresh() {
      const tpl = await loadActiveTemplate(db, ctx.accountId);
      if (!tpl) return null;
      const { data: std } = await db.from("incident_standards").select("account_id").eq("id", tpl.standardId).maybeSingle();
      const ownCopy = (std as { account_id: string | null } | null)?.account_id === ctx.accountId;
      return { template: { id: tpl.standardId, name: tpl.name, ownCopy }, severities: tpl.severities };
    }

    const view = await fresh();
    if (!view) return NextResponse.json({ error: "This school has no incident template yet." }, { status: 404 });
    if (!view.template.ownCopy) return NextResponse.json({ error: "Make your school's own copy of the template first." }, { status: 409 });

    if (body?.action === "rename") {
      const id = typeof body.id === "string" ? body.id : null;
      const label = typeof body.label === "string" ? body.label.trim() : null;
      if (!id || !label) return NextResponse.json({ error: "Provide id and label." }, { status: 400 });
      if (!view.severities.some((s) => s.id === id)) return NextResponse.json({ error: "Severity level not found." }, { status: 404 });
      const { error } = await db.from("incident_severity_levels").update({ label }).eq("id", id).eq("standard_id", view.template.id);
      if (error) { console.error("[severities rename]", error); return NextResponse.json({ error: "Could not rename." }, { status: 500 }); }
      return NextResponse.json(await fresh());
    }

    if (body?.action === "patch") {
      const id = typeof body.id === "string" ? body.id : null;
      if (!id) return NextResponse.json({ error: "Provide id." }, { status: 400 });
      if (!view.severities.some((s) => s.id === id)) return NextResponse.json({ error: "Severity level not found." }, { status: 404 });
      const update: Record<string, unknown> = {};
      if ("color" in body) update.color = typeof body.color === "string" && body.color ? body.color : null;
      if (Object.keys(update).length === 0) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
      const { error } = await db.from("incident_severity_levels").update(update).eq("id", id).eq("standard_id", view.template.id);
      if (error) { console.error("[severities patch]", error); return NextResponse.json({ error: "Could not update." }, { status: 500 }); }
      return NextResponse.json(await fresh());
    }

    if (body?.action === "reorder") {
      const order = Array.isArray(body.order) ? (body.order as string[]) : null;
      if (!order || order.length === 0) return NextResponse.json({ error: "Provide the new order." }, { status: 400 });
      const knownIds = new Set(view.severities.map((s) => s.id));
      if (order.some((id) => !knownIds.has(id))) return NextResponse.json({ error: "One or more severity IDs not found." }, { status: 400 });
      for (let i = 0; i < order.length; i++) {
        const { error } = await db.from("incident_severity_levels").update({ position: i + 1 }).eq("id", order[i]).eq("standard_id", view.template.id);
        if (error) { console.error("[severities reorder]", error); return NextResponse.json({ error: "Could not save the new order." }, { status: 500 }); }
      }
      return NextResponse.json(await fresh());
    }

    return NextResponse.json({ error: "Say what to do: rename, patch, or reorder." }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
