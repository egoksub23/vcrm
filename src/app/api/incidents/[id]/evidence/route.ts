// GET /api/incidents/[id]/evidence — everything held about one incident, in one document: the incident, the people named, the timeline, the required steps,
// approvals, the message log, files (by name), and Return to Play dates (only for people who hold incidents.medical). Requires incidents.export.
// The incident page's "Print / save as PDF" record is built from this. Add ?download=1 for a JSON file.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { textDates } from "@/lib/incidents/platform/dates";
import { referenceOf } from "@/lib/incidents/platform/registers";
import { loadApprovals } from "@/lib/incidents/platform/workflow-data";
import { loadNames } from "@/lib/incidents/platform/records-data";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.export");
    const { id } = await params;
    // Read as the person first: another school's incident, or one they cannot see, is a 404.
    const { data: incident } = await ctx.supabase.from("incidents").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!incident) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    const inc = incident as Record<string, unknown> & { created_at: string; incident_number: number };

    const db = ctx.supabase;
    const admin = createAdminPgDb();
    const [names, involved, comments, activity, steps, deliveries, files, approvals] = await Promise.all([
      loadNames(db, ctx.accountId),
      db.from("incident_involved").select("name, class_name, external_student_id, involvement, guardians").eq("incident_id", id),
      db.from("incident_comments").select("author_id, body, created_at").eq("incident_id", id).order("created_at"),
      db.from("incident_activity").select("event_type, from_value, to_value, created_at").eq("incident_id", id).order("created_at"),
      db.from("incident_obligations").select("title, description, party, role_key, due_at, status, completed_at").eq("incident_id", id).order("due_at"),
      db.from("incident_deliveries").select("role_key, recipient_name, channel, address, reason, status, sent_at, acknowledged_at, is_test").eq("incident_id", id).order("created_at"),
      db.from("incident_attachments").select("filename, mime_type, size_bytes, file_hash, created_at").eq("incident_id", id).order("created_at"),
      loadApprovals(db, id, ctx.accountId),
    ]);

    const clearances = ctx.capabilities.has("incidents.medical")
      ? ((await admin.from("person_clearances").select("student_name, type, not_before, note, cleared_at").eq("account_id", ctx.accountId).eq("incident_id", id)).data ?? []).map((c: Record<string, unknown>) => textDates(c, ["cleared_at"], ["not_before"]))
      : null;

    const reference = referenceOf(inc);
    const doc = {
      reference,
      generated_at: new Date().toISOString(),
      incident: { ...inc, category_name: names.categories.find((c) => c.code === inc.incident_type)?.name ?? inc.incident_type, severity_label: names.severities.find((s) => s.slug === inc.severity)?.label ?? inc.severity },
      people_named: involved.data ?? [],
      timeline: activity.data ?? [],
      comments: comments.data ?? [],
      required_steps: steps.data ?? [],
      approvals,
      message_log: deliveries.data ?? [],
      files: files.data ?? [],
      return_to_play: clearances,
    };
    const download = new URL(request.url).searchParams.get("download") === "1";
    return NextResponse.json(doc, { headers: { "Cache-Control": "no-store", ...(download ? { "Content-Disposition": `attachment; filename="${reference}-evidence.json"` } : {}) } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
