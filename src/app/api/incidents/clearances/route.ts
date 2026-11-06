// /api/incidents/clearances — Return to Play dates. Requires incidents.medical. Warn only: nothing here blocks a student.
//   GET   ?incident=<id>  the students named on that incident and the dates set for them · without it: every date still in force
//   POST  { incident_id, student_id, type?, not_before, note? }  set a date for a student named on the incident
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isActive, parseClearance } from "@/lib/incidents/platform/clearance";
import { incidentKey } from "@/lib/incidents/types";
import { createAdminPgDb } from "@/lib/postgres/db";

type Clearance = { id: string; external_student_id: string; student_name: string; type: string; not_before: string; note: string | null; incident_id: string | null; cleared_at: string | null; created_at: string };

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("incidents.medical");
    const admin = createAdminPgDb();
    const incidentId = new URL(request.url).searchParams.get("incident");
    const today = new Date().toISOString().slice(0, 10);

    if (incidentId) {
      const { data: inc } = await admin.from("incidents").select("id").eq("id", incidentId).eq("account_id", ctx.accountId).maybeSingle();
      if (!inc) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
      const [people, existing] = await Promise.all([
        admin.from("incident_involved").select("external_student_id, name, class_name").eq("incident_id", incidentId).not("external_student_id", "is", null),
        admin.from("person_clearances").select("*").eq("account_id", ctx.accountId).eq("incident_id", incidentId).order("created_at", { ascending: false }),
      ]);
      return NextResponse.json({ students: people.data ?? [], clearances: (existing.data ?? []) as Clearance[], today });
    }

    const { data } = await admin.from("person_clearances").select("*").eq("account_id", ctx.accountId).is("cleared_at", null).order("not_before", { ascending: true }).limit(300);
    const rows = ((data ?? []) as Clearance[]).filter((c) => isActive(c, today));
    const ids = [...new Set(rows.map((r) => r.incident_id).filter((v): v is string => Boolean(v)))];
    const { data: incs } = ids.length ? await admin.from("incidents").select("id, created_at, incident_number").in("id", ids) : { data: [] };
    const ref = new Map(((incs ?? []) as { id: string; created_at: string; incident_number: number }[]).map((i) => [i.id, incidentKey(i)]));
    return NextResponse.json({ clearances: rows.map((r) => ({ ...r, incident_reference: r.incident_id ? (ref.get(r.incident_id) ?? null) : null })), today });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.medical");
    const parsed = parseClearance(await request.json().catch(() => null), new Date());
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const v = parsed.value;
    const admin = createAdminPgDb();

    // The student must be named on this incident (and the incident must be this school's): a date cannot be set for just anyone.
    const { data: person } = await admin
      .from("incident_involved")
      .select("name")
      .eq("incident_id", v.incidentId)
      .eq("account_id", ctx.accountId)
      .eq("external_student_id", v.studentId)
      .limit(1)
      .maybeSingle();
    if (!person) return NextResponse.json({ error: "That student is not named on this incident." }, { status: 404 });

    // One current date per student and incident: setting it again replaces it.
    const { data: existing } = await admin.from("person_clearances").select("id").eq("account_id", ctx.accountId).eq("incident_id", v.incidentId).eq("external_student_id", v.studentId).is("cleared_at", null).maybeSingle();
    const row = { type: v.type, not_before: v.notBefore, note: v.note, set_by: ctx.userId };
    const res = existing
      ? await admin.from("person_clearances").update(row).eq("id", (existing as { id: string }).id).select("*").single()
      : await admin.from("person_clearances").insert({ ...row, account_id: ctx.accountId, external_student_id: v.studentId, student_name: (person as { name: string }).name, incident_id: v.incidentId }).select("*").single();
    if (res.error || !res.data) return NextResponse.json({ error: "Could not save the date." }, { status: 500 });
    return NextResponse.json({ clearance: res.data }, { status: existing ? 200 : 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
