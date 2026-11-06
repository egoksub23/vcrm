// POST /api/incidents/setup/portal/keys/[id]/rotate — make a new key with the same settings. The old key keeps working until the admin revokes it, so the
// portal can switch over without a gap. The new key is in the answer once. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { generateKey, type KeyMode } from "@/lib/incidents/intake/keys";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const { data: old } = await ctx.supabase.from("incident_intake_keys").select("label, mode, allowed_origins, scopes").eq("id", id).eq("account_id", ctx.accountId).is("revoked_at", null).maybeSingle();
    const prev = old as { label: string; mode: KeyMode; allowed_origins: string[]; scopes: string[] } | null;
    if (!prev) return NextResponse.json({ error: "Key not found, or it was revoked." }, { status: 404 });

    const { data: active } = await ctx.supabase.from("incident_intake_keys").select("id").eq("account_id", ctx.accountId).is("revoked_at", null);
    if ((active ?? []).length >= 6) return NextResponse.json({ error: "There are already six active keys. Revoke one you no longer use first." }, { status: 409 });

    const { key, prefix, hash } = generateKey(prev.mode);
    const { data, error } = await ctx.supabase
      .from("incident_intake_keys")
      .insert({ account_id: ctx.accountId, label: `${prev.label} (rotated)`.slice(0, 80), mode: prev.mode, prefix, key_hash: hash, allowed_origins: prev.allowed_origins, scopes: prev.scopes, created_by: ctx.userId })
      .select("id, label, mode, prefix, scopes, allowed_origins, created_at, last_used_at, revoked_at")
      .single();
    if (error || !data) return NextResponse.json({ error: "Could not create the new key." }, { status: 500 });
    return NextResponse.json({ key: data, secret: key }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
