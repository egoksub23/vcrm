// GET /api/incidents/setup/retention/export?before=YYYY-MM-DD — download every closed incident up to that date as one JSON file, before deleting them.
// Also answers ?count=1 with just how many incidents the date covers. Requires incidents.export. The export is logged.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseCutoff } from "@/lib/incidents/platform/retention";
import { EXPORT_MAX_INCIDENTS, exportClosedBefore, incidentIdsClosedBefore, logExport } from "@/lib/incidents/platform/retention-data";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("incidents.export");
    const url = new URL(request.url);
    const cutoff = parseCutoff(url.searchParams.get("before"), new Date());
    if (!cutoff.ok) return NextResponse.json({ error: cutoff.error }, { status: 400 });
    const admin = createAdminPgDb();

    if (url.searchParams.get("count") === "1") {
      const ids = await incidentIdsClosedBefore(admin, ctx.accountId, cutoff.value, 10_000);
      return NextResponse.json({ count: ids.length });
    }

    const { bundle, truncated } = await exportClosedBefore(admin, ctx.accountId, cutoff.value);
    await logExport(admin, ctx.accountId, cutoff.value, bundle.incidents.length, ctx.userId);
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="incidents-closed-before-${cutoff.value}.json"`,
        "Cache-Control": "no-store",
        // Tells the screen the file stopped at the limit, so it does not offer a delete of records that are not in the file.
        "X-Export-Truncated": truncated ? String(EXPORT_MAX_INCIDENTS) : "0",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
