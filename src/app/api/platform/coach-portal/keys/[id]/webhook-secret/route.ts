// GET /api/platform/coach-portal/keys/[id]/webhook-secret — the secret the portal uses to check that an event really came from Halo. It is derived from the
// server's secret and this key's id (nothing is stored), so it can be shown again whenever it is needed. Operator only.
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { createAdminPgDb } from "@/lib/postgres/db";
import { webhookSecret } from "@/lib/incidents/webhooks/core";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const { data } = await createAdminPgDb().from("incident_intake_keys").select("id").eq("id", id).is("account_id", null).is("revoked_at", null).maybeSingle();
    if (!data) return NextResponse.json({ error: "Key not found, or it was revoked." }, { status: 404 });
    const secret = webhookSecret(id);
    if (!secret) return NextResponse.json({ error: "The server has no signing secret set (INCIDENT_INTAKE_SECRET)." }, { status: 503 });
    return NextResponse.json({ secret }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
