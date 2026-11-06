// GET /api/incidents/setup/directory — the school's incident roles with their people, and every contact.
// Creates the starter roles the first time it is opened. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { ensureStarterRoles, loadDirectory } from "@/lib/incidents/platform/setup-data";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    await ensureStarterRoles(ctx.accountId);
    const directory = await loadDirectory(ctx.supabase, ctx.accountId);
    const { data: legacy } = await ctx.supabase.from("incident_escalation_recipients").select("user_id").eq("account_id", ctx.accountId);
    const imported = directory.roles.some((r) => r.key === "escalation_level_2" || r.key === "escalation_level_3");
    return NextResponse.json({ ...directory, legacyToImport: imported ? 0 : (legacy ?? []).length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
