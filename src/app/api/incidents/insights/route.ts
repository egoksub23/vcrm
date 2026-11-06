// GET /api/incidents/insights — trends over the last 12 months: by month, category, severity and activity, and places where the same thing keeps happening.
// Requires incidents.manage. Test reports are left out.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { buildTrends } from "@/lib/incidents/platform/registers";
import { loadNames, loadRegisterRows } from "@/lib/incidents/platform/records-data";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.manage");
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
    const [{ rows }, names] = await Promise.all([loadRegisterRows(ctx.supabase, ctx.accountId, since), loadNames(ctx.supabase, ctx.accountId)]);
    return NextResponse.json({
      trends: buildTrends(rows, now),
      categories: Object.fromEntries(names.categories.map((c) => [c.code, c.name])),
      severities: Object.fromEntries(names.severities.map((s) => [s.slug, s.label])),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
