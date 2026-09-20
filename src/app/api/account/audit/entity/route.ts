// ============================================================
// GET /api/account/audit/entity  (audit.view)
//
// The history of ONE item, newest first — what the Activity drawer on
// an article, tag or snippet shows.
//   ?entity_type=article&entity_id=<uuid>&limit=50
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadActorNames, toAuditEntry } from "@/lib/audit/entries";
import { UUID_RE } from "@/lib/audit/filters";
import { AUDIT_ROW_COLUMNS, isAuditEntityType, type AuditRow } from "@/lib/audit/types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("audit.view");
    const params = new URL(request.url).searchParams;

    const entityType = params.get("entity_type");
    const entityId = params.get("entity_id");
    if (!isAuditEntityType(entityType)) {
      return NextResponse.json({ error: "Unknown 'entity_type'" }, { status: 400 });
    }
    if (!entityId || !UUID_RE.test(entityId)) {
      return NextResponse.json({ error: "'entity_id' must be an id" }, { status: 400 });
    }

    const limitRaw = Number(params.get("limit"));
    const limit =
      Number.isInteger(limitRaw) && limitRaw >= 1
        ? Math.min(limitRaw, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const { data, error } = await ctx.supabase
      .from("audit_log")
      .select(AUDIT_ROW_COLUMNS)
      .eq("account_id", ctx.accountId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[GET /api/account/audit/entity] fetch error:", error);
      return NextResponse.json({ error: "Failed to load the activity" }, { status: 500 });
    }

    const rows = (data ?? []) as unknown as AuditRow[];
    const names = await loadActorNames(
      ctx.supabase,
      ctx.accountId,
      rows.map((r) => r.actor_id).filter((v): v is string => !!v),
    );

    return NextResponse.json(
      { entries: rows.map((r) => toAuditEntry(r, names)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
