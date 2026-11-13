// GET /api/incidents/[id]/audit — what the incident's Audit log adds to the Timeline: the chain-of-custody lines for files (name, who, checksum) and every
// escalation with its reason (button, timer or rule). Requires incidents.manage. Read as the person, so another school's incident is empty.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id } = await params;
    const [evidence, escalations] = await Promise.all([
      ctx.supabase.from("incident_evidence_log").select("id, description, source, collected_by, collected_at, file_hash").eq("incident_id", id).eq("account_id", ctx.accountId).order("collected_at", { ascending: true }),
      ctx.supabase.from("incident_escalation_events").select("id, from_level, to_level, reason, triggered_by, created_at").eq("incident_id", id).eq("account_id", ctx.accountId).order("created_at", { ascending: true }),
    ]);
    return NextResponse.json({ evidence: evidence.data ?? [], escalations: escalations.data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
