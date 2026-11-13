// POST /api/platform/coach-portal/test-report  { group_id } — a link to the hosted report page for one linked school, with made-up students, filed under the platform's
// test key. A test report is marked TEST and tells only that school's admins. Operator only.
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { TEST_ROSTER } from "@/lib/incidents/intake/admin";
import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { createTestSession, type KeyRow } from "@/lib/incidents/intake/service";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { createAdminPgDb } from "@/lib/postgres/db";

export async function POST(request: Request) {
  try {
    const ctx = await requirePlatformAdmin();
    const body = (await request.json().catch(() => null)) as { group_id?: unknown } | null;
    const groupId = typeof body?.group_id === "string" ? body.group_id.trim() : "";
    if (!groupId) return NextResponse.json({ error: "Choose the Vircle Group to test." }, { status: 400 });

    const db = createAdminPgDb();
    const { data: school } = await db.from("incident_portal_schools").select("group_id, account_id, allowed_origins, enabled").eq("group_id", groupId).maybeSingle();
    const link = school as { group_id: string; account_id: string; allowed_origins: string[]; enabled: boolean } | null;
    if (!link) return NextResponse.json({ error: "That Vircle Group is not set up." }, { status: 404 });
    if (!link.enabled) return NextResponse.json({ error: "That Vircle Group is switched off. Switch it on to test it." }, { status: 409 });

    const { data: keys } = await db.from("incident_intake_keys").select("id, scopes").is("account_id", null).eq("mode", "test").is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
    const found = ((keys ?? []) as { id: string; scopes: string[] }[])[0];
    if (!found) return NextResponse.json({ error: "Create a test key first. A test report must use the test key." }, { status: 409 });
    const key: KeyRow = { id: found.id, account_id: link.account_id, group_id: link.group_id, mode: "test", scopes: found.scopes, allowed_origins: link.allowed_origins, revoked_at: null };

    const { data: me } = await db.from("profiles").select("full_name, email").eq("user_id", ctx.userId).maybeSingle();
    const profile = me as { full_name: string | null; email: string | null } | null;
    const out = await createTestSession(intakeDeps(), key, { name: profile?.full_name || "Test coach", email: profile?.email ?? null }, TEST_ROSTER);
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: 422 });
    return NextResponse.json(out);
  } catch (err) {
    return toErrorResponse(err);
  }
}
