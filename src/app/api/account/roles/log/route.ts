// ============================================================
// GET /api/account/roles/log  (roles.manage)
//
// Who changed what, from what, when. Newest first.
//   ?role=agent   only that role
//   ?limit=50     page size (1..200)
//   ?before=123   cursor: entries with id < 123 (use `nextCursor`)
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";

interface LogRow {
  id: number;
  role: string;
  capability: string;
  old_granted: boolean;
  new_granted: boolean;
  actor: string | null;
  at: string;
}

export interface RoleLogEntry {
  id: number;
  role: string;
  capability: string;
  oldGranted: boolean;
  newGranted: boolean;
  actor: { id: string; name: string } | null;
  at: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("roles.manage");

    const url = new URL(request.url);
    const roleParam = url.searchParams.get("role");
    if (roleParam !== null && !isAccountRole(roleParam)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit =
      Number.isInteger(limitRaw) && limitRaw >= 1
        ? Math.min(limitRaw, MAX_LIMIT)
        : DEFAULT_LIMIT;
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw !== null ? Number(beforeRaw) : null;
    if (before !== null && (!Number.isInteger(before) || before < 1)) {
      return NextResponse.json({ error: "'before' must be a log id" }, { status: 400 });
    }

    let query = ctx.supabase
      .from("role_capability_log")
      .select("id, role, capability, old_granted, new_granted, actor, at")
      .eq("account_id", ctx.accountId)
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (roleParam) query = query.eq("role", roleParam);
    if (before !== null) query = query.lt("id", before);

    const { data, error } = await query;
    if (error) {
      console.error("[GET /api/account/roles/log] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load the change log" },
        { status: 500 },
      );
    }

    const rows = (data ?? []) as LogRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const actorIds = [
      ...new Set(page.map((r) => r.actor).filter((v): v is string => !!v)),
    ];
    const names = new Map<string, string>();
    if (actorIds.length > 0) {
      const { data: profiles } = await ctx.supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .eq("account_id", ctx.accountId)
        .in("user_id", actorIds);
      for (const p of (profiles ?? []) as {
        user_id: string;
        full_name: string | null;
        email: string | null;
      }[]) {
        names.set(p.user_id, p.full_name?.trim() || p.email || "");
      }
    }

    const entries: RoleLogEntry[] = page.map((r) => ({
      id: r.id,
      role: r.role,
      capability: r.capability,
      oldGranted: r.old_granted,
      newGranted: r.new_granted,
      actor: r.actor ? { id: r.actor, name: names.get(r.actor) ?? "" } : null,
      at: r.at,
    }));

    return NextResponse.json(
      {
        entries,
        nextCursor: hasMore ? page[page.length - 1].id : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
