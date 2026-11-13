// GET /api/incidents/[id]/filed-reports/[reportId] — downloads one filed report (the PDF). Requires incidents.export. Served through the app, never by a
// public file link, because it holds children's details.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { readFiledReport } from "@/lib/incidents/platform/filing-data";

type Params = { params: Promise<{ id: string; reportId: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.export");
    const { id, reportId } = await params;
    const file = await readFiledReport(ctx.supabase, ctx.accountId, id, reportId);
    if (!file) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    return new NextResponse(Buffer.from(file.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
