// POST /api/incidents/setup/portal/keys — create a key for the coach portal. The key is in the answer ONCE; only its hash is stored.
// Body: { mode: "live" | "test", label?, allowed_origins?: string[] }. Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseKeyCreate } from "@/lib/incidents/intake/admin";
import { generateKey } from "@/lib/incidents/intake/keys";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const parsed = parseKeyCreate(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    // A school normally has one live key at a time; extra keys are for rotation, so cap them to stop clutter.
    const { data: existing } = await ctx.supabase.from("incident_intake_keys").select("id").eq("account_id", ctx.accountId).is("revoked_at", null);
    if ((existing ?? []).length >= 6) return NextResponse.json({ error: "There are already six active keys. Revoke one you no longer use first." }, { status: 409 });

    const { key, prefix, hash } = generateKey(parsed.value.mode);
    const { data, error } = await ctx.supabase
      .from("incident_intake_keys")
      .insert({
        account_id: ctx.accountId,
        label: parsed.value.label,
        mode: parsed.value.mode,
        prefix,
        key_hash: hash,
        allowed_origins: parsed.value.allowedOrigins,
        created_by: ctx.userId,
      })
      .select("id, label, mode, prefix, scopes, allowed_origins, created_at, last_used_at, revoked_at")
      .single();
    if (error || !data) {
      console.error("[POST portal/keys]", error);
      return NextResponse.json({ error: "Could not create the key." }, { status: 500 });
    }
    return NextResponse.json({ key: data, secret: key }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
