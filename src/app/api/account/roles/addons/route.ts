// ============================================================
// GET  /api/account/roles/addons   (any member)
// POST /api/account/roles/addons   (roles.manage)
//
// Add-on roles (migration 191): named sets of extra permissions a person can be given on top of their base role. They only ADD; nothing in one takes a
// permission away. GET lists the workspace's add-ons with how many people hold each, so the member panel and the invite dialog can offer them; the
// permission keys themselves are sent only to people who manage roles. POST makes one through the create_addon_role function, which is where every rule
// lives (roles.manage, known permissions, only permissions the caller holds).
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, loadCapabilities, requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  parseAddonDescription,
  parseAddonName,
  parseCapabilityKeys,
  rpcErrorToResponse,
  type AddonRoleEntry,
  type AddonRoleListResponse,
} from "@/lib/auth/addon-roles";
import { addonMinBaseRole } from "@/lib/auth/capabilities";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

interface AddonRow {
  id: string;
  name: string;
  description: string | null;
  account_addon_role_capabilities: { capability: string }[] | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const caps = await loadCapabilities(ctx);
    const canManage = caps.has("roles.manage");

    const [rolesRes, membersRes] = await Promise.all([
      ctx.supabase
        .from("account_addon_roles")
        .select("id, name, description, account_addon_role_capabilities(capability)")
        .eq("account_id", ctx.accountId)
        .order("name"),
      ctx.supabase.from("member_addon_roles").select("addon_role_id").eq("account_id", ctx.accountId),
    ]);
    if (rolesRes.error || membersRes.error) {
      console.error("[GET /api/account/roles/addons] fetch error:", rolesRes.error ?? membersRes.error);
      return NextResponse.json({ error: "Failed to load add-on roles" }, { status: 500 });
    }

    const counts = new Map<string, number>();
    for (const row of (membersRes.data ?? []) as { addon_role_id: string }[]) counts.set(row.addon_role_id, (counts.get(row.addon_role_id) ?? 0) + 1);

    const addons: AddonRoleEntry[] = ((rolesRes.data ?? []) as AddonRow[]).map((r) => {
      const keys = (r.account_addon_role_capabilities ?? []).map((c) => c.capability).sort();
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        memberCount: counts.get(r.id) ?? 0,
        capabilityCount: keys.length,
        minBaseRole: addonMinBaseRole(keys),
        editable: canManage,
        ...(canManage ? { capabilities: keys } : {}),
      };
    });

    const body: AddonRoleListResponse = { addons };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("roles.manage");
    const limit = checkRateLimit(`admin:addonRole:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { name?: unknown; description?: unknown; capabilities?: unknown } | null;

    const name = parseAddonName(body?.name);
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
    let description = "";
    if (body?.description !== undefined && body.description !== null) {
      const d = parseAddonDescription(body.description);
      if (!d.ok) return NextResponse.json({ error: d.error }, { status: 400 });
      description = d.value;
    }
    const caps = parseCapabilityKeys(body?.capabilities ?? []);
    if (!caps.ok) return NextResponse.json({ error: caps.error }, { status: 400 });

    const { data, error } = await ctx.supabase.rpc("create_addon_role", {
      p_account_id: ctx.accountId,
      p_name: name.value,
      p_description: description === "" ? null : description,
      p_capabilities: caps.value,
    });
    if (error) return rpcErrorToResponse(error, "create the add-on role");
    return NextResponse.json({ id: data as string }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
