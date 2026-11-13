// GET /api/incidents/[id]/notification-docx — download a Word-processor notification letter for the incident.
// Requires incidents.export. The DOCX is editable: schools adjust the salutation and send it to parents
// or external authorities. No medical detail is included.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadEvidenceDoc } from "@/lib/incidents/platform/evidence-doc";
import { buildNotificationDocx } from "@/lib/incidents/platform/notification-docx";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.export");
    const { id } = await params;

    const doc = await loadEvidenceDoc({
      db: ctx.supabase,
      accountId: ctx.accountId,
      incidentId: id,
      canMedical: false, // never include medical detail in external notification
    });
    if (!doc) return NextResponse.json({ error: "Incident not found." }, { status: 404 });

    const db = createAdminPgDb();
    const { data: acct } = await db.from("accounts").select("brand_name, name, timezone").eq("id", ctx.accountId).maybeSingle();
    const a = acct as { brand_name: string | null; name: string | null; timezone: string | null } | null;
    const schoolName = a?.brand_name || a?.name || "School";
    const timeZone = a?.timezone ?? undefined;

    const bytes = await buildNotificationDocx({ doc, schoolName, timeZone });
    const filename = `${doc.reference}-notification.docx`;

    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
