// ============================================================
// GET /api/account/audit/removed  (audit.view)
//
// "Recently removed": tags, labels, snippets and articles that were
// soft-deleted in the last 90 days, newest first. Row-level security
// hides soft-deleted rows from normal reads, so this goes through the
// SECURITY DEFINER function `audit_removed_items()` (migration 082),
// which checks audit.view itself and scopes to the caller's account.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isRestorableEntityType, type RemovedItem } from "@/lib/audit/types";

interface RemovedRow {
  entity_type: string;
  entity_id: string;
  label: string | null;
  kind: string | null;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_name: string | null;
}

export async function GET() {
  try {
    const ctx = await requireCapability("audit.view");

    const { data, error } = await ctx.supabase.rpc("audit_removed_items", { p_limit: 200 });
    if (error) {
      console.error("[GET /api/account/audit/removed] rpc error:", error);
      return NextResponse.json({ error: "Failed to load removed items" }, { status: 500 });
    }

    const items: RemovedItem[] = [];
    for (const r of (data ?? []) as RemovedRow[]) {
      if (!isRestorableEntityType(r.entity_type)) continue;
      items.push({
        entityType: r.entity_type,
        entityId: r.entity_id,
        label: r.label ?? "",
        kind: r.kind ?? "",
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by,
        deletedByName: r.deleted_by_name ?? "",
      });
    }

    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
