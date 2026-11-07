// POST /api/incidents/setup/portal/test-report — a link to the hosted report with made-up students, filed under the platform's test key and this school's Vircle Group.
// A test report is marked TEST and notifies only the school's admins. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { TEST_ROSTER } from "@/lib/incidents/intake/admin";
import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { createTestSession, type KeyRow } from "@/lib/incidents/intake/service";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function POST() {
  try {
    const ctx = await requireCapability("incidents.configure");
    const admin = createAdminPgDb();

    const { data: school } = await admin
      .from("incident_portal_schools")
      .select("group_id, allowed_origins")
      .eq("account_id", ctx.accountId)
      .eq("enabled", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const link = school as { group_id: string; allowed_origins: string[] } | null;
    if (!link) return NextResponse.json({ error: "This school is not linked to a Vircle Group yet. Ask the Halo administrator to link it." }, { status: 409 });

    const { data: keys } = await admin.from("incident_intake_keys").select("id, mode, scopes").is("account_id", null).eq("mode", "test").is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
    const found = ((keys ?? []) as { id: string; mode: "test"; scopes: string[] }[])[0];
    if (!found) return NextResponse.json({ error: "The Halo administrator has not created a test key yet. A test report must use the test key." }, { status: 409 });
    const key: KeyRow = { id: found.id, account_id: ctx.accountId, group_id: link.group_id, mode: "test", scopes: found.scopes, allowed_origins: link.allowed_origins, revoked_at: null };

    const { data: me } = await admin.from("profiles").select("full_name, email").eq("user_id", ctx.userId).maybeSingle();
    const profile = me as { full_name: string | null; email: string | null } | null;
    const out = await createTestSession(intakeDeps(), key, { name: profile?.full_name || "Test coach", email: profile?.email ?? null }, TEST_ROSTER);
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: 422 });
    return NextResponse.json(out);
  } catch (err) {
    return toErrorResponse(err);
  }
}
