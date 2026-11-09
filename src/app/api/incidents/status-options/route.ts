// GET /api/incidents/status-options — the statuses people can choose for an incident in this school: the six base statuses (with the school's own wording
// where it renamed one) and its extra statuses that are switched on. Anyone who can use Incidents may read it. Migration 226.
import { NextResponse } from "next/server";

import { requireAnyCapability, toErrorResponse } from "@/lib/auth/account";
import { loadStatusOptions } from "@/lib/incidents/platform/statuses-data";

export async function GET() {
  try {
    const ctx = await requireAnyCapability(["menu.incidents"]);
    const options = await loadStatusOptions(ctx.supabase, ctx.accountId);
    return NextResponse.json({ options }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
