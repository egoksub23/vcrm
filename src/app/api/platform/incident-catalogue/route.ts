// /api/platform/incident-catalogue — platform admin editor for system incident templates.
// Lets the operator add, rename or retire incident type codes on a system template without
// deploying a SQL migration. Schools that have already made their own copy are unaffected.
//   GET   list system templates with their type catalogue entries
//   POST  { action: "add",    standard_id, name, description?, code? }
//         { action: "rename", id, name }
//         { action: "retire", id }                     soft-delete: sets is_hidden = true
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { createAdminPgDb } from "@/lib/postgres/db";

const NO_STORE = { "Cache-Control": "no-store" };

function makeCode(name: string, existing: string[]): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "TYPE";
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const c = `${base}${i}`;
    if (!existing.includes(c)) return c;
  }
  return `${base}${Date.now()}`;
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = createAdminPgDb();
    const { data: stds } = await db.from("incident_standards").select("id, name, sector, regulatory_body").eq("is_system", true).eq("kind", "template").order("name");
    const standards = (stds ?? []) as { id: string; name: string; sector: string | null; regulatory_body: string | null }[];
    const result = await Promise.all(
      standards.map(async (s) => {
        const { data: entries } = await db.from("incident_type_catalogue").select("id, code, name, description, is_hidden, position").eq("standard_id", s.id).order("position");
        return { ...s, entries: (entries ?? []) as { id: string; code: string; name: string; description: string | null; is_hidden: boolean | null; position: number }[] };
      })
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    await requirePlatformAdmin();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const db = createAdminPgDb();

    if (body?.action === "add") {
      const standardId = typeof body.standard_id === "string" ? body.standard_id : null;
      const name = typeof body.name === "string" ? body.name.trim() : null;
      if (!standardId || !name) return NextResponse.json({ error: "Provide standard_id and name." }, { status: 400 });
      const { data: std } = await db.from("incident_standards").select("id").eq("id", standardId).eq("is_system", true).eq("kind", "template").maybeSingle();
      if (!std) return NextResponse.json({ error: "Template not found." }, { status: 404 });
      const { data: existing } = await db.from("incident_type_catalogue").select("code, position").eq("standard_id", standardId).order("position");
      const rows = (existing ?? []) as { code: string; position: number }[];
      const code = typeof body.code === "string" && body.code.trim() ? body.code.trim().toUpperCase() : makeCode(name, rows.map((r) => r.code));
      if (rows.some((r) => r.code === code)) return NextResponse.json({ error: `Code ${code} is already in use.` }, { status: 409 });
      const position = Math.max(0, ...rows.map((r) => r.position)) + 1;
      const { error } = await db.from("incident_type_catalogue").insert({ standard_id: standardId, code, name, description: typeof body.description === "string" ? body.description.trim() || null : null, default_flags: [], notifiable: false, position });
      if (error) { console.error("[platform catalogue add]", error); return NextResponse.json({ error: "Could not add the entry." }, { status: 500 }); }
      return NextResponse.json({ ok: true }, { status: 201 });
    }

    if (body?.action === "rename") {
      const id = typeof body.id === "string" ? body.id : null;
      const name = typeof body.name === "string" ? body.name.trim() : null;
      if (!id || !name) return NextResponse.json({ error: "Provide id and name." }, { status: 400 });
      const { data: row } = await db.from("incident_type_catalogue").select("standard_id").eq("id", id).maybeSingle();
      if (!row) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
      const { data: std } = await db.from("incident_standards").select("id").eq("id", (row as { standard_id: string }).standard_id).eq("is_system", true).maybeSingle();
      if (!std) return NextResponse.json({ error: "Cannot edit a school's own copy via this route." }, { status: 409 });
      const { error } = await db.from("incident_type_catalogue").update({ name }).eq("id", id);
      if (error) { console.error("[platform catalogue rename]", error); return NextResponse.json({ error: "Could not rename." }, { status: 500 }); }
      return NextResponse.json({ ok: true });
    }

    if (body?.action === "retire") {
      const id = typeof body.id === "string" ? body.id : null;
      if (!id) return NextResponse.json({ error: "Provide id." }, { status: 400 });
      const { data: row } = await db.from("incident_type_catalogue").select("standard_id").eq("id", id).maybeSingle();
      if (!row) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
      const { data: std } = await db.from("incident_standards").select("id").eq("id", (row as { standard_id: string }).standard_id).eq("is_system", true).maybeSingle();
      if (!std) return NextResponse.json({ error: "Cannot retire from a school's own copy via this route." }, { status: 409 });
      const { error } = await db.from("incident_type_catalogue").update({ is_hidden: true }).eq("id", id);
      if (error) { console.error("[platform catalogue retire]", error); return NextResponse.json({ error: "Could not retire." }, { status: 500 }); }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Say what to do: add, rename, or retire." }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
