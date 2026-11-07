// POST /api/platform/coach-portal/keys/[id]/rotate — make a new platform key with the same settings. The old key keeps working until the operator revokes it, so the
// portal can switch over without a gap. The new key is in the answer once. Operator only.
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { generateKey, type KeyMode } from "@/lib/incidents/intake/keys";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requirePlatformAdmin();
    const { id } = await params;
    const db = createAdminPgDb();
    const { data: old } = await db.from("incident_intake_keys").select("label, mode, scopes, webhook_url").eq("id", id).is("account_id", null).is("revoked_at", null).maybeSingle();
    const prev = old as { label: string; mode: KeyMode; scopes: string[]; webhook_url: string | null } | null;
    if (!prev) return NextResponse.json({ error: "Key not found, or it was revoked." }, { status: 404 });

    const { data: active } = await db.from("incident_intake_keys").select("id").is("account_id", null).is("revoked_at", null);
    if ((active ?? []).length >= 6) return NextResponse.json({ error: "There are already six active keys. Revoke one you no longer use first." }, { status: 409 });

    const { key, prefix, hash } = generateKey(prev.mode);
    const { data, error } = await db
      .from("incident_intake_keys")
      .insert({ account_id: null, label: `${prev.label} (rotated)`.slice(0, 80), mode: prev.mode, prefix, key_hash: hash, scopes: prev.scopes, webhook_url: prev.webhook_url, created_by: ctx.userId })
      .select("id, label, mode, prefix, scopes, webhook_url, created_at, last_used_at, revoked_at")
      .single();
    if (error || !data) return NextResponse.json({ error: "Could not create the new key." }, { status: 500 });
    return NextResponse.json({ key: data, secret: key }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
