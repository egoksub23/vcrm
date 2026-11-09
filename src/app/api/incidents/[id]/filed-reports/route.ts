// /api/incidents/[id]/filed-reports — the reports for filing made from a closed incident.
//   GET  lists them (newest first).
//   POST makes a new one: a PDF of everything the workflow recorded, from the report to the closure, kept and linked to the incident. Body: { timeZone }.
// Requires incidents.export. Another school's incident is a 404; an incident that is not closed is a 409.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { generateFilingReport, listFiledReports } from "@/lib/incidents/platform/filing-data";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.export");
    const { id } = await params;
    return NextResponse.json({ reports: await listFiledReports(ctx.supabase, id, ctx.accountId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.export");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { timeZone?: unknown } | null;
    const timeZone = typeof body?.timeZone === "string" ? body.timeZone.slice(0, 60) : "UTC";
    const result = await generateFilingReport({
      db: ctx.supabase,
      accountId: ctx.accountId,
      accountName: ctx.account.name,
      userId: ctx.userId,
      incidentId: id,
      canMedical: ctx.capabilities.has("incidents.medical"),
      timeZone,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ report: result.report, unsupportedCharacters: result.unsupportedCharacters, picturesNotShown: result.picturesNotShown }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
