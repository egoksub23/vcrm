// GET /api/incidents/[id]/answers — what the coach answered on the report form, labelled with the wording of the form version it was filed under, and the people
// named on it. Requires incidents.manage (children's names and medical answers). Another school's incident is a 404.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadAnswerLines } from "@/lib/incidents/platform/evidence-doc";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    const { data } = await ctx.supabase.from("incidents").select("id, source, form_version, custom_fields, reporter_name, reporter_email, reporter_phone, activity").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    const inc = data as { id: string; source: string; form_version: number | null; custom_fields: Record<string, unknown> | null; reporter_name: string | null; reporter_email: string | null; reporter_phone: string | null; activity: { name?: string; venue?: string; date?: string } | null } | null;
    if (!inc) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    if (inc.source === "halo" && Object.keys(inc.custom_fields ?? {}).length === 0) return NextResponse.json({ available: false });

    const lines = await loadAnswerLines(createAdminPgDb(), ctx.accountId, inc);
    const people = await ctx.supabase.from("incident_involved").select("name, class_name, involvement, guardians").eq("incident_id", id);
    return NextResponse.json({
      available: true,
      source: inc.source,
      formVersion: inc.form_version,
      reporter: { name: inc.reporter_name, email: inc.reporter_email, phone: inc.reporter_phone },
      activity: inc.activity,
      lines: lines ?? [],
      people: ((people.data ?? []) as { name: string; class_name: string | null; involvement: string; guardians: { email?: string; phone?: string }[] | null }[]).map((p) => ({
        name: p.name,
        class_name: p.class_name,
        involvement: p.involvement,
        // Whether a parent can be reached is shown; their details are not (they are in the record, for those who export it).
        has_guardian_contact: (p.guardians ?? []).some((g) => g.email || g.phone),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
