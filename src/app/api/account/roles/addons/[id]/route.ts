// ============================================================
// PATCH  /api/account/roles/addons/[id]   (roles.manage)   rename, describe, and/or replace the permissions
// DELETE /api/account/roles/addons/[id]   (roles.manage)   delete it; everyone who held it loses what it gave
//
// Both go through SECURITY DEFINER functions (update_addon_role, delete_addon_role, migration 191), which hold every rule: roles.manage in this workspace,
// and a permission added only by a person who holds it. `capabilities`, when sent, is the WHOLE new set; leave it out to change only the name or description.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  isUuid,
  parseAddonDescription,
  parseAddonName,
  parseCapabilityKeys,
  rpcErrorToResponse,
} from "@/lib/auth/addon-roles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(`admin:addonRole:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Role not found" }, { status: 404 });

    const body = (await request.json().catch(() => null)) as { name?: unknown; description?: unknown; capabilities?: unknown } | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Send what to change" }, { status: 400 });

    let name: string | null = null;
    if (body.name !== undefined) {
      const n = parseAddonName(body.name);
      if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
      name = n.value;
    }
    let description: string | null = null;
    if (body.description !== undefined) {
      const d = parseAddonDescription(body.description === null ? "" : body.description);
      if (!d.ok) return NextResponse.json({ error: d.error }, { status: 400 });
      description = d.value;
    }
    let capabilities: string[] | null = null;
    if (body.capabilities !== undefined) {
      const c = parseCapabilityKeys(body.capabilities);
      if (!c.ok) return NextResponse.json({ error: c.error }, { status: 400 });
      capabilities = c.value;
    }
    if (name === null && description === null && capabilities === null) return NextResponse.json({ error: "Send what to change" }, { status: 400 });

    const { data, error } = await ctx.supabase.rpc("update_addon_role", {
      p_addon_role_id: id,
      p_name: name,
      p_description: description,
      p_capabilities: capabilities,
    });
    if (error) return rpcErrorToResponse(error, "save the add-on role");
    return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(`admin:addonRole:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Role not found" }, { status: 404 });

    const { data, error } = await ctx.supabase.rpc("delete_addon_role", { p_addon_role_id: id });
    if (error) return rpcErrorToResponse(error, "delete the add-on role");
    return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
