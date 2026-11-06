// POST /api/incidents/setup/portal/test-report — a link to the hosted report with made-up students, filed under a test key. A test report is marked TEST and
// notifies only the school's admins. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { TEST_ROSTER } from "@/lib/incidents/intake/admin";
import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { createTestSession, type KeyRow } from "@/lib/incidents/intake/service";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function POST() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { data } = await ctx.supabase
      .from("incident_intake_keys")
      .select("id, account_id, mode, scopes, allowed_origins, revoked_at")
      .eq("account_id", ctx.accountId)
      .eq("mode", "test")
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const key = ((data ?? []) as KeyRow[])[0];
    if (!key) return NextResponse.json({ error: "Create a test key first. A test report must use a test key." }, { status: 409 });

    const { data: me } = await createAdminPgDb().from("profiles").select("full_name, email").eq("user_id", ctx.userId).maybeSingle();
    const profile = me as { full_name: string | null; email: string | null } | null;
    const out = await createTestSession(intakeDeps(), key, { name: profile?.full_name || "Test coach", email: profile?.email ?? null }, TEST_ROSTER);
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: 422 });
    return NextResponse.json(out);
  } catch (err) {
    return toErrorResponse(err);
  }
}
