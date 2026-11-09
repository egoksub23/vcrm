// GET /api/incidents/[id]/evidence — everything held about one incident, in one document: the incident, who reported it, the people named, the timeline, the
// required steps, approvals, the message log, files (by name), the coach's answers and Return to Play dates (only for people who hold incidents.medical).
// Requires incidents.export. The incident page's "Print / save as PDF" record is built from this. Add ?download=1 for a JSON file.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadEvidenceDoc } from "@/lib/incidents/platform/evidence-doc";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.export");
    const { id } = await params;
    // Read as the person first: another school's incident, or one they cannot see, is a 404.
    const doc = await loadEvidenceDoc({ db: ctx.supabase, accountId: ctx.accountId, incidentId: id, canMedical: ctx.capabilities.has("incidents.medical") });
    if (!doc) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    const download = new URL(request.url).searchParams.get("download") === "1";
    return NextResponse.json(doc, { headers: { "Cache-Control": "no-store", ...(download ? { "Content-Disposition": `attachment; filename="${doc.reference}-evidence.json"` } : {}) } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
