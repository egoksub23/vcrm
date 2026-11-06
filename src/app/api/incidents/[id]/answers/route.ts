// GET /api/incidents/[id]/answers — what the coach answered on the report form, labelled with the wording of the form version it was filed under, and the people
// named on it. Requires incidents.manage (children's names and medical answers). Another school's incident is a 404.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { answerLines } from "@/lib/incidents/intake/answers-view";
import { CCA_FORM, type FormSchema } from "@/lib/incidents/intake/form-schema";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    const { data } = await ctx.supabase.from("incidents").select("id, source, form_version, custom_fields, reporter_name, reporter_email, reporter_phone, activity").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    const inc = data as { id: string; source: string; form_version: number | null; custom_fields: Record<string, unknown> | null; reporter_name: string | null; reporter_email: string | null; reporter_phone: string | null; activity: { name?: string; venue?: string; date?: string } | null } | null;
    if (!inc) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    if (inc.source === "halo") return NextResponse.json({ available: false });

    let schema: FormSchema = CCA_FORM;
    if (inc.form_version != null) {
      const { data: v } = await createAdminPgDb().from("incident_form_versions").select("schema").eq("account_id", ctx.accountId).eq("form_key", "cca").eq("version", inc.form_version).maybeSingle();
      if (v) schema = (v as { schema: FormSchema }).schema;
    }
    const people = await ctx.supabase.from("incident_involved").select("name, class_name, involvement, guardians").eq("incident_id", id);
    return NextResponse.json({
      available: true,
      source: inc.source,
      formVersion: inc.form_version,
      reporter: { name: inc.reporter_name, email: inc.reporter_email, phone: inc.reporter_phone },
      activity: inc.activity,
      lines: answerLines(schema, inc.custom_fields ?? {}),
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
