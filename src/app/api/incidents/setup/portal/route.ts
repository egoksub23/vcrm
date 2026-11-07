// GET /api/incidents/setup/portal — what the "Coach portal" page shows a school: which Vircle Group the Halo operator has linked to this school (with the web addresses
// allowed to show its report page), whether a test report can be sent, and the last calls the portal made for this school. The keys and the link are the operator's to
// manage (in the operator console); a school only reads them. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const [schools, calls, settings, testKey] = await Promise.all([
      ctx.supabase.from("incident_portal_schools").select("group_id, group_name, allowed_origins, enabled").eq("account_id", ctx.accountId).order("group_name", { ascending: true }),
      ctx.supabase.from("incident_intake_calls").select("id, route, status, summary, created_at").eq("account_id", ctx.accountId).order("created_at", { ascending: false }).limit(15),
      ctx.supabase.from("incident_settings").select("retention_years").eq("account_id", ctx.accountId).maybeSingle(),
      createAdminPgDb().from("incident_intake_keys").select("id").is("account_id", null).eq("mode", "test").is("revoked_at", null).limit(1),
    ]);
    return NextResponse.json({
      schools: schools.data ?? [],
      calls: calls.data ?? [],
      address: process.env.NEXT_PUBLIC_SITE_URL?.trim() || null,
      retentionYears: (settings.data as { retention_years: number | null } | null)?.retention_years ?? null,
      canTest: ((testKey.data ?? []) as unknown[]).length > 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
