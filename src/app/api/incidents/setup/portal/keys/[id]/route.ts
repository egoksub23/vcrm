// PATCH /api/incidents/setup/portal/keys/[id] — rename a key, change the addresses allowed to frame the report, or revoke it (revoking cannot be undone,
// and ends every link the key issued). Requires incidents.configure.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseKeyPatch } from "@/lib/incidents/intake/admin";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const parsed = parseKeyPatch(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if (parsed.value.label !== undefined) patch.label = parsed.value.label;
    if (parsed.value.allowedOrigins !== undefined) patch.allowed_origins = parsed.value.allowedOrigins;
    if (parsed.value.revoke) patch.revoked_at = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from("incident_intake_keys")
      .update(patch)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .is("revoked_at", null)
      .select("id, label, mode, prefix, scopes, allowed_origins, created_at, last_used_at, revoked_at")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not save the changes." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Key not found, or it was already revoked." }, { status: 404 });
    return NextResponse.json({ key: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
